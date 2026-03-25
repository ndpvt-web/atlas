/**
 * multi-window-coordinator.js - Central coordinator for multi-window operations
 *
 * PURPOSE:
 *   Enable ATLAS to work with multiple windows and applications simultaneously.
 *   Uses AX API for window enumeration and JXA for cross-app control.
 *
 * ARCHITECTURE:
 *   - Window Discovery: Uses AX API to enumerate all windows with metadata
 *   - Focus Control: Uses JXA (JavaScript for Automation) via osascript
 *   - Action Execution: Integrates with Phase 2 semantic actions
 *   - State Tracking: Records window transitions in trajectory graph
 *
 * DEPENDENCIES:
 *   - Phase 0: ax-grounding.js (AX-first element discovery)
 *   - Phase 2: semantic-action-converter.js (semantic action format)
 *
 * USAGE:
 *   const mwc = require('./multi-window-coordinator');
 *   // List all windows
 *   const windows = await mwc.listWindows();
 *   // Switch to specific window
 *   await mwc.switchToWindow({ appName: 'Safari', title: 'Google' });
 *   // Execute action in window
 *   await mwc.executeInWindow({ appName: 'Terminal' }, [clickAction]);
 *   // Cross-window copy/paste
 *   await mwc.crossWindowOperation(sourceWin, targetWin, 'copy-paste');
 */

const { execSync } = require('child_process');
const axGrounding = require('./ax-grounding');
const semanticConverter = require('./semantic-action-converter');

// Configuration
const WINDOW_SWITCH_DELAY = 500; // ms to wait after window switch for UI to settle
const JXA_TIMEOUT = 5000; // ms timeout for JXA commands

// Cache for window list
let _windowListCache = null;
let _windowListTimestamp = 0;
const WINDOW_LIST_CACHE_TTL = 1000; // 1 second

// Statistics
const stats = {
  windowSwitches: 0,
  actionsExecuted: 0,
  crossWindowOps: 0,
  errors: 0,
  avgSwitchTimeMs: 0,
  _switchTimes: [],
};

// ============================================================================
// JXA EXECUTION UTILITIES
// ============================================================================

/**
 * Execute JXA (JavaScript for Automation) script via osascript.
 * Handles escaping and error handling.
 *
 * @param {string} script - JXA script code
 * @param {number} timeout - Timeout in ms (default: JXA_TIMEOUT)
 * @returns {string} - Script output
 * @throws {Error} - If script execution fails
 */
function runJXA(script, timeout = JXA_TIMEOUT) {
  try {
    // Escape single quotes for shell
    const escaped = script.replace(/'/g, "'\\''");

    const result = execSync(`osascript -l JavaScript -e '${escaped}'`, {
      encoding: 'utf8',
      timeout: timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return result;
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : '';
    const stdout = error.stdout ? error.stdout.toString() : '';
    throw new Error(`JXA execution failed: ${stderr || stdout || error.message}`);
  }
}

/**
 * Test if JXA is available on the system.
 *
 * @returns {boolean} - True if JXA is available
 */
function isJXAAvailable() {
  try {
    runJXA('return "ok";', 1000);
    return true;
  } catch (error) {
    console.warn('[MultiWindow] JXA not available:', error.message);
    return false;
  }
}

// ============================================================================
// WINDOW ENUMERATION
// ============================================================================

/**
 * List all open windows across all applications.
 * Returns windows with AX metadata (app name, title, position, size, z-order).
 *
 * @param {boolean} includeMinimized - Include minimized windows (default: false)
 * @returns {Promise<Array>} - WindowInfo[] array
 */
async function listWindows(includeMinimized = false) {
  // Check cache
  const now = Date.now();
  if (_windowListCache && (now - _windowListTimestamp) < WINDOW_LIST_CACHE_TTL) {
    return _windowListCache;
  }

  try {
    // Use JXA to enumerate all windows across all applications
    const jxaScript = `
      const se = Application("System Events");
      const processes = se.applicationProcesses.whose({backgroundOnly: false});
      const windows = [];

      for (let i = 0; i < processes.length; i++) {
        const proc = processes[i];
        const appName = proc.name();
        const bundleId = proc.bundleIdentifier();

        try {
          const appWindows = proc.windows();
          for (let j = 0; j < appWindows.length; j++) {
            const win = appWindows[j];

            // Get window properties
            const title = win.title ? win.title() : '';
            const position = win.position ? win.position() : [0, 0];
            const size = win.size ? win.size() : [0, 0];
            const minimized = win.minimized ? win.minimized() : false;
            const focused = proc.frontmost ? proc.frontmost() : false;

            if (!${includeMinimized} && minimized) continue;

            windows.push({
              appName: appName,
              bundleId: bundleId,
              windowTitle: title,
              windowIndex: j,
              position: { x: position[0], y: position[1] },
              size: { width: size[0], height: size[1] },
              isMinimized: minimized,
              isFocused: focused && j === 0,
              zOrder: windows.length
            });
          }
        } catch (e) {
          // Some apps don't allow window access, skip silently
        }
      }

      return JSON.stringify(windows);
    `;

    const result = runJXA(jxaScript);
    const windows = JSON.parse(result);

    // Enrich with AX metadata where available
    for (const window of windows) {
      try {
        // Get AX tree for this window's app (if it's focused)
        if (window.isFocused) {
          const axTree = await axGrounding.queryAXTree();
          window.axElementCount = axTree.length;
          window.hasAXSupport = axTree.length > 0;
        }
      } catch (err) {
        // AX metadata is optional enhancement
        window.hasAXSupport = false;
      }
    }

    _windowListCache = windows;
    _windowListTimestamp = Date.now();

    console.log(`[MultiWindow] Listed ${windows.length} windows across ${new Set(windows.map(w => w.appName)).size} applications`);

    return windows;
  } catch (error) {
    console.error('[MultiWindow] listWindows error:', error.message);
    stats.errors++;
    return [];
  }
}

/**
 * Get the currently focused window.
 *
 * @returns {Promise<object|null>} - WindowInfo or null
 */
async function getFocusedWindow() {
  const windows = await listWindows();
  return windows.find(w => w.isFocused) || null;
}

/**
 * Invalidate window list cache.
 * Call after any operation that changes window state.
 */
function invalidateWindowCache() {
  _windowListCache = null;
  _windowListTimestamp = 0;
}

// ============================================================================
// WINDOW FOCUS CONTROL
// ============================================================================

/**
 * Switch to a window by application name and optional title.
 * Uses JXA to activate the application and bring window to front.
 *
 * @param {object} windowSpec - Window specification {appName, title?, windowIndex?}
 * @returns {Promise<object>} - FocusResult {success, latency, previousWindow, currentWindow}
 */
async function switchToWindow(windowSpec) {
  if (!windowSpec || !windowSpec.appName) {
    throw new Error('[MultiWindow] switchToWindow requires windowSpec.appName');
  }

  const startTime = Date.now();
  const previousWindow = await getFocusedWindow();

  try {
    const { appName, title, windowIndex } = windowSpec;

    // Build JXA script for window switching
    let jxaScript = `
      const app = Application("${appName}");
      if (!app.running()) {
        throw new Error("Application ${appName} is not running");
      }

      app.activate();
    `;

    // If title or index specified, select specific window
    if (title) {
      jxaScript += `
      const windows = app.windows();
      let targetWindow = null;
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        if (win.name && win.name().includes("${title}")) {
          targetWindow = win;
          break;
        }
      }
      if (targetWindow) {
        targetWindow.index = 1; // Bring to front
      }
      `;
    } else if (windowIndex !== undefined) {
      jxaScript += `
      const windows = app.windows();
      if (windows.length > ${windowIndex}) {
        windows[${windowIndex}].index = 1;
      }
      `;
    }

    jxaScript += `
      delay(${WINDOW_SWITCH_DELAY / 1000});
      return "switched";
    `;

    runJXA(jxaScript);

    // Wait for UI to settle
    await sleep(WINDOW_SWITCH_DELAY);

    // Invalidate caches (window state changed)
    invalidateWindowCache();
    axGrounding.invalidateCache();

    const latency = Date.now() - startTime;
    stats.windowSwitches++;
    stats._switchTimes.push(latency);
    if (stats._switchTimes.length > 20) stats._switchTimes.shift();
    stats.avgSwitchTimeMs = Math.round(
      stats._switchTimes.reduce((a, b) => a + b, 0) / stats._switchTimes.length
    );

    const currentWindow = await getFocusedWindow();

    console.log(`[MultiWindow] Switched to ${appName}${title ? ` (${title})` : ''} in ${latency}ms`);

    return {
      success: true,
      latency,
      previousWindow,
      currentWindow,
    };
  } catch (error) {
    console.error('[MultiWindow] switchToWindow error:', error.message);
    stats.errors++;
    return {
      success: false,
      error: error.message,
      latency: Date.now() - startTime,
      previousWindow,
      currentWindow: await getFocusedWindow(),
    };
  }
}

/**
 * Switch to application (activates frontmost window of app).
 * Simpler version of switchToWindow for app-level switching.
 *
 * @param {string} appName - Application name
 * @returns {Promise<object>} - FocusResult
 */
async function switchToApp(appName) {
  return switchToWindow({ appName });
}

// ============================================================================
// WINDOW CONTEXT
// ============================================================================

/**
 * Get AX tree for a specific window.
 * If window is not focused, switches to it first, then retrieves AX tree.
 *
 * @param {object} windowSpec - Window specification {appName, title?}
 * @param {boolean} switchFocus - Whether to switch focus (default: true)
 * @returns {Promise<object>} - {axTree, windowInfo, focusSwitched}
 */
async function getWindowContext(windowSpec, switchFocus = true) {
  try {
    const currentWindow = await getFocusedWindow();
    let focusSwitched = false;

    // Check if target window is already focused
    if (!currentWindow || currentWindow.appName !== windowSpec.appName ||
        (windowSpec.title && !currentWindow.windowTitle.includes(windowSpec.title))) {

      if (switchFocus) {
        // Need to switch focus
        const switchResult = await switchToWindow(windowSpec);
        if (!switchResult.success) {
          throw new Error(`Failed to switch to window: ${switchResult.error}`);
        }
        focusSwitched = true;
      } else {
        throw new Error('Target window not focused and switchFocus=false');
      }
    }

    // Query AX tree (now that window is focused)
    const axTree = await axGrounding.queryAXTree();
    const windowInfo = await getFocusedWindow();

    console.log(`[MultiWindow] Retrieved context for ${windowSpec.appName}: ${axTree.length} AX elements`);

    return {
      axTree,
      windowInfo,
      focusSwitched,
    };
  } catch (error) {
    console.error('[MultiWindow] getWindowContext error:', error.message);
    stats.errors++;
    throw error;
  }
}

// ============================================================================
// ACTION EXECUTION
// ============================================================================

/**
 * Execute semantic actions in a specific window.
 * Switches to window, executes actions, returns results.
 *
 * @param {object} windowSpec - Window specification {appName, title?}
 * @param {Array} actions - Array of SemanticAction objects
 * @param {boolean} restoreFocus - Restore original focus after execution (default: true)
 * @returns {Promise<object>} - ExecutionResult {success, actionsExecuted, results, windowInfo}
 */
async function executeInWindow(windowSpec, actions, restoreFocus = true) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('[MultiWindow] executeInWindow requires non-empty actions array');
  }

  const originalWindow = await getFocusedWindow();
  const startTime = Date.now();

  try {
    // Switch to target window
    const switchResult = await switchToWindow(windowSpec);
    if (!switchResult.success) {
      throw new Error(`Failed to switch to window: ${switchResult.error}`);
    }

    // Execute each semantic action
    const results = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      try {
        // Convert semantic action to coordinates
        const coords = await semanticConverter.semanticToCoordinate(action);

        if (!coords) {
          throw new Error(`Cannot resolve semantic target: ${semanticConverter.getSemanticDescription(action)}`);
        }

        // Execute the action (simplified - real implementation would use full action executor)
        await executeAction(action, coords);

        results.push({
          actionIndex: i,
          action,
          success: true,
          coordinates: coords,
        });

        stats.actionsExecuted++;

        // Invalidate cache after action (UI changed)
        axGrounding.invalidateCache();

      } catch (actionError) {
        console.error(`[MultiWindow] Action ${i} failed:`, actionError.message);
        results.push({
          actionIndex: i,
          action,
          success: false,
          error: actionError.message,
        });
        stats.errors++;
      }
    }

    const windowInfo = await getFocusedWindow();
    const duration = Date.now() - startTime;

    console.log(`[MultiWindow] Executed ${results.filter(r => r.success).length}/${actions.length} actions in ${windowSpec.appName} (${duration}ms)`);

    // Restore original focus if requested
    if (restoreFocus && originalWindow && originalWindow.appName !== windowInfo.appName) {
      await switchToWindow({ appName: originalWindow.appName, title: originalWindow.windowTitle });
    }

    return {
      success: results.every(r => r.success),
      actionsExecuted: results.filter(r => r.success).length,
      actionsTotal: actions.length,
      results,
      windowInfo,
      duration,
    };

  } catch (error) {
    console.error('[MultiWindow] executeInWindow error:', error.message);
    stats.errors++;

    // Restore focus on error
    if (restoreFocus && originalWindow) {
      try {
        await switchToWindow({ appName: originalWindow.appName, title: originalWindow.windowTitle });
      } catch (restoreError) {
        console.error('[MultiWindow] Failed to restore focus:', restoreError.message);
      }
    }

    return {
      success: false,
      error: error.message,
      actionsExecuted: 0,
      actionsTotal: actions.length,
      results: [],
    };
  }
}

/**
 * Execute a single action at given coordinates.
 * Helper function for executeInWindow.
 *
 * @param {object} action - SemanticAction object
 * @param {object} coords - {x, y} coordinates
 */
async function executeAction(action, coords) {
  const { type } = action;

  switch (type) {
    case 'click':
      execSync(`cliclick c:${coords.x},${coords.y}`, { timeout: 3000 });
      await sleep(200);
      break;

    case 'double_click':
      execSync(`cliclick dc:${coords.x},${coords.y}`, { timeout: 3000 });
      await sleep(200);
      break;

    case 'type':
      if (action.text) {
        // Click first to focus
        execSync(`cliclick c:${coords.x},${coords.y}`, { timeout: 3000 });
        await sleep(100);
        // Type text (escape special chars)
        const escaped = action.text.replace(/'/g, "'\\''");
        execSync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, { timeout: 5000 });
        await sleep(100);
      }
      break;

    case 'key':
      if (action.key) {
        execSync(`cliclick kp:${action.key}`, { timeout: 3000 });
        await sleep(100);
      }
      break;

    default:
      throw new Error(`Unsupported action type: ${type}`);
  }
}

// ============================================================================
// CROSS-WINDOW OPERATIONS
// ============================================================================

/**
 * Execute cross-window operation (copy/paste, drag-drop between windows).
 * Coordinates data transfer between two windows.
 *
 * @param {object} sourceWindow - Source window spec {appName, title?}
 * @param {object} targetWindow - Target window spec {appName, title?}
 * @param {string} operation - Operation type ('copy-paste', 'drag-drop')
 * @param {object} options - Operation-specific options
 * @returns {Promise<object>} - OperationResult {success, operation, sourceWindow, targetWindow}
 */
async function crossWindowOperation(sourceWindow, targetWindow, operation, options = {}) {
  stats.crossWindowOps++;
  const startTime = Date.now();

  try {
    switch (operation) {
      case 'copy-paste':
        return await copyPasteBetweenWindows(sourceWindow, targetWindow, options);

      case 'drag-drop':
        return await dragDropBetweenWindows(sourceWindow, targetWindow, options);

      default:
        throw new Error(`Unsupported cross-window operation: ${operation}`);
    }
  } catch (error) {
    console.error('[MultiWindow] crossWindowOperation error:', error.message);
    stats.errors++;
    return {
      success: false,
      operation,
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Copy data from source window and paste into target window.
 *
 * @param {object} sourceWindow - Source window spec
 * @param {object} targetWindow - Target window spec
 * @param {object} options - {sourceElement?, targetElement?}
 * @returns {Promise<object>} - OperationResult
 */
async function copyPasteBetweenWindows(sourceWindow, targetWindow, options) {
  const startTime = Date.now();

  // Step 1: Switch to source window
  await switchToWindow(sourceWindow);

  // Step 2: Select and copy (if sourceElement specified)
  if (options.sourceElement) {
    const coords = await semanticConverter.semanticToCoordinate(options.sourceElement);
    if (!coords) {
      throw new Error('Cannot resolve source element');
    }

    // Triple-click to select all, then copy
    execSync(`cliclick tc:${coords.x},${coords.y}`, { timeout: 3000 });
    await sleep(100);
  }

  // Copy to clipboard (Cmd+C)
  execSync(`osascript -e 'tell application "System Events" to keystroke "c" using command down'`, { timeout: 3000 });
  await sleep(200);

  // Step 3: Switch to target window
  await switchToWindow(targetWindow);

  // Step 4: Click target element and paste
  if (options.targetElement) {
    const coords = await semanticConverter.semanticToCoordinate(options.targetElement);
    if (!coords) {
      throw new Error('Cannot resolve target element');
    }

    execSync(`cliclick c:${coords.x},${coords.y}`, { timeout: 3000 });
    await sleep(100);
  }

  // Paste from clipboard (Cmd+V)
  execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 3000 });
  await sleep(200);

  const duration = Date.now() - startTime;

  console.log(`[MultiWindow] Copy-paste from ${sourceWindow.appName} to ${targetWindow.appName} completed in ${duration}ms`);

  return {
    success: true,
    operation: 'copy-paste',
    sourceWindow,
    targetWindow,
    duration,
  };
}

/**
 * Drag element from source window to target window.
 * Note: This is complex and may not work for all applications.
 *
 * @param {object} sourceWindow - Source window spec
 * @param {object} targetWindow - Target window spec
 * @param {object} options - {sourceElement, targetLocation}
 * @returns {Promise<object>} - OperationResult
 */
async function dragDropBetweenWindows(sourceWindow, targetWindow, options) {
  if (!options.sourceElement || !options.targetLocation) {
    throw new Error('[MultiWindow] drag-drop requires sourceElement and targetLocation');
  }

  const startTime = Date.now();

  try {
    // Step 1: Switch to source window and resolve element
    await switchToWindow(sourceWindow);
    const sourceCoords = await semanticConverter.semanticToCoordinate(options.sourceElement);
    if (!sourceCoords) {
      throw new Error('Cannot resolve source element');
    }

    // Step 2: Switch to target window and get target coordinates
    await switchToWindow(targetWindow);
    const targetCoords = options.targetLocation; // Should be {x, y}

    // Step 3: Execute drag from source to target
    // Note: This requires both windows to be visible, may need to arrange first
    const dragCmd = `cliclick dd:${sourceCoords.x},${sourceCoords.y} du:${targetCoords.x},${targetCoords.y}`;
    execSync(dragCmd, { timeout: 5000 });
    await sleep(300);

    const duration = Date.now() - startTime;

    console.log(`[MultiWindow] Drag-drop from ${sourceWindow.appName} to ${targetWindow.appName} completed in ${duration}ms`);

    return {
      success: true,
      operation: 'drag-drop',
      sourceWindow,
      targetWindow,
      duration,
    };
  } catch (error) {
    console.error('[MultiWindow] dragDropBetweenWindows error:', error.message);
    stats.errors++;
    return {
      success: false,
      operation: 'drag-drop',
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================================
// WINDOW ARRANGEMENT
// ============================================================================

/**
 * Arrange windows in a layout (side-by-side, stack, tile).
 * Moves and resizes windows to fit specified layout.
 *
 * @param {string} layout - Layout name ('split-left', 'split-right', 'quarters', 'thirds')
 * @param {Array} windows - Array of window specs to arrange
 * @returns {Promise<object>} - ArrangementResult {success, layout, windowsArranged}
 */
async function arrangeWindows(layout, windows) {
  if (!windows || windows.length === 0) {
    throw new Error('[MultiWindow] arrangeWindows requires window array');
  }

  const startTime = Date.now();

  try {
    // Get screen dimensions
    const screenDims = await getScreenDimensions();
    const { width, height } = screenDims;

    // Calculate geometries based on layout
    const geometries = calculateLayoutGeometries(layout, windows.length, width, height);

    if (geometries.length !== windows.length) {
      throw new Error(`Layout ${layout} does not support ${windows.length} windows`);
    }

    // Apply geometry to each window
    const results = [];
    for (let i = 0; i < windows.length; i++) {
      const windowSpec = windows[i];
      const geometry = geometries[i];

      try {
        await setWindowGeometry(windowSpec, geometry);
        results.push({ window: windowSpec, success: true, geometry });
      } catch (error) {
        console.error(`[MultiWindow] Failed to arrange ${windowSpec.appName}:`, error.message);
        results.push({ window: windowSpec, success: false, error: error.message });
        stats.errors++;
      }
    }

    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;

    console.log(`[MultiWindow] Arranged ${successCount}/${windows.length} windows in ${layout} layout (${duration}ms)`);

    return {
      success: successCount === windows.length,
      layout,
      windowsArranged: successCount,
      windowsTotal: windows.length,
      results,
      duration,
    };
  } catch (error) {
    console.error('[MultiWindow] arrangeWindows error:', error.message);
    stats.errors++;
    return {
      success: false,
      error: error.message,
      layout,
      windowsArranged: 0,
      windowsTotal: windows.length,
    };
  }
}

/**
 * Calculate window geometries for a given layout.
 *
 * @param {string} layout - Layout name
 * @param {number} count - Number of windows
 * @param {number} screenWidth - Screen width
 * @param {number} screenHeight - Screen height
 * @returns {Array} - Array of {x, y, width, height} geometries
 */
function calculateLayoutGeometries(layout, count, screenWidth, screenHeight) {
  const geometries = [];

  switch (layout) {
    case 'split-left':
      // First window left half, rest stacked on right
      geometries.push({ x: 0, y: 0, width: screenWidth / 2, height: screenHeight });
      for (let i = 1; i < count; i++) {
        const h = screenHeight / (count - 1);
        geometries.push({ x: screenWidth / 2, y: h * (i - 1), width: screenWidth / 2, height: h });
      }
      break;

    case 'split-right':
      // First window right half, rest stacked on left
      geometries.push({ x: screenWidth / 2, y: 0, width: screenWidth / 2, height: screenHeight });
      for (let i = 1; i < count; i++) {
        const h = screenHeight / (count - 1);
        geometries.push({ x: 0, y: h * (i - 1), width: screenWidth / 2, height: h });
      }
      break;

    case 'quarters':
      // 2x2 grid
      if (count !== 4) throw new Error('quarters layout requires exactly 4 windows');
      geometries.push(
        { x: 0, y: 0, width: screenWidth / 2, height: screenHeight / 2 },
        { x: screenWidth / 2, y: 0, width: screenWidth / 2, height: screenHeight / 2 },
        { x: 0, y: screenHeight / 2, width: screenWidth / 2, height: screenHeight / 2 },
        { x: screenWidth / 2, y: screenHeight / 2, width: screenWidth / 2, height: screenHeight / 2 }
      );
      break;

    case 'thirds':
      // Three equal columns
      if (count !== 3) throw new Error('thirds layout requires exactly 3 windows');
      const thirdWidth = screenWidth / 3;
      geometries.push(
        { x: 0, y: 0, width: thirdWidth, height: screenHeight },
        { x: thirdWidth, y: 0, width: thirdWidth, height: screenHeight },
        { x: thirdWidth * 2, y: 0, width: thirdWidth, height: screenHeight }
      );
      break;

    case 'stack':
      // All windows stacked vertically
      const stackHeight = screenHeight / count;
      for (let i = 0; i < count; i++) {
        geometries.push({ x: 0, y: stackHeight * i, width: screenWidth, height: stackHeight });
      }
      break;

    default:
      throw new Error(`Unsupported layout: ${layout}`);
  }

  // Round all values
  return geometries.map(g => ({
    x: Math.round(g.x),
    y: Math.round(g.y),
    width: Math.round(g.width),
    height: Math.round(g.height),
  }));
}

/**
 * Set window geometry (position and size).
 * Uses JXA to move and resize window.
 *
 * @param {object} windowSpec - Window specification {appName, title?}
 * @param {object} geometry - {x, y, width, height}
 */
async function setWindowGeometry(windowSpec, geometry) {
  const { appName, title, windowIndex } = windowSpec;
  const { x, y, width, height } = geometry;

  const jxaScript = `
    const se = Application("System Events");
    const proc = se.applicationProcesses["${appName}"];

    if (!proc.exists()) {
      throw new Error("Application ${appName} not found");
    }

    let targetWindow = null;
    ${title ? `
    const windows = proc.windows();
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      if (win.title && win.title().includes("${title}")) {
        targetWindow = win;
        break;
      }
    }
    ` : windowIndex !== undefined ? `
    const windows = proc.windows();
    if (windows.length > ${windowIndex}) {
      targetWindow = windows[${windowIndex}];
    }
    ` : `
    targetWindow = proc.windows[0];
    `}

    if (!targetWindow) {
      throw new Error("Window not found");
    }

    targetWindow.position = [${x}, ${y}];
    targetWindow.size = [${width}, ${height}];

    return "ok";
  `;

  runJXA(jxaScript);
  await sleep(100); // Let animation settle
}

/**
 * Get screen dimensions using JXA.
 *
 * @returns {Promise<object>} - {width, height}
 */
async function getScreenDimensions() {
  try {
    const jxaScript = `
      const se = Application("System Events");
      const displays = se.desktops[0].displays();

      if (displays.length === 0) {
        throw new Error("No displays found");
      }

      const mainDisplay = displays[0];
      const bounds = mainDisplay.bounds();

      return JSON.stringify({
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1]
      });
    `;

    const result = runJXA(jxaScript);
    return JSON.parse(result);
  } catch (error) {
    console.error('[MultiWindow] getScreenDimensions error:', error.message);
    // Fallback to common resolution
    return { width: 1920, height: 1080 };
  }
}

// ============================================================================
// APPLICATION CONTROL
// ============================================================================

/**
 * Launch application if not already running.
 * Uses JXA to start the application.
 *
 * @param {string} appName - Application name
 * @param {boolean} activate - Activate after launch (default: true)
 * @returns {Promise<object>} - {success, wasRunning, windowCount}
 */
async function launchApp(appName, activate = true) {
  try {
    const jxaScript = `
      const app = Application("${appName}");
      const wasRunning = app.running();

      if (!wasRunning) {
        app.launch();
        delay(2); // Wait for app to start
      }

      if (${activate}) {
        app.activate();
        delay(0.5);
      }

      return JSON.stringify({
        wasRunning: wasRunning,
        windowCount: app.windows ? app.windows().length : 0
      });
    `;

    const result = runJXA(jxaScript, 10000); // Longer timeout for launch
    const data = JSON.parse(result);

    console.log(`[MultiWindow] Launched ${appName} (was running: ${data.wasRunning})`);

    // Invalidate caches
    invalidateWindowCache();
    if (activate) {
      await sleep(WINDOW_SWITCH_DELAY);
      axGrounding.invalidateCache();
    }

    return {
      success: true,
      appName,
      wasRunning: data.wasRunning,
      windowCount: data.windowCount,
    };
  } catch (error) {
    console.error('[MultiWindow] launchApp error:', error.message);
    stats.errors++;
    return {
      success: false,
      appName,
      error: error.message,
    };
  }
}

/**
 * Check if application is running.
 *
 * @param {string} appName - Application name
 * @returns {Promise<boolean>} - True if app is running
 */
async function isAppRunning(appName) {
  try {
    const jxaScript = `Application("${appName}").running()`;
    const result = runJXA(jxaScript, 2000);
    return result === 'true';
  } catch (error) {
    return false;
  }
}

/**
 * Quit application.
 * Uses JXA to gracefully quit the application.
 *
 * @param {string} appName - Application name
 * @param {boolean} force - Force quit if graceful quit fails
 * @returns {Promise<object>} - {success, forced}
 */
async function quitApp(appName, force = false) {
  try {
    const jxaScript = `
      const app = Application("${appName}");
      if (!app.running()) {
        return JSON.stringify({ alreadyQuit: true });
      }

      ${force ? `
      const se = Application("System Events");
      const proc = se.applicationProcesses["${appName}"];
      if (proc.exists()) {
        proc.kill();
      }
      ` : `
      app.quit();
      delay(1);
      `}

      return JSON.stringify({ forced: ${force} });
    `;

    const result = runJXA(jxaScript);
    const data = JSON.parse(result);

    invalidateWindowCache();

    console.log(`[MultiWindow] Quit ${appName}${data.forced ? ' (forced)' : ''}`);

    return {
      success: true,
      appName,
      forced: data.forced || false,
    };
  } catch (error) {
    console.error('[MultiWindow] quitApp error:', error.message);
    stats.errors++;
    return {
      success: false,
      appName,
      error: error.message,
    };
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Sleep for specified milliseconds.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get statistics for multi-window operations.
 * @returns {object} - Statistics object
 */
function getStats() {
  return {
    windowSwitches: stats.windowSwitches,
    actionsExecuted: stats.actionsExecuted,
    crossWindowOps: stats.crossWindowOps,
    errors: stats.errors,
    avgSwitchTimeMs: stats.avgSwitchTimeMs,
    jxaAvailable: isJXAAvailable(),
  };
}

/**
 * Reset statistics.
 */
function resetStats() {
  stats.windowSwitches = 0;
  stats.actionsExecuted = 0;
  stats.crossWindowOps = 0;
  stats.errors = 0;
  stats.avgSwitchTimeMs = 0;
  stats._switchTimes = [];
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Window enumeration
  listWindows,
  getFocusedWindow,
  invalidateWindowCache,

  // Focus control
  switchToWindow,
  switchToApp,

  // Window context
  getWindowContext,

  // Action execution
  executeInWindow,

  // Cross-window operations
  crossWindowOperation,

  // Window arrangement
  arrangeWindows,
  getScreenDimensions,

  // Application control
  launchApp,
  isAppRunning,
  quitApp,

  // Utilities
  getStats,
  resetStats,
  isJXAAvailable,
};

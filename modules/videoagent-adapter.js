/**
 * VideoAgent Adapter
 *
 * Converts VideoAgentTrek trajectory data into ATLAS reflection format.
 * VideoAgentTrek extracts GUI interactions from screen recordings.
 *
 * Expected VideoAgent trajectory format:
 * {
 *   "video_path": "/path/to/recording.mp4",
 *   "task_description": "Open Safari and search for cats",
 *   "actions": [
 *     { "timestamp": 1.2, "action": "click", "target": "Safari icon", "coords": [100, 200] },
 *     { "timestamp": 3.5, "action": "type", "text": "cats" },
 *     ...
 *   ],
 *   "success": true,
 *   "duration": 12500
 * }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONVERSION LOGIC
// ============================================================

/**
 * Convert a single VideoAgent trajectory to ATLAS reflection format.
 *
 * @param {object} trajectory - VideoAgent trajectory object
 * @returns {object} - ATLAS reflection object
 */
function convertTrajectory(trajectory) {
  if (!trajectory || !trajectory.actions) {
    throw new Error('Invalid trajectory: missing actions array');
  }

  // Extract task type from description (simple heuristic)
  const taskType = inferTaskType(trajectory.task_description || '');

  // Generate lessons from action sequence
  const lessons = extractLessons(trajectory);

  // Build ATLAS reflection
  const reflection = {
    id: `ref-video-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    trajectoryId: trajectory.video_path ? path.basename(trajectory.video_path, '.mp4') : `video-${Date.now()}`,
    taskDescription: trajectory.task_description || 'Unknown task',
    taskType,
    outcome: trajectory.success ? 'success' : 'failure',
    iterations: trajectory.actions.length,
    loopsDetected: 0, // VideoAgent doesn't track loops
    stagnationsDetected: 0,
    duration: trajectory.duration || 0,
    reflection: generateReflectionText(trajectory),
    lessons,
    failurePoints: trajectory.success ? [] : ['Task did not complete successfully'],
    effectiveStrategies: trajectory.success ? extractStrategies(trajectory) : [],
    timestamp: Date.now(),

    // Phase 1 additions
    source: 'videoagent',
    confidence: computeConfidence(trajectory),
    sourceId: trajectory.video_path || `video-${Date.now()}`,
  };

  return reflection;
}

/**
 * Infer task type from task description using keyword matching.
 */
function inferTaskType(description) {
  const lower = description.toLowerCase();

  if (/\b(open|launch|start)\b.*\b(app|application|program)\b/.test(lower)) return 'app_launch';
  if (/\b(search|find|look|google)\b/.test(lower)) return 'web_search';
  if (/\b(file|folder|directory|document)\b/.test(lower)) return 'file_management';
  if (/\b(settings|preferences|system|control)\b/.test(lower)) return 'settings_change';
  if (/\b(write|edit|type|text|document)\b/.test(lower)) return 'text_editing';
  if (/\b(email|mail|message|send)\b/.test(lower)) return 'communication';
  if (/\b(browser|chrome|safari|firefox|web)\b/.test(lower)) return 'web_navigation';
  if (/\b(screenshot|capture|record|snap)\b/.test(lower)) return 'media_capture';
  if (/\b(terminal|command|shell|cli)\b/.test(lower)) return 'cli_interaction';

  return 'general_interaction';
}

/**
 * Extract generalizable lessons from VideoAgent trajectory.
 */
function extractLessons(trajectory) {
  const lessons = [];
  const actions = trajectory.actions || [];

  // Lesson 1: Interaction method used
  const clickCount = actions.filter(a => a.action === 'click').length;
  const typeCount = actions.filter(a => a.action === 'type').length;
  const keyCount = actions.filter(a => a.action === 'key' || a.action === 'press').length;

  if (clickCount > typeCount + keyCount) {
    lessons.push('Primary interaction method: mouse clicks on visual elements');
  } else if (keyCount > clickCount) {
    lessons.push('Primary interaction method: keyboard shortcuts');
  } else if (typeCount > 0) {
    lessons.push('Task requires text input via keyboard typing');
  }

  // Lesson 2: Timing patterns
  const delays = [];
  for (let i = 1; i < actions.length; i++) {
    const delay = actions[i].timestamp - actions[i - 1].timestamp;
    delays.push(delay);
  }

  if (delays.length > 0) {
    const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
    const maxDelay = Math.max(...delays);

    if (maxDelay > 3.0 && maxDelay > avgDelay * 3) {
      lessons.push(`Task requires waiting for UI updates (observed ${maxDelay.toFixed(1)}s delay)`);
    } else if (avgDelay < 0.5) {
      lessons.push('Rapid sequential actions without delays');
    }
  }

  // Lesson 3: Outcome-specific insight
  if (trajectory.success) {
    lessons.push(`Task completed successfully in ${actions.length} actions over ${((trajectory.duration || 0) / 1000).toFixed(1)}s`);
  } else {
    lessons.push('Task execution incomplete or unsuccessful');
  }

  return lessons.slice(0, 4); // Cap at 4 lessons
}

/**
 * Generate reflection text summary.
 */
function generateReflectionText(trajectory) {
  const actionCount = (trajectory.actions || []).length;
  const duration = ((trajectory.duration || 0) / 1000).toFixed(1);
  const outcome = trajectory.success ? 'succeeded' : 'failed';

  return `VideoAgent trajectory: ${trajectory.task_description || 'Unknown task'} ${outcome} with ${actionCount} actions in ${duration}s.`;
}

/**
 * Extract effective strategies from successful trajectory.
 */
function extractStrategies(trajectory) {
  const strategies = [];
  const actions = trajectory.actions || [];

  // Strategy 1: Action sequence pattern
  const actionTypes = actions.map(a => a.action).slice(0, 5).join(' -> ');
  if (actionTypes) {
    strategies.push(`Action sequence: ${actionTypes}`);
  }

  // Strategy 2: Targeting strategy
  const hasCoords = actions.some(a => a.coords);
  const hasTarget = actions.some(a => a.target);

  if (hasTarget) {
    strategies.push('Used semantic target identification (element labels)');
  } else if (hasCoords) {
    strategies.push('Used coordinate-based targeting');
  }

  return strategies;
}

/**
 * Compute confidence score for VideoAgent reflection.
 * Based on trajectory quality indicators.
 *
 * @param {object} trajectory - VideoAgent trajectory
 * @returns {number} - Confidence 0-1
 */
function computeConfidence(trajectory) {
  let confidence = 0.5; // Start at neutral

  // Factor 1: Successful completion
  if (trajectory.success) {
    confidence += 0.2;
  } else {
    confidence -= 0.1;
  }

  // Factor 2: Action count (too few = incomplete, too many = confused)
  const actionCount = (trajectory.actions || []).length;
  if (actionCount >= 3 && actionCount <= 20) {
    confidence += 0.15;
  } else if (actionCount > 50) {
    confidence -= 0.1;
  }

  // Factor 3: Duration (too fast = trivial, too slow = struggling)
  const duration = (trajectory.duration || 0) / 1000;
  if (duration >= 2 && duration <= 60) {
    confidence += 0.15;
  } else if (duration > 120) {
    confidence -= 0.1;
  }

  // Factor 4: Action diversity
  const actionTypes = new Set((trajectory.actions || []).map(a => a.action));
  if (actionTypes.size >= 2) {
    confidence += 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

// ============================================================
// BATCH PROCESSING
// ============================================================

/**
 * Process a batch of VideoAgent trajectories from JSON files.
 *
 * @param {array} videoFiles - Array of file paths to VideoAgent trajectory JSON files
 * @returns {object} - { reflections: array, errors: array }
 */
function processBatch(videoFiles) {
  const reflections = [];
  const errors = [];

  for (const filePath of videoFiles) {
    try {
      if (!fs.existsSync(filePath)) {
        errors.push({ file: filePath, error: 'File not found' });
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const trajectory = JSON.parse(content);

      const reflection = convertTrajectory(trajectory);
      reflections.push(reflection);

      console.log(`[VideoAgent] Converted: ${path.basename(filePath)} -> ${reflection.id}`);
    } catch (e) {
      errors.push({ file: filePath, error: e.message });
      console.error(`[VideoAgent] Error processing ${path.basename(filePath)}: ${e.message}`);
    }
  }

  console.log(`[VideoAgent] Batch complete: ${reflections.length} reflections, ${errors.length} errors`);

  return { reflections, errors };
}

/**
 * Process VideoAgent trajectories from a directory.
 *
 * @param {string} dirPath - Directory containing VideoAgent trajectory JSON files
 * @returns {object} - { reflections: array, errors: array }
 */
function processDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      return { reflections: [], errors: [{ dir: dirPath, error: 'Directory not found' }] };
    }

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(dirPath, f));

    return processBatch(files);
  } catch (e) {
    return { reflections: [], errors: [{ dir: dirPath, error: e.message }] };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  convertTrajectory,
  processBatch,
  processDirectory,
  computeConfidence,
};

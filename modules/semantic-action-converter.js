/**
 * semantic-action-converter.js - Convert between coordinate-based and semantic actions
 *
 * PURPOSE:
 *   Bridge between legacy coordinate-based macros and new semantic macros.
 *   Enables backward compatibility and progressive enhancement of existing macros.
 *
 * ARCHITECTURE:
 *   Recording: coordinateToSemantic() queries AX at click point, extracts semantic target
 *   Replay: semanticToCoordinate() searches AX tree by role/label/path, resolves to coordinates
 *   Migration: enrichExistingMacro() adds semantic data to old coordinate-only macros
 *
 * USAGE:
 *   const converter = require('./semantic-action-converter');
 *   // Recording: convert click coordinates to semantic action
 *   const semantic = await converter.coordinateToSemantic(450, 320, 'click');
 *   // Replay: find element by semantic target, get current coordinates
 *   const coords = await converter.semanticToCoordinate(semantic);
 *   // Migration: enrich old macro with semantic data
 *   const enriched = await converter.enrichExistingMacro(oldMacro);
 */

const axGrounding = require('./ax-grounding');

/**
 * Convert screen coordinates to semantic action.
 * Queries AX tree at given coordinates, extracts semantic properties.
 *
 * @param {number} x - Click X coordinate
 * @param {number} y - Click Y coordinate
 * @param {string} actionType - Action type ('click', 'type', 'key', 'scroll')
 * @returns {Promise<object|null>} - SemanticAction or null if AX element not found
 */
async function coordinateToSemantic(x, y, actionType) {
  try {
    // Query full AX tree
    const axTree = await axGrounding.queryAXTree();

    if (!axTree || axTree.length === 0) {
      console.log(`[Semantic] No AX tree available`);
      return null;
    }

    // Find elements near coordinates (within 50px radius)
    const nearby = axTree.filter(el => {
      if (!el.rect) return false;

      const centerX = el.rect.x + el.rect.w / 2;
      const centerY = el.rect.y + el.rect.h / 2;
      const dx = centerX - x;
      const dy = centerY - y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      return dist <= 50;
    });

    if (nearby.length === 0) {
      console.log(`[Semantic] No AX element found within 50px of (${x},${y})`);
      return null;
    }

    // Find closest element to click point
    let closest = nearby[0];
    let minDist = Infinity;

    for (const el of nearby) {
      const centerX = el.rect.x + el.rect.w / 2;
      const centerY = el.rect.y + el.rect.h / 2;
      const dx = centerX - x;
      const dy = centerY - y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < minDist) {
        minDist = dist;
        closest = el;
      }
    }

    // Build semantic action
    const semanticAction = {
      type: actionType,
      target: {
        role: closest.role,
        label: closest.label || '',
        path: closest.path || '',
      },
      coordinates: [x, y],
      confidence: calculateConfidence(closest, x, y),
      capturedAt: new Date().toISOString(),
    };

    console.log(`[Semantic] Converted (${x},${y}) -> ${closest.role}[${closest.label}] (confidence: ${semanticAction.confidence.toFixed(2)})`);

    return semanticAction;
  } catch (error) {
    console.error(`[Semantic] coordinateToSemantic error: ${error.message}`);
    return null;
  }
}

/**
 * Calculate confidence score for semantic capture.
 * Based on:
 * - Distance from click point to element center
 * - Whether element has a label
 * - Whether element has clickable actions
 *
 * @param {object} element - AX element
 * @param {number} clickX - Click X coordinate
 * @param {number} clickY - Click Y coordinate
 * @returns {number} - Confidence score (0-1)
 */
function calculateConfidence(element, clickX, clickY) {
  let confidence = 0.5;

  // Distance factor
  if (element.rect) {
    const centerX = element.rect.x + element.rect.w / 2;
    const centerY = element.rect.y + element.rect.h / 2;
    const dx = centerX - clickX;
    const dy = centerY - clickY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) confidence += 0.4;
    else if (dist < 15) confidence += 0.3;
    else if (dist < 30) confidence += 0.15;
    else confidence += 0.05;
  }

  // Label factor
  if (element.label && element.label.length > 0) {
    confidence += 0.1;
  }

  // Actions factor
  if (element.actions && element.actions.length > 0) {
    if (element.actions.includes('AXPress')) {
      confidence += 0.05;
    }
  }

  return Math.min(confidence, 1.0);
}

/**
 * Convert semantic action to current screen coordinates.
 * Searches AX tree by role/label/path, returns current coordinates.
 *
 * @param {object} semanticAction - SemanticAction to resolve
 * @returns {Promise<object|null>} - {x, y, confidence, method} or null if not found
 */
async function semanticToCoordinate(semanticAction) {
  if (!semanticAction || !semanticAction.target) {
    console.warn('[Semantic] Invalid semantic action: missing target');
    return null;
  }

  const { target } = semanticAction;

  try {
    // Strategy 1: Search by role + label (most specific)
    if (target.role && target.label) {
      const matches = await axGrounding.searchAXElements({
        role: target.role,
        label: target.label,
      });

      if (matches.length > 0) {
        const coords = await axGrounding.resolveElementToCoordinates(matches[0]);
        console.log(`[Semantic] Found ${target.role}[${target.label}] at (${coords.x},${coords.y}) via exact match`);
        return {
          x: coords.x,
          y: coords.y,
          confidence: coords.confidence,
          method: 'semantic_exact',
          element: matches[0],
        };
      }
    }

    // Strategy 2: Fuzzy label search (handles label changes)
    if (target.role && target.label) {
      const matches = await axGrounding.searchAXElements({
        role: target.role,
        fuzzyLabel: target.label,
      });

      if (matches.length > 0) {
        const coords = await axGrounding.resolveElementToCoordinates(matches[0]);
        console.log(`[Semantic] Found ${target.role}[${target.label}] at (${coords.x},${coords.y}) via fuzzy match`);
        return {
          x: coords.x,
          y: coords.y,
          confidence: coords.confidence * 0.9,
          method: 'semantic_fuzzy',
          element: matches[0],
        };
      }
    }

    // Strategy 3: Path-based search (handles renamed labels if hierarchy stable)
    if (target.path) {
      const axTree = await axGrounding.queryAXTree();
      const pathMatches = axTree.filter(el => el.path === target.path);

      if (pathMatches.length > 0) {
        const coords = await axGrounding.resolveElementToCoordinates(pathMatches[0]);
        console.log(`[Semantic] Found by path ${target.path} at (${coords.x},${coords.y})`);
        return {
          x: coords.x,
          y: coords.y,
          confidence: coords.confidence,
          method: 'semantic_path',
          element: pathMatches[0],
        };
      }
    }

    console.log(`[Semantic] No match found for ${target.role}[${target.label}]`);
    return null;
  } catch (error) {
    console.error(`[Semantic] semanticToCoordinate error: ${error.message}`);
    return null;
  }
}

/**
 * Enrich existing coordinate-only macro with semantic data.
 * Replays the macro, queries AX at each step, adds semantic targets.
 *
 * @param {object} macro - Existing macro manifest
 * @returns {Promise<object>} - Enriched macro with semantic actions
 */
async function enrichExistingMacro(macro) {
  if (!macro || !macro.steps) {
    throw new Error('[Semantic] Invalid macro: missing steps');
  }

  console.log(`[Semantic] Enriching macro "${macro.name}" (${macro.steps.length} steps)`);

  const enrichedSteps = [];
  let successCount = 0;

  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    const enrichedStep = { ...step };

    // Only enrich click-type actions with coordinates
    if (['click', 'double_click'].includes(step.type) && step.position) {
      const semantic = await coordinateToSemantic(
        step.position.x,
        step.position.y,
        step.type
      );

      if (semantic) {
        enrichedStep.target = semantic.target;
        enrichedStep.semanticConfidence = semantic.confidence;
        successCount++;
        console.log(`[Semantic] Step ${i}: enriched with ${semantic.target.role}[${semantic.target.label}]`);
      } else {
        console.log(`[Semantic] Step ${i}: no AX element found, keeping coordinates only`);
      }
    }

    enrichedSteps.push(enrichedStep);
  }

  const enrichedMacro = {
    ...macro,
    steps: enrichedSteps,
    enriched: true,
    enrichedAt: new Date().toISOString(),
    enrichmentSuccess: successCount,
    enrichmentTotal: macro.steps.length,
  };

  console.log(`[Semantic] Enrichment complete: ${successCount}/${macro.steps.length} steps enhanced`);

  return enrichedMacro;
}

/**
 * Type guard: check if action is semantic vs coordinate-only.
 *
 * @param {object} action - Action to check
 * @returns {boolean} - True if action has semantic target
 */
function isSemanticAction(action) {
  return !!(
    action &&
    action.target &&
    action.target.role &&
    typeof action.target.label === 'string'
  );
}

/**
 * Get semantic target description for logging/display.
 *
 * @param {object} semanticAction - SemanticAction
 * @returns {string} - Human-readable description
 */
function getSemanticDescription(semanticAction) {
  if (!isSemanticAction(semanticAction)) {
    return 'coordinate-only action';
  }

  const { target } = semanticAction;
  const label = target.label || '(unlabeled)';
  return `${target.role}[${label}]`;
}

/**
 * Validate semantic action structure.
 *
 * @param {object} action - Action to validate
 * @returns {object} - {valid: boolean, errors: string[]}
 */
function validateSemanticAction(action) {
  const errors = [];

  if (!action) {
    errors.push('Action is null or undefined');
    return { valid: false, errors };
  }

  if (!action.type) {
    errors.push('Missing action type');
  }

  if (!action.target) {
    errors.push('Missing semantic target');
  } else {
    if (!action.target.role) errors.push('Missing target.role');
    if (action.target.label === undefined) errors.push('Missing target.label');
    if (!action.target.path) errors.push('Missing target.path');
  }

  if (!action.coordinates || !Array.isArray(action.coordinates) || action.coordinates.length !== 2) {
    errors.push('Missing or invalid fallback coordinates');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Merge semantic data into existing step.
 * Used during recording to enhance coordinate-based steps.
 *
 * @param {object} step - Existing step with coordinates
 * @param {object} semanticAction - Semantic action data
 * @returns {object} - Merged step
 */
function mergeSemanticIntoStep(step, semanticAction) {
  if (!semanticAction) {
    return step;
  }

  return {
    ...step,
    target: semanticAction.target,
    semanticConfidence: semanticAction.confidence,
    semanticCapturedAt: semanticAction.capturedAt,
  };
}

/**
 * Extract legacy coordinate from semantic action (for backward compatibility).
 *
 * @param {object} semanticAction - SemanticAction
 * @returns {object|null} - {x, y} or null
 */
function extractLegacyCoordinates(semanticAction) {
  if (!semanticAction) return null;

  if (Array.isArray(semanticAction.coordinates) && semanticAction.coordinates.length === 2) {
    return {
      x: semanticAction.coordinates[0],
      y: semanticAction.coordinates[1],
    };
  }

  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  coordinateToSemantic,
  semanticToCoordinate,
  enrichExistingMacro,
  isSemanticAction,
  getSemanticDescription,
  validateSemanticAction,
  mergeSemanticIntoStep,
  extractLegacyCoordinates,
};

/**
 * Hindsight Experience Replay (HER) Relabeler
 *
 * Extracts learning from failed trajectories by relabeling intermediate states.
 * Based on OpenAI's HER paper (Andrychowicz et al. 2017).
 *
 * Core insight: A failed trajectory often achieves intermediate sub-goals.
 * Example: "Open Safari and search for cats" fails at the search step,
 * but successfully achieved "Open Safari". By relabeling the goal as
 * "Open Safari", we extract a successful reflection from a failed trajectory.
 *
 * This is especially valuable for computer-use because:
 * - Many tasks are compositional (multi-step)
 * - Partial success provides learning signal
 * - Early steps are often reusable across tasks
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// HER RELABELING LOGIC
// ============================================================

/**
 * Extract intermediate successes from a failed trajectory.
 *
 * Identifies partial completion points and creates reflections for each.
 *
 * @param {object} trajectory - Failed trajectory object
 * @returns {array} - Array of synthetic reflections from intermediate successes
 */
function extractIntermediateSuccesses(trajectory) {
  if (!trajectory || trajectory.success) {
    return []; // HER only applies to failures
  }

  const reflections = [];
  const nodes = trajectory.nodes || [];

  // Find checkpoint nodes (verified intermediate states)
  const checkpoints = nodes.filter(n =>
    (n.flags || []).includes('checkpoint') ||
    (n.flags || []).includes('verified') ||
    (n.flags || []).includes('milestone')
  );

  if (checkpoints.length === 0) {
    // No explicit checkpoints, try to infer from action sequence
    return inferIntermediateGoals(trajectory);
  }

  // Create a reflection for each checkpoint reached
  for (let i = 0; i < checkpoints.length; i++) {
    const checkpoint = checkpoints[i];
    const subGoal = extractSubGoal(trajectory, checkpoint);

    if (!subGoal) continue;

    // Extract actions up to this checkpoint
    const checkpointIndex = nodes.indexOf(checkpoint);
    const subTrajectory = nodes.slice(0, checkpointIndex + 1);

    const reflection = {
      id: `ref-her-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      trajectoryId: `her-${trajectory.taskId || 'unknown'}`,
      taskDescription: subGoal,
      taskType: inferTaskTypeFromGoal(subGoal),
      outcome: 'success', // Relabeled as success
      iterations: subTrajectory.length,
      loopsDetected: 0,
      stagnationsDetected: 0,
      duration: checkpoint.relativeTime || 0,
      reflection: `Extracted from failed trajectory: achieved intermediate goal "${subGoal}"`,
      lessons: generateLessonsFromSubTrajectory(subTrajectory, subGoal),
      failurePoints: [],
      effectiveStrategies: [`Completed sub-goal in ${subTrajectory.length} steps`],
      timestamp: Date.now(),

      // Phase 1 additions
      source: 'her',
      confidence: 0.65, // Medium confidence (extracted from failure)
      sourceId: trajectory.taskId || 'unknown',
      originalGoal: trajectory.taskDescription,
      relabeledGoal: subGoal,
    };

    reflections.push(reflection);
  }

  console.log(`[HER] Extracted ${reflections.length} intermediate successes from failed trajectory ${trajectory.taskId}`);
  return reflections;
}

/**
 * Extract sub-goal description from checkpoint node.
 * Looks for checkpoint labels, comments, or action descriptions.
 */
function extractSubGoal(trajectory, checkpointNode) {
  // Try checkpoint label
  if (checkpointNode.checkpointLabel) {
    return checkpointNode.checkpointLabel;
  }

  // Try comment
  if (checkpointNode.comment) {
    return checkpointNode.comment;
  }

  // Try to infer from action
  const action = checkpointNode.action;
  if (typeof action === 'string') {
    return action;
  } else if (action && action.raw) {
    return action.raw;
  }

  return null;
}

/**
 * Infer intermediate goals from action sequence when no explicit checkpoints exist.
 * Uses heuristics to identify natural completion points.
 */
function inferIntermediateGoals(trajectory) {
  const reflections = [];
  const nodes = trajectory.nodes || [];

  // Heuristic 1: App launches (opening apps is a common sub-goal)
  const appLaunchNodes = nodes.filter(n => {
    const action = typeof n.action === 'string' ? n.action : (n.action?.raw || '');
    return /\b(open|launch|start)\b.*\b(app|application|safari|chrome|finder|terminal)\b/i.test(action);
  });

  for (const node of appLaunchNodes) {
    const action = typeof node.action === 'string' ? node.action : (node.action?.raw || '');
    const reflection = createSubGoalReflection(trajectory, node, action, 'app_launch');
    if (reflection) reflections.push(reflection);
  }

  // Heuristic 2: Navigation completions (reaching a specific location)
  const navNodes = nodes.filter(n => {
    const action = typeof n.action === 'string' ? n.action : (n.action?.raw || '');
    return /\b(navigate|goto|visit|open|access)\b.*\b(url|website|page|folder|directory)\b/i.test(action);
  });

  for (const node of navNodes) {
    const action = typeof node.action === 'string' ? node.action : (node.action?.raw || '');
    const reflection = createSubGoalReflection(trajectory, node, action, 'web_navigation');
    if (reflection) reflections.push(reflection);
  }

  console.log(`[HER] Inferred ${reflections.length} intermediate goals from action sequence`);
  return reflections;
}

/**
 * Create a reflection from an inferred sub-goal.
 */
function createSubGoalReflection(trajectory, node, subGoal, taskType) {
  const nodeIndex = (trajectory.nodes || []).indexOf(node);
  if (nodeIndex < 0) return null;

  const subTrajectory = (trajectory.nodes || []).slice(0, nodeIndex + 1);

  return {
    id: `ref-her-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    trajectoryId: `her-${trajectory.taskId || 'unknown'}`,
    taskDescription: subGoal,
    taskType,
    outcome: 'success',
    iterations: subTrajectory.length,
    loopsDetected: 0,
    stagnationsDetected: 0,
    duration: node.relativeTime || 0,
    reflection: `HER: extracted sub-goal from failed trajectory`,
    lessons: generateLessonsFromSubTrajectory(subTrajectory, subGoal),
    failurePoints: [],
    effectiveStrategies: [`Achieved intermediate goal in ${subTrajectory.length} actions`],
    timestamp: Date.now(),

    // Phase 1 additions
    source: 'her',
    confidence: 0.6,
    sourceId: trajectory.taskId || 'unknown',
    originalGoal: trajectory.taskDescription,
    relabeledGoal: subGoal,
  };
}

/**
 * Generate lessons from a sub-trajectory.
 */
function generateLessonsFromSubTrajectory(subTrajectory, subGoal) {
  const lessons = [];

  // Lesson 1: Action pattern
  const actionTypes = subTrajectory
    .map(n => {
      const action = typeof n.action === 'string' ? n.action : (n.action?.raw || '');
      return action.split(' ')[0]; // First word of action
    })
    .filter(Boolean);

  if (actionTypes.length > 0) {
    const uniqueActions = [...new Set(actionTypes)];
    if (uniqueActions.length === 1) {
      lessons.push(`Single action type (${uniqueActions[0]}) sufficient for this sub-goal`);
    } else {
      lessons.push(`Multi-step procedure: ${uniqueActions.slice(0, 3).join(', ')}`);
    }
  }

  // Lesson 2: Efficiency
  if (subTrajectory.length <= 3) {
    lessons.push(`Efficient completion: ${subTrajectory.length} actions`);
  } else if (subTrajectory.length > 10) {
    lessons.push(`Complex sub-goal requiring ${subTrajectory.length} actions`);
  }

  // Lesson 3: Sub-goal specific
  lessons.push(`Successfully achieved: ${subGoal}`);

  return lessons.slice(0, 3);
}

/**
 * Infer task type from sub-goal description.
 */
function inferTaskTypeFromGoal(goal) {
  const lower = goal.toLowerCase();

  if (/\b(open|launch|start)\b/.test(lower)) return 'app_launch';
  if (/\b(navigate|goto|visit|url)\b/.test(lower)) return 'web_navigation';
  if (/\b(click|press|select)\b.*\b(button|menu|icon)\b/.test(lower)) return 'ui_interaction';
  if (/\b(type|enter|input)\b/.test(lower)) return 'text_input';
  if (/\b(search|find)\b/.test(lower)) return 'search';
  if (/\b(close|quit|exit)\b/.test(lower)) return 'app_management';

  return 'general_interaction';
}

// ============================================================
// BATCH PROCESSING
// ============================================================

/**
 * Process all failed trajectories from a directory.
 * Extracts intermediate successes from each.
 *
 * @param {string} trajectoryDir - Directory containing trajectory JSON files
 * @returns {object} - { reflections: array, errors: array, stats: object }
 */
function processFailedTrajectories(trajectoryDir) {
  const reflections = [];
  const errors = [];
  let processedCount = 0;
  let failedCount = 0;

  try {
    if (!fs.existsSync(trajectoryDir)) {
      return {
        reflections: [],
        errors: [{ error: `Directory not found: ${trajectoryDir}` }],
        stats: { processed: 0, failed: 0, reflections: 0 },
      };
    }

    const files = fs.readdirSync(trajectoryDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(trajectoryDir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const trajectory = JSON.parse(content);

        // Skip successful trajectories
        if (trajectory.success) {
          continue;
        }

        failedCount++;
        const extracted = extractIntermediateSuccesses(trajectory);
        reflections.push(...extracted);
        processedCount++;

        console.log(`[HER] Processed ${file}: ${extracted.length} intermediate successes`);
      } catch (e) {
        errors.push({ file, error: e.message });
        console.error(`[HER] Error processing ${file}: ${e.message}`);
      }
    }

    console.log(`[HER] Batch complete: ${reflections.length} reflections from ${failedCount} failed trajectories`);

    return {
      reflections,
      errors,
      stats: {
        processed: processedCount,
        failed: failedCount,
        reflections: reflections.length,
        avgReflectionsPerFailure: failedCount > 0 ? +(reflections.length / failedCount).toFixed(2) : 0,
      },
    };
  } catch (e) {
    return {
      reflections: [],
      errors: [{ error: `Directory read failed: ${e.message}` }],
      stats: { processed: 0, failed: 0, reflections: 0 },
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  extractIntermediateSuccesses,
  processFailedTrajectories,
};

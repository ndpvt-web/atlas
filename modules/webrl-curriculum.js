/**
 * WebRL Curriculum Generator
 *
 * Self-evolving curriculum for computer-use tasks.
 * Based on WebRL (Pan et al. 2024) which achieved 42.4% success rate
 * (up from 4.8% baseline) by generating increasingly difficult task variations.
 *
 * Core mechanism:
 * 1. Assess difficulty of recent failed tasks
 * 2. Generate easier/same/harder variants of those tasks
 * 3. Create reflections assuming those variants were executed
 * 4. Optimal difficulty: tasks just beyond current capability (Vygotsky's ZPD)
 */

const https = require('https');
const crypto = require('crypto');

// ============================================================
// AI GATEWAY INTEGRATION
// ============================================================

const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = 'cc00f875633a4dca884e24f5ab6e0106';
const SONNET_PATH = '/api/v1/bedrock/model/claude-sonnet-4-6/invoke';

/**
 * Call AI Gateway Sonnet endpoint.
 */
function callSonnet(prompt, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2000,
      system: systemPrompt || undefined,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: SONNET_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': AI_GATEWAY_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error('Unexpected API response format'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// DIFFICULTY ASSESSMENT
// ============================================================

/**
 * Assess difficulty of a task description.
 * Returns a score 0-1 where 0 = trivial, 1 = very hard.
 *
 * Heuristics:
 * - Number of steps/actions required
 * - Precision requirements (exact coordinates, timing)
 * - Conditional logic (if/then/else)
 * - Error handling needs
 *
 * @param {string} taskDescription - Task description
 * @returns {number} - Difficulty score 0-1
 */
function assessDifficulty(taskDescription) {
  const lower = taskDescription.toLowerCase();
  let score = 0.3; // Base difficulty

  // Factor 1: Multi-step (0.1 per step, max 0.3)
  const stepIndicators = [' then ', ' after ', ' and then ', ' next ', ' finally '];
  for (const indicator of stepIndicators) {
    if (lower.includes(indicator)) score += 0.1;
  }

  // Factor 2: Conditionals (0.2 each)
  if (/\b(if|when|unless|only if)\b/.test(lower)) score += 0.2;
  if (/\b(else|otherwise|or)\b/.test(lower)) score += 0.1;

  // Factor 3: Precision requirements (0.15 each)
  if (/\b(exact|specific|particular|precise)\b/.test(lower)) score += 0.15;
  if (/\b(center|middle|top-right|bottom-left)\b/.test(lower)) score += 0.1;

  // Factor 4: Complex targets (0.1 each)
  if (/\b(menu|dropdown|context menu|right-click)\b/.test(lower)) score += 0.1;
  if (/\b(nested|deep|hierarchy|subfolder)\b/.test(lower)) score += 0.15;

  // Factor 5: Error handling (0.15)
  if (/\b(retry|wait for|ensure|verify|check)\b/.test(lower)) score += 0.15;

  // Factor 6: Multiple targets (0.1)
  if (/\b(all|each|every|multiple)\b/.test(lower)) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Assess difficulty of a task with failure mode context.
 *
 * @param {object} task - Task object with description and optional failure info
 * @returns {object} - { difficulty: number, failureMode: string, factors: array }
 */
function assessTaskDifficulty(task) {
  const baseDifficulty = assessDifficulty(task.taskDescription || task.description || '');

  // Boost difficulty if task failed
  let adjustedDifficulty = baseDifficulty;
  let failureMode = 'unknown';

  if (task.outcome === 'failure') {
    if (task.loopsDetected > 0) {
      failureMode = 'loop';
      adjustedDifficulty += 0.15;
    } else if (task.stagnationsDetected > 0) {
      failureMode = 'stagnation';
      adjustedDifficulty += 0.1;
    } else if (task.iterations > 20) {
      failureMode = 'complexity';
      adjustedDifficulty += 0.2;
    } else {
      failureMode = 'execution_error';
      adjustedDifficulty += 0.1;
    }
  }

  return {
    difficulty: Math.min(1, adjustedDifficulty),
    failureMode,
    baseDifficulty: +baseDifficulty.toFixed(2),
  };
}

// ============================================================
// TASK VARIANT GENERATION
// ============================================================

/**
 * Generate easier, same-difficulty, and harder variants of a failed task.
 *
 * @param {object} failedTask - Failed task reflection
 * @param {string} failureMode - Type of failure (loop, stagnation, complexity)
 * @returns {Promise<array>} - Array of task variant objects
 */
async function generateVariants(failedTask, failureMode) {
  const prompt = `You are a curriculum designer for a computer-use agent. Given a failed task, generate 3 variants:

FAILED TASK:
Description: "${failedTask.taskDescription}"
Type: ${failedTask.taskType}
Failure Mode: ${failureMode}
Iterations: ${failedTask.iterations}
Failure Points: ${(failedTask.failurePoints || []).join('; ')}

Generate 3 variants:
1. EASIER: Simplify the task (fewer steps, less precision, more forgiving)
2. SAME: Equivalent difficulty but different context
3. HARDER: More complex (more steps, more precision, additional constraints)

Respond in EXACTLY this JSON format (no other text):
{
  "variants": [
    {
      "difficulty": "easier",
      "task_description": "<simplified task>",
      "task_type": "${failedTask.taskType}",
      "rationale": "<why this is easier>"
    },
    {
      "difficulty": "same",
      "task_description": "<equivalent task>",
      "task_type": "${failedTask.taskType}",
      "rationale": "<why this is equivalent>"
    },
    {
      "difficulty": "harder",
      "task_description": "<more complex task>",
      "task_type": "${failedTask.taskType}",
      "rationale": "<why this is harder>"
    }
  ]
}

RULES:
- Keep the same task_type
- Easier: remove steps, broaden targets, reduce precision
- Same: change context (different app, different search term) but keep complexity
- Harder: add steps, narrow targets, add conditionals`;

  try {
    const response = await callSonnet(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[WebRL] No JSON in variant generation response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.variants || []).map(v => ({
      ...v,
      sourceTaskId: failedTask.id,
      estimatedDifficulty: assessDifficulty(v.task_description),
    }));
  } catch (e) {
    console.error(`[WebRL] Failed to generate variants: ${e.message}`);
    return [];
  }
}

/**
 * Generate synthetic reflections for task variants.
 * Assumes the variants were executed successfully with reasonable strategies.
 *
 * @param {array} variants - Array of task variants
 * @returns {array} - Array of synthetic reflections
 */
function createSyntheticReflections(variants) {
  const reflections = [];

  for (const variant of variants) {
    const reflection = {
      id: `ref-webrl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      trajectoryId: `webrl-${variant.sourceTaskId}`,
      taskDescription: variant.task_description,
      taskType: variant.task_type,
      outcome: 'success', // WebRL generates success scenarios
      iterations: estimateIterations(variant),
      loopsDetected: 0,
      stagnationsDetected: 0,
      duration: estimateDuration(variant),
      reflection: `WebRL curriculum variant (${variant.difficulty}): ${variant.rationale}`,
      lessons: generateLessonsForVariant(variant),
      failurePoints: [],
      effectiveStrategies: [`${variant.difficulty} variant completed successfully`],
      timestamp: Date.now(),

      // Phase 1 additions
      source: 'webrl',
      confidence: 0.65, // Medium confidence (synthetic but curriculum-guided)
      sourceId: variant.sourceTaskId,
      difficulty: variant.difficulty,
      estimatedDifficulty: variant.estimatedDifficulty,
    };

    reflections.push(reflection);
  }

  return reflections;
}

/**
 * Estimate iterations needed for a task variant.
 */
function estimateIterations(variant) {
  const difficulty = variant.estimatedDifficulty || 0.5;

  // Easier tasks: 2-5 iterations
  // Medium tasks: 5-12 iterations
  // Harder tasks: 12-25 iterations
  if (difficulty < 0.4) {
    return Math.floor(2 + Math.random() * 3);
  } else if (difficulty < 0.7) {
    return Math.floor(5 + Math.random() * 7);
  } else {
    return Math.floor(12 + Math.random() * 13);
  }
}

/**
 * Estimate duration for a task variant (milliseconds).
 */
function estimateDuration(variant) {
  const difficulty = variant.estimatedDifficulty || 0.5;

  // Easier: 5-15 seconds
  // Medium: 15-40 seconds
  // Harder: 40-90 seconds
  if (difficulty < 0.4) {
    return (5 + Math.random() * 10) * 1000;
  } else if (difficulty < 0.7) {
    return (15 + Math.random() * 25) * 1000;
  } else {
    return (40 + Math.random() * 50) * 1000;
  }
}

/**
 * Generate lessons for a task variant.
 */
function generateLessonsForVariant(variant) {
  const lessons = [];

  if (variant.difficulty === 'easier') {
    lessons.push('Simplified approach reduces complexity and error rate');
    lessons.push(`Easier variant: ${variant.rationale}`);
  } else if (variant.difficulty === 'same') {
    lessons.push('Equivalent tasks can be solved with similar strategies');
    lessons.push(`Same-difficulty variant: ${variant.rationale}`);
  } else if (variant.difficulty === 'harder') {
    lessons.push('Complex tasks require careful planning and verification');
    lessons.push(`Harder variant: ${variant.rationale}`);
  }

  return lessons;
}

// ============================================================
// CURRICULUM GENERATION
// ============================================================

/**
 * Generate a curriculum of tasks based on recent performance.
 * Focuses on tasks at the edge of current capability (optimal difficulty).
 *
 * @param {array} recentReflections - Recent task reflections (last 10-20)
 * @returns {Promise<object>} - { curriculum: array, stats: object }
 */
async function generateCurriculum(recentReflections) {
  // Filter to failures only
  const failures = recentReflections.filter(r => r.outcome === 'failure');

  if (failures.length === 0) {
    console.log('[WebRL] No recent failures, curriculum generation skipped');
    return { curriculum: [], stats: { failures: 0, variants: 0 } };
  }

  // Assess difficulty distribution
  const difficulties = failures.map(f => assessTaskDifficulty(f));
  const avgDifficulty = difficulties.reduce((sum, d) => sum + d.difficulty, 0) / difficulties.length;

  console.log(`[WebRL] Recent failures: ${failures.length}, avg difficulty: ${avgDifficulty.toFixed(2)}`);

  // Generate variants for each failed task
  const allVariants = [];
  for (const failure of failures) {
    const assessment = assessTaskDifficulty(failure);
    const variants = await generateVariants(failure, assessment.failureMode);
    allVariants.push(...variants);
  }

  // Filter to optimal difficulty range (current capability + 0.1 to 0.2)
  const optimalVariants = allVariants.filter(v => {
    const diff = v.estimatedDifficulty - avgDifficulty;
    return diff >= 0.05 && diff <= 0.25; // Slightly harder than current capability
  });

  // Create synthetic reflections for optimal variants
  const curriculum = createSyntheticReflections(optimalVariants);

  console.log(`[WebRL] Curriculum: ${curriculum.length} optimal-difficulty tasks (from ${allVariants.length} total variants)`);

  return {
    curriculum,
    stats: {
      failures: failures.length,
      variants: allVariants.length,
      optimal: optimalVariants.length,
      avgDifficulty: +avgDifficulty.toFixed(2),
    },
  };
}

/**
 * Generate task variants for specific task types that need more data.
 *
 * @param {array} failedTasks - Failed tasks in target categories
 * @param {number} variantsPerTask - Variants to generate per task (default 2)
 * @returns {Promise<array>} - Array of synthetic reflections
 */
async function generateForCategories(failedTasks, variantsPerTask = 2) {
  const allReflections = [];

  for (const task of failedTasks) {
    const assessment = assessTaskDifficulty(task);
    const variants = await generateVariants(task, assessment.failureMode);

    // Take first N variants (easier + same, skip harder)
    const selectedVariants = variants
      .filter(v => v.difficulty !== 'harder')
      .slice(0, variantsPerTask);

    const reflections = createSyntheticReflections(selectedVariants);
    allReflections.push(...reflections);
  }

  console.log(`[WebRL] Generated ${allReflections.length} reflections for category targets`);
  return allReflections;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  generateVariants,
  assessDifficulty,
  assessTaskDifficulty,
  generateCurriculum,
  generateForCategories,
};

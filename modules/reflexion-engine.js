/**
 * Reflexion Engine
 *
 * Self-reflection and counterfactual generation from existing reflections.
 * Implements the Reflexion pattern (Shinn et al. 2023) for synthetic data augmentation.
 *
 * Core idea: Given a real reflection, generate "what if" scenarios:
 * - What if the task parameters changed slightly?
 * - What if the environment state was different?
 * - What if the agent tried a different approach?
 *
 * This creates synthetic reflections that explore the task space without
 * requiring actual task execution.
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
// COUNTERFACTUAL GENERATION
// ============================================================

/**
 * Generate counterfactual reflections from an existing reflection.
 * Creates "what if" scenarios that explore variations.
 *
 * @param {object} reflection - Base reflection to vary
 * @param {number} scenarios - Number of counterfactuals to generate (default 3)
 * @returns {Promise<array>} - Array of synthetic reflection objects
 */
async function generateCounterfactuals(reflection, scenarios = 3) {
  if (!reflection || !reflection.lessons || reflection.lessons.length === 0) {
    return [];
  }

  const prompt = `You are generating counterfactual "what if" variations of a successful computer-use task reflection.

ORIGINAL REFLECTION:
Task: "${reflection.taskDescription}"
Type: ${reflection.taskType}
Outcome: ${reflection.outcome}
Lessons:
${reflection.lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Generate ${scenarios} counterfactual scenarios by varying ONE aspect:
1. Change task parameters (e.g., different app, different search query)
2. Change environment state (e.g., app already open, network offline)
3. Change approach (e.g., keyboard shortcuts instead of mouse clicks)

For each scenario, create a hypothetical reflection with:
- Modified task description
- Same task type (${reflection.taskType})
- Predicted outcome (success/failure)
- New lessons that would apply to that variation

Respond in EXACTLY this JSON format (no other text):
{
  "scenarios": [
    {
      "variation": "<brief description of what changed>",
      "task_description": "<modified task description>",
      "task_type": "${reflection.taskType}",
      "outcome": "success or failure",
      "lessons": ["<lesson 1>", "<lesson 2>"],
      "reflection": "<1 sentence summary>"
    }
  ]
}

RULES:
- Each scenario should explore a DIFFERENT dimension of variation
- Lessons must be generalizable (not task-specific)
- Keep the same task_type as the original
- Predict realistic outcomes based on the variation`;

  try {
    const response = await callSonnet(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Reflexion] No JSON in counterfactual response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const counterfactuals = [];

    for (const scenario of (parsed.scenarios || [])) {
      const synthetic = {
        id: `ref-reflexion-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        trajectoryId: `reflexion-${reflection.id}`,
        taskDescription: scenario.task_description || reflection.taskDescription,
        taskType: scenario.task_type || reflection.taskType,
        outcome: scenario.outcome || 'success',
        iterations: reflection.iterations, // Inherit from original
        loopsDetected: 0,
        stagnationsDetected: 0,
        duration: reflection.duration, // Inherit from original
        reflection: scenario.reflection || '',
        lessons: scenario.lessons || [],
        failurePoints: scenario.outcome === 'failure' ? ['Counterfactual failure scenario'] : [],
        effectiveStrategies: scenario.outcome === 'success' ? ['Counterfactual success scenario'] : [],
        timestamp: Date.now(),

        // Phase 1 additions
        source: 'reflexion',
        confidence: 0.7, // Lower than real trajectories
        sourceId: reflection.id,
        variation: scenario.variation || 'Unknown variation',
      };

      counterfactuals.push(synthetic);
    }

    console.log(`[Reflexion] Generated ${counterfactuals.length} counterfactuals from ${reflection.id}`);
    return counterfactuals;
  } catch (e) {
    console.error(`[Reflexion] Failed to generate counterfactuals: ${e.message}`);
    return [];
  }
}

/**
 * Batch generate counterfactuals from multiple reflections.
 *
 * @param {array} reflections - Array of base reflections
 * @param {number} scenariosPerReflection - Counterfactuals per reflection (default 2)
 * @returns {Promise<array>} - Array of all synthetic reflections
 */
async function batchReflexion(reflections, scenariosPerReflection = 2) {
  const allSynthetic = [];

  for (const reflection of reflections) {
    // Only generate counterfactuals from successful reflections
    if (reflection.outcome !== 'success') continue;

    // Skip if already synthetic
    if (reflection.source && reflection.source !== 'real') continue;

    try {
      const counterfactuals = await generateCounterfactuals(reflection, scenariosPerReflection);
      allSynthetic.push(...counterfactuals);
    } catch (e) {
      console.error(`[Reflexion] Error processing ${reflection.id}: ${e.message}`);
    }
  }

  console.log(`[Reflexion] Batch complete: ${allSynthetic.length} synthetic reflections from ${reflections.length} base reflections`);
  return allSynthetic;
}

/**
 * Generate targeted counterfactuals for specific task types.
 * Focuses on under-represented categories.
 *
 * @param {array} reflections - All reflections
 * @param {array} targetCategories - Task types to focus on
 * @param {number} scenariosPerReflection - Counterfactuals per reflection
 * @returns {Promise<array>} - Array of synthetic reflections
 */
async function generateTargeted(reflections, targetCategories, scenariosPerReflection = 3) {
  const filtered = reflections.filter(r =>
    r.outcome === 'success' &&
    targetCategories.includes(r.taskType) &&
    (!r.source || r.source === 'real')
  );

  if (filtered.length === 0) {
    console.log('[Reflexion] No successful real reflections found for target categories');
    return [];
  }

  console.log(`[Reflexion] Targeted generation: ${filtered.length} base reflections in categories [${targetCategories.join(', ')}]`);
  return batchReflexion(filtered, scenariosPerReflection);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  generateCounterfactuals,
  batchReflexion,
  generateTargeted,
};

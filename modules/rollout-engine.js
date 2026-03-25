/**
 * rollout-engine.js
 * Main rollout generation and selection engine for Phase 5 (BJudge-style Rollouts)
 * Orchestrates candidate generation, ranking, and selection using learning and trajectory data
 */

const https = require('https');
const learning = require('./learning.js');
const trajectory = require('./trajectory.js');
const actionJudge = require('./action-judge.js');
const candidateRanker = require('./candidate-ranker.js');

const AI_HOST = 'ai-gateway.happycapy.ai';
const AI_PATH = '/api/v1/chat/completions';
const AI_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
const AI_MODEL = 'anthropic/claude-sonnet-4-6';

// Statistics tracking
const stats = {
  candidatesGenerated: 0,
  selectionsMode: {},
  avgCandidatesPerRound: 0,
  totalRounds: 0,
  aiCallCount: 0,
  aiFailures: 0,
  fallbackCount: 0
};

/**
 * Call AI Gateway for LLM inference
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {object} options - Optional parameters
 * @returns {Promise<string>} - LLM response text
 */
async function callAIGateway(systemPrompt, userPrompt, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.7
    });

    const reqOptions = {
      hostname: AI_HOST,
      path: AI_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`AI Gateway returned ${res.statusCode}: ${data}`));
            return;
          }
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content);
        } catch (err) {
          reject(new Error(`Failed to parse AI response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI Gateway request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Generate candidate actions for the current state
 * @param {object} state - Current AXQueryResult from ax-grounding
 * @param {string} taskGoal - Description of the task goal
 * @param {number} rolloutCount - Number of candidates to generate
 * @returns {Promise<Array>} - Array of RolloutCandidate objects
 */
async function generateCandidates(state, taskGoal, rolloutCount) {
  console.log(`[RolloutEngine] Generating ${rolloutCount} candidates for task: ${taskGoal}`);

  try {
    stats.aiCallCount++;

    // Build context from current state
    const stateElements = state.elements || [];
    const elementSummary = stateElements.slice(0, 20).map(el =>
      `${el.role} "${el.label || el.value || 'unlabeled'}" at path ${el.path}`
    ).join('\n');

    const systemPrompt = `You are an action planning expert for macOS GUI automation. Generate diverse, viable action candidates that advance toward the goal.

Each candidate should be a semantic action with:
- type: 'click' | 'type' | 'key' | 'scroll'
- target: { role, label, path }
- value: (for type/key actions)
- expectedOutcome: what happens after this action
- confidence: 0-1 (your confidence this helps)

Return ONLY valid JSON array of ${rolloutCount} candidates, no other text.`;

    const userPrompt = `Task Goal: ${taskGoal}

Current State Elements:
${elementSummary}

Generate ${rolloutCount} diverse action candidates that could advance toward this goal. Consider different approaches and strategies.`;

    const response = await callAIGateway(systemPrompt, userPrompt, { maxTokens: 3000, temperature: 0.8 });

    // Parse response
    let candidates = [];
    try {
      // Extract JSON from response (may have markdown backticks)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        candidates = JSON.parse(jsonMatch[0]);
      } else {
        candidates = JSON.parse(response);
      }
    } catch (parseErr) {
      console.error(`[RolloutEngine] Failed to parse AI response: ${parseErr.message}`);
      stats.aiFailures++;
      stats.fallbackCount++;
      candidates = generateFallbackCandidates(state, taskGoal, rolloutCount);
    }

    // Validate and enrich candidates
    const enrichedCandidates = candidates.map((cand, idx) => {
      const cost = estimateActionCost(cand.type);
      return {
        action: {
          type: cand.type || 'click',
          target: cand.target || { role: 'unknown', label: '', path: '' },
          value: cand.value
        },
        expectedOutcome: cand.expectedOutcome || 'Unknown outcome',
        confidence: cand.confidence || 0.5,
        trajectoryEvidence: [],
        cost,
        judgeReasoning: ''
      };
    });

    stats.candidatesGenerated += enrichedCandidates.length;
    console.log(`[RolloutEngine] Generated ${enrichedCandidates.length} candidates`);

    return enrichedCandidates;

  } catch (err) {
    console.error(`[RolloutEngine] AI generation failed: ${err.message}`);
    stats.aiFailures++;
    stats.fallbackCount++;
    return generateFallbackCandidates(state, taskGoal, rolloutCount);
  }
}

/**
 * Generate fallback candidates using heuristics when AI is unavailable
 * @param {object} state - Current AXQueryResult
 * @param {string} taskGoal - Task description
 * @param {number} count - Number of candidates needed
 * @returns {Array} - Array of RolloutCandidate objects
 */
function generateFallbackCandidates(state, taskGoal, count) {
  console.log(`[RolloutEngine] Using fallback candidate generation`);

  const candidates = [];
  const elements = state.elements || [];

  // Prioritize buttons, text fields, and clickable elements
  const interactive = elements.filter(el =>
    el.role === 'AXButton' ||
    el.role === 'AXTextField' ||
    el.role === 'AXStaticText' ||
    (el.actions && el.actions.includes('AXPress'))
  );

  for (let i = 0; i < Math.min(count, interactive.length); i++) {
    const el = interactive[i];
    const actionType = el.role === 'AXTextField' ? 'type' : 'click';

    candidates.push({
      action: {
        type: actionType,
        target: {
          role: el.role,
          label: el.label || el.value || '',
          path: el.path
        },
        value: actionType === 'type' ? 'sample input' : undefined
      },
      expectedOutcome: `Interact with ${el.role} ${el.label || 'element'}`,
      confidence: 0.4,
      trajectoryEvidence: [],
      cost: estimateActionCost(actionType),
      judgeReasoning: 'Fallback heuristic selection'
    });
  }

  return candidates;
}

/**
 * Estimate action cost based on type
 * @param {string} actionType - Type of action
 * @returns {number} - Cost estimate (1-5)
 */
function estimateActionCost(actionType) {
  const costMap = {
    'click': 2,
    'type': 3,
    'key': 1,
    'scroll': 2,
    'drag': 4
  };
  return costMap[actionType] || 3;
}

/**
 * Rank candidates using multi-factor scoring
 * @param {Array} candidates - Array of RolloutCandidate objects
 * @param {object} options - Context for ranking
 * @returns {Promise<Array>} - Sorted candidates (best first)
 */
async function rankCandidates(candidates, options) {
  console.log(`[RolloutEngine] Ranking ${candidates.length} candidates`);

  const { trajectoryQuery, learningContext, taskGoal, currentState, executionHistory } = options;

  try {
    // Query trajectory for similar past situations
    const similarTrajectories = trajectoryQuery.findSimilar
      ? await trajectoryQuery.findSimilar(taskGoal, 10)
      : [];

    const successfulApproaches = trajectoryQuery.getSuccessfulApproaches
      ? await trajectoryQuery.getSuccessfulApproaches('general')
      : [];

    const failurePatterns = trajectoryQuery.getFailurePatterns
      ? await trajectoryQuery.getFailurePatterns('general')
      : [];

    // Query learning for relevant reflections
    const reflections = learningContext.queryReflections
      ? await learningContext.queryReflections(taskGoal, 10)
      : [];

    // Build context for action judge
    const judgeContext = {
      taskGoal,
      currentState,
      executionHistory: executionHistory || [],
      failureHistory: failurePatterns
    };

    // Score all candidates with action judge
    const judgeScores = await actionJudge.scoreBatch(candidates, judgeContext, reflections);

    // Build trajectory evidence map
    const trajectoryEvidence = new Map();
    candidates.forEach((cand, idx) => {
      const supporting = similarTrajectories.filter(traj =>
        traj.success && isActionSimilar(cand.action, traj)
      );
      trajectoryEvidence.set(idx, supporting);
      cand.trajectoryEvidence = supporting.map(t => t.taskId);
    });

    // Attach judge reasoning to candidates
    candidates.forEach((cand, idx) => {
      cand.judgeReasoning = judgeScores[idx].reasoning;
    });

    // Rank using composite scoring
    const ranked = candidateRanker.rank(candidates, trajectoryEvidence, judgeScores);

    console.log(`[RolloutEngine] Ranked candidates, top score: ${ranked[0]?.compositeScore?.toFixed(3)}`);

    return ranked;

  } catch (err) {
    console.error(`[RolloutEngine] Ranking failed: ${err.message}, using fallback`);
    stats.fallbackCount++;
    return candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }
}

/**
 * Check if action is similar to trajectory approach
 * @param {object} action - SemanticAction
 * @param {object} trajectory - Similar trajectory result
 * @returns {boolean} - True if similar
 */
function isActionSimilar(action, trajectory) {
  if (!trajectory.approach) return false;

  const approachLower = trajectory.approach.toLowerCase();
  const actionDesc = `${action.type} ${action.target?.label || ''}`.toLowerCase();

  // Simple keyword matching
  const keywords = actionDesc.split(/\s+/).filter(w => w.length > 3);
  return keywords.some(kw => approachLower.includes(kw));
}

/**
 * Select best candidate from ranked list
 * @param {Array} rankedCandidates - Sorted array of candidates
 * @returns {object|null} - Best candidate or null
 */
function selectBest(rankedCandidates) {
  if (!rankedCandidates || rankedCandidates.length === 0) {
    console.log(`[RolloutEngine] No candidates to select from`);
    return null;
  }

  const best = rankedCandidates[0];
  const score = best.compositeScore || best.confidence || 0;

  console.log(`[RolloutEngine] Selected best candidate: ${best.action.type} on ${best.action.target?.label || 'target'} (score: ${score.toFixed(3)})`);
  console.log(`[RolloutEngine] Reasoning: ${best.judgeReasoning}`);

  // Track selection mode
  const mode = best.action.type;
  stats.selectionsMode[mode] = (stats.selectionsMode[mode] || 0) + 1;
  stats.totalRounds++;
  stats.avgCandidatesPerRound = stats.candidatesGenerated / stats.totalRounds;

  return best;
}

/**
 * Determine rollout count based on task complexity
 * @param {string} taskComplexity - 'simple' | 'medium' | 'complex'
 * @returns {number} - Number of candidates to generate
 */
function determineRolloutCount(taskComplexity) {
  const complexityMap = {
    'simple': 3,
    'medium': 5,
    'complex': 8
  };

  const count = complexityMap[taskComplexity] || 5;
  console.log(`[RolloutEngine] Rollout count for ${taskComplexity} task: ${count}`);
  return count;
}

/**
 * Get rollout engine statistics
 * @returns {object} - Statistics object
 */
function getStats() {
  return {
    candidatesGenerated: stats.candidatesGenerated,
    selectionsMode: stats.selectionsMode,
    avgCandidatesPerRound: stats.avgCandidatesPerRound,
    totalRounds: stats.totalRounds,
    aiCallCount: stats.aiCallCount,
    aiFailures: stats.aiFailures,
    fallbackCount: stats.fallbackCount
  };
}

/**
 * Reset statistics (useful for testing)
 */
function resetStats() {
  stats.candidatesGenerated = 0;
  stats.selectionsMode = {};
  stats.avgCandidatesPerRound = 0;
  stats.totalRounds = 0;
  stats.aiCallCount = 0;
  stats.aiFailures = 0;
  stats.fallbackCount = 0;
}

module.exports = {
  generateCandidates,
  rankCandidates,
  selectBest,
  determineRolloutCount,
  getStats,
  resetStats
};

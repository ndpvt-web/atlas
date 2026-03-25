/**
 * action-judge.js
 * Behavior-aware judge using learning reflections
 * Scores candidates on goal alignment, safety, and progress markers
 */

const https = require('https');

const AI_HOST = 'ai-gateway.happycapy.ai';
const AI_PATH = '/api/v1/chat/completions';
const AI_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
const AI_MODEL = 'anthropic/claude-sonnet-4-6';

// Scoring weights
const WEIGHTS = {
  goalAlignment: 0.5,
  safetyCheck: 0.3,
  progressMarkers: 0.2
};

// Statistics tracking
const stats = {
  candidatesScored: 0,
  avgScore: 0,
  totalScore: 0,
  aiCallCount: 0,
  fallbackCount: 0,
  batchCount: 0
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
      max_tokens: options.maxTokens || 1500,
      temperature: options.temperature || 0.5
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
 * Score a single candidate action
 * @param {object} candidate - RolloutCandidate to score
 * @param {object} context - Execution context
 * @param {Array} reflections - Relevant reflections from learning
 * @returns {Promise<object>} - { score: 0-1, reasoning: string }
 */
async function scoreCandidate(candidate, context, reflections) {
  if (!candidate || !candidate.action) {
    return { score: 0.5, reasoning: 'No candidate provided', dimensions: { goalAlignment: 0.5, safetyCheck: 0.8, progressMarkers: 0.5 } };
  }
  if (!context) {
    context = { taskGoal: '', currentState: '', executionHistory: [], failureHistory: [] };
  }
  if (!Array.isArray(reflections)) {
    reflections = [];
  }

  console.log(`[ActionJudge] Scoring candidate: ${candidate.action.type} on ${candidate.action.target?.label}`);

  try {
    stats.aiCallCount++;

    const { taskGoal, currentState, executionHistory, failureHistory } = context;

    // Build reflection summary
    const reflectionSummary = reflections.slice(0, 5).map((r, idx) =>
      `${idx + 1}. ${r.reflection?.lessons?.join('; ') || 'No lessons'} (confidence: ${r.reflection?.confidence || 0})`
    ).join('\n');

    // Build failure pattern summary
    const failureSummary = (failureHistory || []).slice(0, 3).map(f =>
      `Pattern: ${f.pattern} (frequency: ${f.frequency})`
    ).join('\n');

    const systemPrompt = `You are an expert action evaluator for GUI automation. Score actions on three dimensions:

1. goalAlignment (0-1): Does this action directly advance toward the task goal?
2. safetyCheck (0-1): Is this action safe and unlikely to cause unintended side effects?
3. progressMarkers (0-1): Will this action produce measurable, observable progress?

Consider past reflections and failure patterns. Return ONLY valid JSON with this structure:
{
  "goalAlignment": 0.0-1.0,
  "safetyCheck": 0.0-1.0,
  "progressMarkers": 0.0-1.0,
  "reasoning": "Brief explanation"
}`;

    const userPrompt = `Task Goal: ${taskGoal}

Action to Score:
- Type: ${candidate.action.type}
- Target: ${candidate.action.target?.role} "${candidate.action.target?.label}"
- Value: ${candidate.action.value || 'N/A'}
- Expected Outcome: ${candidate.expectedOutcome}

Relevant Past Reflections:
${reflectionSummary || 'None'}

Known Failure Patterns:
${failureSummary || 'None'}

Execution History: ${executionHistory.length || 0} prior actions

Score this action on the three dimensions.`;

    const response = await callAIGateway(systemPrompt, userPrompt, { maxTokens: 800, temperature: 0.4 });

    // Parse scoring response
    let scoring = null;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        scoring = JSON.parse(jsonMatch[0]);
      } else {
        scoring = JSON.parse(response);
      }
    } catch (parseErr) {
      console.error(`[ActionJudge] Failed to parse scoring: ${parseErr.message}`);
      stats.fallbackCount++;
      return fallbackScore(candidate, context);
    }

    // Compute weighted composite score
    const score = (
      WEIGHTS.goalAlignment * (scoring.goalAlignment || 0.5) +
      WEIGHTS.safetyCheck * (scoring.safetyCheck || 0.8) +
      WEIGHTS.progressMarkers * (scoring.progressMarkers || 0.5)
    );

    const result = {
      score,
      reasoning: scoring.reasoning || 'LLM-based scoring',
      dimensions: {
        goalAlignment: scoring.goalAlignment || 0.5,
        safetyCheck: scoring.safetyCheck || 0.8,
        progressMarkers: scoring.progressMarkers || 0.5
      }
    };

    stats.candidatesScored++;
    stats.totalScore += score;
    stats.avgScore = stats.totalScore / stats.candidatesScored;

    return result;

  } catch (err) {
    console.error(`[ActionJudge] Scoring failed: ${err.message}`);
    stats.fallbackCount++;
    return fallbackScore(candidate, context);
  }
}

/**
 * Score all candidates in batch (sequentially with caching)
 * @param {Array} candidates - Array of RolloutCandidate objects
 * @param {object} context - Execution context
 * @param {Array} reflections - Relevant reflections from learning
 * @returns {Promise<Array>} - Array of { score, reasoning, dimensions }
 */
async function scoreBatch(candidates, context, reflections) {
  console.log(`[ActionJudge] Scoring batch of ${candidates.length} candidates`);
  stats.batchCount++;

  const scores = [];

  for (const candidate of candidates) {
    const score = await scoreCandidate(candidate, context, reflections);
    scores.push(score);
  }

  console.log(`[ActionJudge] Batch scoring complete, avg score: ${(scores.reduce((sum, s) => sum + s.score, 0) / scores.length).toFixed(3)}`);

  return scores;
}

/**
 * Fallback scoring using heuristics when AI is unavailable
 * @param {object} candidate - RolloutCandidate to score
 * @param {object} context - Execution context
 * @returns {object} - { score, reasoning, dimensions }
 */
function fallbackScore(candidate, context) {
  console.log(`[ActionJudge] Using fallback heuristic scoring`);

  // Heuristic scoring based on action type and confidence
  let goalAlignment = candidate.confidence || 0.5;
  let safetyCheck = 0.8; // Default to safe
  let progressMarkers = 0.6;

  // Adjust based on action type
  if (candidate.action.type === 'click') {
    progressMarkers = 0.7; // Clicks usually produce visible changes
  } else if (candidate.action.type === 'type') {
    progressMarkers = 0.8; // Typing shows immediate feedback
  } else if (candidate.action.type === 'key') {
    safetyCheck = 0.9; // Key presses generally safe
  }

  // Penalize high-cost actions slightly
  if (candidate.cost > 3) {
    safetyCheck *= 0.9;
  }

  const score = (
    WEIGHTS.goalAlignment * goalAlignment +
    WEIGHTS.safetyCheck * safetyCheck +
    WEIGHTS.progressMarkers * progressMarkers
  );

  return {
    score,
    reasoning: 'Fallback heuristic scoring (AI unavailable)',
    dimensions: { goalAlignment, safetyCheck, progressMarkers }
  };
}

/**
 * Load judge training data from reflections
 * @param {Array} reflections - Array of reflection objects
 * @returns {object} - { successPatterns, failurePatterns }
 */
function loadJudgeTrainingData(reflections) {
  console.log(`[ActionJudge] Loading training data from ${reflections.length} reflections`);

  const successPatterns = [];
  const failurePatterns = [];

  reflections.forEach(ref => {
    const refl = ref.reflection || ref;
    const lessons = refl.lessons || [];

    lessons.forEach(lesson => {
      const lessonLower = lesson.toLowerCase();

      if (lessonLower.includes('success') || lessonLower.includes('worked') || lessonLower.includes('effective')) {
        successPatterns.push({
          pattern: lesson,
          confidence: refl.confidence || 0.5,
          source: refl.taskId || 'unknown'
        });
      } else if (lessonLower.includes('fail') || lessonLower.includes('error') || lessonLower.includes('avoid')) {
        failurePatterns.push({
          pattern: lesson,
          confidence: refl.confidence || 0.5,
          source: refl.taskId || 'unknown'
        });
      }
    });
  });

  console.log(`[ActionJudge] Extracted ${successPatterns.length} success patterns, ${failurePatterns.length} failure patterns`);

  return { successPatterns, failurePatterns };
}

/**
 * Get judge statistics
 * @returns {object} - Statistics object
 */
function getJudgeStats() {
  return {
    candidatesScored: stats.candidatesScored,
    avgScore: stats.avgScore,
    aiCallCount: stats.aiCallCount,
    fallbackCount: stats.fallbackCount,
    batchCount: stats.batchCount
  };
}

/**
 * Reset statistics (useful for testing)
 */
function resetStats() {
  stats.candidatesScored = 0;
  stats.avgScore = 0;
  stats.totalScore = 0;
  stats.aiCallCount = 0;
  stats.fallbackCount = 0;
  stats.batchCount = 0;
}

module.exports = {
  scoreCandidate,
  scoreBatch,
  loadJudgeTrainingData,
  getJudgeStats,
  resetStats
};

/**
 * candidate-ranker.js
 * Multi-factor candidate ranking using trajectory evidence, judge scores, and cost
 * Composite scoring: 50% judge + 30% trajectory + 20% inverse cost
 */

// Statistics tracking
const stats = {
  rankingRuns: 0,
  avgCandidatesPerRun: 0,
  totalCandidatesRanked: 0,
  avgTopScore: 0,
  totalTopScore: 0
};

/**
 * Rank candidates using multi-factor composite scoring
 * @param {Array} candidates - Array of RolloutCandidate objects
 * @param {Map} trajectoryEvidence - Map of candidate index -> SimilarTrajectory[]
 * @param {Array} judgeScores - Array of { score, reasoning, dimensions }
 * @returns {Array} - Candidates sorted by composite score (descending)
 */
function rank(candidates, trajectoryEvidence, judgeScores) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }
  if (!trajectoryEvidence || typeof trajectoryEvidence.get !== 'function') {
    trajectoryEvidence = new Map();
  }
  if (!Array.isArray(judgeScores)) {
    judgeScores = [];
  }

  console.log(`[CandidateRanker] Ranking ${candidates.length} candidates`);

  // Compute composite scores
  const rankedCandidates = candidates.map((candidate, idx) => {
    const judgeScore = judgeScores[idx]?.score || 0.5;
    const evidence = trajectoryEvidence.get(idx) || [];
    const trajectorySupport = evidence.length;
    const cost = candidate.cost || 3;

    const compositeScore = computeCompositeScore(trajectorySupport, judgeScore, cost);

    return {
      ...candidate,
      compositeScore,
      trajectorySupport,
      judgeScore,
      judgeDetails: judgeScores[idx]
    };
  });

  // Sort descending by composite score
  rankedCandidates.sort((a, b) => b.compositeScore - a.compositeScore);

  // Update statistics
  stats.rankingRuns++;
  stats.totalCandidatesRanked += candidates.length;
  stats.avgCandidatesPerRun = stats.totalCandidatesRanked / stats.rankingRuns;

  if (rankedCandidates.length > 0) {
    const topScore = rankedCandidates[0].compositeScore;
    stats.totalTopScore += topScore;
    stats.avgTopScore = stats.totalTopScore / stats.rankingRuns;
  }

  console.log(`[CandidateRanker] Top candidate score: ${rankedCandidates[0].compositeScore.toFixed(3)}`);

  return rankedCandidates;
}

/**
 * Compute composite score from components
 * @param {number} trajectorySupport - Number of supporting past trajectories (0-5+)
 * @param {number} judgeScore - Judge score (0-1)
 * @param {number} cost - Action cost (1-5)
 * @returns {number} - Composite score (0-1)
 */
function computeCompositeScore(trajectorySupport, judgeScore, cost) {
  // Sanitize inputs: NaN/Infinity -> defaults
  if (!Number.isFinite(trajectorySupport)) trajectorySupport = 0;
  if (!Number.isFinite(judgeScore)) judgeScore = 0.5;
  if (!Number.isFinite(cost)) cost = 3;

  // Normalize trajectory support to 0-1 (saturate at 5)
  const trajectorySupportScore = Math.min(trajectorySupport / 5.0, 1.0);

  // Normalize cost to 0-1 (inverse, so lower cost = higher score)
  const costScore = 1.0 - ((cost - 1) / 4.0);

  // Weighted composite: 50% judge + 30% trajectory + 20% cost
  const composite = (
    0.5 * judgeScore +
    0.3 * trajectorySupportScore +
    0.2 * costScore
  );

  return Math.max(0, Math.min(1, composite)); // Clamp to [0, 1]
}

/**
 * Log detailed ranking decision
 * @param {Array} candidates - All ranked candidates
 * @param {object} selected - The selected candidate
 */
function logRankingDecision(candidates, selected) {
  console.log(`[CandidateRanker] ===== Ranking Decision =====`);
  console.log(`[CandidateRanker] Total candidates: ${candidates.length}`);

  if (selected) {
    console.log(`[CandidateRanker] Selected: ${selected.action.type} on ${selected.action.target?.label}`);
    console.log(`[CandidateRanker]   Composite: ${selected.compositeScore.toFixed(3)}`);
    console.log(`[CandidateRanker]   Judge: ${selected.judgeScore.toFixed(3)}`);
    console.log(`[CandidateRanker]   Trajectory Support: ${selected.trajectorySupport}`);
    console.log(`[CandidateRanker]   Cost: ${selected.cost}`);
    console.log(`[CandidateRanker]   Reasoning: ${selected.judgeReasoning || 'N/A'}`);
  }

  // Show top 3 candidates for comparison
  console.log(`[CandidateRanker] Top 3 candidates:`);
  candidates.slice(0, 3).forEach((cand, idx) => {
    console.log(`[CandidateRanker]   ${idx + 1}. ${cand.action.type} (score: ${cand.compositeScore.toFixed(3)}, judge: ${cand.judgeScore.toFixed(3)}, traj: ${cand.trajectorySupport}, cost: ${cand.cost})`);
  });

  console.log(`[CandidateRanker] ===========================`);
}

/**
 * Get ranker statistics
 * @returns {object} - Statistics object
 */
function getRankerStats() {
  return {
    rankingRuns: stats.rankingRuns,
    avgCandidatesPerRun: stats.avgCandidatesPerRun,
    totalCandidatesRanked: stats.totalCandidatesRanked,
    avgTopScore: stats.avgTopScore
  };
}

/**
 * Reset statistics (useful for testing)
 */
function resetStats() {
  stats.rankingRuns = 0;
  stats.avgCandidatesPerRun = 0;
  stats.totalCandidatesRanked = 0;
  stats.avgTopScore = 0;
  stats.totalTopScore = 0;
}

module.exports = {
  rank,
  computeCompositeScore,
  logRankingDecision,
  getRankerStats,
  resetStats
};

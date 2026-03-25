/**
 * Coverage Tracker
 *
 * Monitors distribution of reflections across task categories.
 * Identifies gaps where synthetic data generation should focus.
 *
 * Key metrics:
 * - Distribution histogram: reflections per task type
 * - Coverage gaps: categories below convergence threshold (5 examples)
 * - Diversity index: Shannon entropy of distribution
 */

// ============================================================
// DISTRIBUTION ANALYSIS
// ============================================================

/**
 * Compute distribution histogram from reflections.
 *
 * @param {array} reflections - Array of reflection objects
 * @returns {object} - { histogram: Map(taskType -> count), totalReflections: number, uniqueCategories: number }
 */
function getDistribution(reflections) {
  const histogram = new Map();

  for (const r of reflections) {
    const taskType = r.taskType || 'unknown';
    histogram.set(taskType, (histogram.get(taskType) || 0) + 1);
  }

  return {
    histogram,
    totalReflections: reflections.length,
    uniqueCategories: histogram.size,
  };
}

/**
 * Identify gaps: categories below convergence threshold.
 *
 * Convergence threshold = 5 reflections per category (from Reflexion paper).
 * Returns categories sorted by deficit (most under-represented first).
 *
 * @param {array} reflections - Array of reflection objects
 * @param {number} threshold - Minimum reflections per category (default 5)
 * @returns {array} - Array of { taskType, count, deficit } sorted by deficit DESC
 */
function getGaps(reflections, threshold = 5) {
  const { histogram } = getDistribution(reflections);
  const gaps = [];

  for (const [taskType, count] of histogram.entries()) {
    if (count < threshold) {
      gaps.push({
        taskType,
        count,
        deficit: threshold - count,
      });
    }
  }

  // Sort by deficit descending (most under-represented first)
  gaps.sort((a, b) => b.deficit - a.deficit);

  return gaps;
}

/**
 * Compute Shannon entropy of task type distribution.
 * Higher entropy = more diverse coverage.
 *
 * H = -sum(p_i * log2(p_i)) where p_i = proportion of category i
 * Maximum H = log2(N) where N = number of categories (uniform distribution)
 *
 * @param {array} reflections - Array of reflection objects
 * @returns {object} - { entropy: number, maxEntropy: number, normalized: number }
 */
function getDiversityIndex(reflections) {
  const { histogram, totalReflections } = getDistribution(reflections);

  if (totalReflections === 0 || histogram.size === 0) {
    return { entropy: 0, maxEntropy: 0, normalized: 0 };
  }

  let entropy = 0;
  for (const count of histogram.values()) {
    const p = count / totalReflections;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  const maxEntropy = Math.log2(histogram.size);
  const normalized = maxEntropy > 0 ? entropy / maxEntropy : 0;

  return {
    entropy: +entropy.toFixed(3),
    maxEntropy: +maxEntropy.toFixed(3),
    normalized: +normalized.toFixed(3),
  };
}

/**
 * Generate coverage report with detailed statistics.
 *
 * @param {array} reflections - Array of reflection objects
 * @returns {object} - Comprehensive coverage report
 */
function getCoverageReport(reflections) {
  const { histogram, totalReflections, uniqueCategories } = getDistribution(reflections);
  const gaps = getGaps(reflections, 5);
  const diversity = getDiversityIndex(reflections);

  // Compute convergence: % of categories with >= 5 examples
  const convergedCategories = Array.from(histogram.values()).filter(c => c >= 5).length;
  const convergenceRate = uniqueCategories > 0 ? convergedCategories / uniqueCategories : 0;

  // Distribution stats
  const counts = Array.from(histogram.values());
  const avgPerCategory = counts.length > 0 ? totalReflections / counts.length : 0;
  const maxPerCategory = counts.length > 0 ? Math.max(...counts) : 0;
  const minPerCategory = counts.length > 0 ? Math.min(...counts) : 0;

  // Top 5 most covered categories
  const topCategories = Array.from(histogram.entries())
    .map(([taskType, count]) => ({ taskType, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalReflections,
    uniqueCategories,
    convergedCategories,
    convergenceRate: +convergenceRate.toFixed(3),
    diversity,
    distribution: {
      avg: +avgPerCategory.toFixed(2),
      min: minPerCategory,
      max: maxPerCategory,
    },
    topCategories,
    gaps: gaps.slice(0, 10), // Top 10 gaps
    histogramArray: Array.from(histogram.entries()).map(([taskType, count]) => ({ taskType, count })),
  };
}

/**
 * Update distribution after ingesting new reflections.
 * Returns updated statistics.
 *
 * @param {array} allReflections - All reflections after ingestion
 * @returns {object} - Updated coverage report
 */
function updateDistribution(allReflections) {
  return getCoverageReport(allReflections);
}

/**
 * Recommend priority categories for synthetic data generation.
 * Uses weighted scoring: gap size + recency + diversity impact.
 *
 * @param {array} reflections - Array of reflection objects
 * @param {number} topN - Number of recommendations to return (default 5)
 * @returns {array} - Array of { taskType, priority, reason } sorted by priority DESC
 */
function recommendPriorities(reflections, topN = 5) {
  const { histogram } = getDistribution(reflections);
  const gaps = getGaps(reflections, 5);

  // Build priority scores
  const priorities = [];

  for (const gap of gaps) {
    let priority = 0;

    // Weight 1: Deficit size (0-5 points)
    priority += gap.deficit;

    // Weight 2: Recency (has recent examples = lower priority)
    const recentReflections = reflections.filter(r =>
      r.taskType === gap.taskType &&
      (Date.now() - (r.timestamp || 0)) < 7 * 24 * 60 * 60 * 1000 // 7 days
    );
    if (recentReflections.length === 0) {
      priority += 2; // Boost if no recent examples
    }

    // Weight 3: Diversity impact (categories with 0 examples get a boost)
    if (gap.count === 0) {
      priority += 3;
    }

    priorities.push({
      taskType: gap.taskType,
      priority: +priority.toFixed(2),
      currentCount: gap.count,
      deficit: gap.deficit,
      reason: gap.count === 0
        ? 'New category (no examples yet)'
        : `Only ${gap.count} example${gap.count === 1 ? '' : 's'}, need ${5} for convergence`,
    });
  }

  // Sort by priority DESC
  priorities.sort((a, b) => b.priority - a.priority);

  return priorities.slice(0, topN);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getDistribution,
  getGaps,
  getDiversityIndex,
  getCoverageReport,
  updateDistribution,
  recommendPriorities,
};

/**
 * Synthetic Data Pipeline Orchestrator
 *
 * Central coordinator for all 5 synthetic data generation strategies:
 * 1. VideoAgentTrek: Extract from screen recordings
 * 2. Reflexion: Counterfactual generation from existing reflections
 * 3. HER: Hindsight Experience Replay from failed trajectories
 * 4. WebRL: Self-evolving curriculum from recent failures
 * 5. Transfer: Cross-domain pattern application
 *
 * Provides unified interface for running individual strategies or full pipeline.
 */

const videoagent = require('./videoagent-adapter.js');
const reflexion = require('./reflexion-engine.js');
const her = require('./her-relabeler.js');
const webrl = require('./webrl-curriculum.js');
const transfer = require('./transfer-mapper.js');
const validator = require('./reflection-validator.js');
const coverage = require('./coverage-tracker.js');

// ============================================================
// STRATEGY RUNNERS
// ============================================================

/**
 * Run VideoAgentTrek: process video dataset into reflections.
 *
 * @param {string} videoPath - Path to video files or directory
 * @param {number} batchSize - Max videos to process (default 10)
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runVideoAgentTrek(videoPath, batchSize = 10) {
  console.log(`[Pipeline] VideoAgentTrek: processing ${videoPath}`);

  try {
    const result = videoagent.processDirectory(videoPath);

    // Limit by batch size
    const reflections = result.reflections.slice(0, batchSize);

    return {
      strategy: 'videoagent',
      reflections,
      stats: {
        processed: reflections.length,
        errors: result.errors.length,
      },
    };
  } catch (e) {
    console.error(`[Pipeline] VideoAgentTrek error: ${e.message}`);
    return { strategy: 'videoagent', reflections: [], stats: { processed: 0, errors: 1 } };
  }
}

/**
 * Run Reflexion: counterfactual generation from existing reflections.
 *
 * @param {array} baseReflections - Existing real reflections to vary
 * @param {number} scenariosPerReflection - Counterfactuals per reflection (default 2)
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runReflexion(baseReflections, scenariosPerReflection = 2) {
  console.log(`[Pipeline] Reflexion: generating from ${baseReflections.length} base reflections`);

  try {
    const reflections = await reflexion.batchReflexion(baseReflections, scenariosPerReflection);

    return {
      strategy: 'reflexion',
      reflections,
      stats: {
        baseReflections: baseReflections.length,
        generated: reflections.length,
      },
    };
  } catch (e) {
    console.error(`[Pipeline] Reflexion error: ${e.message}`);
    return { strategy: 'reflexion', reflections: [], stats: { baseReflections: 0, generated: 0 } };
  }
}

/**
 * Run HER: extract from failed trajectories.
 *
 * @param {string} trajectoryPath - Path to trajectory directory (default /tmp/capy-trajectories)
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runHER(trajectoryPath = '/tmp/capy-trajectories') {
  console.log(`[Pipeline] HER: processing failed trajectories from ${trajectoryPath}`);

  try {
    const result = her.processFailedTrajectories(trajectoryPath);

    return {
      strategy: 'her',
      reflections: result.reflections,
      stats: result.stats,
    };
  } catch (e) {
    console.error(`[Pipeline] HER error: ${e.message}`);
    return { strategy: 'her', reflections: [], stats: { processed: 0, failed: 0, reflections: 0 } };
  }
}

/**
 * Run WebRL: self-evolving curriculum from failed tasks.
 *
 * @param {array} failedTasks - Recent failed task reflections
 * @param {number} variantsPerTask - Variants per task (default 2)
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runWebRL(failedTasks, variantsPerTask = 2) {
  console.log(`[Pipeline] WebRL: generating curriculum from ${failedTasks.length} failures`);

  try {
    const result = await webrl.generateCurriculum(failedTasks);

    return {
      strategy: 'webrl',
      reflections: result.curriculum,
      stats: result.stats,
    };
  } catch (e) {
    console.error(`[Pipeline] WebRL error: ${e.message}`);
    return { strategy: 'webrl', reflections: [], stats: { failures: 0, variants: 0 } };
  }
}

/**
 * Run Transfer: cross-domain pattern mapping.
 *
 * @param {array} sourceReflections - Reflections to extract patterns from
 * @param {array} targetDomains - Task types to transfer to (default: auto-detect gaps)
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runTransfer(sourceReflections, targetDomains = null) {
  // Auto-detect target domains from gaps if not specified
  if (!targetDomains) {
    const gaps = coverage.getGaps(sourceReflections, 5);
    targetDomains = gaps.slice(0, 5).map(g => g.taskType);
  }

  console.log(`[Pipeline] Transfer: mapping to domains [${targetDomains.join(', ')}]`);

  try {
    const result = await transfer.batchTransfer(sourceReflections, targetDomains);

    return {
      strategy: 'transfer',
      reflections: result.reflections,
      stats: result.stats,
    };
  } catch (e) {
    console.error(`[Pipeline] Transfer error: ${e.message}`);
    return { strategy: 'transfer', reflections: [], stats: { sourcesProcessed: 0, patternsExtracted: 0, reflectionsGenerated: 0 } };
  }
}

// ============================================================
// FULL PIPELINE
// ============================================================

/**
 * Run the full synthetic data generation pipeline.
 * Executes all 5 strategies and returns validated reflections.
 *
 * @param {object} config - Pipeline configuration
 *   @param {array} config.realReflections - Existing real reflections
 *   @param {string} config.videoPath - Path to video dataset (optional)
 *   @param {string} config.trajectoryPath - Path to trajectory directory (optional)
 *   @param {boolean} config.enableVideoAgent - Run VideoAgentTrek (default false)
 *   @param {boolean} config.enableReflexion - Run Reflexion (default true)
 *   @param {boolean} config.enableHER - Run HER (default true)
 *   @param {boolean} config.enableWebRL - Run WebRL (default true)
 *   @param {boolean} config.enableTransfer - Run Transfer (default true)
 *   @param {number} config.qualityThreshold - Minimum quality score (default 0.6)
 * @returns {Promise<object>} - { reflections: array, rejected: array, strategyResults: array, summary: object }
 */
async function runFullPipeline(config) {
  const {
    realReflections = [],
    videoPath = null,
    trajectoryPath = '/tmp/capy-trajectories',
    enableVideoAgent = false,
    enableReflexion = true,
    enableHER = true,
    enableWebRL = true,
    enableTransfer = true,
    qualityThreshold = 0.6,
  } = config;

  console.log('[Pipeline] Starting full synthetic data generation pipeline');
  console.log(`[Pipeline] Base: ${realReflections.length} real reflections`);

  const strategyResults = [];
  const allSynthetic = [];

  // Strategy 1: VideoAgentTrek
  if (enableVideoAgent && videoPath) {
    const result = await runVideoAgentTrek(videoPath, 10);
    strategyResults.push(result);
    allSynthetic.push(...result.reflections);
    console.log(`[Pipeline] VideoAgentTrek: ${result.reflections.length} reflections`);
  }

  // Strategy 2: Reflexion (counterfactuals from successful reflections)
  if (enableReflexion && realReflections.length > 0) {
    const successful = realReflections.filter(r => r.outcome === 'success');
    const result = await runReflexion(successful.slice(0, 10), 2); // Limit to 10 base reflections
    strategyResults.push(result);
    allSynthetic.push(...result.reflections);
    console.log(`[Pipeline] Reflexion: ${result.reflections.length} reflections`);
  }

  // Strategy 3: HER (intermediate successes from failures)
  if (enableHER) {
    const result = await runHER(trajectoryPath);
    strategyResults.push(result);
    allSynthetic.push(...result.reflections);
    console.log(`[Pipeline] HER: ${result.reflections.length} reflections`);
  }

  // Strategy 4: WebRL (curriculum from recent failures)
  if (enableWebRL && realReflections.length > 0) {
    const recentFailures = realReflections
      .filter(r => r.outcome === 'failure')
      .slice(0, 5); // Last 5 failures

    if (recentFailures.length > 0) {
      const result = await runWebRL(recentFailures, 2);
      strategyResults.push(result);
      allSynthetic.push(...result.reflections);
      console.log(`[Pipeline] WebRL: ${result.reflections.length} reflections`);
    }
  }

  // Strategy 5: Transfer (cross-domain mapping)
  if (enableTransfer && realReflections.length > 0) {
    const result = await runTransfer(realReflections.slice(0, 10), null); // Auto-detect gaps
    strategyResults.push(result);
    allSynthetic.push(...result.reflections);
    console.log(`[Pipeline] Transfer: ${result.reflections.length} reflections`);
  }

  // Quality validation
  console.log(`[Pipeline] Validating ${allSynthetic.length} synthetic reflections (threshold: ${qualityThreshold})`);

  const validated = [];
  const rejected = [];

  for (const reflection of allSynthetic) {
    const validation = validator.validateReflection(reflection);

    if (validation.isValid && validation.quality >= qualityThreshold) {
      validated.push({
        ...reflection,
        validationScore: validation.quality,
        validationBreakdown: validation.breakdown,
      });
    } else {
      rejected.push({
        id: reflection.id,
        source: reflection.source,
        reason: validation.reason,
        quality: validation.quality,
      });
    }
  }

  // Check for duplicates against real reflections
  console.log('[Pipeline] Checking for duplicates');
  const deduplicated = [];
  const duplicates = [];

  for (const reflection of validated) {
    const dupCheck = validator.checkDuplicate(reflection, realReflections, 0.9);

    if (dupCheck.isDuplicate) {
      duplicates.push({
        id: reflection.id,
        matchedId: dupCheck.matchedId,
        similarity: dupCheck.similarity,
      });
    } else {
      deduplicated.push(reflection);
    }
  }

  console.log('[Pipeline] Pipeline complete');
  console.log(`[Pipeline] Generated: ${allSynthetic.length} total`);
  console.log(`[Pipeline] Validated: ${validated.length} (quality >= ${qualityThreshold})`);
  console.log(`[Pipeline] Deduplicated: ${deduplicated.length} (similarity < 0.9)`);
  console.log(`[Pipeline] Rejected: ${rejected.length} (quality issues)`);
  console.log(`[Pipeline] Duplicates: ${duplicates.length} (too similar to existing)`);

  return {
    reflections: deduplicated,
    rejected,
    duplicates,
    strategyResults,
    summary: {
      generated: allSynthetic.length,
      validated: validated.length,
      deduplicated: deduplicated.length,
      rejected: rejected.length,
      duplicates: duplicates.length,
      byStrategy: strategyResults.map(r => ({
        strategy: r.strategy,
        count: r.reflections.length,
      })),
    },
  };
}

/**
 * Run targeted synthetic generation for specific categories.
 * Focuses all strategies on under-represented task types.
 *
 * @param {array} realReflections - Existing reflections
 * @param {array} targetCategories - Task types to focus on
 * @returns {Promise<object>} - { reflections: array, stats: object }
 */
async function runTargetedGeneration(realReflections, targetCategories) {
  console.log(`[Pipeline] Targeted generation for categories: [${targetCategories.join(', ')}]`);

  const allSynthetic = [];

  // Strategy 1: Reflexion targeted
  const successfulInCategories = realReflections.filter(r =>
    r.outcome === 'success' && targetCategories.includes(r.taskType)
  );

  if (successfulInCategories.length > 0) {
    const result = await reflexion.generateTargeted(realReflections, targetCategories, 3);
    allSynthetic.push(...result);
    console.log(`[Pipeline] Reflexion targeted: ${result.length} reflections`);
  }

  // Strategy 2: WebRL targeted
  const failedInCategories = realReflections.filter(r =>
    r.outcome === 'failure' && targetCategories.includes(r.taskType)
  );

  if (failedInCategories.length > 0) {
    const result = await webrl.generateForCategories(failedInCategories, 2);
    allSynthetic.push(...result);
    console.log(`[Pipeline] WebRL targeted: ${result.length} reflections`);
  }

  // Strategy 3: Transfer to target categories
  const sourceReflections = realReflections.filter(r =>
    r.outcome === 'success' && !targetCategories.includes(r.taskType)
  );

  if (sourceReflections.length > 0) {
    const result = await transfer.batchTransfer(sourceReflections.slice(0, 5), targetCategories);
    allSynthetic.push(...result.reflections);
    console.log(`[Pipeline] Transfer targeted: ${result.reflections.length} reflections`);
  }

  // Quality validation
  const validated = [];
  for (const reflection of allSynthetic) {
    const validation = validator.validateReflection(reflection);
    if (validation.isValid && validation.quality >= 0.6) {
      validated.push({
        ...reflection,
        validationScore: validation.quality,
      });
    }
  }

  // Deduplication
  const deduplicated = [];
  for (const reflection of validated) {
    const dupCheck = validator.checkDuplicate(reflection, realReflections, 0.9);
    if (!dupCheck.isDuplicate) {
      deduplicated.push(reflection);
    }
  }

  console.log(`[Pipeline] Targeted complete: ${deduplicated.length} validated reflections for [${targetCategories.join(', ')}]`);

  return {
    reflections: deduplicated,
    stats: {
      generated: allSynthetic.length,
      validated: validated.length,
      deduplicated: deduplicated.length,
      targetCategories,
    },
  };
}

/**
 * Generate progress report for pipeline execution.
 * Tracks coverage improvements before and after synthetic data ingestion.
 *
 * @param {array} beforeReflections - Reflections before pipeline
 * @param {array} afterReflections - Reflections after pipeline
 * @returns {object} - Progress report with metrics
 */
function generateProgressReport(beforeReflections, afterReflections) {
  const beforeReport = coverage.getCoverageReport(beforeReflections);
  const afterReport = coverage.getCoverageReport(afterReflections);

  const improvement = {
    reflections: {
      before: beforeReport.totalReflections,
      after: afterReport.totalReflections,
      added: afterReport.totalReflections - beforeReport.totalReflections,
    },
    categories: {
      before: beforeReport.uniqueCategories,
      after: afterReport.uniqueCategories,
      added: afterReport.uniqueCategories - beforeReport.uniqueCategories,
    },
    convergence: {
      before: beforeReport.convergenceRate,
      after: afterReport.convergenceRate,
      improvement: +(afterReport.convergenceRate - beforeReport.convergenceRate).toFixed(3),
    },
    diversity: {
      before: beforeReport.diversity.normalized,
      after: afterReport.diversity.normalized,
      improvement: +(afterReport.diversity.normalized - beforeReport.diversity.normalized).toFixed(3),
    },
  };

  return {
    improvement,
    beforeReport,
    afterReport,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Individual strategy runners
  runVideoAgentTrek,
  runReflexion,
  runHER,
  runWebRL,
  runTransfer,

  // Full pipeline
  runFullPipeline,
  runTargetedGeneration,
  generateProgressReport,
};

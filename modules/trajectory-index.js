/**
 * Trajectory Index - Fast cross-trajectory querying with keyword similarity
 *
 * Provides indexing and search capabilities for trajectory queries:
 *   - Build searchable index over all saved trajectories
 *   - TF-IDF keyword similarity matching
 *   - Query by task type (extracted from description)
 *   - In-memory cache with optional disk persistence
 *
 * NO external dependencies - pure Node.js stdlib implementation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TRAJECTORY_DIR = path.join(os.homedir(), '.capy-trajectories');
const INDEX_PATH = '/tmp/capy-trajectory-index.json';

// Rebuild index after this many new trajectories
const REBUILD_THRESHOLD = 10;

// Rebuild index after this time (milliseconds)
const REBUILD_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

class TrajectoryIndex {
  constructor() {
    this.index = null;
    this.lastBuildTime = null;
    this.trajectoriesSinceRebuild = 0;
  }

  /**
   * Build index from all trajectories in storage.
   * Returns stats about the index.
   */
  buildIndex() {
    console.log('[TrajectoryIndex] Building index...');
    const startTime = Date.now();

    const index = {
      trajectories: {},   // taskId -> metadata
      taskTypes: {},      // taskType -> [taskIds]
      keywords: {},       // word -> { taskId: frequency }
      stats: {
        totalTrajectories: 0,
        successCount: 0,
        failureCount: 0,
        avgDuration: 0,
        indexedAt: Date.now(),
      }
    };

    // Scan trajectory directory
    if (!fs.existsSync(TRAJECTORY_DIR)) {
      console.log('[TrajectoryIndex] No trajectory directory found, creating empty index');
      this.index = index;
      this.lastBuildTime = Date.now();
      return index.stats;
    }

    const taskDirs = fs.readdirSync(TRAJECTORY_DIR);
    let totalDuration = 0;

    for (const taskId of taskDirs) {
      const trajPath = path.join(TRAJECTORY_DIR, taskId, 'trajectory.json');
      if (!fs.existsSync(trajPath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(trajPath, 'utf8'));

        const success = data.success === true;
        const duration = data.endTime ? (data.endTime - data.startTime) : 0;
        const stepCount = (data.nodes || []).length;
        const taskDescription = data.taskDescription || '';

        // Extract metadata
        const metadata = {
          taskId,
          taskDescription,
          success,
          duration,
          stepCount,
          startTime: data.startTime,
          branches: data.branches || [],
          loopsDetected: data.loopsDetected || 0,
          stagnationsDetected: data.stagnationsDetected || 0,
          surprisesDetected: data.surprisesDetected || 0,
        };

        index.trajectories[taskId] = metadata;
        index.stats.totalTrajectories++;
        if (success) index.stats.successCount++;
        else index.stats.failureCount++;
        totalDuration += duration;

        // Extract task type
        const taskType = this._extractTaskType(taskDescription);
        if (!index.taskTypes[taskType]) {
          index.taskTypes[taskType] = [];
        }
        index.taskTypes[taskType].push(taskId);

        // Index keywords from task description and branches
        const text = [
          taskDescription,
          ...(data.branches || []).map(b => `${b.approach || ''} ${b.lesson || ''}`),
        ].join(' ');

        const keywords = this._extractKeywords(text);
        for (const word of keywords) {
          if (!index.keywords[word]) {
            index.keywords[word] = {};
          }
          index.keywords[word][taskId] = (index.keywords[word][taskId] || 0) + 1;
        }

      } catch (e) {
        console.error(`[TrajectoryIndex] Failed to index ${taskId}:`, e.message);
      }
    }

    index.stats.avgDuration = index.stats.totalTrajectories > 0
      ? totalDuration / index.stats.totalTrajectories
      : 0;

    this.index = index;
    this.lastBuildTime = Date.now();
    this.trajectoriesSinceRebuild = 0;

    const elapsed = Date.now() - startTime;
    console.log(`[TrajectoryIndex] Built index: ${index.stats.totalTrajectories} trajectories in ${elapsed}ms`);

    // Persist to disk (optional)
    this._saveIndex();

    return index.stats;
  }

  /**
   * Query by task description similarity using TF-IDF keyword matching.
   * Returns ranked results.
   */
  queryBySimilarity(taskDescription, limit = 10) {
    if (!this.index) {
      this._loadOrBuildIndex();
    }

    const queryKeywords = this._extractKeywords(taskDescription);
    if (queryKeywords.length === 0) return [];

    // Compute TF-IDF similarity for each trajectory
    const scores = [];
    for (const [taskId, metadata] of Object.entries(this.index.trajectories)) {
      const score = this._computeSimilarity(queryKeywords, taskId);
      if (score > 0) {
        scores.push({
          taskId,
          similarity: score,
          metadata,
        });
      }
    }

    // Sort by similarity (highest first) and limit
    scores.sort((a, b) => b.similarity - a.similarity);
    return scores.slice(0, limit);
  }

  /**
   * Query by task type (exact match).
   * Returns all trajectories of the given task type.
   */
  queryByTaskType(taskType) {
    if (!this.index) {
      this._loadOrBuildIndex();
    }

    const taskIds = this.index.taskTypes[taskType] || [];
    return taskIds.map(taskId => ({
      taskId,
      metadata: this.index.trajectories[taskId],
    }));
  }

  /**
   * Get statistics about the index.
   */
  getStatistics() {
    if (!this.index) {
      this._loadOrBuildIndex();
    }
    return this.index.stats;
  }

  /**
   * Add new trajectory to index (incremental).
   * Triggers rebuild if threshold is reached.
   */
  addTrajectory(taskId, trajectory) {
    if (!this.index) {
      this._loadOrBuildIndex();
    }

    this.trajectoriesSinceRebuild++;

    // Check if rebuild needed
    const timeSinceRebuild = Date.now() - this.lastBuildTime;
    if (this.trajectoriesSinceRebuild >= REBUILD_THRESHOLD ||
        timeSinceRebuild >= REBUILD_INTERVAL) {
      console.log('[TrajectoryIndex] Rebuild threshold reached, rebuilding index...');
      this.buildIndex();
    }
  }

  /**
   * Force rebuild of the index.
   */
  rebuild() {
    return this.buildIndex();
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Load index from disk or build if not found.
   */
  _loadOrBuildIndex() {
    if (fs.existsSync(INDEX_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        this.index = data.index;
        this.lastBuildTime = data.lastBuildTime;
        this.trajectoriesSinceRebuild = data.trajectoriesSinceRebuild || 0;
        console.log('[TrajectoryIndex] Loaded index from disk');
        return;
      } catch (e) {
        console.error('[TrajectoryIndex] Failed to load index:', e.message);
      }
    }

    // Build new index
    this.buildIndex();
  }

  /**
   * Save index to disk.
   */
  _saveIndex() {
    if (!this.index) return;

    try {
      const data = {
        index: this.index,
        lastBuildTime: this.lastBuildTime,
        trajectoriesSinceRebuild: this.trajectoriesSinceRebuild,
      };
      fs.writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[TrajectoryIndex] Failed to save index:', e.message);
    }
  }

  /**
   * Extract task type from description.
   * Task type = first verb + first noun (e.g., "open browser", "fill form").
   */
  _extractTaskType(description) {
    if (!description) return 'unknown';

    const words = description.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Simple heuristic: first two meaningful words
    if (words.length >= 2) {
      return `${words[0]} ${words[1]}`;
    } else if (words.length === 1) {
      return words[0];
    }

    return 'unknown';
  }

  /**
   * Extract keywords from text (nouns, verbs, meaningful words).
   * Filters out common stop words.
   */
  _extractKeywords(text) {
    if (!text) return [];

    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'it',
    ]);

    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    return words;
  }

  /**
   * Compute TF-IDF similarity between query keywords and a trajectory.
   * Returns a score in range [0, 1].
   */
  _computeSimilarity(queryKeywords, taskId) {
    const N = Object.keys(this.index.trajectories).length; // Total documents
    if (N === 0) return 0;

    let score = 0;
    let normalization = 0;

    for (const word of queryKeywords) {
      const docFreq = this.index.keywords[word] || {};
      const tf = docFreq[taskId] || 0; // Term frequency in this trajectory

      if (tf > 0) {
        // IDF = log(N / df) where df = number of docs containing the word
        const df = Object.keys(docFreq).length;
        const idf = Math.log(N / df);
        const tfidf = tf * idf;

        score += tfidf;
      }

      normalization += 1; // Simple normalization by query length
    }

    // Normalize to [0, 1]
    return normalization > 0 ? Math.min(1, score / normalization / 5) : 0;
  }
}

// Singleton instance
const indexInstance = new TrajectoryIndex();

/**
 * Build index from all trajectories in storage.
 */
function buildIndex() {
  return indexInstance.buildIndex();
}

/**
 * Query for similar tasks by description.
 */
function queryBySimilarity(taskDescription, limit = 10) {
  return indexInstance.queryBySimilarity(taskDescription, limit);
}

/**
 * Query by task type.
 */
function queryByTaskType(taskType) {
  return indexInstance.queryByTaskType(taskType);
}

/**
 * Get index statistics.
 */
function getStatistics() {
  return indexInstance.getStatistics();
}

/**
 * Add new trajectory to index (incremental).
 */
function addTrajectory(taskId, trajectory) {
  return indexInstance.addTrajectory(taskId, trajectory);
}

/**
 * Force rebuild of the index.
 */
function rebuild() {
  return indexInstance.rebuild();
}

module.exports = {
  buildIndex,
  queryBySimilarity,
  queryByTaskType,
  getStatistics,
  addTrajectory,
  rebuild,
};

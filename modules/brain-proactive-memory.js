/**
 * Brain Proactive Memory Module - Anticipatory Context Loading for Jarvis
 *
 * Extends brain-memory.js with mem0-inspired proactive capabilities:
 * - Session context tracking (topics, entities, patterns across messages)
 * - Predictive memory loading (anticipate what memories are needed BEFORE the LLM call)
 * - Access pattern analysis (learn which memories follow which queries)
 * - Memory importance evolution (importance changes based on usage, not just time)
 * - Context compression (reduce token usage by pre-selecting relevant memories)
 *
 * Research basis: mem0 (+26% accuracy, 90% token reduction), FadeMem (adaptive decay),
 * EverMemOS (MemCells hierarchy), ProAgentBench (proactive timing prediction).
 *
 * Axioms:
 * - Builds ON TOP of existing brain-memory.js (does not replace it)
 * - Uses same SQLite DB (brain.db)
 * - Must predict relevant memories in <50ms (before LLM call)
 * - Session context persists within a session, resets between sessions
 * - Max 15-20 proactive memories per prediction (token budget)
 *
 * @module brain-proactive-memory
 */

const crypto = require('crypto');

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_PROACTIVE_MEMORIES = 15;
const MAX_SESSION_TOPICS = 20;
const PREDICTION_TIMEOUT_MS = 50; // Target: predict in <50ms
const ACCESS_LOG_RETENTION_DAYS = 30;
const PATTERN_MIN_FREQUENCY = 3; // Min co-occurrences to form a pattern

// ============================================================================
// SESSION CONTEXT TRACKER
// ============================================================================

/**
 * Tracks the evolving context within a conversation session.
 * Used to predict what memories will be needed next.
 */
class SessionContext {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.messages = []; // Last N messages
    this.topics = new Map(); // topic -> {count, lastSeen}
    this.entities = new Map(); // entity -> {count, lastSeen}
    this.loadedMemoryIds = new Set(); // Already loaded memories
    this.startedAt = Date.now();
  }

  /**
   * Add a message and extract topics/entities.
   */
  addMessage(message, role = 'user') {
    this.messages.push({ text: message, role, timestamp: Date.now() });
    if (this.messages.length > 10) this.messages.shift();

    // Extract topics and entities from message
    const tokens = this.extractKeyTerms(message);
    const now = Date.now();

    for (const term of tokens) {
      if (term.length > 3) {
        const existing = this.topics.get(term) || { count: 0, lastSeen: 0 };
        this.topics.set(term, { count: existing.count + 1, lastSeen: now });
      }
    }

    // Trim old topics
    if (this.topics.size > MAX_SESSION_TOPICS) {
      const sorted = [...this.topics.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
      this.topics = new Map(sorted.slice(0, MAX_SESSION_TOPICS));
    }
  }

  /**
   * Extract key terms from a message for topic tracking.
   * Simple but effective: lowercase, remove stop words, keep meaningful terms.
   */
  extractKeyTerms(text) {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
      'in', 'with', 'to', 'for', 'of', 'not', 'no', 'can', 'will', 'do',
      'does', 'did', 'has', 'have', 'had', 'was', 'were', 'been', 'be',
      'are', 'am', 'this', 'that', 'these', 'those', 'it', 'its', 'my',
      'your', 'his', 'her', 'our', 'their', 'what', 'how', 'when', 'where',
      'who', 'why', 'just', 'also', 'very', 'really', 'about', 'from',
      'some', 'any', 'all', 'each', 'every', 'both', 'few', 'more',
      'most', 'other', 'into', 'over', 'such', 'than', 'too', 'only',
      'same', 'so', 'then', 'now', 'here', 'there', 'should', 'could',
      'would', 'may', 'might', 'must', 'shall', 'need', 'want', 'like',
      'please', 'hey', 'hi', 'hello', 'thanks', 'thank', 'yes', 'no',
      'okay', 'sure', 'right', 'well', 'you', 'me', 'him', 'them', 'us',
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  /**
   * Get top topics for prediction query.
   */
  getTopTopics(n = 5) {
    return [...this.topics.entries()]
      .sort((a, b) => {
        // Score by recency * frequency
        const scoreA = a[1].count * (1 / (1 + (Date.now() - a[1].lastSeen) / 60000));
        const scoreB = b[1].count * (1 / (1 + (Date.now() - b[1].lastSeen) / 60000));
        return scoreB - scoreA;
      })
      .slice(0, n)
      .map(([topic]) => topic);
  }

  /**
   * Get a compact representation for memory prediction.
   */
  getPredictionQuery() {
    const recentMessage = this.messages.length > 0
      ? this.messages[this.messages.length - 1].text
      : '';
    const topTopics = this.getTopTopics(5);
    return `${recentMessage} ${topTopics.join(' ')}`.trim();
  }
}

// ============================================================================
// PROACTIVE MEMORY ENGINE
// ============================================================================

class ProactiveMemoryEngine {
  constructor(db, brainMemory) {
    this.db = db;
    this.brainMemory = brainMemory; // Reference to brain-memory module
    this.sessions = new Map(); // sessionId -> SessionContext
    this.accessPatterns = new Map(); // "queryHash" -> Set<memoryId>
    this.initialized = false;
  }

  /**
   * Initialize: create additional tables for access pattern tracking.
   */
  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        session_id TEXT,
        query_hash TEXT,
        query_terms TEXT,
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        was_useful INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS memory_cooccurrence (
        query_hash TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        frequency INTEGER DEFAULT 1,
        last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (query_hash, memory_id)
      );

      CREATE TABLE IF NOT EXISTS memory_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        predicted_ids TEXT NOT NULL,
        actually_used_ids TEXT,
        prediction_ms INTEGER,
        hit_rate REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_access_log_query ON memory_access_log(query_hash);
      CREATE INDEX IF NOT EXISTS idx_access_log_time ON memory_access_log(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_cooccurrence_freq ON memory_cooccurrence(frequency DESC);
    `);

    // Load access patterns into memory
    await this.loadAccessPatterns();

    this.initialized = true;
    console.log('[proactive-memory] Initialized. Patterns loaded.');
  }

  /**
   * Load frequent co-occurrence patterns into memory for fast prediction.
   */
  async loadAccessPatterns() {
    const patterns = await this.db.all(
      `SELECT query_hash, memory_id, frequency FROM memory_cooccurrence
       WHERE frequency >= ? ORDER BY frequency DESC LIMIT 5000`,
      [PATTERN_MIN_FREQUENCY]
    );

    this.accessPatterns.clear();
    for (const p of patterns) {
      if (!this.accessPatterns.has(p.query_hash)) {
        this.accessPatterns.set(p.query_hash, new Set());
      }
      this.accessPatterns.get(p.query_hash).add(p.memory_id);
    }

    console.log(`[proactive-memory] Loaded ${this.accessPatterns.size} access patterns.`);
  }

  /**
   * Get or create a session context.
   */
  getSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionContext(sessionId));
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Record that a user message arrived. Updates session context.
   */
  trackMessage(sessionId, message, role = 'user') {
    const session = this.getSession(sessionId);
    session.addMessage(message, role);
  }

  /**
   * CORE: Predict relevant memories BEFORE the LLM call.
   * Returns pre-loaded context that should be injected into the system prompt.
   *
   * Three parallel prediction strategies:
   * 1. Pattern-based: query_hash -> co-occurring memories
   * 2. Topic-based: session topics -> hybrid search
   * 3. Frequency-based: most accessed memories recently
   */
  async predictMemories(sessionId, userMessage, limit = MAX_PROACTIVE_MEMORIES) {
    const startTime = Date.now();
    const session = this.getSession(sessionId);
    session.addMessage(userMessage, 'user');

    const candidates = new Map(); // memoryId -> score

    // Strategy 1: Pattern-based prediction (from access log co-occurrences)
    const queryHash = this.hashQuery(userMessage);
    const patternMemories = this.accessPatterns.get(queryHash);
    if (patternMemories) {
      for (const memId of patternMemories) {
        candidates.set(memId, (candidates.get(memId) || 0) + 3.0); // High confidence
      }
    }

    // Also check partial query hashes (individual key terms)
    const terms = session.extractKeyTerms(userMessage);
    for (const term of terms.slice(0, 5)) {
      const termHash = this.hashQuery(term);
      const termMemories = this.accessPatterns.get(termHash);
      if (termMemories) {
        for (const memId of termMemories) {
          candidates.set(memId, (candidates.get(memId) || 0) + 1.0);
        }
      }
    }

    // Strategy 2: Topic-based (use session context for enhanced query)
    const predictionQuery = session.getPredictionQuery();
    if (this.brainMemory && predictionQuery) {
      try {
        const searchResults = await this.brainMemory.searchMemory(predictionQuery, {
          limit: Math.ceil(limit * 1.5),
          memoryTypes: ['episodic', 'semantic', 'preference'],
        });

        if (searchResults && Array.isArray(searchResults)) {
          for (let i = 0; i < searchResults.length; i++) {
            const mem = searchResults[i];
            const score = 2.0 * (1 - i / searchResults.length); // Decay by rank
            candidates.set(mem.id, (candidates.get(mem.id) || 0) + score);
          }
        }
      } catch {
        // Search failed, continue with other strategies
      }
    }

    // Strategy 3: Frequency-based (recently popular memories)
    try {
      const frequentMemories = await this.db.all(
        `SELECT memory_id, COUNT(*) as freq FROM memory_access_log
         WHERE accessed_at > ? GROUP BY memory_id ORDER BY freq DESC LIMIT 10`,
        [Math.floor(Date.now() / 1000) - 7 * 86400] // Last 7 days
      );

      for (const fm of frequentMemories) {
        candidates.set(fm.memory_id, (candidates.get(fm.memory_id) || 0) + 0.5);
      }
    } catch {
      // Access log might not have data yet
    }

    // Filter out already-loaded memories
    for (const loadedId of session.loadedMemoryIds) {
      candidates.delete(loadedId);
    }

    // Sort by score, take top N
    const topIds = [...candidates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    // Fetch full memory content
    let memories = [];
    if (topIds.length > 0 && this.db) {
      const placeholders = topIds.map(() => '?').join(',');
      memories = await this.db.all(
        `SELECT id, content, memory_type, importance_score, accessed_at
         FROM brain_memories WHERE id IN (${placeholders}) AND importance_score >= 0.05`,
        topIds
      );

      // Mark as loaded in session
      for (const mem of memories) {
        session.loadedMemoryIds.add(mem.id);
      }
    }

    const predictionMs = Date.now() - startTime;

    // Log prediction for accuracy tracking
    try {
      await this.db.run(
        `INSERT INTO memory_predictions (session_id, predicted_ids, prediction_ms, created_at)
         VALUES (?, ?, ?, ?)`,
        [sessionId, JSON.stringify(topIds), predictionMs, Math.floor(Date.now() / 1000)]
      );
    } catch {
      // Non-critical
    }

    return {
      memories,
      prediction_ms: predictionMs,
      strategies_used: {
        pattern_matches: patternMemories ? patternMemories.size : 0,
        topic_search: memories.length,
        frequency: candidates.size,
      },
      total_candidates: candidates.size,
    };
  }

  /**
   * Record which memories the LLM actually used (for learning patterns).
   * Called AFTER the LLM response, with the memory IDs it referenced.
   */
  async recordMemoryUsage(sessionId, queryText, usedMemoryIds) {
    const queryHash = this.hashQuery(queryText);
    const now = Math.floor(Date.now() / 1000);

    for (const memId of usedMemoryIds) {
      // Log access
      await this.db.run(
        `INSERT INTO memory_access_log (memory_id, session_id, query_hash, query_terms, accessed_at)
         VALUES (?, ?, ?, ?, ?)`,
        [memId, sessionId, queryHash, queryText.substring(0, 200), now]
      );

      // Update co-occurrence
      await this.db.run(
        `INSERT INTO memory_cooccurrence (query_hash, memory_id, frequency, last_seen)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(query_hash, memory_id) DO UPDATE SET
           frequency = frequency + 1,
           last_seen = excluded.last_seen`,
        [queryHash, memId, now]
      );

      // Also index by individual terms
      const terms = new SessionContext('tmp').extractKeyTerms(queryText);
      for (const term of terms.slice(0, 5)) {
        const termHash = this.hashQuery(term);
        await this.db.run(
          `INSERT INTO memory_cooccurrence (query_hash, memory_id, frequency, last_seen)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(query_hash, memory_id) DO UPDATE SET
             frequency = frequency + 1,
             last_seen = excluded.last_seen`,
          [termHash, memId, now]
        );
      }
    }

    // Update in-memory patterns
    if (!this.accessPatterns.has(queryHash)) {
      this.accessPatterns.set(queryHash, new Set());
    }
    for (const memId of usedMemoryIds) {
      this.accessPatterns.get(queryHash).add(memId);
    }
  }

  /**
   * Format predicted memories as context string for system prompt injection.
   */
  formatAsContext(memories) {
    if (!memories || memories.length === 0) return '';

    const lines = memories.map(m => {
      const typeTag = m.memory_type === 'preference' ? '[PREF]'
        : m.memory_type === 'semantic' ? '[FACT]'
        : '[MEM]';
      return `${typeTag} ${m.content}`;
    });

    return `\n## Proactive Context (predicted relevant memories)\n${lines.join('\n')}`;
  }

  /**
   * Clean up old access logs.
   */
  async cleanupAccessLogs() {
    const cutoff = Math.floor(Date.now() / 1000) - ACCESS_LOG_RETENTION_DAYS * 86400;
    const result = await this.db.run(
      'DELETE FROM memory_access_log WHERE accessed_at < ?',
      [cutoff]
    );
    return { deleted: result.changes };
  }

  /**
   * Get prediction accuracy stats.
   */
  async getStats() {
    const stats = await this.db.get(`
      SELECT
        COUNT(*) as total_predictions,
        AVG(prediction_ms) as avg_prediction_ms,
        AVG(hit_rate) as avg_hit_rate
      FROM memory_predictions
      WHERE created_at > ?`,
      [Math.floor(Date.now() / 1000) - 86400] // Last 24 hours
    );

    const patternCount = this.accessPatterns.size;
    const sessionCount = this.sessions.size;

    return {
      ...stats,
      pattern_count: patternCount,
      active_sessions: sessionCount,
    };
  }

  /**
   * Hash a query for pattern matching.
   */
  hashQuery(text) {
    const normalized = text.toLowerCase().trim().replace(/\s+/g, ' ');
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 12);
  }

  /**
   * Clean up expired sessions.
   */
  cleanupSessions(maxAge = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.startedAt > maxAge) {
        this.sessions.delete(id);
      }
    }
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

function mountProactiveMemoryRoutes(app, engine) {
  /**
   * POST /brain/memory/predict - Predict relevant memories for a query
   */
  app.post('/brain/memory/predict', async (req, res) => {
    try {
      const { session_id, message, limit } = req.body;
      if (!message) {
        return res.status(400).json({ success: false, error: 'Missing message field' });
      }

      const result = await engine.predictMemories(
        session_id || `anon-${Date.now()}`,
        message,
        limit || MAX_PROACTIVE_MEMORIES
      );

      res.json({
        success: true,
        count: result.memories.length,
        prediction_ms: result.prediction_ms,
        strategies: result.strategies_used,
        memories: result.memories,
        context_string: engine.formatAsContext(result.memories),
      });
    } catch (err) {
      console.error('[proactive-memory] Predict error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /brain/memory/record-usage - Record which memories the LLM used
   */
  app.post('/brain/memory/record-usage', async (req, res) => {
    try {
      const { session_id, query, used_memory_ids } = req.body;
      if (!query || !used_memory_ids) {
        return res.status(400).json({ success: false, error: 'Missing query or used_memory_ids' });
      }

      await engine.recordMemoryUsage(session_id || 'unknown', query, used_memory_ids);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /brain/memory/proactive-stats - Prediction accuracy stats
   */
  app.get('/brain/memory/proactive-stats', async (req, res) => {
    try {
      const stats = await engine.getStats();
      res.json({ success: true, ...stats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[proactive-memory] Routes mounted: /brain/memory/predict, /brain/memory/record-usage');
}

// ============================================================================
// TOOL SCHEMAS (for brain.js)
// ============================================================================

const PROACTIVE_MEMORY_TOOL_SCHEMAS = [
  {
    name: 'memory_predict',
    description: 'Predict and pre-load relevant memories based on the current conversation context. Returns memories the user is likely to need. Use at the start of complex conversations to pre-load context.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The current message or topic to predict context for.',
        },
        session_id: {
          type: 'string',
          description: 'Session ID for context continuity.',
        },
        limit: {
          type: 'number',
          description: 'Max memories to return (default 15).',
        },
      },
      required: ['message'],
    },
  },
];

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  ProactiveMemoryEngine,
  SessionContext,
  mountProactiveMemoryRoutes,
  PROACTIVE_MEMORY_TOOL_SCHEMAS,
};

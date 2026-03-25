const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const BRAIN_DB_PATH = process.env.BRAIN_DB_PATH || './brain/brain.db';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const EMBEDDING_DIM = parseInt(process.env.BRAIN_EMBEDDING_DIM) || 384;
const PRUNE_DAYS = parseInt(process.env.BRAIN_MEMORY_PRUNE_DAYS) || 90;
const MIN_IMPORTANCE = parseFloat(process.env.BRAIN_MEMORY_MIN_IMPORTANCE) || 0.05;
const RRF_K = 60; // Reciprocal Rank Fusion constant

let db = null;
let vecEnabled = false;

function log(...args) {
  console.log('[brain-memory]', ...args);
}

function error(...args) {
  console.error('[brain-memory]', ...args);
}

// Initialize database with schema
function initDatabase() {
  try {
    // Ensure directory exists
    const dbDir = path.dirname(BRAIN_DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      log(`Created database directory: ${dbDir}`);
    }

    db = new Database(BRAIN_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache

    // Try to load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);
      vecEnabled = true;
      log('sqlite-vec extension loaded successfully');
    } catch (err) {
      error('Failed to load sqlite-vec (degrading to FTS5 only):', err.message);
      vecEnabled = false;
    }

    // Create main memories table
    db.exec(`
      CREATE TABLE IF NOT EXISTS brain_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL CHECK(memory_type IN ('episodic','semantic','preference')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        access_count INTEGER NOT NULL DEFAULT 0,
        importance_score REAL NOT NULL DEFAULT 1.0,
        session_id TEXT,
        source TEXT,
        metadata TEXT
      );
    `);

    // Create FTS5 full-text search table
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS brain_memories_fts USING fts5(
        content,
        content=brain_memories,
        content_rowid=id,
        tokenize='porter unicode61'
      );
    `);

    // Create triggers to keep FTS5 in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS brain_memories_ai AFTER INSERT ON brain_memories BEGIN
        INSERT INTO brain_memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS brain_memories_ad AFTER DELETE ON brain_memories BEGIN
        DELETE FROM brain_memories_fts WHERE rowid = old.id;
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS brain_memories_au AFTER UPDATE ON brain_memories BEGIN
        UPDATE brain_memories_fts SET content = new.content WHERE rowid = new.id;
      END;
    `);

    // Create vector table if extension loaded
    if (vecEnabled) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS brain_memories_vec USING vec0(
            embedding float[${EMBEDDING_DIM}]
          );
        `);
        log(`Vector table initialized (${EMBEDDING_DIM} dimensions)`);
      } catch (err) {
        error('Failed to create vector table:', err.message);
        vecEnabled = false;
      }
    }

    // Create indices for common queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_type ON brain_memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_accessed_at ON brain_memories(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_importance ON brain_memories(importance_score);
      CREATE INDEX IF NOT EXISTS idx_session ON brain_memories(session_id);
    `);

    log(`Database initialized at ${BRAIN_DB_PATH}`);
    log(`Vector search: ${vecEnabled ? 'ENABLED' : 'DISABLED'}`);

    return true;
  } catch (err) {
    error('Failed to initialize database:', err);
    throw err;
  }
}

// Generate embedding via Voyage AI or fallback
async function generateEmbedding(text, inputType = 'document') {
  if (VOYAGE_API_KEY) {
    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${VOYAGE_API_KEY}`
        },
        body: JSON.stringify({
          input: [text],
          model: 'voyage-3.5-lite',
          input_type: inputType
        })
      });

      if (!response.ok) {
        throw new Error(`Voyage API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    } catch (err) {
      error('Voyage API failed, using fallback:', err.message);
      return generateFallbackEmbedding(text);
    }
  } else {
    return generateFallbackEmbedding(text);
  }
}

// Batch embedding generation
async function generateEmbeddings(texts, inputType = 'document') {
  if (texts.length === 0) return [];

  if (VOYAGE_API_KEY) {
    try {
      // Voyage API supports up to 128 texts per batch, we use 100 to be safe
      const batchSize = 100;
      const embeddings = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const response = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VOYAGE_API_KEY}`
          },
          body: JSON.stringify({
            input: batch,
            model: 'voyage-3.5-lite',
            input_type: inputType
          })
        });

        if (!response.ok) {
          throw new Error(`Voyage API error: ${response.status}`);
        }

        const data = await response.json();
        embeddings.push(...data.data.map(d => d.embedding));
      }

      return embeddings;
    } catch (err) {
      error('Batch Voyage API failed, using fallback:', err.message);
      return texts.map(t => generateFallbackEmbedding(t));
    }
  } else {
    return texts.map(t => generateFallbackEmbedding(t));
  }
}

// Fallback embedding using TF-IDF + random projection (degraded but functional)
function generateFallbackEmbedding(text) {
  // Simple tokenization
  const tokens = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);

  // Create deterministic "embedding" using hashing
  const embedding = new Array(EMBEDDING_DIM).fill(0);

  for (const token of tokens) {
    // Use token hash to determine which dimensions to activate
    const hash = crypto.createHash('md5').update(token).digest();
    for (let i = 0; i < 4; i++) {
      const idx = hash.readUInt8(i * 4) % EMBEDDING_DIM;
      const sign = (hash.readUInt8(i * 4 + 1) % 2) * 2 - 1;
      embedding[idx] += sign / Math.sqrt(tokens.length);
    }
  }

  // Normalize
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

// Calculate cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Store a new memory with embedding
async function storeMemory(content, memoryType = 'episodic', options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');

    const {
      sessionId = null,
      source = null,
      metadata = null,
      importanceScore = 1.0
    } = options;

    // Validate memory type
    if (!['episodic', 'semantic', 'preference'].includes(memoryType)) {
      throw new Error(`Invalid memory type: ${memoryType}`);
    }

    // Generate embedding
    const embedding = await generateEmbedding(content, 'document');

    // Insert into main table
    const insertStmt = db.prepare(`
      INSERT INTO brain_memories (content, memory_type, session_id, source, metadata, importance_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      content,
      memoryType,
      sessionId,
      source,
      metadata ? JSON.stringify(metadata) : null,
      importanceScore
    );

    const memoryId = Number(result.lastInsertRowid);

    // Insert into vector table if enabled
    if (vecEnabled) {
      try {
        const vecInsertStmt = db.prepare(`
          INSERT INTO brain_memories_vec (rowid, embedding)
          VALUES (?, ?)
        `);
        vecInsertStmt.run(BigInt(memoryId), JSON.stringify(embedding));
      } catch (err) {
        error(`Failed to insert vector for memory ${memoryId}:`, err.message);
      }
    }

    log(`Stored ${memoryType} memory #${memoryId}: "${content.substring(0, 50)}..."`);

    return {
      id: memoryId,
      content,
      memoryType,
      importanceScore
    };
  } catch (err) {
    error('Failed to store memory:', err);
    throw err;
  }
}

// Hybrid search using FTS5 + Vector + RRF
async function hybridSearch(query, options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');
    if (!query || typeof query !== 'string' || query.trim().length === 0) return [];

    const {
      limit = 10,
      memoryTypes = ['episodic', 'semantic', 'preference'],
      minImportance = MIN_IMPORTANCE,
      sessionId = null
    } = options;

    const typeFilter = memoryTypes.map(() => '?').join(',');
    let whereClause = `memory_type IN (${typeFilter}) AND importance_score >= ?`;
    const params = [...memoryTypes, minImportance];

    if (sessionId) {
      whereClause += ' AND session_id = ?';
      params.push(sessionId);
    }

    // Step 1: FTS5 keyword search (BM25 ranked)
    // Sanitize query for FTS5: quote each token to prevent operator interpretation
    // e.g. "capy-bridge" would be interpreted as "capy MINUS bridge" without quoting
    const fts5Query = query
      .replace(/["“”]/g, '') // strip quotes
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => '"' + t.replace(/"/g, '') + '"')
      .join(' ');

    const ftsQuery = db.prepare(`
      SELECT m.id, m.content, m.memory_type, m.importance_score, m.accessed_at, m.access_count,
             bm25(brain_memories_fts) as fts_score
      FROM brain_memories_fts
      JOIN brain_memories m ON brain_memories_fts.rowid = m.id
      WHERE brain_memories_fts MATCH ? AND ${whereClause}
      ORDER BY fts_score
      LIMIT ?
    `);

    let ftsResults = [];
    try {
      ftsResults = ftsQuery.all(fts5Query, ...params, limit * 2);
    } catch (ftsErr) {
      // If FTS5 still fails (e.g. empty query after sanitization), continue with vector-only
      log('FTS5 query failed, falling back to vector-only:', ftsErr.message);
    }
    const ftsRanks = new Map();
    ftsResults.forEach((row, idx) => {
      ftsRanks.set(row.id, idx + 1);
    });

    log(`FTS5 found ${ftsResults.length} results`);

    // Step 2: Vector similarity search (if enabled)
    let vecRanks = new Map();
    let vecResults = [];

    if (vecEnabled) {
      try {
        const queryEmbedding = await generateEmbedding(query, 'query');

        // Get all vectors for comparison (in production, use approximate nearest neighbor)
        const allMemoriesStmt = db.prepare(`
          SELECT m.id, m.content, m.memory_type, m.importance_score, m.accessed_at, m.access_count
          FROM brain_memories m
          WHERE ${whereClause}
        `);
        const allMemories = allMemoriesStmt.all(...params);

        // Calculate similarities
        const similarities = [];
        for (const memory of allMemories) {
          try {
            const vecStmt = db.prepare('SELECT embedding FROM brain_memories_vec WHERE rowid = ?');
            const vecRow = vecStmt.get(BigInt(memory.id));
            if (vecRow) {
              const embedding = JSON.parse(vecRow.embedding);
              const similarity = cosineSimilarity(queryEmbedding, embedding);
              similarities.push({ ...memory, similarity });
            }
          } catch (err) {
            // Skip memories without valid embeddings
          }
        }

        // Sort by similarity
        vecResults = similarities
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit * 2);

        vecResults.forEach((row, idx) => {
          vecRanks.set(row.id, idx + 1);
        });

        log(`Vector search found ${vecResults.length} results`);
      } catch (err) {
        error('Vector search failed:', err.message);
      }
    }

    // Step 3: Reciprocal Rank Fusion
    const rrfScores = new Map();
    const allIds = new Set([...ftsRanks.keys(), ...vecRanks.keys()]);

    for (const id of allIds) {
      let score = 0;
      if (ftsRanks.has(id)) {
        score += 1 / (RRF_K + ftsRanks.get(id));
      }
      if (vecRanks.has(id)) {
        score += 1 / (RRF_K + vecRanks.get(id));
      }
      rrfScores.set(id, score);
    }

    // Step 4: Get full results and sort by RRF score
    const finalIds = Array.from(rrfScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    if (finalIds.length === 0) {
      return [];
    }

    const resultStmt = db.prepare(`
      SELECT id, content, memory_type, importance_score, accessed_at, access_count, session_id, source, metadata
      FROM brain_memories
      WHERE id IN (${finalIds.map(() => '?').join(',')})
    `);

    const results = resultStmt.all(...finalIds);

    // Update access tracking
    const updateStmt = db.prepare(`
      UPDATE brain_memories
      SET accessed_at = unixepoch(), access_count = access_count + 1
      WHERE id = ?
    `);

    for (const result of results) {
      updateStmt.run(result.id);
    }

    // Sort results by RRF score order
    const idToScore = new Map(Array.from(rrfScores.entries()));
    results.sort((a, b) => (idToScore.get(b.id) || 0) - (idToScore.get(a.id) || 0));

    // Parse metadata
    results.forEach(r => {
      if (r.metadata) {
        try {
          r.metadata = JSON.parse(r.metadata);
        } catch (err) {
          r.metadata = null;
        }
      }
      r.rrf_score = idToScore.get(r.id) || 0;
    });

    log(`Hybrid search returned ${results.length} results`);

    return results;
  } catch (err) {
    error('Hybrid search failed:', err);
    throw err;
  }
}

// Update memory content (re-generates embedding)
async function updateMemory(id, content, options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');

    const { importanceScore = null } = options;

    // Generate new embedding
    const embedding = await generateEmbedding(content, 'document');

    // Update main table
    const updates = ['content = ?'];
    const params = [content];

    if (importanceScore !== null) {
      updates.push('importance_score = ?');
      params.push(importanceScore);
    }

    params.push(id);

    const updateStmt = db.prepare(`
      UPDATE brain_memories
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    const result = updateStmt.run(...params);

    if (result.changes === 0) {
      throw new Error(`Memory ${id} not found`);
    }

    // Update vector if enabled
    if (vecEnabled) {
      try {
        const vecUpdateStmt = db.prepare(`
          UPDATE brain_memories_vec
          SET embedding = ?
          WHERE rowid = ?
        `);
        vecUpdateStmt.run(JSON.stringify(embedding), BigInt(id));
      } catch (err) {
        error(`Failed to update vector for memory ${id}:`, err.message);
      }
    }

    log(`Updated memory #${id}`);

    return { id, content, updated: true };
  } catch (err) {
    error('Failed to update memory:', err);
    throw err;
  }
}

// Delete memory from all tables
function deleteMemory(id) {
  try {
    if (!db) throw new Error('Database not initialized');

    // Delete from vector table first (if enabled)
    if (vecEnabled) {
      try {
        const vecDeleteStmt = db.prepare('DELETE FROM brain_memories_vec WHERE rowid = ?');
        vecDeleteStmt.run(BigInt(id));
      } catch (err) {
        error(`Failed to delete vector for memory ${id}:`, err.message);
      }
    }

    // Delete from main table (triggers will handle FTS5)
    const deleteStmt = db.prepare('DELETE FROM brain_memories WHERE id = ?');
    const result = deleteStmt.run(id);

    if (result.changes === 0) {
      throw new Error(`Memory ${id} not found`);
    }

    log(`Deleted memory #${id}`);

    return { id, deleted: true };
  } catch (err) {
    error('Failed to delete memory:', err);
    throw err;
  }
}

// Get memory statistics
function getMemoryStats() {
  try {
    if (!db) throw new Error('Database not initialized');

    const statsStmt = db.prepare(`
      SELECT
        memory_type,
        COUNT(*) as count,
        AVG(importance_score) as avg_importance,
        MAX(accessed_at) as last_access
      FROM brain_memories
      GROUP BY memory_type
    `);

    const stats = statsStmt.all();

    const totalStmt = db.prepare('SELECT COUNT(*) as total FROM brain_memories');
    const total = totalStmt.get().total;

    const dbSize = fs.existsSync(BRAIN_DB_PATH)
      ? fs.statSync(BRAIN_DB_PATH).size
      : 0;

    return {
      total,
      byType: stats.reduce((acc, row) => {
        acc[row.memory_type] = {
          count: row.count,
          avgImportance: row.avg_importance,
          lastAccess: row.last_access
        };
        return acc;
      }, {}),
      dbSizeBytes: dbSize,
      vectorEnabled: vecEnabled
    };
  } catch (err) {
    error('Failed to get stats:', err);
    throw err;
  }
}

// Calculate importance score with time decay and access boost
function calculateImportance(memory, currentTime = null) {
  const now = currentTime || Math.floor(Date.now() / 1000);
  const daysSinceAccess = (now - memory.accessed_at) / 86400;

  // Ebbinghaus forgetting curve approximation
  const timeDecay = Math.max(0.1, 1 / Math.log10(daysSinceAccess + 10));

  // Access count boost (logarithmic)
  const accessBoost = Math.log10(memory.access_count + 1);

  return memory.importance_score * timeDecay * (1 + accessBoost * 0.3);
}

// Update importance scores with time decay
function updateImportanceScores() {
  try {
    if (!db) throw new Error('Database not initialized');

    const now = Math.floor(Date.now() / 1000);
    const selectStmt = db.prepare('SELECT id, importance_score, accessed_at, access_count FROM brain_memories');
    const memories = selectStmt.all();

    const updateStmt = db.prepare('UPDATE brain_memories SET importance_score = ? WHERE id = ?');

    let updated = 0;
    for (const memory of memories) {
      const newScore = calculateImportance(memory, now);
      if (Math.abs(newScore - memory.importance_score) > 0.01) {
        updateStmt.run(newScore, memory.id);
        updated++;
      }
    }

    log(`Updated importance scores for ${updated} memories`);

    return { updated, total: memories.length };
  } catch (err) {
    error('Failed to update importance scores:', err);
    throw err;
  }
}

// Consolidate similar episodic memories into semantic memories
async function consolidateMemories(options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');

    const {
      similarityThreshold = 0.85,
      minClusterSize = 2,
      dryRun = false
    } = options;

    if (!vecEnabled) {
      log('Vector search disabled, skipping consolidation');
      return { consolidated: 0, message: 'Vector search not enabled' };
    }

    // Get all episodic memories
    const episodicStmt = db.prepare(`
      SELECT id, content, importance_score, accessed_at, access_count
      FROM brain_memories
      WHERE memory_type = 'episodic'
      ORDER BY accessed_at DESC
    `);
    const episodics = episodicStmt.all();

    if (episodics.length < minClusterSize) {
      log('Not enough episodic memories to consolidate');
      return { consolidated: 0, message: 'Not enough memories' };
    }

    // Get embeddings for all episodic memories
    const embeddings = [];
    for (const memory of episodics) {
      try {
        const vecStmt = db.prepare('SELECT embedding FROM brain_memories_vec WHERE rowid = ?');
        const vecRow = vecStmt.get(BigInt(memory.id));
        if (vecRow) {
          embeddings.push({
            id: memory.id,
            embedding: JSON.parse(vecRow.embedding),
            content: memory.content,
            importance: memory.importance_score
          });
        }
      } catch (err) {
        error(`Failed to get embedding for memory ${memory.id}:`, err.message);
      }
    }

    // Find clusters using simple agglomerative clustering
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < embeddings.length; i++) {
      if (used.has(embeddings[i].id)) continue;

      const cluster = [embeddings[i]];
      used.add(embeddings[i].id);

      for (let j = i + 1; j < embeddings.length; j++) {
        if (used.has(embeddings[j].id)) continue;

        // Check similarity with all members of current cluster
        let avgSimilarity = 0;
        for (const member of cluster) {
          avgSimilarity += cosineSimilarity(member.embedding, embeddings[j].embedding);
        }
        avgSimilarity /= cluster.length;

        if (avgSimilarity >= similarityThreshold) {
          cluster.push(embeddings[j]);
          used.add(embeddings[j].id);
        }
      }

      if (cluster.length >= minClusterSize) {
        clusters.push(cluster);
      }
    }

    log(`Found ${clusters.length} clusters for consolidation`);

    if (dryRun) {
      return {
        consolidated: 0,
        clusters: clusters.map(c => ({
          size: c.length,
          preview: c[0].content.substring(0, 50)
        })),
        dryRun: true
      };
    }

    // Consolidate each cluster into a semantic memory
    let consolidated = 0;
    const transaction = db.transaction((clusters) => {
      for (const cluster of clusters) {
        // Merge content
        const mergedContent = cluster.map(m => m.content).join(' | ');

        // Average importance
        const avgImportance = cluster.reduce((sum, m) => sum + m.importance, 0) / cluster.length;

        // Create semantic memory
        const insertStmt = db.prepare(`
          INSERT INTO brain_memories (content, memory_type, importance_score, source)
          VALUES (?, 'semantic', ?, 'consolidation')
        `);
        const result = insertStmt.run(mergedContent, avgImportance);
        const semanticId = Number(result.lastInsertRowid);

        // Generate embedding for semantic memory
        const avgEmbedding = new Array(EMBEDDING_DIM).fill(0);
        for (const member of cluster) {
          for (let i = 0; i < EMBEDDING_DIM; i++) {
            avgEmbedding[i] += member.embedding[i];
          }
        }
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          avgEmbedding[i] /= cluster.length;
        }

        // Insert vector
        try {
          const vecInsertStmt = db.prepare(`
            INSERT INTO brain_memories_vec (rowid, embedding)
            VALUES (?, ?)
          `);
          vecInsertStmt.run(BigInt(semanticId), JSON.stringify(avgEmbedding));
        } catch (err) {
          error(`Failed to insert vector for semantic memory ${semanticId}:`, err.message);
        }

        // Delete episodic memories
        const deleteStmt = db.prepare('DELETE FROM brain_memories WHERE id = ?');
        const vecDeleteStmt = db.prepare('DELETE FROM brain_memories_vec WHERE rowid = ?');

        for (const member of cluster) {
          try {
            vecDeleteStmt.run(BigInt(member.id));
          } catch (err) {
            // Ignore vector delete errors
          }
          deleteStmt.run(member.id);
        }

        consolidated++;
        log(`Consolidated cluster of ${cluster.length} into semantic memory #${semanticId}`);
      }
    });

    transaction(clusters);

    log(`Consolidation complete: ${consolidated} clusters merged`);

    return {
      consolidated,
      clustersProcessed: clusters.length,
      totalMemoriesMerged: clusters.reduce((sum, c) => sum + c.length, 0)
    };
  } catch (err) {
    error('Failed to consolidate memories:', err);
    throw err;
  }
}

// Prune old low-importance memories
function pruneMemories(options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');

    const {
      olderThanDays = PRUNE_DAYS,
      minImportance = MIN_IMPORTANCE,
      memoryTypes = ['episodic'],
      dryRun = false
    } = options;

    const cutoffTime = Math.floor(Date.now() / 1000) - (olderThanDays * 86400);

    const selectStmt = db.prepare(`
      SELECT id, content, memory_type, importance_score, accessed_at
      FROM brain_memories
      WHERE memory_type IN (${memoryTypes.map(() => '?').join(',')})
        AND accessed_at < ?
        AND importance_score < ?
    `);

    const toPrune = selectStmt.all(...memoryTypes, cutoffTime, minImportance);

    log(`Found ${toPrune.length} memories to prune`);

    if (dryRun) {
      return {
        pruned: 0,
        candidates: toPrune.length,
        preview: toPrune.slice(0, 5).map(m => ({
          id: m.id,
          type: m.memory_type,
          importance: m.importance_score,
          preview: m.content.substring(0, 50)
        })),
        dryRun: true
      };
    }

    const transaction = db.transaction((memories) => {
      const deleteStmt = db.prepare('DELETE FROM brain_memories WHERE id = ?');
      const vecDeleteStmt = vecEnabled
        ? db.prepare('DELETE FROM brain_memories_vec WHERE rowid = ?')
        : null;

      for (const memory of memories) {
        if (vecDeleteStmt) {
          try {
            vecDeleteStmt.run(BigInt(memory.id));
          } catch (err) {
            // Ignore vector delete errors
          }
        }
        deleteStmt.run(memory.id);
      }
    });

    transaction(toPrune);

    log(`Pruned ${toPrune.length} memories`);

    return {
      pruned: toPrune.length,
      criteria: {
        olderThanDays,
        minImportance,
        memoryTypes
      }
    };
  } catch (err) {
    error('Failed to prune memories:', err);
    throw err;
  }
}

// Export top-importance memories as MEMORY.md content
function exportMemoryMd(options = {}) {
  try {
    if (!db) throw new Error('Database not initialized');

    const {
      topN = 100,
      memoryTypes = ['semantic', 'preference']
    } = options;

    const selectStmt = db.prepare(`
      SELECT content, memory_type, importance_score, accessed_at, access_count
      FROM brain_memories
      WHERE memory_type IN (${memoryTypes.map(() => '?').join(',')})
      ORDER BY importance_score DESC, access_count DESC
      LIMIT ?
    `);

    const memories = selectStmt.all(...memoryTypes, topN);

    let markdown = '# Brain Memory Export\n\n';
    markdown += `Generated: ${new Date().toISOString()}\n\n`;

    // Group by type
    const byType = memories.reduce((acc, m) => {
      if (!acc[m.memory_type]) acc[m.memory_type] = [];
      acc[m.memory_type].push(m);
      return acc;
    }, {});

    for (const [type, items] of Object.entries(byType)) {
      markdown += `## ${type.charAt(0).toUpperCase() + type.slice(1)} Memories\n\n`;
      for (const item of items) {
        markdown += `- ${item.content}\n`;
        markdown += `  *Importance: ${item.importance_score.toFixed(2)}, Accessed: ${item.access_count} times*\n\n`;
      }
    }

    return markdown;
  } catch (err) {
    error('Failed to export memory:', err);
    throw err;
  }
}

// Register Express routes
function registerRoutes(app) {
  if (!app) {
    error('Express app not provided, skipping route registration');
    return;
  }

  // Store memory
  app.post('/brain/memory/store', async (req, res) => {
    try {
      const { content, type = 'episodic', options = {} } = req.body;

      if (!content) {
        return res.status(400).json({ error: 'Content is required' });
      }

      const result = await storeMemory(content, type, options);
      res.json(result);
    } catch (err) {
      error('Store memory route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Search memory
  app.post('/brain/memory/search', async (req, res) => {
    try {
      const { query, options = {} } = req.body;

      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }

      const results = await hybridSearch(query, options);
      res.json({ results, count: results.length });
    } catch (err) {
      error('Search memory route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update memory
  app.post('/brain/memory/update', async (req, res) => {
    try {
      const { id, content, options = {} } = req.body;

      if (!id || !content) {
        return res.status(400).json({ error: 'ID and content are required' });
      }

      const result = await updateMemory(id, content, options);
      res.json(result);
    } catch (err) {
      error('Update memory route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete memory
  app.post('/brain/memory/delete', async (req, res) => {
    try {
      const { id } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'ID is required' });
      }

      const result = deleteMemory(id);
      res.json(result);
    } catch (err) {
      error('Delete memory route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get statistics
  app.get('/brain/memory/stats', (req, res) => {
    try {
      const stats = getMemoryStats();
      res.json(stats);
    } catch (err) {
      error('Stats route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Consolidate memories
  app.post('/brain/memory/consolidate', async (req, res) => {
    try {
      const options = req.body || {};
      const result = await consolidateMemories(options);
      res.json(result);
    } catch (err) {
      error('Consolidate route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Prune memories
  app.post('/brain/memory/prune', (req, res) => {
    try {
      const options = req.body || {};
      const result = pruneMemories(options);
      res.json(result);
    } catch (err) {
      error('Prune route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update importance scores
  app.post('/brain/memory/update-importance', (req, res) => {
    try {
      const result = updateImportanceScores();
      res.json(result);
    } catch (err) {
      error('Update importance route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Export MEMORY.md
  app.get('/brain/memory/export', (req, res) => {
    try {
      const options = {
        topN: parseInt(req.query.topN) || 100,
        memoryTypes: req.query.memoryTypes
          ? req.query.memoryTypes.split(',')
          : ['semantic', 'preference']
      };
      const markdown = exportMemoryMd(options);
      res.type('text/markdown').send(markdown);
    } catch (err) {
      error('Export route error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  log('Registered memory routes: /brain/memory/*');
}

// Initialize module
function init(app = null) {
  try {
    initDatabase();

    if (app) {
      registerRoutes(app);
    }

    log('Brain memory module initialized successfully');

    return true;
  } catch (err) {
    error('Failed to initialize brain memory module:', err);
    throw err;
  }
}

// Cleanup on shutdown
function cleanup() {
  if (db) {
    try {
      db.close();
      log('Database closed');
    } catch (err) {
      error('Error closing database:', err);
    }
  }
}

// Get raw database handle for other modules
function getDb() {
  return db;
}

// Export module
module.exports = {
  getDb,
  init,
  cleanup,
  storeMemory,
  searchMemory: hybridSearch,
  updateMemory,
  deleteMemory,
  getMemoryStats,
  consolidateMemories,
  pruneMemories,
  updateImportanceScores,
  exportMemoryMd,
  registerRoutes,

  // Expose for testing
  initDatabase,
  calculateImportance,
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddings,
  generateFallbackEmbedding
};

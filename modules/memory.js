/**
 * memory.js — Persistent memory system for capy-bridge
 *
 * Stores system-wide memories: meetings, calls, voice commands, tasks, facts, preferences.
 * Uses SQLite FTS5 for full-text search (zero npm dependencies).
 * Storage location: ~/Documents/Capy Memory/
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const MEMORY_DIR = path.join(require('os').homedir(), 'Documents', 'Capy Memory');
const ENTRIES_DIR = path.join(MEMORY_DIR, 'entries');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');
const SEARCH_DB = path.join(MEMORY_DIR, 'search.db');

// Memory types
const MEMORY_TYPES = ['meeting', 'call', 'voice_command', 'task', 'fact', 'preference', 'conversation', 'learning'];

// ────────────────────────────── Init ──────────────────────────────

function ensureDirectories() {
    fs.mkdirSync(ENTRIES_DIR, { recursive: true });
    if (!fs.existsSync(INDEX_FILE)) {
        fs.writeFileSync(INDEX_FILE, JSON.stringify({ version: 1, count: 0, types: {} }, null, 2));
    }
    initSearchDB();
}

function initSearchDB() {
    try {
        const tableCheck = execSync(
            `sqlite3 "${SEARCH_DB}" "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_index';"`,
            { encoding: 'utf-8' }
        ).trim();

        if (!tableCheck) {
            execSync(`sqlite3 "${SEARCH_DB}" "
                CREATE VIRTUAL TABLE memory_index USING fts5(
                    id,
                    type,
                    title,
                    content,
                    tags,
                    source,
                    created_at,
                    tokenize='porter unicode61'
                );
            "`);
            console.log('[Memory] Created FTS5 search index');
        }
    } catch (e) {
        console.error('[Memory] Failed to init search DB:', e.message);
    }
}

// ────────────────────────────── Core Operations ──────────────────────────────

function generateId() {
    return `mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function addMemory({ type, title, content, metadata = {}, tags = [], source = '' }) {
    if (!MEMORY_TYPES.includes(type)) {
        throw new Error(`Invalid memory type: ${type}. Valid: ${MEMORY_TYPES.join(', ')}`);
    }

    const id = generateId();
    const now = new Date().toISOString();

    const entry = {
        id,
        type,
        title: title || 'Untitled',
        content: content || '',
        metadata,
        tags,
        source,
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
        lastAccessed: null,
        links: []
    };

    // Save entry file
    const entryPath = path.join(ENTRIES_DIR, `${id}.json`);
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

    // Update index
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    index.count++;
    index.types[type] = (index.types[type] || 0) + 1;
    index.lastUpdated = now;
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

    // Update FTS5 index
    indexMemory(entry);

    return entry;
}

function getMemory(id) {
    const entryPath = path.join(ENTRIES_DIR, `${id}.json`);
    if (!fs.existsSync(entryPath)) return null;

    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8'));

    // Update access stats
    entry.accessCount++;
    entry.lastAccessed = new Date().toISOString();
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

    return entry;
}

function deleteMemory(id) {
    const entryPath = path.join(ENTRIES_DIR, `${id}.json`);
    if (!fs.existsSync(entryPath)) return false;

    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8'));
    fs.unlinkSync(entryPath);

    // Update index
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    index.count = Math.max(0, index.count - 1);
    index.types[entry.type] = Math.max(0, (index.types[entry.type] || 1) - 1);
    index.lastUpdated = new Date().toISOString();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

    // Remove from FTS5
    try {
        const escapedId = id.replace(/'/g, "''");
        execSync(`sqlite3 "${SEARCH_DB}" "DELETE FROM memory_index WHERE id = '${escapedId}';"`);
    } catch (e) { /* ignore */ }

    return true;
}

// ────────────────────────────── Search ──────────────────────────────

function indexMemory(entry) {
    try {
        const esc = (s) => (s || '').replace(/'/g, "''").replace(/"/g, '""');
        const cmd = `sqlite3 "${SEARCH_DB}" "INSERT INTO memory_index (id, type, title, content, tags, source, created_at) VALUES ('${esc(entry.id)}', '${esc(entry.type)}', '${esc(entry.title)}', '${esc(entry.content)}', '${esc((entry.tags || []).join(' '))}', '${esc(entry.source)}', '${esc(entry.createdAt)}');"`;
        execSync(cmd);
    } catch (e) {
        console.error('[Memory] FTS5 index failed:', e.message);
    }
}

function searchMemories(query, { type = null, limit = 20 } = {}) {
    try {
        const escapedQuery = query.replace(/'/g, "''").replace(/"/g, '');
        let ftsQuery = `"${escapedQuery}"`;

        let whereClause = '';
        if (type) {
            const escapedType = type.replace(/'/g, "''");
            whereClause = `AND type = '${escapedType}'`;
        }

        const sql = `SELECT id, type, title, snippet(memory_index, 3, '>>>', '<<<', '...', 32) as snippet, rank FROM memory_index WHERE memory_index MATCH '${ftsQuery}' ${whereClause} ORDER BY rank LIMIT ${limit};`;

        const result = execSync(`sqlite3 -json "${SEARCH_DB}" "${sql}"`, { encoding: 'utf-8' }).trim();
        if (!result) return [];
        return JSON.parse(result);
    } catch (e) {
        // Fallback: try simpler query
        try {
            const words = query.split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/'/g, "''"));
            if (words.length === 0) return [];
            const ftsQuery = words.join(' OR ');
            const sql = `SELECT id, type, title, snippet(memory_index, 3, '>>>', '<<<', '...', 32) as snippet, rank FROM memory_index WHERE memory_index MATCH '${ftsQuery}' ORDER BY rank LIMIT ${limit};`;
            const result = execSync(`sqlite3 -json "${SEARCH_DB}" "${sql}"`, { encoding: 'utf-8' }).trim();
            if (!result) return [];
            return JSON.parse(result);
        } catch (e2) {
            console.error('[Memory] Search failed:', e2.message);
            return [];
        }
    }
}

function recentMemories({ type = null, limit = 20 } = {}) {
    try {
        const files = fs.readdirSync(ENTRIES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const entry = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, f), 'utf-8'));
                return entry;
            })
            .filter(e => !type || e.type === type)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, limit);
        return files;
    } catch (e) {
        return [];
    }
}

// ────────────────────────────── Context Retrieval ──────────────────────────────

/**
 * Get relevant memories for a given context (combines recency + relevance).
 * This is the "light RAG" endpoint — no embeddings, uses FTS5 + recency scoring.
 */
function getContextMemories(query, { limit = 10, type = null } = {}) {
    const results = [];
    const seen = new Set();

    // 1. FTS5 search results (relevance)
    if (query) {
        const searchResults = searchMemories(query, { type, limit: Math.ceil(limit * 0.7) });
        for (const r of searchResults) {
            if (!seen.has(r.id)) {
                seen.add(r.id);
                const full = getMemory(r.id);
                if (full) {
                    results.push({ ...full, _score: 'relevant', _snippet: r.snippet });
                }
            }
        }
    }

    // 2. Recent memories (recency, fill remaining slots)
    const remaining = limit - results.length;
    if (remaining > 0) {
        const recent = recentMemories({ type, limit: remaining + results.length });
        for (const r of recent) {
            if (!seen.has(r.id) && results.length < limit) {
                seen.add(r.id);
                results.push({ ...r, _score: 'recent' });
            }
        }
    }

    return results;
}

// ────────────────────────────── Meeting Ingestion ──────────────────────────────

function ingestMeetings() {
    const meetingsDir = path.join(require('os').homedir(), 'Documents', 'Capy Meetings');
    const indexPath = path.join(meetingsDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
        console.log('[Memory] No meetings index found');
        return { ingested: 0, skipped: 0 };
    }

    const meetingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    let ingested = 0, skipped = 0;

    const meetings = meetingIndex.meetings || [];
    for (const meeting of meetings) {
        try {
            // Check if already ingested
            const existingId = `meeting_${meeting.id}`;
            const existingPath = path.join(ENTRIES_DIR, `${existingId}.json`);
            if (fs.existsSync(existingPath)) {
                skipped++;
                continue;
            }

            // Read meeting content
            let content = '';
            let summary = '';

            if (meeting.localPath) {
                // localPath may be absolute or relative
                const meetingDir = path.isAbsolute(meeting.localPath) ? meeting.localPath : path.join(meetingsDir, meeting.localPath);
                const transcriptPath = path.join(meetingDir, 'transcript.md');
                const summaryPath = path.join(meetingDir, 'summary.md');

                if (fs.existsSync(transcriptPath)) {
                    content = fs.readFileSync(transcriptPath, 'utf-8');
                }
                if (fs.existsSync(summaryPath)) {
                    summary = fs.readFileSync(summaryPath, 'utf-8');
                }
            }

            // Build searchable content
            const searchContent = [
                meeting.title || 'Untitled Meeting',
                summary,
                content.substring(0, 2000) // First 2K chars of transcript
            ].filter(Boolean).join('\n\n');

            const entry = {
                id: existingId,
                type: 'meeting',
                title: meeting.title || `Meeting ${meeting.date}`,
                content: searchContent,
                metadata: {
                    meetingId: meeting.id,
                    date: meeting.date,
                    startTime: meeting.startTime,
                    endTime: meeting.endTime,
                    duration: meeting.duration,
                    chunkCount: meeting.chunkCount,
                    topicCount: meeting.topicCount,
                    actionCount: meeting.actionCount,
                    hasSummary: !!summary,
                    hasTranscript: !!content
                },
                tags: ['meeting', meeting.date || ''].filter(Boolean),
                source: 'meeting-notes',
                createdAt: meeting.startTime ? new Date(meeting.startTime).toISOString() : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                accessCount: 0,
                lastAccessed: null,
                links: []
            };

            // Save entry
            fs.writeFileSync(existingPath, JSON.stringify(entry, null, 2));
            indexMemory(entry);
            ingested++;
        } catch (e) {
            console.error(`[Memory] Failed to ingest meeting ${meeting.id}:`, e.message);
            skipped++;
        }
    }

    // Update master index
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    index.count += ingested;
    index.types['meeting'] = (index.types['meeting'] || 0) + ingested;
    index.lastUpdated = new Date().toISOString();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

    console.log(`[Memory] Ingested ${ingested} meetings, skipped ${skipped}`);
    return { ingested, skipped };
}

// ────────────────────────────── Call Ingestion ──────────────────────────────

function ingestCallTranscript({ sessionId, transcript, duration, turns, systemPrompt }) {
    const id = `call_${sessionId || Date.now()}`;
    const existingPath = path.join(ENTRIES_DIR, `${id}.json`);
    if (fs.existsSync(existingPath)) return null; // Already ingested

    const content = (transcript || []).map(t => `${t.role}: ${t.text}`).join('\n');

    return addMemory({
        type: 'call',
        title: `Call Agent Session (${turns || 0} turns)`,
        content,
        metadata: { sessionId, duration, turns, systemPrompt },
        tags: ['call', 'voice-agent'],
        source: 'call-agent'
    });
}

// ────────────────────────────── Voice Command Ingestion ──────────────────────────────

function ingestVoiceCommand({ command, result, steps }) {
    return addMemory({
        type: 'voice_command',
        title: command,
        content: [command, ...(steps || []), result].filter(Boolean).join('\n'),
        metadata: { result, steps },
        tags: ['voice', 'command'],
        source: 'voice-assistant'
    });
}

// ────────────────────────────── Stats ──────────────────────────────

function getStats() {
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    return {
        totalMemories: index.count,
        byType: index.types,
        lastUpdated: index.lastUpdated,
        storageLocation: MEMORY_DIR
    };
}

// ────────────────────────────── Express Routes ──────────────────────────────

function mountMemoryRoutes(app) {
    ensureDirectories();

    // IMPORTANT: Specific routes BEFORE parameterized :id route

    // Stats
    app.get('/memory/stats', (req, res) => {
        const stats = getStats();
        res.json(stats);
    });

    // Search memories (FTS5)
    app.get('/memory/search', (req, res) => {
        const { q, type, limit } = req.query;
        if (!q) return res.status(400).json({ error: 'q parameter required' });
        const results = searchMemories(q, {
            type: type || null,
            limit: parseInt(limit) || 20
        });
        res.json({ results, query: q });
    });

    // Recent memories
    app.get('/memory/recent', (req, res) => {
        const { type, limit } = req.query;
        const entries = recentMemories({
            type: type || null,
            limit: parseInt(limit) || 20
        });
        res.json({ memories: entries });
    });

    // Context retrieval (light RAG)
    app.get('/memory/context', (req, res) => {
        const { q, type, limit } = req.query;
        const memories = getContextMemories(q || '', {
            type: type || null,
            limit: parseInt(limit) || 10
        });
        res.json({ memories, query: q });
    });

    // Add a memory
    app.post('/memory/add', (req, res) => {
        try {
            const { type, title, content, metadata, tags, source } = req.body;
            if (!type || !content) {
                return res.status(400).json({ error: 'type and content are required' });
            }
            const entry = addMemory({ type, title, content, metadata, tags, source });
            res.json({ success: true, id: entry.id, type: entry.type });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Ingest meetings
    app.post('/memory/ingest', (req, res) => {
        const result = ingestMeetings();
        res.json({ success: true, ...result });
    });

    // Ingest a call transcript
    app.post('/memory/ingest/call', (req, res) => {
        const entry = ingestCallTranscript(req.body);
        if (!entry) return res.json({ success: true, message: 'Already ingested' });
        res.json({ success: true, id: entry.id });
    });

    // Ingest a voice command
    app.post('/memory/ingest/command', (req, res) => {
        const entry = ingestVoiceCommand(req.body);
        res.json({ success: true, id: entry.id });
    });

    // Parameterized routes LAST
    // Get a specific memory
    app.get('/memory/:id', (req, res) => {
        const entry = getMemory(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Memory not found' });
        res.json(entry);
    });

    // Delete a memory
    app.delete('/memory/:id', (req, res) => {
        const deleted = deleteMemory(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Memory not found' });
        res.json({ success: true });
    });

    console.log('[Memory] Module loaded — storage:', MEMORY_DIR);
}

module.exports = {
    mountMemoryRoutes,
    addMemory,
    getMemory,
    deleteMemory,
    searchMemories,
    recentMemories,
    getContextMemories,
    ingestMeetings,
    ingestCallTranscript,
    ingestVoiceCommand,
    getStats,
    MEMORY_DIR
};

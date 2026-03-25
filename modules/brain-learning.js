/**
 * Brain Learning Pipeline
 * Aristotelian Phronesis (Practical Wisdom) for the Brain module.
 *
 * 3-Layer Architecture (adapted from ATLAS learning.js):
 *   Layer 1: Reflections  - LLM post-mortem of brain queries
 *   Layer 2: Patterns     - Recurring tool-call sequences for query types
 *   Layer 3: Strategies   - Graduated, proven approaches (parameterized)
 *
 * Theory: Shinn et al. (Reflexion) verbal RL + Agent-R trajectory splicing
 * All thresholds derived from data state (zero magic numbers).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Storage directory
const LEARNING_DIR = '/tmp/capy-brain-learning';
const REFLECTIONS_FILE = path.join(LEARNING_DIR, 'reflections.json');
const PATTERNS_FILE = path.join(LEARNING_DIR, 'patterns.json');
const STRATEGIES_FILE = path.join(LEARNING_DIR, 'strategies.json');
const TRAJECTORIES_DIR = path.join(LEARNING_DIR, 'trajectories');

// Ensure directories exist
function ensureDirs() {
  [LEARNING_DIR, TRAJECTORIES_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// Load/save JSON helpers
function loadJSON(filePath, fallback = []) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.error(`[brain-learning] Error loading ${filePath}:`, e.message); }
  return fallback;
}
function saveJSON(filePath, data) {
  ensureDirs();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Short hash for IDs
function shortHash(str) {
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
}

/**
 * Adaptive thresholds derived from data state (Aristotelian -- zero magic numbers)
 */
function adaptiveConfig() {
  const reflections = loadJSON(REFLECTIONS_FILE);
  const patterns = loadJSON(PATTERNS_FILE);
  const strategies = loadJSON(STRATEGIES_FILE);

  const totalRef = reflections.length;
  const totalPat = patterns.length;
  const totalStrat = strategies.length;
  const uniqueTaskTypes = new Set(reflections.map(r => r.taskType)).size || 1;
  const avgPatSuccess = patterns.length > 0
    ? patterns.reduce((s, p) => s + (p.successRate || 0), 0) / patterns.length
    : 0.5;

  return {
    // Reflexion paper: 5 episodes per task type for convergence
    reflectionsCap: Math.max(30, uniqueTaskTypes * 8),
    // Brain has fewer "primitives" than desktop UI; sqrt growth buffer
    patternsCap: Math.max(20, totalPat + Math.ceil(Math.sqrt(totalPat) * 2)),
    // Strategies: abstracted patterns, expect 10-20 core approaches
    strategiesCap: Math.max(15, Math.floor(Math.sqrt(totalPat) * 2)),
    // Graduation: min 3 occurrences, scales with system maturity
    graduationOccurrences: Math.max(3, Math.ceil(Math.sqrt(totalRef))),
    // Must beat average + 10pp margin
    graduationSuccessRate: Math.min(0.9, Math.max(0.6, avgPatSuccess + 0.1)),
    // Context relevance thresholds (lower as data grows)
    relevanceThreshold: Math.max(0.05, 0.15 / Math.sqrt(Math.max(1, totalRef / 10))),
    // Token budget for context injection
    contextBudget: { reflections: 300, patterns: 150, strategies: 200 },
  };
}

/**
 * Classify brain query into task type
 * FIX BUG-4: Vision patterns checked BEFORE system_info to prevent
 * "apps" in "what apps are visible on screen" matching system_info.
 */
function classifyTaskType(userMessage) {
  const msg = (userMessage || '').toLowerCase();
  const patterns = [
    [/\b(morning|briefing|daily|overview|summary)\b/, 'briefing'],
    [/\b(remind|reminder|todo|task)\b/, 'reminders'],
    [/\b(calendar|event|meeting|schedule)\b/, 'calendar'],
    [/\b(mail|email|inbox)\b/, 'mail'],
    // Vision BEFORE system_info (BUG-4 fix: "apps on screen" should be vision)
    [/\b(screen|screenshot|see|look|desktop|window)\b/, 'vision'],
    [/\b(click|type|scroll|interact|open app)\b/, 'desktop_action'],
    [/\b(battery|wifi|system|volume|disk)\b/, 'system_info'],
    [/\b(remember|memory|store|recall)\b/, 'memory'],
    [/\b(speak|say|voice|tts)\b/, 'speech'],
    [/\b(search|web|google|find online)\b/, 'web_search'],
    [/\b(note|notes|create note)\b/, 'notes'],
    [/\b(contact|phone|call)\b/, 'contacts'],
    [/\b(music|play|pause|song)\b/, 'music'],
    [/\b(build|deploy|xcode|swift|compile)\b/, 'development'],
    [/\b(schedule|cron|timer|interval)\b/, 'scheduling'],
  ];
  for (const [regex, type] of patterns) {
    if (regex.test(msg)) return type;
  }
  return 'general';
}

/**
 * Extract tool-call sequence signature from trajectory
 */
function extractToolSignature(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return '';
  return toolCalls.map(tc => {
    const name = tc.name || tc.tool || 'unknown';
    const action = tc.input?.action || tc.params?.action || '';
    return action ? `${name}:${action}` : name;
  }).join(' -> ');
}

/**
 * Jaccard similarity for keyword matching
 */
function jaccardSimilarity(a, b) {
  const setA = new Set((a || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set((b || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}


// ============================================================================
// LAYER 1: REFLECTIONS (Post-Mortem Analysis)
// ============================================================================

/**
 * Generate a reflection from a brain trajectory.
 * If LLM is available, uses it. Otherwise, algorithmic extraction.
 */
function generateReflection(trajectory, llmReflection = null) {
  const id = `ref-${Date.now()}-${shortHash(trajectory.task || '')}`;
  const toolNames = (trajectory.tools_used || []).map(t => t.name || t.tool || 'unknown');
  const uniqueTools = [...new Set(toolNames)];
  const signature = extractToolSignature(trajectory.tools_used);

  // Algorithmic reflection (always available)
  const isEfficient = (trajectory.iterations || 999) <= 4;
  const lessons = [];

  if (isEfficient && trajectory.outcome === 'success') {
    lessons.push(`Efficient approach: ${uniqueTools.join(', ')} in ${trajectory.iterations} iterations for ${trajectory.taskType}`);
  }
  if ((trajectory.iterations || 0) > 6) {
    lessons.push(`High iteration count (${trajectory.iterations}): consider more targeted tool selection`);
  }
  // BUG-5 fix: Task-type-aware cost thresholds (vision is inherently expensive)
  const costThresholds = {
    vision: 1.50, desktop_action: 0.50, briefing: 0.30, general: 0.25,
  };
  const costThreshold = costThresholds[trajectory.taskType] || 0.20;
  if ((trajectory.cost || 0) > costThreshold) {
    lessons.push(`High cost ($${trajectory.cost?.toFixed(2)}) for ${trajectory.taskType}: consider optimizing`);
  }
  if (trajectory.outcome === 'failure') {
    lessons.push(`Failed task type '${trajectory.taskType}': ${trajectory.error || 'unknown error'}`);
  }
  // Fan-out detection (multiple tools in one iteration)
  if (uniqueTools.length >= 3 && (trajectory.iterations || 999) <= 3) {
    lessons.push(`Good fan-out pattern: ${uniqueTools.length} tools in ${trajectory.iterations} iterations`);
  }

  const reflection = {
    id,
    task: (trajectory.task || '').slice(0, 200),
    taskType: trajectory.taskType || classifyTaskType(trajectory.task),
    outcome: trajectory.outcome || 'unknown',
    iterations: trajectory.iterations || 0,
    toolsUsed: uniqueTools,
    toolSignature: signature,
    cost: trajectory.cost || 0,
    duration_ms: trajectory.duration_ms || 0,
    lessons,
    llmReflection: llmReflection || null,
    timestamp: Date.now(),
  };

  // Save
  const reflections = loadJSON(REFLECTIONS_FILE);
  reflections.push(reflection);

  // Cap with recency preference
  const config = adaptiveConfig();
  if (reflections.length > config.reflectionsCap) {
    // Keep most recent, but preserve at least 2 per task type
    const byType = {};
    reflections.forEach(r => {
      if (!byType[r.taskType]) byType[r.taskType] = [];
      byType[r.taskType].push(r);
    });
    const kept = [];
    for (const [type, refs] of Object.entries(byType)) {
      // Keep at least 2 most recent per type
      refs.sort((a, b) => b.timestamp - a.timestamp);
      kept.push(...refs.slice(0, Math.max(2, Math.ceil(config.reflectionsCap / Object.keys(byType).length))));
    }
    kept.sort((a, b) => b.timestamp - a.timestamp);
    saveJSON(REFLECTIONS_FILE, kept.slice(0, config.reflectionsCap));
  } else {
    saveJSON(REFLECTIONS_FILE, reflections);
  }

  return reflection;
}


// ============================================================================
// LAYER 2: PATTERNS (Recurring Tool-Call Sequences)
// ============================================================================

/**
 * Extract or update patterns from a trajectory.
 * A pattern = a tool-call sequence associated with a task type and outcome.
 */
function extractPatterns(trajectory) {
  const signature = extractToolSignature(trajectory.tools_used);
  if (!signature) return null;

  const taskType = trajectory.taskType || classifyTaskType(trajectory.task);
  const patterns = loadJSON(PATTERNS_FILE);
  const config = adaptiveConfig();

  // Check for existing similar pattern
  let matched = false;
  for (const pat of patterns) {
    const sigSim = jaccardSimilarity(pat.toolSignature, signature);
    const sameType = pat.taskType === taskType;
    if (sameType && sigSim > 0.5) {
      // Update existing pattern
      pat.occurrences = (pat.occurrences || 1) + 1;
      pat.successRate = ((pat.successRate || 0) * (pat.occurrences - 1) +
        (trajectory.outcome === 'success' ? 1 : 0)) / pat.occurrences;
      pat.avgIterations = ((pat.avgIterations || 0) * (pat.occurrences - 1) +
        (trajectory.iterations || 0)) / pat.occurrences;
      pat.avgCost = ((pat.avgCost || 0) * (pat.occurrences - 1) +
        (trajectory.cost || 0)) / pat.occurrences;
      pat.lastUsed = Date.now();
      pat.sourceTrajectories = pat.sourceTrajectories || [];
      pat.sourceTrajectories.push(trajectory.id);
      if (pat.sourceTrajectories.length > 10) pat.sourceTrajectories = pat.sourceTrajectories.slice(-10);
      matched = true;
      break;
    }
  }

  if (!matched) {
    // Create new pattern
    const toolNames = (trajectory.tools_used || []).map(t => t.name || t.tool || 'unknown');
    patterns.push({
      id: `pat-${Date.now()}-${shortHash(signature)}`,
      taskType,
      description: `${taskType}: ${[...new Set(toolNames)].join(' + ')}`,
      toolSignature: signature,
      tools: [...new Set(toolNames)],
      occurrences: 1,
      successRate: trajectory.outcome === 'success' ? 1 : 0,
      avgIterations: trajectory.iterations || 0,
      avgCost: trajectory.cost || 0,
      sourceTrajectories: [trajectory.id],
      lastUsed: Date.now(),
      createdAt: Date.now(),
    });
  }

  // Cap patterns
  if (patterns.length > config.patternsCap) {
    // Remove lowest-occurrence, oldest patterns
    patterns.sort((a, b) => (b.occurrences * 10 + b.lastUsed / 1e12) - (a.occurrences * 10 + a.lastUsed / 1e12));
    patterns.length = config.patternsCap;
  }

  saveJSON(PATTERNS_FILE, patterns);
  return matched ? 'updated' : 'created';
}


// ============================================================================
// LAYER 3: STRATEGIES (Graduated Proven Approaches)
// ============================================================================

/**
 * Check if any patterns qualify for strategy graduation.
 * Criteria: occurrences >= threshold AND successRate >= threshold.
 */
function graduateStrategies() {
  const patterns = loadJSON(PATTERNS_FILE);
  const strategies = loadJSON(STRATEGIES_FILE);
  const config = adaptiveConfig();

  let graduated = 0;
  for (const pat of patterns) {
    // Check graduation criteria
    if ((pat.occurrences || 0) < config.graduationOccurrences) continue;
    if ((pat.successRate || 0) < config.graduationSuccessRate) continue;

    // Check if already graduated
    const existing = strategies.find(s => s.graduatedFrom === pat.id);
    if (existing) {
      // Update stats
      existing.successRate = pat.successRate;
      existing.occurrences = pat.occurrences;
      existing.lastUpdated = Date.now();
      continue;
    }

    // Graduate!
    strategies.push({
      id: `strat-${Date.now()}-${shortHash(pat.toolSignature)}`,
      name: `${pat.taskType}_${pat.tools.join('_')}`.slice(0, 60),
      description: pat.description,
      taskType: pat.taskType,
      tools: pat.tools,
      toolSignature: pat.toolSignature,
      successRate: pat.successRate,
      avgIterations: pat.avgIterations,
      avgCost: pat.avgCost,
      occurrences: pat.occurrences,
      graduatedFrom: pat.id,
      createdAt: Date.now(),
    });
    graduated++;
  }

  // Cap strategies
  if (strategies.length > config.strategiesCap) {
    strategies.sort((a, b) => (b.successRate * 10 + b.occurrences) - (a.successRate * 10 + a.occurrences));
    strategies.length = config.strategiesCap;
  }

  saveJSON(STRATEGIES_FILE, strategies);
  return graduated;
}


// ============================================================================
// CONTEXT INJECTION (Brain Integration)
// ============================================================================

/**
 * Get relevant learning context for a brain query.
 * Returns formatted text to inject into system prompt.
 */
function getRelevantContext(taskDescription) {
  const config = adaptiveConfig();
  const taskType = classifyTaskType(taskDescription);
  const parts = [];

  // Layer 1: Relevant reflections
  // BUG-2 fix: filter out empty-task entries before scoring
  const reflections = loadJSON(REFLECTIONS_FILE);
  const relevantRefs = reflections
    .filter(r => r.task && r.task.trim().length > 0)  // BUG-2: skip garbage entries
    .map(r => ({
      ...r,
      relevance: (r.taskType === taskType ? 0.4 : 0) +
        jaccardSimilarity(r.task, taskDescription) * 0.6,
    }))
    .filter(r => r.relevance > config.relevanceThreshold)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 3);

  if (relevantRefs.length > 0) {
    const lines = relevantRefs.map(r => {
      const icon = r.outcome === 'success' ? '[OK]' : '[FAIL]';
      const lessons = (r.lessons || []).slice(0, 2).map(l => `  - ${l}`).join('\n');
      return `${icon} "${r.task.slice(0, 80)}" (${r.iterations} iters, $${r.cost?.toFixed(2)})\n${lessons}`;
    });
    parts.push(`LESSONS FROM PAST TASKS:\n${lines.join('\n')}`);
  }

  // Layer 3: Strategies (highest value)
  const strategies = loadJSON(STRATEGIES_FILE);
  const relevantStrats = strategies
    .filter(s => s.taskType === taskType || jaccardSimilarity(s.description, taskDescription) > 0.1)
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 2);

  if (relevantStrats.length > 0) {
    const lines = relevantStrats.map(s =>
      `STRATEGY "${s.name}": ${s.tools.join(' + ')} (${Math.round(s.successRate * 100)}% success, ~${s.avgIterations?.toFixed(1)} iters, ~$${s.avgCost?.toFixed(2)})`
    );
    parts.push(`PROVEN STRATEGIES:\n${lines.join('\n')}`);
  }

  // Layer 2: Patterns (if no strategies matched)
  if (relevantStrats.length === 0) {
    const patterns = loadJSON(PATTERNS_FILE);
    const relevantPats = patterns
      .filter(p => p.taskType === taskType && (p.occurrences || 0) >= 2)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 2);

    if (relevantPats.length > 0) {
      const lines = relevantPats.map(p =>
        `PATTERN: ${p.description} (${p.occurrences}x, ${Math.round(p.successRate * 100)}% success)`
      );
      parts.push(`OBSERVED PATTERNS:\n${lines.join('\n')}`);
    }
  }

  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}


// ============================================================================
// MAIN PIPELINE
// ============================================================================

/**
 * Full learning pipeline -- called after each brain query completion.
 * Non-blocking, fire-and-forget.
 */
async function learnFromBrainQuery(trajectoryData) {
  ensureDirs();
  try {
    // BUG-1 fix: reject empty/missing task
    if (!trajectoryData.task || !trajectoryData.task.trim()) {
      console.log('[brain-learning] Skipping capture: empty task');
      return null;
    }
    const trajectory = {
      id: `brain-${Date.now()}-${shortHash(trajectoryData.task || '')}`,
      task: trajectoryData.task || '',
      taskType: trajectoryData.taskType || classifyTaskType(trajectoryData.task),
      outcome: trajectoryData.outcome || 'unknown',
      iterations: trajectoryData.iterations || 0,
      tools_used: trajectoryData.tools_used || [],
      cost: trajectoryData.cost || 0,
      duration_ms: trajectoryData.duration_ms || 0,
      model: trajectoryData.model || 'unknown',
      error: trajectoryData.error || null,
      timestamp: Date.now(),
    };

    // Save raw trajectory
    const trajFile = path.join(TRAJECTORIES_DIR, `${trajectory.id}.json`);
    fs.writeFileSync(trajFile, JSON.stringify(trajectory, null, 2));

    // Layer 1: Generate reflection
    const reflection = generateReflection(trajectory, trajectoryData.llmReflection);

    // Layer 2: Extract/update patterns
    const patternResult = extractPatterns(trajectory);

    // Layer 3: Check for strategy graduation
    const graduated = graduateStrategies();

    const result = {
      trajectoryId: trajectory.id,
      reflection: reflection.id,
      patternResult,
      strategiesGraduated: graduated,
    };

    console.log(`[brain-learning] Captured: ${trajectory.id} | type=${trajectory.taskType} | outcome=${trajectory.outcome} | iters=${trajectory.iterations} | cost=$${trajectory.cost?.toFixed(2)} | pattern=${patternResult} | graduated=${graduated}`);
    return result;
  } catch (err) {
    console.error('[brain-learning] Pipeline error:', err.message);
    return null;
  }
}


// ============================================================================
// STATS
// ============================================================================

function getStats() {
  const reflections = loadJSON(REFLECTIONS_FILE);
  const patterns = loadJSON(PATTERNS_FILE);
  const strategies = loadJSON(STRATEGIES_FILE);
  const config = adaptiveConfig();

  // Count trajectories
  let trajectoryCount = 0;
  try {
    trajectoryCount = fs.readdirSync(TRAJECTORIES_DIR).filter(f => f.endsWith('.json')).length;
  } catch (e) {}

  // Task type distribution
  const taskTypes = {};
  reflections.forEach(r => {
    taskTypes[r.taskType] = (taskTypes[r.taskType] || 0) + 1;
  });

  // Success rate by type
  const successByType = {};
  reflections.forEach(r => {
    if (!successByType[r.taskType]) successByType[r.taskType] = { success: 0, total: 0 };
    successByType[r.taskType].total++;
    if (r.outcome === 'success') successByType[r.taskType].success++;
  });

  return {
    trajectories: trajectoryCount,
    reflections: reflections.length,
    patterns: patterns.length,
    strategies: strategies.length,
    taskTypes,
    successByType,
    config,
    topPatterns: patterns
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 5)
      .map(p => ({ description: p.description, occurrences: p.occurrences, successRate: p.successRate })),
    allStrategies: strategies.map(s => ({
      name: s.name, successRate: s.successRate, occurrences: s.occurrences, avgCost: s.avgCost,
    })),
  };
}


// ============================================================================
// EXPRESS ROUTES
// ============================================================================

function mountRoutes(app) {
  // Capture trajectory (called by BrainOrchestrator)
  app.post('/brain/learning/capture', async (req, res) => {
    try {
      // BUG-1 fix: validate input
      if (!req.body.task || !req.body.task.trim()) {
        return res.status(400).json({ error: 'Missing or empty task field' });
      }
      const result = await learnFromBrainQuery(req.body);
      if (!result) return res.status(400).json({ error: 'Capture rejected (empty task)' });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get relevant context for a task (called by ContextBuilder)
  app.post('/brain/learning/context', (req, res) => {
    try {
      const context = getRelevantContext(req.body.task || req.body.query || '');
      res.json({ success: true, context });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stats dashboard
  app.get('/brain/learning/stats', (req, res) => {
    try {
      res.json(getStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List reflections
  app.get('/brain/learning/reflections', (req, res) => {
    res.json(loadJSON(REFLECTIONS_FILE));
  });

  // List patterns
  app.get('/brain/learning/patterns', (req, res) => {
    res.json(loadJSON(PATTERNS_FILE));
  });

  // List strategies
  app.get('/brain/learning/strategies', (req, res) => {
    res.json(loadJSON(STRATEGIES_FILE));
  });

  // Force graduation check
  app.post('/brain/learning/graduate', (req, res) => {
    try {
      const graduated = graduateStrategies();
      res.json({ success: true, strategiesGraduated: graduated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reset (careful!)
  app.post('/brain/learning/reset', (req, res) => {
    const target = req.body.target || 'all';
    try {
      if (target === 'all' || target === 'reflections') saveJSON(REFLECTIONS_FILE, []);
      if (target === 'all' || target === 'patterns') saveJSON(PATTERNS_FILE, []);
      if (target === 'all' || target === 'strategies') saveJSON(STRATEGIES_FILE, []);
      if (target === 'all' || target === 'trajectories') {
        const files = fs.readdirSync(TRAJECTORIES_DIR).filter(f => f.endsWith('.json'));
        files.forEach(f => fs.unlinkSync(path.join(TRAJECTORIES_DIR, f)));
      }
      res.json({ success: true, reset: target });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[brain-learning] Routes mounted at /brain/learning/*');
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  learnFromBrainQuery,
  getRelevantContext,
  getStats,
  mountRoutes,
  classifyTaskType,
  adaptiveConfig,
  // For testing
  generateReflection,
  extractPatterns,
  graduateStrategies,
  LEARNING_DIR,
};

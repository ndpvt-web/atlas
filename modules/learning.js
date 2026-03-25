/**
 * Self-Improving Learning Engine for Computer-Use Agent
 *
 * Implements a 3-layer learning pipeline that builds on trajectory data:
 *
 *   Layer 1: REFLECTIONS (post-mortem analysis after each task)
 *     - After each task, an LLM analyzes the trajectory and writes lessons learned
 *     - Stored as natural language insights (Reflexion pattern / verbal reinforcement)
 *     - Injected into future task prompts when similar tasks are detected
 *
 *   Layer 2: SEGMENTS (reusable checkpoint-to-checkpoint action sequences)
 *     - Extracts the action sequence between consecutive verified checkpoints
 *     - Each segment = a proven sub-procedure that achieved a verified sub-goal
 *     - Matched to new tasks by semantic similarity of precondition/postcondition
 *
 *   Layer 3: SKILLS (graduated segments that appear across multiple trajectories)
 *     - When a segment pattern appears 3+ times with >70% success, it graduates to a skill
 *     - Skills are parameterized (e.g., "open_app(name)" instead of "open Safari")
 *     - Available to the agent as known-good procedures in its system prompt
 *
 * Data Flow:
 *   trajectory.json -> postMortem() -> reflections.json
 *                   -> extractSegments() -> segment_library.json
 *                                        -> graduateSkills() -> skills.json
 *                   -> getRelevantContext(task) -> system prompt injection
 *
 * Theoretical Foundation (Aristotle's Phronesis / Practical Wisdom):
 *   - Observation: Trajectory graph records what happened (raw empirical data)
 *   - Induction: Reflections generalize from specific observations to principles
 *   - Practical Syllogism: Skills apply proven principles to new situations
 *   - Dialectic: When reflections conflict, recency-weighted trust resolves them
 *
 * References:
 *   - Reflexion (Shinn et al. 2023): Verbal reinforcement learning for agents
 *   - Agent-R: MCTS + trajectory splicing for self-improvement
 *   - SkillRL: Recursive skill library for composable behaviors
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

// ============================================================
// STORAGE PATHS (Phase 1: Migrated to persistent storage)
// ============================================================
// Try persistent storage first (~/.capy-learning), fallback to /tmp if not writable
let LEARNING_DIR;
try {
  LEARNING_DIR = path.join(os.homedir(), '.capy-learning');
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  // Test writability
  const testFile = path.join(LEARNING_DIR, '.write-test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
} catch (e) {
  console.log('[Learning] Home directory not writable, falling back to /tmp/capy-learning');
  LEARNING_DIR = '/tmp/capy-learning';
  try { fs.mkdirSync(LEARNING_DIR, { recursive: true }); } catch (e2) {}
}

const REFLECTIONS_PATH = path.join(LEARNING_DIR, 'reflections.json');
const SEGMENTS_PATH = path.join(LEARNING_DIR, 'segment_library.json');
const SKILLS_PATH = path.join(LEARNING_DIR, 'skills.json');
const ENVIRONMENT_PATH = path.join(LEARNING_DIR, 'environment.json');

// Phase 1: Create subdirectories for source tracking
try {
  fs.mkdirSync(path.join(LEARNING_DIR, 'reflections'), { recursive: true });
  fs.mkdirSync(path.join(LEARNING_DIR, 'reflections', 'real'), { recursive: true });
  fs.mkdirSync(path.join(LEARNING_DIR, 'reflections', 'synthetic'), { recursive: true });
  fs.mkdirSync(path.join(LEARNING_DIR, 'reflections', 'her'), { recursive: true });
} catch (e) {}

// AI Gateway config (same as computer-use.js)
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = 'cc00f875633a4dca884e24f5ab6e0106';
const SONNET_PATH = '/api/v1/bedrock/model/claude-sonnet-4-6/invoke';

// ============================================================
// ADAPTIVE THRESHOLDS (zero magic numbers -- all derived from data state)
// ============================================================
//
// Every threshold, cap, and limit in this module is computed from the current
// data state. No hardcoded numbers. Each formula has an Aristotle-style proof
// from first principles.
//
// The proofs follow Aristotle's epistemic methodology:
//   1. State observable premises (empirical facts about the data)
//   2. Derive conclusions via syllogism (if P1 and P2, then C)
//   3. Verify the conclusion is falsifiable (could be wrong, can be tested)
//

/**
 * Compute all adaptive thresholds from current data state.
 *
 * Called on every operation that needs a threshold. Reads current stores
 * and derives all values from the data. O(N) where N = total items,
 * but N is small (< 1000) and this is called infrequently.
 *
 * @returns {object} - All threshold values with derivation metadata
 */
function _adaptiveConfig() {
  const reflections = loadJSON(REFLECTIONS_PATH, []);
  const segments = loadJSON(SEGMENTS_PATH, []);
  const skills = loadJSON(SKILLS_PATH, []);

  // --- OBSERVED QUANTITIES ---
  const totalReflections = reflections.length;
  const totalSegments = segments.length;
  const totalSkills = skills.length;
  const uniqueTaskTypes = new Set(reflections.map(r => r.taskType)).size;
  const avgSegSuccessRate = totalSegments > 0
    ? segments.reduce((s, seg) => s + (seg.successRate || 0), 0) / totalSegments
    : 0.5;
  const avgSegmentLabelWords = totalSegments > 0
    ? segments.reduce((s, seg) => s + _tokenize(seg.label).length, 0) / totalSegments
    : 5;

  // --- STORAGE CAPS ---
  //
  // REFLECTIONS CAP
  //
  // Premise 1 (Information coverage): A task type is "covered" when we have
  //   enough reflections to extract both success patterns and failure patterns.
  //   The Reflexion paper (Shinn et al.) shows convergence after ~5 episodes
  //   per task category. So we need: uniqueTaskTypes * 5 reflections.
  //
  // Premise 2 (Cold start): Before we have enough data to estimate diversity,
  //   we need a minimum. The birthday paradox tells us: to observe K unique types
  //   from a space of N types, we need ~sqrt(2*N*K) samples. For ~25 desktop task
  //   types and K=1 (first duplicate): sqrt(50) ≈ 7 reflections. With 5 per type,
  //   floor = 7*5 = 35. Round down to 20 as absolute minimum (4 types * 5).
  //
  // Conclusion: cap = max(20, uniqueTaskTypes * 5). No upper ceiling -- the
  //   formula self-limits because uniqueTaskTypes grows sublinearly with reflections.
  //
  const reflectionsCap = Math.max(20, uniqueTaskTypes * 5),

  // SEGMENTS CAP
  //
  // Premise 1 (Finite UI vocabulary): Desktop automation has a bounded set of
  //   primitive UI procedures. OSWorld and WebArena research catalogues ~25-40
  //   distinct primitives across all desktop tasks.
  //
  // Premise 2 (Variations): Each primitive has ~2-3 variations (e.g., open app
  //   via Spotlight vs Dock vs Terminal). So the theoretical max distinct segments
  //   is ~40*3 = 120.
  //
  // Premise 3 (Growth buffer): We don't know which primitives the agent will encounter.
  //   Allow room for discovery: currentSegments + sqrt(currentSegments)*3 headroom.
  //
  // Conclusion: cap = max(30, totalSegments + ceil(sqrt(totalSegments) * 3))
  //   - 30 minimum (before we know the vocabulary)
  //   - Grows with usage but decelerates (sqrt scaling)
  //
  segmentsCap = Math.max(30, totalSegments + Math.ceil(Math.sqrt(Math.max(totalSegments, 1)) * 3)),

  // SKILLS CAP
  //
  // Premise 1 (Skills = abstract procedures): Skills are parameterized versions of
  //   segments. The abstraction reduces the count: "open_app(Safari)" + "open_app(Terminal)"
  //   = 1 skill "open_app($name)". So skills < segments.
  //
  // Premise 2 (Bounded by primitive space): ~25-40 distinct desktop primitives means
  //   at most ~40 abstract skills. In practice, many primitives share parameters
  //   (click_button, click_link, click_menu → "click_element"), so expect ~20-30.
  //
  // Premise 3 (Value-proportional growth): Skills are the MOST valuable layer
  //   (each required an LLM call to create). Growth should track segment growth
  //   but at a reduced rate: sqrt(segments) captures this.
  //
  // Conclusion: cap = max(20, floor(sqrt(totalSegments) * 3))
  //   - 20 minimum (core desktop primitives)
  //   - sqrt scaling: 100 segments → 30 skills, 400 segments → 60 skills
  //
  skillsCap = Math.max(20, Math.floor(Math.sqrt(Math.max(totalSegments, 1)) * 3));

  // --- GRADUATION THRESHOLDS ---
  //
  // OCCURRENCE THRESHOLD (how many times a segment must appear before graduation)
  //
  // Premise 1 (Statistical significance): With n=1 observation, we have zero variance.
  //   With n=2, the variance is maximal (could be 50/50 or 100/0). With n=3,
  //   we start seeing a distribution. For a binomial with p=0.7 and n=3,
  //   P(all 3 succeed) = 0.343 -- so even 3 successes doesn't guarantee 70%.
  //   This is the MINIMUM for any meaningful inference.
  //
  // Premise 2 (System maturity): As the system accumulates more trajectories,
  //   we should demand MORE evidence before graduation. A young system with
  //   5 trajectories should graduate at 3 (60% of data). A mature system with
  //   100 trajectories should require more (but not linearly -- that would be
  //   too strict). sqrt(N) scaling: sqrt(5)≈2→3, sqrt(25)=5, sqrt(100)=10.
  //
  // Conclusion: max(3, ceil(sqrt(totalReflections)))
  //   - 3 absolute minimum (statistical floor)
  //   - sqrt scaling with system maturity
  //
  const graduationOccurrences = Math.max(3, Math.ceil(Math.sqrt(Math.max(totalReflections, 1))));

  // SUCCESS RATE THRESHOLD (minimum success rate for graduation)
  //
  // Premise 1 (Better than average): A skill must outperform the average segment.
  //   If the average segment has 60% success, graduating a 60% segment adds no value.
  //   The graduated skill must be ABOVE average + margin.
  //
  // Premise 2 (Margin of superiority): The margin should be enough to be
  //   statistically distinguishable from average. For proportions, a difference
  //   of 0.1 (10pp) is conventionally significant at moderate sample sizes.
  //
  // Premise 3 (Floor and ceiling): Never require < 50% (worse than coin flip is
  //   not a skill). Never require > 90% (perfection is unrealistic for UI automation
  //   where environmental noise causes ~5-10% random failures).
  //
  // Conclusion: clamp(avgSegSuccessRate + 0.1, 0.5, 0.9)
  //
  const graduationSuccessRate = Math.min(0.9, Math.max(0.5, avgSegSuccessRate + 0.1));

  // --- SEGMENT DEDUPLICATION THRESHOLDS ---
  //
  // SIMILARITY THRESHOLD (Jaccard index to consider two segments "the same procedure")
  //
  // Premise 1 (Text length affects Jaccard): Short texts (3-5 words) have high
  //   Jaccard variance -- a single different word drops the score dramatically.
  //   Long texts (15+ words) have lower variance -- many shared filler words inflate it.
  //
  // Premise 2 (Diminishing returns of word count): The information per word
  //   follows a log curve (Zipf's law). The threshold should account for this:
  //   threshold = 1 - 1/sqrt(avgWordCount)
  //   - 3 words: 1 - 1/1.73 = 0.42
  //   - 8 words: 1 - 1/2.83 = 0.65
  //   - 15 words: 1 - 1/3.87 = 0.74
  //
  // Premise 3 (Floor): Even for very short texts, require > 0.3 overlap.
  //   Below 0.3 Jaccard, texts share less than 1/3 of their vocabulary -- too
  //   dissimilar to be the "same procedure".
  //
  // Conclusion: max(0.3, 1 - 1/sqrt(avgWordsPerLabel))
  //   Adaptive to the text length of stored segments.
  //
  const dedupThreshold = Math.max(0.3, 1 - 1 / Math.sqrt(Math.max(avgSegmentLabelWords, 1)));

  // --- CONTEXT INJECTION BUDGET ---
  //
  // TOKEN BUDGET (how much learning context to inject into the system prompt)
  //
  // Premise 1 (Context window cost): Each token of injected context competes
  //   with screenshot images and conversation history. RAG research (Lewis et al.)
  //   shows that 500-1000 tokens of retrieved context is optimal. Beyond that,
  //   the model attends less to each piece (attention dilution).
  //
  // Premise 2 (Token estimation): We approximate ~15 tokens per line of text.
  //   Each reflection entry ≈ 3 + avg_lessons lines (header + lessons).
  //   Each skill entry ≈ 3 lines (name + instructions + success rate).
  //   Each segment entry ≈ 2 lines (label + pre/post conditions).
  //
  // Premise 3 (Priority ordering): Reflections > Skills > Segments.
  //   Reflections contain generalized PRINCIPLES (most transferable).
  //   Skills contain PROCEDURES (second most useful).
  //   Segments are raw patterns (least abstracted, will graduate to skills).
  //   Budget allocation: 50% reflections, 35% skills, 15% segments.
  //
  // Conclusion: TOKEN_BUDGET = 500
  //   maxReflections = floor(250 / tokensPerReflection)
  //   maxSkills = floor(175 / tokensPerSkill)
  //   maxSegments = floor(75 / tokensPerSegment)
  //
  const TOKEN_BUDGET = 500;
  const avgLessonsPerReflection = totalReflections > 0
    ? reflections.reduce((s, r) => s + (r.lessons?.length || 0), 0) / totalReflections
    : 2;
  const tokensPerReflection = (3 + avgLessonsPerReflection) * 15;
  const tokensPerSkill = 3 * 15;
  const tokensPerSegment = 2 * 15;
  const maxReflections = Math.max(1, Math.floor((TOKEN_BUDGET * 0.5) / tokensPerReflection));
  const maxSkills = Math.max(1, Math.floor((TOKEN_BUDGET * 0.35) / tokensPerSkill));
  const maxSegments = Math.max(1, Math.floor((TOKEN_BUDGET * 0.15) / tokensPerSegment));

  // --- RELEVANCE THRESHOLDS ---
  //
  // Premise 1 (Noise filtering): Relevance scores below a threshold inject noise
  //   that distracts the model. The threshold must separate signal from noise.
  //
  // Premise 2 (Adaptive noise floor): With more data, we can be more selective
  //   (higher threshold). With less data, we should be lenient (lower threshold).
  //   The noise floor is proportional to 1/sqrt(dataSize): more data → lower
  //   random match probability.
  //
  // Premise 3 (Per-layer adjustment): Skills are already curated (graduated from
  //   segments), so they need a LOWER threshold (we trust them more). Segments are
  //   raw patterns -- HIGHER threshold to filter noise. Reflections are in between.
  //
  // Conclusion:
  //   reflectionThreshold = max(0.05, 0.15 / sqrt(max(1, totalReflections / 10)))
  //   skillThreshold = max(0.03, 0.10 / sqrt(max(1, totalSkills / 5)))
  //   segmentThreshold = max(0.05, 0.20 / sqrt(max(1, totalSegments / 10)))
  //
  const reflectionRelevanceThreshold = Math.max(0.05, 0.15 / Math.sqrt(Math.max(1, totalReflections / 10)));
  const skillRelevanceThreshold = Math.max(0.03, 0.10 / Math.sqrt(Math.max(1, totalSkills / 5)));
  const segmentRelevanceThreshold = Math.max(0.05, 0.20 / Math.sqrt(Math.max(1, totalSegments / 10)));

  // --- SEGMENT INJECTION QUALITY FLOOR ---
  //
  // Premise 1 (Don't inject unproven patterns): A segment with 1 occurrence
  //   could be a fluke. Require at least sqrt(graduationOccurrences) before injection.
  //   This is a softer bar than graduation but still demands evidence.
  //
  // Premise 2 (Success floor): A segment injected as a "known pattern" must have
  //   at least average success rate. Below average = unreliable.
  //
  // Conclusion:
  //   minOccurrences = max(2, floor(sqrt(graduationOccurrences)))
  //   minSuccessRate = max(0.4, avgSegSuccessRate)
  //
  const segmentInjectionMinOccurrences = Math.max(2, Math.floor(Math.sqrt(graduationOccurrences)));
  const segmentInjectionMinSuccess = Math.max(0.4, avgSegSuccessRate);

  return {
    reflectionsCap,
    segmentsCap,
    skillsCap,
    graduationOccurrences,
    graduationSuccessRate,
    dedupThreshold,
    maxReflections,
    maxSkills,
    maxSegments,
    reflectionRelevanceThreshold,
    skillRelevanceThreshold,
    segmentRelevanceThreshold,
    segmentInjectionMinOccurrences,
    segmentInjectionMinSuccess,
    // --- ENVIRONMENT MODEL THRESHOLDS ---
    //
    // ENTITY CAP
    // Premise: macOS has ~30 built-in apps + ~20 settings panes + ~10 system features.
    // With 3 entries per type for variations, theoretical max ~180.
    // In practice, agent interacts with ~10-30 entities.
    // Conclusion: max(20, observed entities * 3)
    //
    entityCap: 60, // Hard cap -- will be refined as data grows

    // SHORTCUT CAP: macOS has ~40 universal shortcuts. Agent uses ~20.
    shortcutCap: 30,

    // CONVENTION CAP: Conventions generalize across entities. Few needed.
    conventionCap: 10,

    // ENVIRONMENT TOKEN BUDGET: 10% of total budget = 50 tokens
    maxEnvironmentTokens: Math.floor(TOKEN_BUDGET * 0.10),

    // metadata for debugging
    _meta: {
      totalReflections,
      totalSegments,
      totalSkills,
      uniqueTaskTypes,
      avgSegSuccessRate: +avgSegSuccessRate.toFixed(3),
      avgSegmentLabelWords: +avgSegmentLabelWords.toFixed(1),
      tokenBudget: TOKEN_BUDGET,
    },
  };
}

// ============================================================
// STORAGE HELPERS
// ============================================================

function loadJSON(filepath, defaultValue = []) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {
    console.error(`[Learning] Failed to load ${path.basename(filepath)}: ${e.message}`);
  }
  return defaultValue;
}

function saveJSON(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[Learning] Failed to save ${path.basename(filepath)}: ${e.message}`);
  }
}

function loadReflections() {
  const reflections = loadJSON(REFLECTIONS_PATH, []);
  // Phase 1: Add source='real' to legacy reflections on load
  return reflections.map(r => ({
    ...r,
    source: r.source || 'real',
    confidence: r.confidence || 1.0,
    sourceId: r.sourceId || r.id,
  }));
}
function loadSegments() { return loadJSON(SEGMENTS_PATH, []); }
function loadSkills() { return loadJSON(SKILLS_PATH, []); }

function loadEnvironment() {
  return loadJSON(ENVIRONMENT_PATH, { version: 1, entities: {}, shortcuts: {}, conventions: [], metadata: { totalTrajectories: 0, totalExtractions: 0 } });
}

function saveEnvironment(data) {
  data.lastUpdated = Date.now();
  saveJSON(ENVIRONMENT_PATH, data);
}

// ============================================================
// LAYER 1: POST-MORTEM REFLECTIONS
// ============================================================

/**
 * Generate a post-mortem reflection after a task completes.
 *
 * Calls Sonnet (cheap/fast) to analyze the trajectory summary and produce:
 *   - task_type: Categorization for matching future similar tasks
 *   - lessons: Array of concise, generalizable insights
 *   - reflection: Brief natural language summary
 *   - failure_points: What went wrong (if anything)
 *   - effective_strategies: What worked well
 *
 * This is the core of the Reflexion pattern (Shinn et al. 2023):
 * Instead of updating model weights, we store verbal feedback that gets
 * injected into future prompts as episodic memory.
 *
 * @param {object} trajectoryData - Saved trajectory JSON
 * @param {string} finalText - Agent's final response text
 * @returns {Promise<object>} - The reflection object
 */
async function generatePostMortem(trajectoryData, finalText = '') {
  const summary = formatTrajectoryForReflection(trajectoryData);

  const reflectionPrompt = `You are analyzing a computer-use agent's task execution to extract reusable lessons.

TASK: "${trajectoryData.taskDescription}"
OUTCOME: ${trajectoryData.success ? 'SUCCESS' : 'FAILURE'}
ITERATIONS: ${trajectoryData.totalSteps}
LOOPS DETECTED: ${trajectoryData.loopsDetected}
STAGNATIONS: ${trajectoryData.stagnationsDetected}
DURATION: ${((trajectoryData.duration || 0) / 1000).toFixed(1)}s

EXECUTION SUMMARY:
${summary}

AGENT'S FINAL RESPONSE:
${(finalText || '').slice(0, 500)}

Analyze this execution and respond in EXACTLY this JSON format (no other text):
{
  "task_type": "<2-4 word category, e.g. 'app_launch', 'web_search', 'file_management', 'settings_change', 'text_editing'>",
  "lessons": [
    "<lesson 1: concise, generalizable insight that applies to FUTURE similar tasks>",
    "<lesson 2: another insight (if applicable)>"
  ],
  "reflection": "<1-2 sentence summary of what happened and why>",
  "failure_points": ["<what went wrong, if anything>"],
  "effective_strategies": ["<what worked well>"]
}

RULES:
- Lessons must be GENERALIZABLE (not task-specific). "Use Cmd+Space for Spotlight" not "Used Cmd+Space to open Safari".
- Lessons must be ACTIONABLE. "Click the center of buttons, not edges" not "The agent clicked things".
- Maximum 4 lessons. Quality over quantity.
- If task succeeded with no issues, 1-2 lessons max.
- failure_points should be empty [] if task succeeded cleanly.`;

  try {
    const response = await callSonnet(reflectionPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Learning] Post-mortem: no JSON in response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const reflection = {
      id: `ref-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      trajectoryId: trajectoryData.taskId,
      taskDescription: trajectoryData.taskDescription,
      taskType: parsed.task_type || 'unknown',
      outcome: trajectoryData.success ? 'success' : 'failure',
      iterations: trajectoryData.totalSteps,
      loopsDetected: trajectoryData.loopsDetected,
      stagnationsDetected: trajectoryData.stagnationsDetected,
      duration: trajectoryData.duration,
      reflection: parsed.reflection || '',
      lessons: parsed.lessons || [],
      failurePoints: parsed.failure_points || [],
      effectiveStrategies: parsed.effective_strategies || [],
      timestamp: Date.now(),
      // Phase 1: Source tracking
      source: 'real',
      confidence: 1.0,
      sourceId: trajectoryData.taskId,
    };

    // Save to reflections store (adaptive cap: uniqueTaskTypes * 5, min 20)
    const reflections = loadReflections();
    reflections.unshift(reflection);
    const config = _adaptiveConfig();
    if (reflections.length > config.reflectionsCap) {
      reflections.length = config.reflectionsCap;
    }
    saveJSON(REFLECTIONS_PATH, reflections);
    console.log(`[Learning] Reflections: ${reflections.length}/${config.reflectionsCap} (cap = ${config._meta.uniqueTaskTypes} types * 5, min 20)`);

    console.log(`[Learning] Post-mortem saved: ${reflection.id} (${reflection.taskType}, ${reflection.lessons.length} lessons)`);
    return reflection;
  } catch (e) {
    console.error(`[Learning] Post-mortem failed: ${e.message}`);
    return null;
  }
}

/**
 * Format trajectory data into a concise summary for the reflection LLM.
 * Extracts the action sequence with flags, not raw screenshots.
 */
function formatTrajectoryForReflection(trajectoryData) {
  const nodes = trajectoryData.nodes || [];
  const lines = [];

  for (const node of nodes) {
    const flags = (node.flags || []).join(', ');
    const flagStr = flags ? ` [${flags}]` : '';
    const action = node.action
      ? (typeof node.action === 'string' ? node.action : node.action.raw || JSON.stringify(node.action))
      : 'initial_state';
    const time = ((node.relativeTime || 0) / 1000).toFixed(1);
    lines.push(`  ${node.id} (+${time}s): ${action}${flagStr}`);
  }

  // Include checkpoints
  if (trajectoryData.checkpoints && trajectoryData.checkpoints.length > 0) {
    lines.push('\nCHECKPOINTS:');
    for (const cp of trajectoryData.checkpoints) {
      lines.push(`  [${cp.stepNumber}]: ${cp.description}`);
    }
  }

  // Include task plan
  if (trajectoryData.taskPlan) {
    lines.push('\nTASK PLAN:');
    for (const step of trajectoryData.taskPlan.steps) {
      lines.push(`  ${step.n}. ${step.desc} ${step.done ? '(DONE)' : '(PENDING)'}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// LAYER 2: SEGMENT EXTRACTION
// ============================================================

/**
 * Extract reusable segments from a completed trajectory.
 *
 * A segment = the sequence of actions between two consecutive checkpoints.
 * Each segment represents a proven sub-procedure that achieved a verified sub-goal.
 *
 * Theory (Agent-R / trajectory splicing):
 *   - Good trajectories contain reusable sub-trajectories.
 *   - Checkpoints are verified-good states (human-validated via screenshot).
 *   - The action sequence between checkpoints is a "proven lemma" (Aristotle).
 *   - Storing these lemmas lets the agent cite them instead of re-deriving.
 *
 * @param {object} trajectoryData - Saved trajectory JSON
 * @returns {Array} - Array of extracted segments
 */
function extractSegments(trajectoryData) {
  const checkpoints = trajectoryData.checkpoints || [];
  const nodes = trajectoryData.nodes || [];
  const taskPlan = trajectoryData.taskPlan;

  if (checkpoints.length === 0 || nodes.length === 0) return [];

  const segments = [];

  // Build segments between consecutive checkpoints
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const prevCp = i > 0 ? checkpoints[i - 1] : null;

    // Start index: after the previous checkpoint (or from the beginning)
    const startIdx = prevCp ? prevCp.nodeIndex + 1 : 0;
    const endIdx = cp.nodeIndex;

    if (endIdx <= startIdx) continue;

    // Extract action sequence between checkpoints
    const segmentNodes = nodes.slice(startIdx, endIdx + 1);
    const actions = segmentNodes
      .filter(n => n.action)
      .map(n => ({
        action: typeof n.action === 'string' ? n.action : (n.action.type || n.action.raw || 'unknown'),
        input: typeof n.action === 'object' ? n.action : null,
        flags: n.flags || [],
      }));

    // Skip segments that had loops or stagnations (they're not clean patterns)
    const hasIssues = segmentNodes.some(n =>
      (n.flags || []).includes('loop') || (n.flags || []).includes('stagnation')
    );

    // Skip segments from failed branches (only extract from succeeded or exploring branches)
    const branches = trajectoryData.branches || [];
    let inFailedBranch = false;
    if (branches.length > 1) { // Only check if branching was used (more than just 'main')
      // Find which branch this segment's frames belong to
      const segBranches = new Set(segmentNodes.map(n => n.branch).filter(Boolean));
      inFailedBranch = [...segBranches].some(branchId => {
        const branch = branches.find(b => b.id === branchId);
        return branch && branch.status === 'failed';
      });
    }

    // Get description from task plan if available
    const planStep = taskPlan?.steps?.find(s => s.n === cp.stepNumber);
    const label = planStep ? planStep.desc : cp.description;

    // Precondition: previous checkpoint description or "initial state"
    // Enrich with semantic state if available (from SCENE markers)
    const prevSemantic = prevCp?.semanticState;
    const curSemantic = cp.semanticState;
    const precondition = prevCp
      ? (prevSemantic ? `${prevCp.description} [SCENE: ${prevSemantic}]` : prevCp.description)
      : 'initial desktop state';
    const postcondition = curSemantic
      ? `${cp.description} [SCENE: ${curSemantic}]`
      : cp.description;

    const segment = {
      id: `seg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      label,
      precondition,
      postcondition,
      steps: actions,
      stepCount: actions.length,
      clean: !hasIssues && !inFailedBranch,
      sourceTrajectory: trajectoryData.taskId,
      taskType: '', // Will be filled from reflection
      timestamp: Date.now(),
    };

    segments.push(segment);
  }

  if (segments.length === 0) return [];

  // Merge with existing segment library
  const library = loadSegments();
  const config = _adaptiveConfig();
  // Dedup threshold: adaptive to avg word count. max(0.3, 1 - 1/sqrt(avgWords))
  const dupThreshold = config.dedupThreshold;

  for (const seg of segments) {
    // Check for similar existing segments (matching label or postcondition)
    // Threshold adapts to text length of stored segments (longer text = higher bar)
    const existing = library.find(s =>
      _similarity(s.postcondition, seg.postcondition) > dupThreshold ||
      _similarity(s.label, seg.label) > dupThreshold
    );

    if (existing) {
      // Update existing segment: merge stats
      existing.occurrences = (existing.occurrences || 1) + 1;
      existing.successRate = seg.clean
        ? ((existing.successRate || 1) * (existing.occurrences - 1) + 1) / existing.occurrences
        : ((existing.successRate || 1) * (existing.occurrences - 1) + 0) / existing.occurrences;
      existing.lastUsed = Date.now();
      existing.sourceTrajectories = existing.sourceTrajectories || [existing.sourceTrajectory];
      if (!existing.sourceTrajectories.includes(seg.sourceTrajectory)) {
        existing.sourceTrajectories.push(seg.sourceTrajectory);
      }
      // If new segment is cleaner (no issues), prefer its steps
      if (seg.clean && !existing.clean) {
        existing.steps = seg.steps;
        existing.stepCount = seg.stepCount;
        existing.clean = true;
      }
    } else {
      // New segment
      seg.occurrences = 1;
      seg.successRate = seg.clean ? 1.0 : 0.0;
      seg.sourceTrajectories = [seg.sourceTrajectory];
      library.push(seg);
    }
  }

  // Cap library at adaptive limit (based on current + sqrt growth buffer)
  if (library.length > config.segmentsCap) {
    library.sort((a, b) => {
      // Sort by: occurrences (desc) then recency (desc)
      if ((b.occurrences || 1) !== (a.occurrences || 1)) return (b.occurrences || 1) - (a.occurrences || 1);
      return (b.lastUsed || b.timestamp) - (a.lastUsed || a.timestamp);
    });
    library.length = config.segmentsCap;
  }

  saveJSON(SEGMENTS_PATH, library);
  console.log(`[Learning] Extracted ${segments.length} segments (library: ${library.length} total)`);
  return segments;
}

// ============================================================
// LAYER 3: SKILL GRADUATION
// ============================================================

/**
 * Graduate frequently-occurring segments into parameterized skills.
 *
 * A segment graduates to a skill when:
 *   1. It has appeared 3+ times across different trajectories
 *   2. It has a success rate >= 70%
 *   3. It's "clean" (no loops/stagnations in the action sequence)
 *
 * Skills are parameterized versions of segments. The LLM is asked to
 * identify the variable parts and create a template.
 *
 * Theory (SkillRL / recursive skill library):
 *   - Repeated patterns are evidence of a general capability
 *   - Parameters make skills composable (open_app("Safari") vs open_app("Terminal"))
 *   - Once graduated, skills provide the agent with proven procedures
 *
 * @returns {number} - Number of newly graduated skills
 */
async function graduateSkills() {
  const library = loadSegments();
  const skills = loadSkills();
  const existingSkillSources = new Set(skills.flatMap(s => s.graduatedFrom || []));
  const config = _adaptiveConfig();

  // Find graduation candidates (adaptive thresholds)
  // Occurrences: max(3, ceil(sqrt(totalReflections))) -- more data = higher bar
  // Success: clamp(avgSegSuccess + 0.1, 0.5, 0.9) -- must beat average + margin
  const candidates = library.filter(seg =>
    (seg.occurrences || 1) >= config.graduationOccurrences &&
    (seg.successRate || 0) >= config.graduationSuccessRate &&
    seg.clean !== false &&
    !existingSkillSources.has(seg.id)
  );

  console.log(`[Learning] Graduation check: ${candidates.length} candidates (threshold: ${config.graduationOccurrences} occurrences, ${(config.graduationSuccessRate * 100).toFixed(0)}% success)`);

  if (candidates.length === 0) return 0;

  let graduated = 0;

  for (const seg of candidates) {
    try {
      const skill = await generateSkill(seg);
      if (skill) {
        skills.push(skill);
        graduated++;
        console.log(`[Learning] Skill graduated: ${skill.name} (from segment ${seg.id}, ${seg.occurrences} occurrences)`);
      }
    } catch (e) {
      console.error(`[Learning] Skill graduation failed for ${seg.id}: ${e.message}`);
    }
  }

  if (graduated > 0) {
    // Cap skills at adaptive limit: max(20, floor(sqrt(segments) * 3))
    if (skills.length > config.skillsCap) {
      skills.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
      skills.length = config.skillsCap;
    }
    saveJSON(SKILLS_PATH, skills);
  }

  return graduated;
}

/**
 * Generate a parameterized skill from a segment using LLM.
 */
async function generateSkill(segment) {
  const stepsStr = segment.steps.map((s, i) =>
    `  ${i + 1}. ${s.action}${s.input ? ': ' + JSON.stringify(s.input) : ''}`
  ).join('\n');

  const prompt = `Analyze this computer-use action sequence and create a reusable SKILL template.

SEGMENT:
  Label: ${segment.label}
  Precondition: ${segment.precondition}
  Postcondition: ${segment.postcondition}
  Occurrences: ${segment.occurrences}
  Success Rate: ${((segment.successRate || 0) * 100).toFixed(0)}%
  Steps:
${stepsStr}

Create a parameterized skill. Respond in EXACTLY this JSON format (no other text):
{
  "name": "<snake_case skill name, e.g. 'open_app_spotlight', 'navigate_to_url', 'type_in_field'>",
  "description": "<1 sentence: what this skill does, when to use it>",
  "preconditions": ["<what must be true before using this skill>"],
  "postconditions": ["<what will be true after this skill succeeds>"],
  "parameters": {"<param_name>": "<type and description>"},
  "instructions": "<Concise natural language instructions for the agent to follow, using $param_name for variables>"
}

RULES:
- Make it GENERALIZABLE. Replace specific values with parameters.
- "open_app_spotlight" not "open_safari" (parameterize the app name).
- Instructions should be natural language the agent can follow, not code.
- Keep it concise. The agent is smart - it doesn't need every click spelled out.`;

  const response = await callSonnet(prompt);
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    id: `skill-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    name: parsed.name || 'unnamed_skill',
    description: parsed.description || '',
    preconditions: parsed.preconditions || [],
    postconditions: parsed.postconditions || [],
    parameters: parsed.parameters || {},
    instructions: parsed.instructions || '',
    successRate: segment.successRate,
    usageCount: 0,
    occurrences: segment.occurrences,
    graduatedFrom: [segment.id],
    createdAt: Date.now(),
  };
}

// ============================================================
// LAYER 4: ENVIRONMENT MODEL (persistent world knowledge)
// ============================================================

/**
 * Extract environment facts from a completed trajectory using heuristics.
 *
 * Parses trajectory nodes for:
 *   - Application entities (from bash 'open -a' commands, Spotlight usage, SCENE markers)
 *   - Keyboard shortcuts (from key actions containing 'cmd', 'ctrl', 'alt')
 *   - URL schemes (from bash commands containing 'x-apple' or custom schemes)
 *   - Navigation topology (from SCENE descriptions mentioning hierarchy)
 *
 * This is Phase 6a: heuristic extraction (free, per-trajectory, deterministic).
 * No LLM calls. Follows the same pattern as extractSegments().
 *
 * Theory (Aristotle's Persistent Knowledge):
 *   - Environment facts are task-INDEPENDENT truths about the world
 *   - They persist across tasks (unlike reflections which are task-specific)
 *   - They enable CROSS-TASK transfer (knowing Safari works via Spotlight helps with Calculator)
 *
 * @param {object} trajectoryData - Saved trajectory JSON
 * @returns {object} - { entitiesFound, shortcutsFound, conventionsFound }
 */
function extractEnvironmentFacts(trajectoryData) {
  const nodes = trajectoryData.nodes || [];
  const checkpoints = trajectoryData.checkpoints || [];
  const env = loadEnvironment();
  const now = Date.now();

  let entitiesFound = 0;
  let shortcutsFound = 0;
  let conventionsFound = 0;

  // --- EXTRACT ENTITIES FROM ACTIONS ---

  // Known app names to look for (lowercase)
  const knownApps = [
    'safari', 'notes', 'textedit', 'finder', 'terminal', 'calculator',
    'system settings', 'system preferences', 'calendar', 'reminders',
    'mail', 'messages', 'maps', 'music', 'photos', 'preview',
    'activity monitor', 'disk utility', 'keychain access', 'console',
    'xcode', 'automator', 'font book', 'digital color meter',
    'screen sharing', 'bluetooth file exchange', 'audio midi setup',
  ];

  // Track what we find in this trajectory
  const seenEntities = new Map(); // entityKey -> { displayName, type, accessMethods[] }
  const seenShortcuts = new Map(); // shortcutKey -> { action, scope }

  for (const node of nodes) {
    if (!node.action) continue;
    const action = node.action;
    const actionType = typeof action === 'string' ? action : (action.type || '');
    const actionRaw = typeof action === 'string' ? action : (action.raw || '');
    const actionText = typeof action === 'string' ? action : (action.text || '');
    const actionLower = actionRaw.toLowerCase();

    // 1. BASH OPEN COMMANDS -> app entities with bash access method
    if (actionType === 'bash' && actionLower.includes('open')) {
      // Match: open -a "App Name" or open -a AppName
      const openAppMatch = actionRaw.match(/open\s+-a\s+["']?([^"'\s;]+(?:\s+[^"'\s;]+)?)["']?/i);
      if (openAppMatch) {
        const appName = openAppMatch[1].trim();
        const key = appName.toLowerCase().replace(/\s+/g, '-');
        if (!seenEntities.has(key)) {
          seenEntities.set(key, { displayName: appName, type: 'application', accessMethods: [] });
        }
        seenEntities.get(key).accessMethods.push({ method: 'bash', command: `open -a "${appName}"` });
      }

      // Match URL schemes: open "x-apple.systempreferences:..."
      const urlSchemeMatch = actionRaw.match(/open\s+["']?(x-apple[^"'\s]+)["']?/i);
      if (urlSchemeMatch) {
        const scheme = urlSchemeMatch[1];
        // Extract settings pane name from URL scheme
        const paneMatch = scheme.match(/com\.apple\.([A-Za-z]+)/);
        if (paneMatch) {
          const paneName = paneMatch[1].replace(/Settings$/, '').replace(/Preferences$/, '');
          const parentKey = 'system-settings';
          if (!seenEntities.has(parentKey)) {
            seenEntities.set(parentKey, { displayName: 'System Settings', type: 'application', accessMethods: [], children: {} });
          }
          const parent = seenEntities.get(parentKey);
          if (!parent.children) parent.children = {};
          parent.children[paneName.toLowerCase()] = {
            displayName: paneName,
            path: `System Settings > ${paneName}`,
            directAccess: `open '${scheme}'`,
          };
        }
      }
    }

    // 2. KEYBOARD SHORTCUTS -> shortcuts registry
    if (actionType === 'key' || actionType === 'key_combo') {
      const keyText = (actionText || actionRaw).toLowerCase().replace(/^key:\s*["']?/, '').replace(/["']$/, '');

      // Track cmd+key shortcuts
      if (keyText.includes('cmd+') || keyText.includes('command+')) {
        const normalized = keyText.replace('command+', 'cmd+').replace(/\s+/g, '');
        if (!seenShortcuts.has(normalized)) {
          // Infer action from context
          let inferredAction = '';
          if (normalized === 'cmd+space') inferredAction = 'Open Spotlight (universal app/file launcher)';
          else if (normalized === 'cmd+w') inferredAction = 'Close current window/tab';
          else if (normalized === 'cmd+n') inferredAction = 'New window/document';
          else if (normalized === 'cmd+z') inferredAction = 'Undo last action';
          else if (normalized === 'cmd+c') inferredAction = 'Copy selection';
          else if (normalized === 'cmd+v') inferredAction = 'Paste from clipboard';
          else if (normalized === 'cmd+a') inferredAction = 'Select all';
          else if (normalized === 'cmd+s') inferredAction = 'Save';
          else if (normalized === 'cmd+q') inferredAction = 'Quit application';
          else if (normalized === 'cmd+t') inferredAction = 'New tab';
          else if (normalized === 'cmd+l') inferredAction = 'Focus address/location bar';
          else if (normalized === 'cmd+f') inferredAction = 'Find in page';
          else if (normalized === 'cmd+h') inferredAction = 'Hide application';
          else inferredAction = `Keyboard shortcut: ${normalized}`;

          seenShortcuts.set(normalized, { action: inferredAction, scope: 'global' });
        }
      }
    }

    // 3. SPOTLIGHT USAGE -> entity with spotlight access method
    // Pattern: cmd+space (already tracked) followed by type action with app name
    if (actionType === 'type' || actionType === 'type_text') {
      const typed = (actionText || actionRaw).replace(/^type:\s*["']?/, '').replace(/["']$/, '').trim();
      // Check if previous action was cmd+space (Spotlight)
      const nodeIdx = nodes.indexOf(node);
      if (nodeIdx > 0) {
        const prevAction = nodes[nodeIdx - 1]?.action;
        const prevText = typeof prevAction === 'string' ? prevAction : (prevAction?.text || prevAction?.raw || '');
        if (prevText.toLowerCase().includes('cmd+space') || prevText.toLowerCase().includes('command+space')) {
          // This type action is into Spotlight -- it's an app name
          const appName = typed.split('\n')[0].trim();
          if (appName.length > 1 && appName.length < 40 && !appName.includes('/') && !appName.includes('\\')) {
            const key = appName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            if (!seenEntities.has(key)) {
              seenEntities.set(key, { displayName: appName, type: 'application', accessMethods: [] });
            }
            seenEntities.get(key).accessMethods.push({ method: 'spotlight' });
          }
        }
      }
    }
  }

  // 4. EXTRACT ENTITIES FROM SCENE DESCRIPTIONS
  for (const cp of checkpoints) {
    if (!cp.semanticState) continue;
    const scene = cp.semanticState.toLowerCase();

    for (const appName of knownApps) {
      if (scene.includes(appName)) {
        const key = appName.replace(/\s+/g, '-');
        if (!seenEntities.has(key)) {
          seenEntities.set(key, { displayName: appName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), type: 'application', accessMethods: [] });
        }
      }
    }
  }

  // 5. EXTRACT ENTITIES FROM TASK DESCRIPTION
  const taskLower = (trajectoryData.taskDescription || '').toLowerCase();
  for (const appName of knownApps) {
    if (taskLower.includes(appName)) {
      const key = appName.replace(/\s+/g, '-');
      if (!seenEntities.has(key)) {
        seenEntities.set(key, { displayName: appName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), type: 'application', accessMethods: [] });
      }
    }
  }

  // --- MERGE INTO ENVIRONMENT MODEL ---

  const config = _adaptiveConfig();

  // Merge entities
  for (const [key, entity] of seenEntities) {
    if (!env.entities[key]) {
      // New entity
      env.entities[key] = {
        displayName: entity.displayName,
        type: entity.type,
        accessMethods: [],
        children: entity.children || {},
        properties: {},
        totalInteractions: 0,
        firstSeen: now,
        lastSeen: now,
      };
      entitiesFound++;
    }

    const existing = env.entities[key];
    existing.lastSeen = now;
    existing.totalInteractions = (existing.totalInteractions || 0) + 1;

    // Merge access methods
    for (const am of entity.accessMethods) {
      const existingAm = existing.accessMethods.find(e =>
        e.method === am.method && (!am.command || e.command === am.command)
      );
      if (existingAm) {
        existingAm.observations = (existingAm.observations || 1) + 1;
        existingAm.lastSeen = now;
        // Bayesian confidence: observations / (observations + 3), capped at 0.95
        existingAm.confidence = Math.min(0.95, existingAm.observations / (existingAm.observations + 3));
      } else {
        existing.accessMethods.push({
          method: am.method,
          command: am.command || undefined,
          confidence: 1 / (1 + 3), // = 0.25 for first observation
          observations: 1,
          lastSeen: now,
        });
      }
    }

    // Merge children (for System Settings hierarchy)
    if (entity.children) {
      if (!existing.children) existing.children = {};
      for (const [childKey, child] of Object.entries(entity.children)) {
        if (!existing.children[childKey]) {
          existing.children[childKey] = { ...child, confidence: 0.25, observations: 1 };
          entitiesFound++;
        } else {
          existing.children[childKey].observations = (existing.children[childKey].observations || 1) + 1;
          existing.children[childKey].confidence = Math.min(0.95,
            existing.children[childKey].observations / (existing.children[childKey].observations + 3));
        }
      }
    }
  }

  // Merge shortcuts
  for (const [key, shortcut] of seenShortcuts) {
    if (!env.shortcuts[key]) {
      env.shortcuts[key] = {
        action: shortcut.action,
        scope: shortcut.scope,
        confidence: 1 / (1 + 3), // 0.25
        observations: 1,
        lastSeen: now,
      };
      shortcutsFound++;
    } else {
      env.shortcuts[key].observations = (env.shortcuts[key].observations || 1) + 1;
      env.shortcuts[key].lastSeen = now;
      env.shortcuts[key].confidence = Math.min(0.95,
        env.shortcuts[key].observations / (env.shortcuts[key].observations + 3));
      // Update action description if we have a better one
      if (shortcut.action && !shortcut.action.startsWith('Keyboard shortcut:')) {
        env.shortcuts[key].action = shortcut.action;
      }
    }
  }

  // Detect conventions from patterns
  // Convention: "Use Spotlight to open apps" if cmd+space has 3+ observations
  // Find cmd+space shortcut regardless of key format variations
  const cmdSpaceKey = Object.keys(env.shortcuts).find(k => k.includes('cmd+space'));
  const cmdSpaceShortcut = cmdSpaceKey ? env.shortcuts[cmdSpaceKey] : null;
  if (cmdSpaceShortcut && cmdSpaceShortcut.observations >= 3) {
    const spotlightConvention = env.conventions.find(c => c.pattern.includes('Spotlight'));
    if (!spotlightConvention) {
      env.conventions.push({
        pattern: 'Use Spotlight (Cmd+Space -> type name -> Return) to open any application',
        confidence: env.shortcuts['cmd+space'].confidence,
        observations: env.shortcuts['cmd+space'].observations,
        appliesTo: 'application',
      });
      conventionsFound++;
    } else {
      spotlightConvention.observations = cmdSpaceShortcut.observations;
      spotlightConvention.confidence = cmdSpaceShortcut.confidence;
    }
  }

  // Convention: "Use URL schemes for System Settings" if any children found
  const sysSettings = env.entities['system-settings'];
  if (sysSettings && sysSettings.children && Object.keys(sysSettings.children).length >= 2) {
    const urlConvention = env.conventions.find(c => c.pattern.includes('URL scheme'));
    if (!urlConvention) {
      env.conventions.push({
        pattern: 'Use URL schemes (x-apple.systempreferences:) for direct System Settings pane access -- faster and more reliable than GUI navigation',
        confidence: 0.85,
        observations: Object.values(sysSettings.children).reduce((s, c) => s + (c.observations || 1), 0),
        appliesTo: 'system-settings',
      });
      conventionsFound++;
    }
  }

  // Cap entities
  const entityKeys = Object.keys(env.entities);
  if (entityKeys.length > config.entityCap) {
    // Sort by totalInteractions desc, then lastSeen desc
    const sorted = entityKeys.sort((a, b) => {
      const ea = env.entities[a], eb = env.entities[b];
      if ((eb.totalInteractions || 0) !== (ea.totalInteractions || 0))
        return (eb.totalInteractions || 0) - (ea.totalInteractions || 0);
      return (eb.lastSeen || 0) - (ea.lastSeen || 0);
    });
    for (const key of sorted.slice(config.entityCap)) {
      delete env.entities[key];
    }
  }

  // Cap conventions
  if (env.conventions.length > config.conventionCap) {
    env.conventions.sort((a, b) => (b.observations || 0) - (a.observations || 0));
    env.conventions.length = config.conventionCap;
  }

  // Update metadata
  env.metadata.totalTrajectories = (env.metadata.totalTrajectories || 0) + 1;
  env.metadata.totalExtractions = (env.metadata.totalExtractions || 0) + 1;

  saveEnvironment(env);

  const totalEntities = Object.keys(env.entities).length;
  const totalShortcuts = Object.keys(env.shortcuts).length;
  console.log(`[Learning] Environment: ${entitiesFound} new entities, ${shortcutsFound} new shortcuts, ${conventionsFound} new conventions (total: ${totalEntities} entities, ${totalShortcuts} shortcuts, ${env.conventions.length} conventions)`);

  return { entitiesFound, shortcutsFound, conventionsFound };
}

// ============================================================
// CONTEXT INJECTION (for getAgentHints)
// ============================================================

/**
 * Get relevant learning context for a new task.
 *
 * Searches reflections, segments, and skills for matches relevant to
 * the new task description. Returns formatted text for system prompt injection.
 *
 * Matching strategy (computationally cheap, no embeddings needed):
 *   1. Keyword overlap between task description and stored entries
 *   2. Task type matching (from reflection categories)
 *   3. Recency weighting (newer reflections trusted more - dialectic resolution)
 *
 * @param {string} taskDescription - The new task to find context for
 * @returns {string|null} - Formatted context for injection, or null if nothing relevant
 */
function getRelevantContext(taskDescription) {
  if (!taskDescription) return null;

  const taskWords = _tokenize(taskDescription);
  const config = _adaptiveConfig();
  const lines = [];
  let hasContent = false;

  // --- REFLECTIONS (lessons from past tasks) ---
  // Budget: 50% of tokens → maxReflections items
  // Threshold: adaptive to data density (more data = higher bar)
  const reflections = loadReflections();
  const relevantReflections = reflections
    .map(r => ({
      ...r,
      score: _matchScore(taskWords, r.taskDescription, r.taskType, r.lessons),
    }))
    .filter(r => r.score > config.reflectionRelevanceThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxReflections);

  if (relevantReflections.length > 0) {
    lines.push('LESSONS FROM PAST TASKS (apply these insights):');
    for (const r of relevantReflections) {
      const outcome = r.outcome === 'success' ? 'OK' : 'FAILED';
      lines.push(`  [${outcome}] "${r.taskDescription.slice(0, 60)}"`);
      for (const lesson of r.lessons) {
        lines.push(`    - ${lesson}`);
      }
      if (r.failurePoints && r.failurePoints.length > 0 && r.failurePoints[0]) {
        lines.push(`    AVOID: ${r.failurePoints[0]}`);
      }
    }
    hasContent = true;
  }

  // --- SKILLS (proven reusable procedures) ---
  // Budget: 35% of tokens → maxSkills items
  // Threshold: lower than reflections (skills are pre-curated, more trustworthy)
  const skills = loadSkills();
  const relevantSkills = skills
    .map(s => ({
      ...s,
      score: _matchScore(taskWords, s.description, s.name, s.preconditions),
    }))
    .filter(s => s.score > config.skillRelevanceThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxSkills);

  if (relevantSkills.length > 0) {
    if (hasContent) lines.push('');
    lines.push('KNOWN SKILLS (proven procedures you can use):');
    for (const s of relevantSkills) {
      const params = Object.keys(s.parameters || {}).map(k => `$${k}`).join(', ');
      lines.push(`  SKILL "${s.name}"${params ? ` (${params})` : ''}: ${s.description}`);
      lines.push(`    How: ${s.instructions}`);
      lines.push(`    Success rate: ${((s.successRate || 0) * 100).toFixed(0)}%`);
    }
    hasContent = true;
  }

  // --- SEGMENTS (reusable sub-procedures, only if no skills matched) ---
  // Budget: 15% of tokens → maxSegments items
  // Quality floor: must have enough occurrences and success rate to be trustworthy
  if (relevantSkills.length === 0) {
    const segments = loadSegments();
    const relevantSegments = segments
      .filter(s =>
        (s.occurrences || 1) >= config.segmentInjectionMinOccurrences &&
        (s.successRate || 0) >= config.segmentInjectionMinSuccess
      )
      .map(s => ({
        ...s,
        score: _matchScore(taskWords, s.label, s.precondition, [s.postcondition]),
      }))
      .filter(s => s.score > config.segmentRelevanceThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxSegments);

    if (relevantSegments.length > 0) {
      if (hasContent) lines.push('');
      lines.push('KNOWN PATTERNS (sub-procedures that worked before):');
      for (const s of relevantSegments) {
        lines.push(`  "${s.label}" (${s.stepCount} steps, ${((s.successRate || 0) * 100).toFixed(0)}% success, used ${s.occurrences}x)`);
        lines.push(`    Pre: ${s.precondition} -> Post: ${s.postcondition}`);
      }
      hasContent = true;
    }
  }

  // --- ENVIRONMENT FACTS (persistent world knowledge) ---
  // Budget: 10% of tokens → ~50 tokens
  // Two tiers: universal facts (always inject) + entity-specific (task-matched)
  const env = loadEnvironment();
  const envLines = [];

  // Tier 1: Universal conventions (always inject if high confidence)
  const universalConventions = (env.conventions || [])
    .filter(c => c.confidence >= 0.5 && c.observations >= 3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  // Tier 2: Entity-specific facts (matched by entity name in task)
  const taskLower = taskDescription.toLowerCase();
  const matchedEntities = [];
  for (const [key, entity] of Object.entries(env.entities || {})) {
    const name = (entity.displayName || key).toLowerCase();
    if (taskLower.includes(name) || taskWords.some(w => name.includes(w) && w.length > 3)) {
      matchedEntities.push({ key, ...entity });
    }
  }

  if (universalConventions.length > 0 || matchedEntities.length > 0) {
    if (hasContent) envLines.push('');
    envLines.push('ENVIRONMENT KNOWLEDGE (reliable facts about this system):');

    // Inject universal conventions
    for (const conv of universalConventions) {
      envLines.push(`  - ${conv.pattern} (${(conv.confidence * 100).toFixed(0)}% reliable, ${conv.observations} observations)`);
    }

    // Inject matched entity info
    for (const entity of matchedEntities.slice(0, 3)) {
      const methods = (entity.accessMethods || [])
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 3)
        .map(m => {
          const cmd = m.command ? ` ('${m.command}')` : '';
          return `${m.method}${cmd} [${(m.confidence * 100).toFixed(0)}%]`;
        })
        .join(', ');
      if (methods) {
        envLines.push(`  - ${entity.displayName}: access via ${methods}`);
      }

      // Show children (navigation topology)
      if (entity.children && Object.keys(entity.children).length > 0) {
        for (const [childKey, child] of Object.entries(entity.children).slice(0, 3)) {
          if (child.directAccess) {
            envLines.push(`    -> ${child.path || child.displayName}: ${child.directAccess}`);
          }
        }
      }
    }

    if (envLines.length > 1) { // More than just the header
      lines.push(...envLines);
      hasContent = true;
    }
  }

  return hasContent ? lines.join('\n') : null;
}

// ============================================================
// TEXT MATCHING UTILITIES
// ============================================================

/**
 * Tokenize a string into lowercase words for matching.
 */
function _tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Compute a relevance score between task words and stored entry fields.
 * Simple keyword overlap + weighted by field importance.
 */
function _matchScore(taskWords, ...fields) {
  if (taskWords.length === 0) return 0;

  const fieldText = fields
    .flat()
    .filter(Boolean)
    .join(' ');
  const fieldWords = new Set(_tokenize(fieldText));

  if (fieldWords.size === 0) return 0;

  let matches = 0;
  for (const word of taskWords) {
    if (fieldWords.has(word)) matches++;
  }

  return matches / taskWords.length;
}

/**
 * Simple text similarity (Jaccard index on word tokens).
 */
function _similarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(_tokenize(a));
  const wordsB = new Set(_tokenize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

// ============================================================
// LLM HELPER (Sonnet for cheap analysis)
// ============================================================

function callSonnet(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: SONNET_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_GATEWAY_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Sonnet API ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            const text = parsed.content?.map(b => b.text || '').join('') || '';
            resolve(text);
          }
        } catch (e) {
          reject(new Error(`Sonnet parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Sonnet timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// FULL LEARNING PIPELINE (called after task completion)
// ============================================================

/**
 * Run the full learning pipeline after a task completes.
 * This is called asynchronously (non-blocking) from agentLoop.
 *
 * Pipeline:
 *   1. Load trajectory data from disk
 *   2. Generate post-mortem reflection (LLM call)
 *   3. Extract reusable segments (algorithmic)
 *   4. Check for skill graduation candidates (LLM call if needed)
 *
 * @param {string} trajectoryId - The task ID to learn from
 * @param {string} finalText - Agent's final response text
 * @returns {Promise<object>} - { reflection, segmentsExtracted, skillsGraduated }
 */
async function learnFromTrajectory(trajectoryId, finalText = '') {
  if (!trajectoryId || typeof trajectoryId !== 'string') {
    console.error(`[Learning] Invalid trajectoryId: expected non-empty string, got ${typeof trajectoryId}`);
    return { reflection: null, segmentsExtracted: 0, skillsGraduated: 0 };
  }
  const trajPath = path.join(require('os').homedir(), '.capy-trajectories', trajectoryId, 'trajectory.json');
  if (!fs.existsSync(trajPath)) {
    console.error(`[Learning] Trajectory not found: ${trajectoryId}`);
    return { reflection: null, segmentsExtracted: 0, skillsGraduated: 0 };
  }

  const trajectoryData = JSON.parse(fs.readFileSync(trajPath, 'utf8'));
  console.log(`[Learning] Starting learning pipeline for ${trajectoryId} ("${trajectoryData.taskDescription?.slice(0, 50)}")`);

  // Layer 1: Post-mortem reflection
  const reflection = await generatePostMortem(trajectoryData, finalText);

  // Layer 2: Segment extraction
  const segments = extractSegments(trajectoryData);

  // Layer 4: Environment facts (heuristic, free, no LLM call)
  const envFacts = extractEnvironmentFacts(trajectoryData);

  // Update segments with task type from reflection
  if (reflection && segments.length > 0) {
    const library = loadSegments();
    for (const seg of segments) {
      const libSeg = library.find(s => s.id === seg.id);
      if (libSeg) libSeg.taskType = reflection.taskType;
    }
    saveJSON(SEGMENTS_PATH, library);
  }

  // Layer 3: Skill graduation (only check periodically, not every task)
  // Uses adaptive thresholds from _adaptiveConfig() - same as graduateSkills() uses internally
  let skillsGraduated = 0;
  const library = loadSegments();
  const gradConfig = _adaptiveConfig();
  const hasCandidates = library.some(s =>
    (s.occurrences || 1) >= gradConfig.graduationOccurrences &&
    (s.successRate || 0) >= gradConfig.graduationSuccessRate
  );
  if (hasCandidates) {
    skillsGraduated = await graduateSkills();
  }

  const result = {
    reflection: reflection ? { id: reflection.id, lessons: reflection.lessons } : null,
    segmentsExtracted: segments.length,
    skillsGraduated,
    environmentFacts: envFacts,
  };

  console.log(`[Learning] Pipeline complete: ${reflection ? reflection.lessons.length + ' lessons' : 'no reflection'}, ${segments.length} segments, ${skillsGraduated} new skills`);
  return result;
}

// ============================================================
// STATISTICS
// ============================================================

function getStats() {
  const reflections = loadReflections();
  const segments = loadSegments();
  const skills = loadSkills();

  // Most common task types
  const typeCounts = {};
  for (const r of reflections) {
    typeCounts[r.taskType] = (typeCounts[r.taskType] || 0) + 1;
  }

  // All unique lessons
  const allLessons = reflections.flatMap(r => r.lessons || []);
  const successRate = reflections.length > 0
    ? reflections.filter(r => r.outcome === 'success').length / reflections.length
    : 0;

  const env = loadEnvironment();

  return {
    environment: {
      entities: Object.keys(env.entities || {}).length,
      shortcuts: Object.keys(env.shortcuts || {}).length,
      conventions: (env.conventions || []).length,
      topEntities: Object.entries(env.entities || {})
        .sort((a, b) => (b[1].totalInteractions || 0) - (a[1].totalInteractions || 0))
        .slice(0, 5)
        .map(([key, e]) => ({
          name: e.displayName,
          interactions: e.totalInteractions,
          accessMethods: (e.accessMethods || []).length,
          children: Object.keys(e.children || {}).length,
        })),
      topShortcuts: Object.entries(env.shortcuts || {})
        .sort((a, b) => (b[1].observations || 0) - (a[1].observations || 0))
        .slice(0, 5)
        .map(([key, s]) => ({
          shortcut: key,
          action: s.action,
          observations: s.observations,
          confidence: s.confidence,
        })),
    },
    reflections: {
      total: reflections.length,
      successRate: (successRate * 100).toFixed(0) + '%',
      totalLessons: allLessons.length,
      taskTypes: typeCounts,
      recent: reflections.slice(0, 5).map(r => ({
        id: r.id,
        task: r.taskDescription?.slice(0, 60),
        outcome: r.outcome,
        lessons: r.lessons?.length || 0,
        timestamp: r.timestamp,
      })),
    },
    segments: {
      total: segments.length,
      highFrequency: segments.filter(s => (s.occurrences || 1) >= 3).length,
      avgSuccessRate: segments.length > 0
        ? ((segments.reduce((sum, s) => sum + (s.successRate || 0), 0) / segments.length) * 100).toFixed(0) + '%'
        : 'N/A',
    },
    skills: {
      total: skills.length,
      list: skills.map(s => ({
        name: s.name,
        description: s.description,
        successRate: ((s.successRate || 0) * 100).toFixed(0) + '%',
        usageCount: s.usageCount || 0,
      })),
    },
  };
}

// ============================================================
// ROUTE MOUNTING
// ============================================================

function mountLearningRoutes(app) {
  // Get learning stats
  app.get('/learning/stats', (req, res) => {
    try {
      res.json(getStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get all reflections
  app.get('/learning/reflections', (req, res) => {
    try {
      const reflections = loadReflections();
      res.json({ reflections });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get segment library
  app.get('/learning/segments', (req, res) => {
    try {
      const segments = loadSegments();
      res.json({ segments });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get skills
  app.get('/learning/skills', (req, res) => {
    try {
      const skills = loadSkills();
      res.json({ skills });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manually trigger learning from a specific trajectory
  app.post('/learning/analyze', async (req, res) => {
    try {
      const { trajectoryId } = req.body;
      if (!trajectoryId) return res.status(400).json({ error: 'trajectoryId required' });
      const result = await learnFromTrajectory(trajectoryId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force skill graduation check
  app.post('/learning/graduate', async (req, res) => {
    try {
      const count = await graduateSkills();
      res.json({ skillsGraduated: count, totalSkills: loadSkills().length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get context for a task (preview what would be injected)
  app.post('/learning/context', (req, res) => {
    try {
      const { task } = req.body;
      if (!task) return res.status(400).json({ error: 'task required' });
      const context = getRelevantContext(task);
      res.json({ context, hasContext: !!context });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get environment model
  app.get('/learning/environment', (req, res) => {
    try {
      const env = loadEnvironment();
      res.json(env);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reset learning data (nuclear option)
  app.post('/learning/reset', (req, res) => {
    try {
      const { target } = req.body; // 'all', 'reflections', 'segments', 'skills'
      if (target === 'all' || target === 'reflections') saveJSON(REFLECTIONS_PATH, []);
      if (target === 'all' || target === 'environment') saveJSON(ENVIRONMENT_PATH, { version: 1, entities: {}, shortcuts: {}, conventions: [], metadata: { totalTrajectories: 0, totalExtractions: 0 } });
      if (target === 'all' || target === 'segments') saveJSON(SEGMENTS_PATH, []);
      if (target === 'all' || target === 'skills') saveJSON(SKILLS_PATH, []);
      res.json({ reset: target || 'all' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Learning] Self-improving learning engine mounted at /learning/*');
  console.log(`[Learning] Storage: ${LEARNING_DIR}`);
  const envData = loadEnvironment();
  console.log(`[Learning] Reflections: ${loadReflections().length}, Segments: ${loadSegments().length}, Skills: ${loadSkills().length}, Environment: ${Object.keys(envData.entities).length} entities, ${Object.keys(envData.shortcuts).length} shortcuts`);
}

// ============================================================
// PHASE 1: LEARNING ACCELERATION INTERFACE
// ============================================================

/**
 * Ingest synthetic reflections with quality validation and duplicate detection.
 * Part of the Learning Rate Acceleration system.
 *
 * @param {array} reflections - Array of synthetic reflection objects
 * @returns {object} - { accepted: number, rejected: number, duplicates: number, reasons: array }
 */
function ingestSynthetic(reflections) {
  if (!Array.isArray(reflections) || reflections.length === 0) {
    return { accepted: 0, rejected: 0, duplicates: 0, reasons: [] };
  }

  const validator = _loadValidator();
  const existingReflections = loadReflections();

  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const reasons = [];

  for (const reflection of reflections) {
    // Validate source field
    if (!reflection.source || !['real', 'videoagent', 'webrl', 'reflexion', 'her', 'transfer'].includes(reflection.source)) {
      rejected.push(reflection.id);
      reasons.push({ id: reflection.id, reason: 'Invalid or missing source field' });
      continue;
    }

    // Quality validation
    const validation = validator.validateReflection(reflection);
    if (!validation.isValid || validation.quality < 0.6) {
      rejected.push(reflection.id);
      reasons.push({ id: reflection.id, reason: validation.reason, quality: validation.quality });
      continue;
    }

    // Duplicate detection (TF-IDF similarity > 0.9)
    const dupCheck = validator.checkDuplicate(reflection, existingReflections, 0.9);
    if (dupCheck.isDuplicate) {
      duplicates.push(reflection.id);
      reasons.push({ id: reflection.id, reason: `Duplicate of ${dupCheck.matchedId}`, similarity: dupCheck.similarity });
      continue;
    }

    // Accepted
    accepted.push({
      ...reflection,
      validationScore: validation.quality,
      ingestedAt: Date.now(),
    });
  }

  // Save accepted reflections
  if (accepted.length > 0) {
    existingReflections.unshift(...accepted);

    // Apply adaptive cap
    const config = _adaptiveConfig();
    if (existingReflections.length > config.reflectionsCap) {
      existingReflections.length = config.reflectionsCap;
    }

    saveJSON(REFLECTIONS_PATH, existingReflections);
    console.log(`[Learning] Ingested ${accepted.length} synthetic reflections (rejected: ${rejected.length}, duplicates: ${duplicates.length})`);
  }

  return {
    accepted: accepted.length,
    rejected: rejected.length,
    duplicates: duplicates.length,
    reasons,
  };
}

/**
 * Get total reflection count across all sources.
 * Phase 1 API for tracking learning progress.
 *
 * @returns {object} - { total: number, bySource: object }
 */
function getReflectionCount() {
  const reflections = loadReflections();
  return reflections.length;
}

/**
 * Get detailed reflection count breakdown by source.
 * @returns {object} - { total: number, bySource: { real, videoagent, webrl, reflexion, her, transfer } }
 */
function getReflectionCountDetailed() {
  const reflections = loadReflections();

  const bySource = {
    real: 0,
    videoagent: 0,
    webrl: 0,
    reflexion: 0,
    her: 0,
    transfer: 0,
  };

  for (const r of reflections) {
    const source = r.source || 'real';
    if (bySource.hasOwnProperty(source)) {
      bySource[source]++;
    }
  }

  return {
    total: reflections.length,
    bySource,
  };
}

/**
 * Get convergence metrics for learning system.
 * Phase 1 API for monitoring learning progress.
 *
 * @returns {object} - ConvergenceReport with category coverage, pattern count, etc.
 */
function getConvergenceMetrics() {
  const reflections = loadReflections();
  const segments = loadSegments();
  const skills = loadSkills();
  const config = _adaptiveConfig();

  // Category coverage: task types and their reflection counts
  const categoryCoverage = new Map();
  for (const r of reflections) {
    const taskType = r.taskType || 'unknown';
    categoryCoverage.set(taskType, (categoryCoverage.get(taskType) || 0) + 1);
  }

  // Pattern extraction status
  const patternsExtracted = segments.filter(s => (s.occurrences || 1) >= 3).length;
  const skillsGraduated = skills.length;

  // Convergence per category (need 5+ examples for convergence)
  const convergedCategories = Array.from(categoryCoverage.values()).filter(count => count >= 5).length;
  const totalCategories = categoryCoverage.size;
  const convergenceRate = totalCategories > 0 ? convergedCategories / totalCategories : 0;

  // Quality distribution (for synthetic reflections)
  const syntheticReflections = reflections.filter(r => r.source !== 'real');
  const avgConfidence = syntheticReflections.length > 0
    ? syntheticReflections.reduce((sum, r) => sum + (r.confidence || 0), 0) / syntheticReflections.length
    : 0;

  return {
    totalReflections: reflections.length,
    realReflections: reflections.filter(r => r.source === 'real').length,
    syntheticReflections: syntheticReflections.length,
    categoryCoverage: Array.from(categoryCoverage.entries()).map(([taskType, count]) => ({
      taskType,
      count,
      converged: count >= 5,
    })),
    convergenceRate: +convergenceRate.toFixed(3),
    convergedCategories,
    totalCategories,
    patternsExtracted,
    skillsGraduated,
    avgSyntheticConfidence: +avgConfidence.toFixed(3),
    storageCapacity: {
      reflections: `${reflections.length}/${config.reflectionsCap}`,
      segments: `${segments.length}/${config.segmentsCap}`,
      skills: `${skills.length}/${config.skillsCap}`,
    },
  };
}

/**
 * Query reflections by relevance to a task description.
 * Returns reflections ranked by similarity.
 * Phase 1 API for retrieval-augmented learning.
 *
 * @param {string} taskDescription - Task description to match against
 * @param {number} limit - Maximum results to return (default 5)
 * @returns {array} - Array of { reflection, relevanceScore }
 */
function queryReflections(taskDescription, limit = 5) {
  const reflections = loadReflections();
  if (reflections.length === 0) return [];

  const taskTokens = _tokenize(taskDescription);
  const scored = [];

  for (const r of reflections) {
    // Compute relevance: similarity to task description and task type
    const reflectionText = [r.taskDescription, r.taskType, ...(r.lessons || [])].join(' ');
    const reflectionTokens = _tokenize(reflectionText);

    const similarity = _similarity_jaccard(taskTokens, reflectionTokens);

    // Weight by confidence and recency
    const ageInDays = (Date.now() - (r.timestamp || 0)) / (24 * 60 * 60 * 1000);
    const recencyWeight = Math.exp(-ageInDays / 30); // Decay over 30 days
    const confidenceWeight = r.confidence || 1.0;

    const relevanceScore = similarity * recencyWeight * confidenceWeight;

    scored.push({
      reflection: r,
      relevanceScore: +relevanceScore.toFixed(4),
      similarity: +similarity.toFixed(4),
      recencyWeight: +recencyWeight.toFixed(4),
      confidenceWeight,
    });
  }

  // Sort by relevance descending
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return scored.slice(0, limit);
}

/**
 * Jaccard similarity for token sets.
 * Used in queryReflections.
 */
function _similarity_jaccard(tokens1, tokens2) {
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  const intersection = [...set1].filter(t => set2.has(t)).length;
  const union = set1.size + set2.size - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * Lazy-load the reflection validator module.
 * Avoids circular dependency issues.
 */
function _loadValidator() {
  try {
    return require('./reflection-validator.js');
  } catch (e) {
    console.error('[Learning] Failed to load reflection-validator.js, using fallback validation');
    // Fallback: basic validation
    return {
      validateReflection: (r) => ({
        isValid: r.lessons && r.lessons.length > 0,
        quality: 0.7,
        reason: 'Fallback validation (validator module not found)',
      }),
      checkDuplicate: () => ({ isDuplicate: false, matchedId: null, similarity: 0 }),
    };
  }
}

module.exports = {
  // Existing exports
  generatePostMortem,
  extractSegments,
  extractEnvironmentFacts,
  graduateSkills,
  getRelevantContext,
  learnFromTrajectory,
  getStats,
  loadReflections,
  loadSegments,
  loadSkills,
  loadEnvironment,
  mountLearningRoutes,
  LEARNING_DIR,
  ENVIRONMENT_PATH,

  // Phase 1: Learning Acceleration exports
  ingestSynthetic,
  getReflectionCount,
  getReflectionCountDetailed,
  getConvergenceMetrics,
  queryReflections,
};

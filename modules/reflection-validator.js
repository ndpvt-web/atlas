/**
 * Reflection Quality Validator
 *
 * Validates synthetic reflections with 4-dimensional quality scoring:
 * - Specificity: concrete vs vague lessons
 * - Actionability: directly applicable vs general
 * - Coherence: actions match outcome logically
 * - Novelty: non-trivial information content
 *
 * Composite score must be >= 0.6 to pass validation.
 * Also provides duplicate detection using TF-IDF cosine similarity.
 */

const crypto = require('crypto');

// ============================================================
// TF-IDF SIMILARITY (for duplicate detection)
// ============================================================

/**
 * Tokenize text into normalized words for TF-IDF.
 */
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Compute TF-IDF vectors for a set of documents.
 * Returns array of { doc, vector } where vector is Map(word -> tfidf).
 */
function computeTFIDF(documents) {
  const tokenizedDocs = documents.map(doc => tokenize(doc));
  const N = tokenizedDocs.length;

  // Document frequency: how many documents contain each word
  const df = new Map();
  for (const tokens of tokenizedDocs) {
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  // Compute TF-IDF for each document
  const vectors = [];
  for (let i = 0; i < tokenizedDocs.length; i++) {
    const tokens = tokenizedDocs[i];
    const tf = new Map();

    // Term frequency
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // TF-IDF vector
    const vector = new Map();
    for (const [term, count] of tf.entries()) {
      const termFreq = count / tokens.length;
      const inverseDocFreq = Math.log(N / (df.get(term) || 1));
      vector.set(term, termFreq * inverseDocFreq);
    }

    vectors.push({ doc: documents[i], vector });
  }

  return vectors;
}

/**
 * Compute cosine similarity between two TF-IDF vectors.
 */
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  const allTerms = new Set([...vecA.keys(), ...vecB.keys()]);

  for (const term of allTerms) {
    const a = vecA.get(term) || 0;
    const b = vecB.get(term) || 0;
    dotProduct += a * b;
    magA += a * a;
    magB += b * b;
  }

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Check if a reflection is a duplicate of any existing reflection.
 * Uses TF-IDF cosine similarity on lessons text.
 *
 * @param {object} reflection - New reflection to check
 * @param {array} existingReflections - Array of existing reflections
 * @param {number} threshold - Similarity threshold (default 0.9)
 * @returns {object} - { isDuplicate: boolean, matchedId: string|null, similarity: number }
 */
function checkDuplicate(reflection, existingReflections, threshold = 0.9) {
  if (!existingReflections || existingReflections.length === 0) {
    return { isDuplicate: false, matchedId: null, similarity: 0 };
  }

  // Combine lessons into a single document for comparison
  const newDoc = (reflection.lessons || []).join(' ');
  if (!newDoc.trim()) {
    return { isDuplicate: false, matchedId: null, similarity: 0 };
  }

  const existingDocs = existingReflections.map(r => (r.lessons || []).join(' '));
  const allDocs = [...existingDocs, newDoc];

  // Compute TF-IDF vectors
  const vectors = computeTFIDF(allDocs);
  const newVector = vectors[vectors.length - 1].vector;

  // Find max similarity with existing reflections
  let maxSim = 0;
  let matchedId = null;

  for (let i = 0; i < existingReflections.length; i++) {
    const sim = cosineSimilarity(newVector, vectors[i].vector);
    if (sim > maxSim) {
      maxSim = sim;
      matchedId = existingReflections[i].id;
    }
  }

  return {
    isDuplicate: maxSim >= threshold,
    matchedId: maxSim >= threshold ? matchedId : null,
    similarity: maxSim,
  };
}

// ============================================================
// QUALITY SCORING (4 dimensions)
// ============================================================

/**
 * Score specificity: concrete vs vague lessons.
 *
 * Heuristics:
 * - Concrete lessons mention specific actions, tools, or UI elements
 * - Vague lessons use abstract language ("be careful", "think about")
 * - Presence of technical terms increases specificity
 *
 * @param {array} lessons - Array of lesson strings
 * @returns {number} - Score 0-1
 */
function scoreSpecificity(lessons) {
  if (!lessons || lessons.length === 0) return 0;

  const concreteIndicators = [
    /\b(click|press|type|scroll|drag|select|open|close|navigate|search)\b/i,
    /\b(button|menu|field|icon|window|tab|panel|dialog|checkbox)\b/i,
    /\b(cmd|ctrl|alt|shift|enter|escape|space|delete)\b/i,
    /\b(\d+|first|second|top|bottom|left|right|center)\b/i,
  ];

  const vagueIndicators = [
    /\b(always|never|sometimes|maybe|probably|usually)\b/i,
    /\b(careful|think|remember|consider|try|ensure)\b/i,
    /\b(thing|stuff|item|element)\b(?! (button|field|menu))/i,
  ];

  let score = 0;
  for (const lesson of lessons) {
    let lessonScore = 0;

    // Count concrete indicators
    for (const pattern of concreteIndicators) {
      if (pattern.test(lesson)) lessonScore += 0.25;
    }

    // Penalize vague indicators
    for (const pattern of vagueIndicators) {
      if (pattern.test(lesson)) lessonScore -= 0.15;
    }

    // Normalize to 0-1
    lessonScore = Math.max(0, Math.min(1, lessonScore));
    score += lessonScore;
  }

  return score / lessons.length;
}

/**
 * Score actionability: directly applicable vs general.
 *
 * Heuristics:
 * - Actionable lessons describe HOW to do something
 * - General lessons describe WHAT happened (descriptive, not prescriptive)
 * - Imperative verbs indicate actionability
 *
 * @param {array} lessons - Array of lesson strings
 * @returns {number} - Score 0-1
 */
function scoreActionability(lessons) {
  if (!lessons || lessons.length === 0) return 0;

  const actionableIndicators = [
    /^(use|try|click|press|type|avoid|wait|verify|check|ensure)/i,
    /\b(should|must|need to|has to|recommended|better to)\b/i,
    /\b(instead of|rather than|before|after|when|if)\b/i,
  ];

  const descriptiveIndicators = [
    /^(the agent|agent|it|this|that)/i,
    /\b(was|were|had|happened|occurred|appeared)\b/i,
    /\b(observed|noticed|saw|found)\b/i,
  ];

  let score = 0;
  for (const lesson of lessons) {
    let lessonScore = 0.5; // Start at neutral

    // Boost for actionable patterns
    for (const pattern of actionableIndicators) {
      if (pattern.test(lesson)) lessonScore += 0.2;
    }

    // Penalize descriptive patterns
    for (const pattern of descriptiveIndicators) {
      if (pattern.test(lesson)) lessonScore -= 0.15;
    }

    lessonScore = Math.max(0, Math.min(1, lessonScore));
    score += lessonScore;
  }

  return score / lessons.length;
}

/**
 * Score coherence: do actions match outcome logically?
 *
 * Heuristics:
 * - If task succeeded: lessons should mention success strategies
 * - If task failed: lessons should mention failure points
 * - Contradiction: success + "avoid X because it failed" is incoherent
 *
 * @param {object} reflection - Full reflection object with outcome
 * @returns {number} - Score 0-1
 */
function scoreCoherence(reflection) {
  const { outcome, lessons, failurePoints, effectiveStrategies } = reflection;

  if (!lessons || lessons.length === 0) return 0;

  const lessonsText = lessons.join(' ').toLowerCase();
  const hasFailureLanguage = /\b(fail|error|incorrect|wrong|didn't work|unsuccessful)\b/.test(lessonsText);
  const hasSuccessLanguage = /\b(success|worked|effective|correct|successfully)\b/.test(lessonsText);

  let score = 0.5; // Start at neutral

  if (outcome === 'success') {
    // Success outcome should have success language or strategies
    if (hasSuccessLanguage || (effectiveStrategies && effectiveStrategies.length > 0)) {
      score += 0.3;
    }
    // Success outcome shouldn't focus on failures
    if (hasFailureLanguage && (!failurePoints || failurePoints.length === 0)) {
      score -= 0.2;
    }
  } else if (outcome === 'failure') {
    // Failure outcome should have failure language or failure points
    if (hasFailureLanguage || (failurePoints && failurePoints.length > 0)) {
      score += 0.3;
    }
    // Failure outcome shouldn't claim everything worked
    if (hasSuccessLanguage && !hasFailureLanguage) {
      score -= 0.2;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score novelty: non-trivial information content.
 *
 * Heuristics:
 * - Trivial lessons: "click buttons to interact", "wait for page to load"
 * - Novel lessons: specific techniques, non-obvious insights
 * - Length: very short lessons (<5 words) are usually trivial
 *
 * @param {array} lessons - Array of lesson strings
 * @returns {number} - Score 0-1
 */
function scoreNovelty(lessons) {
  if (!lessons || lessons.length === 0) return 0;

  const trivialPatterns = [
    /\b(need to|should|must|have to|has to)\b.*\b(click|press|type|wait|check)\b/i,
    /\b(agent|it|this|that)\b.*\b(did|tried|attempted|used)\b/i,
    /^(use|try|click|wait)\s+\w+\s*$/i, // Very short imperative
    /\b(important|necessary|essential|critical|key)\b/i, // Meta-commentary
  ];

  const novelIndicators = [
    /\b(discovered|realized|learned|found that)\b/i,
    /\b(surprisingly|unexpectedly|counterintuitively|note that)\b/i,
    /\b(optimization|workaround|technique|strategy|pattern)\b/i,
    /\b(avoid|prevent|bypass|instead)\b.*\b(because|due to|since)\b/i, // Causal reasoning
  ];

  let score = 0;
  for (const lesson of lessons) {
    let lessonScore = 0.5; // Start at neutral

    // Penalize short lessons
    const wordCount = lesson.split(/\s+/).length;
    if (wordCount < 5) {
      lessonScore -= 0.2;
    } else if (wordCount > 12) {
      lessonScore += 0.1; // Boost detailed lessons
    }

    // Check for trivial patterns
    let isTrivial = false;
    for (const pattern of trivialPatterns) {
      if (pattern.test(lesson)) {
        lessonScore -= 0.2;
        isTrivial = true;
        break;
      }
    }

    // Check for novel patterns
    if (!isTrivial) {
      for (const pattern of novelIndicators) {
        if (pattern.test(lesson)) {
          lessonScore += 0.2;
        }
      }
    }

    lessonScore = Math.max(0, Math.min(1, lessonScore));
    score += lessonScore;
  }

  return score / lessons.length;
}

/**
 * Validate a reflection with composite quality scoring.
 *
 * @param {object} reflection - Reflection object to validate
 * @returns {object} - { isValid: boolean, quality: number, breakdown: object }
 */
function validateReflection(reflection) {
  if (!reflection || !reflection.lessons || reflection.lessons.length === 0) {
    return {
      isValid: false,
      quality: 0,
      breakdown: {
        specificity: 0,
        actionability: 0,
        coherence: 0,
        novelty: 0,
      },
      reason: 'No lessons provided',
    };
  }

  const specificity = scoreSpecificity(reflection.lessons);
  const actionability = scoreActionability(reflection.lessons);
  const coherence = scoreCoherence(reflection);
  const novelty = scoreNovelty(reflection.lessons);

  const quality = (specificity + actionability + coherence + novelty) / 4;
  const isValid = quality >= 0.6;

  return {
    isValid,
    quality: +quality.toFixed(3),
    breakdown: {
      specificity: +specificity.toFixed(3),
      actionability: +actionability.toFixed(3),
      coherence: +coherence.toFixed(3),
      novelty: +novelty.toFixed(3),
    },
    reason: isValid ? 'Passed quality threshold' : `Quality ${quality.toFixed(2)} < 0.6 threshold`,
  };
}

/**
 * Batch validate multiple reflections.
 *
 * @param {array} reflections - Array of reflection objects
 * @returns {array} - Array of validation results
 */
function batchValidate(reflections) {
  return reflections.map(r => ({
    ...validateReflection(r),
    id: r.id,
  }));
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  validateReflection,
  batchValidate,
  checkDuplicate,

  // Expose individual scorers for debugging
  scoreSpecificity,
  scoreActionability,
  scoreCoherence,
  scoreNovelty,
};

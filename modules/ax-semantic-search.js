/**
 * ax-semantic-search.js - Semantic search and ranking for AX elements
 *
 * PURPOSE:
 *   Provides natural language search across macOS Accessibility API elements.
 *   Implements multi-strategy matching cascade with relevance scoring.
 *
 * USAGE:
 *   const search = require('./ax-semantic-search');
 *   const matches = await search.semanticSearchAX('click the Save button', axTree);
 *   const ranked = await search.rankElementsByRelevance(matches, taskDescription);
 *
 * STRATEGIES:
 *   1. Exact identifier match (highest priority)
 *   2. Exact label match (case-insensitive)
 *   3. Fuzzy label match (Levenshtein distance > 0.7)
 *   4. Role + partial label match
 *   5. Hierarchical path match (e.g., "File menu > Open")
 */

// ============================================================================
// PRIMARY EXPORTS
// ============================================================================

/**
 * Semantic search across AX tree using natural language query.
 * Implements multi-strategy matching with fallback cascade.
 *
 * @param {string} query - Natural language task description
 * @param {Array} axTree - Flattened AX tree to search (AXElement[])
 * @returns {Promise<Array>} - Matching elements (may be empty)
 */
async function semanticSearchAX(query, axTree) {
  if (!axTree || axTree.length === 0) {
    return [];
  }

  const results = [];
  const parsed = parseQuery(query);

  // Strategy 1: Exact identifier match
  if (parsed.identifier) {
    const byId = axTree.filter(el => el.identifier === parsed.identifier);
    if (byId.length > 0) {
      return byId;
    }
  }

  // Strategy 2: Exact label match (case-insensitive)
  const exactLabel = axTree.filter(el =>
    el.label && el.label.toLowerCase() === parsed.target.toLowerCase()
  );
  if (exactLabel.length > 0) {
    results.push(...exactLabel);
  }

  // Strategy 3: Fuzzy label match (for typos, partial matches)
  if (results.length === 0) {
    const fuzzy = axTree.filter(el => {
      if (!el.label) return false;
      const similarity = levenshteinSimilarity(el.label.toLowerCase(), parsed.target.toLowerCase());
      return similarity > 0.7;
    });
    results.push(...fuzzy);
  }

  // Strategy 4: Role + partial label
  if (results.length === 0 && parsed.role) {
    const roleMatches = axTree.filter(el =>
      el.role === parsed.role &&
      el.label?.toLowerCase().includes(parsed.target.toLowerCase())
    );
    results.push(...roleMatches);
  }

  // Strategy 5: Hierarchical path match
  if (results.length === 0 && parsed.modifiers.length > 0) {
    const hierarchyMatches = searchByHierarchy(axTree, parsed.modifiers, parsed.target);
    results.push(...hierarchyMatches);
  }

  return results;
}

/**
 * Rank AX elements by relevance to task description.
 * Returns array of {element, confidence} sorted by confidence descending.
 *
 * Scoring factors:
 * - Label similarity (weight: 0.4): Levenshtein distance
 * - Role appropriateness (weight: 0.3): Does role match action?
 * - Hierarchy context (weight: 0.2): Is element in expected parent?
 * - Action availability (weight: 0.1): Does element support required action?
 *
 * @param {Array} elements - Candidate elements from search (AXElement[])
 * @param {string} taskDescription - Original task description
 * @returns {Promise<Array>} - Ranked results [{element, confidence}]
 */
async function rankElementsByRelevance(elements, taskDescription) {
  if (!elements || elements.length === 0) {
    return [];
  }

  const parsed = parseQuery(taskDescription);

  const scored = elements.map(element => {
    let score = 0;

    // Factor 1: Label similarity (weight: 0.4)
    if (element.label) {
      const similarity = levenshteinSimilarity(
        element.label.toLowerCase(),
        parsed.target.toLowerCase()
      );
      score += 0.4 * similarity;
    }

    // Factor 2: Role appropriateness (weight: 0.3)
    const roleMatch = matchRoleToAction(element.role, parsed.action);
    score += 0.3 * roleMatch;

    // Factor 3: Hierarchy context (weight: 0.2)
    const hierarchyMatch = matchHierarchy(element.path || '', parsed.modifiers);
    score += 0.2 * hierarchyMatch;

    // Factor 4: Action availability (weight: 0.1)
    const hasAction = matchAction(element.actions || [], parsed.action);
    score += 0.1 * hasAction;

    return { element, confidence: score };
  });

  // Sort descending by confidence
  return scored.sort((a, b) => b.confidence - a.confidence);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse natural language query into structured format.
 * Extracts action verb, target noun, modifiers from task description.
 *
 * @param {string} query - Natural language task description
 * @returns {object} - Parsed components {action, target, modifiers, role, identifier}
 */
function parseQuery(query) {
  // Extract action verb (click, type, select, etc.)
  const actionMatch = query.match(/\b(click|press|select|type|enter|open|check|toggle)\b/i);
  const action = actionMatch ? actionMatch[1].toLowerCase() : 'click';

  // Extract target (main noun phrase)
  // Remove common filler words
  let targetMatch = query
    .replace(/\b(click|press|select|type|enter|open|check|toggle|the|a|an|on|in)\b/gi, '')
    .trim();

  // Remove modifiers to isolate target
  const modifierPattern = /\bin (toolbar|menu|sidebar|window|dialog|panel)\b/gi;
  targetMatch = targetMatch.replace(modifierPattern, '').trim();

  // Extract modifiers (in toolbar, in menu, etc.)
  const modifiers = [];
  const modifierMatches = query.match(/\bin (toolbar|menu|sidebar|window|dialog|panel)\b/gi);
  if (modifierMatches) {
    modifiers.push(...modifierMatches.map(m => m.replace(/in /i, '').toLowerCase()));
  }

  return {
    action,
    target: targetMatch,
    modifiers,
    role: inferRoleFromAction(action),
    identifier: null
  };
}

/**
 * Map action verb to expected AX role.
 * Used for filtering element candidates by role type.
 *
 * @param {string} action - Action verb (click, type, etc.)
 * @returns {string|null} - Expected AX role or null
 */
function inferRoleFromAction(action) {
  const roleMap = {
    'click': 'AXButton',
    'press': 'AXButton',
    'type': 'AXTextField',
    'enter': 'AXTextField',
    'select': 'AXMenuItem',
    'open': 'AXMenuItem',
    'check': 'AXCheckBox',
    'toggle': 'AXCheckBox'
  };
  return roleMap[action] || null;
}

/**
 * Standard Levenshtein distance algorithm.
 * Measures edit distance between two strings.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance (0 = identical)
 */
function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,  // substitution
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j] + 1       // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Convert Levenshtein distance to similarity score (0-1).
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Similarity score (1 = identical, 0 = completely different)
 */
function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - (distance / maxLen);
}

/**
 * Match element role to action verb.
 * Returns compatibility score (0-1).
 *
 * @param {string} role - AX element role (AXButton, AXTextField, etc.)
 * @param {string} action - Action verb (click, type, etc.)
 * @returns {number} - Compatibility score
 */
function matchRoleToAction(role, action) {
  const compatibilityMap = {
    'click': ['AXButton', 'AXMenuItem', 'AXRadioButton', 'AXCheckBox', 'AXLink'],
    'type': ['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'],
    'select': ['AXMenuItem', 'AXPopUpButton', 'AXComboBox', 'AXRadioButton'],
    'scroll': ['AXScrollArea', 'AXTable', 'AXList'],
    'check': ['AXCheckBox'],
    'toggle': ['AXCheckBox', 'AXButton']
  };

  const compatible = compatibilityMap[action] || [];
  return compatible.includes(role) ? 1.0 : 0.3;
}

/**
 * Match element hierarchy path to modifiers.
 * Checks if element is located in expected parent containers.
 *
 * @param {string} path - XPath-style element path
 * @param {Array<string>} modifiers - Expected parent containers (toolbar, menu, etc.)
 * @returns {number} - Match score (0-1)
 */
function matchHierarchy(path, modifiers) {
  if (modifiers.length === 0) return 1.0;

  const pathLower = path.toLowerCase();
  const matchCount = modifiers.filter(mod =>
    pathLower.includes(mod.toLowerCase())
  ).length;

  return matchCount / modifiers.length;
}

/**
 * Check if element has required action capability.
 * Maps action verb to AX action name.
 *
 * @param {Array<string>} actions - Element's available AX actions
 * @param {string} actionVerb - Required action verb
 * @returns {number} - 1.0 if action available, 0.0 otherwise
 */
function matchAction(actions, actionVerb) {
  const axActionMap = {
    'click': 'AXPress',
    'press': 'AXPress',
    'open': 'AXShowMenu',
    'select': 'AXPress',
    'type': 'AXSetValue',
    'enter': 'AXSetValue'
  };

  const requiredAction = axActionMap[actionVerb];
  if (!requiredAction) return 1.0;

  return actions.includes(requiredAction) ? 1.0 : 0.0;
}

/**
 * Search AX tree by hierarchical path.
 * Handles queries like "File menu > Open" or "toolbar > Build button".
 *
 * @param {Array} axTree - Flattened AX tree
 * @param {Array<string>} modifiers - Hierarchy components
 * @param {string} target - Final target label
 * @returns {Array} - Matching elements
 */
function searchByHierarchy(axTree, modifiers, target) {
  const results = [];

  for (const el of axTree) {
    if (!el.path || !el.label) continue;

    const pathLower = el.path.toLowerCase();
    const labelLower = el.label.toLowerCase();
    const targetLower = target.toLowerCase();

    // Check if element label matches target
    if (!labelLower.includes(targetLower)) continue;

    // Check if all modifiers appear in path
    const allModifiersMatch = modifiers.every(mod =>
      pathLower.includes(mod.toLowerCase())
    );

    if (allModifiersMatch) {
      results.push(el);
    }
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  semanticSearchAX,
  rankElementsByRelevance,
  parseQuery,
  levenshteinDistance,
  inferRoleFromAction,
};

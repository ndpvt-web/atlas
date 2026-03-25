/**
 * Transfer Mapper
 *
 * Cross-domain pattern transfer for reflection knowledge.
 * Extracts abstract patterns from reflections and applies them to new domains.
 *
 * Core insight: Many UI interaction patterns are domain-agnostic:
 * - "Search in Safari" transfers to "Search in Finder"
 * - "Navigate nested menus in System Settings" transfers to "Navigate nested menus in app preferences"
 * - "Wait for page load" transfers to "Wait for app launch"
 *
 * This is especially valuable when:
 * - New task categories emerge (transfer from similar domains)
 * - Reflection data is sparse (leverage related categories)
 */

const https = require('https');
const crypto = require('crypto');

// ============================================================
// AI GATEWAY INTEGRATION
// ============================================================

const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = 'cc00f875633a4dca884e24f5ab6e0106';
const SONNET_PATH = '/api/v1/bedrock/model/claude-sonnet-4-6/invoke';

/**
 * Call AI Gateway Sonnet endpoint.
 */
function callSonnet(prompt, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2000,
      system: systemPrompt || undefined,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: SONNET_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': AI_GATEWAY_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error('Unexpected API response format'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// PATTERN EXTRACTION
// ============================================================

/**
 * Extract an abstract, transferable pattern from a reflection.
 * Removes domain-specific details and identifies the core strategy.
 *
 * @param {object} reflection - Source reflection
 * @returns {Promise<object>} - { pattern: string, applicableDomains: array, confidence: number }
 */
async function extractPattern(reflection) {
  if (!reflection || !reflection.lessons || reflection.lessons.length === 0) {
    return null;
  }

  const prompt = `You are extracting a transferable UI interaction pattern from a computer-use task reflection.

REFLECTION:
Task: "${reflection.taskDescription}"
Type: ${reflection.taskType}
Outcome: ${reflection.outcome}
Lessons:
${reflection.lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Extract the ABSTRACT pattern that could apply to other domains:
- Remove specific app names, search terms, file names
- Keep the core interaction strategy
- Identify transferable principles

Respond in EXACTLY this JSON format (no other text):
{
  "pattern": "<abstract pattern description>",
  "applicable_domains": ["<domain 1>", "<domain 2>", "<domain 3>"],
  "transferable_lessons": ["<lesson 1>", "<lesson 2>"],
  "confidence": <0-1 confidence score>
}

EXAMPLE:
Original: "Use Cmd+Space to open Spotlight and launch Safari"
Pattern: "Use system-wide launcher (Cmd+Space) to quickly access applications"
Applicable: ["app_launch", "settings_access", "file_management"]

RULES:
- Pattern must be generic (no specific app/file names)
- Applicable domains should be task types (app_launch, web_search, etc.)
- Confidence: how broadly applicable is this pattern?`;

  try {
    const response = await callSonnet(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Transfer] No JSON in pattern extraction response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      pattern: parsed.pattern || '',
      applicableDomains: parsed.applicable_domains || [],
      transferableLessons: parsed.transferable_lessons || [],
      confidence: parsed.confidence || 0.5,
      sourceId: reflection.id,
      sourceType: reflection.taskType,
    };
  } catch (e) {
    console.error(`[Transfer] Failed to extract pattern: ${e.message}`);
    return null;
  }
}

/**
 * Apply an extracted pattern to target domains.
 * Creates domain-adapted synthetic reflections.
 *
 * @param {object} pattern - Extracted pattern object
 * @param {array} targetDomains - Array of task types to apply pattern to
 * @returns {Promise<array>} - Array of synthetic reflections
 */
async function applyToDomains(pattern, targetDomains) {
  if (!pattern || !pattern.pattern || targetDomains.length === 0) {
    return [];
  }

  const prompt = `You are adapting an abstract UI pattern to specific task domains.

ABSTRACT PATTERN:
${pattern.pattern}

Transferable Lessons:
${(pattern.transferableLessons || []).map((l, i) => `${i + 1}. ${l}`).join('\n')}

TARGET DOMAINS: ${targetDomains.join(', ')}

For each target domain, create a domain-specific reflection:
- Adapt the abstract pattern to concrete actions in that domain
- Generate realistic task descriptions
- Create actionable lessons

Respond in EXACTLY this JSON format (no other text):
{
  "adaptations": [
    {
      "task_type": "<target domain>",
      "task_description": "<concrete task in that domain>",
      "lessons": ["<adapted lesson 1>", "<adapted lesson 2>"],
      "reflection": "<1 sentence summary>"
    }
  ]
}

RULES:
- Each adaptation should be realistic for that domain
- Lessons should be concrete (not abstract)
- Keep the core strategy from the original pattern`;

  try {
    const response = await callSonnet(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Transfer] No JSON in domain adaptation response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const reflections = [];

    for (const adaptation of (parsed.adaptations || [])) {
      const reflection = {
        id: `ref-transfer-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        trajectoryId: `transfer-${pattern.sourceId}`,
        taskDescription: adaptation.task_description || '',
        taskType: adaptation.task_type || 'general_interaction',
        outcome: 'success', // Transfer assumes successful application
        iterations: 8, // Estimated
        loopsDetected: 0,
        stagnationsDetected: 0,
        duration: 15000, // Estimated 15 seconds
        reflection: adaptation.reflection || '',
        lessons: adaptation.lessons || [],
        failurePoints: [],
        effectiveStrategies: [`Applied transferred pattern: ${pattern.pattern}`],
        timestamp: Date.now(),

        // Phase 1 additions
        source: 'transfer',
        confidence: pattern.confidence * 0.85, // Slightly lower than source pattern
        sourceId: pattern.sourceId,
        sourcePattern: pattern.pattern,
        targetDomain: adaptation.task_type,
      };

      reflections.push(reflection);
    }

    console.log(`[Transfer] Applied pattern to ${reflections.length} domains`);
    return reflections;
  } catch (e) {
    console.error(`[Transfer] Failed to apply pattern to domains: ${e.message}`);
    return [];
  }
}

/**
 * Batch transfer: extract patterns from source reflections and apply to target domains.
 *
 * @param {array} sourceReflections - Reflections to extract patterns from
 * @param {array} targetDomains - Task types to transfer to
 * @returns {Promise<object>} - { reflections: array, patterns: array, stats: object }
 */
async function batchTransfer(sourceReflections, targetDomains) {
  const patterns = [];
  const allReflections = [];

  // Extract patterns from successful reflections
  const successfulSources = sourceReflections.filter(r =>
    r.outcome === 'success' &&
    (!r.source || r.source === 'real') // Only transfer from real reflections
  );

  console.log(`[Transfer] Extracting patterns from ${successfulSources.length} successful reflections`);

  for (const source of successfulSources) {
    try {
      const pattern = await extractPattern(source);
      if (!pattern || !pattern.pattern) continue;

      patterns.push(pattern);

      // Apply to target domains
      const adaptedReflections = await applyToDomains(pattern, targetDomains);
      allReflections.push(...adaptedReflections);
    } catch (e) {
      console.error(`[Transfer] Error processing ${source.id}: ${e.message}`);
    }
  }

  console.log(`[Transfer] Batch complete: ${patterns.length} patterns, ${allReflections.length} transferred reflections`);

  return {
    reflections: allReflections,
    patterns,
    stats: {
      sourcesProcessed: successfulSources.length,
      patternsExtracted: patterns.length,
      reflectionsGenerated: allReflections.length,
      avgReflectionsPerPattern: patterns.length > 0 ? +(allReflections.length / patterns.length).toFixed(2) : 0,
    },
  };
}

/**
 * Identify similar task types for targeted transfer.
 * Uses task type similarity to recommend transfer targets.
 *
 * @param {string} sourceTaskType - Source task type
 * @param {array} allTaskTypes - All known task types
 * @returns {array} - Array of similar task types
 */
function findSimilarDomains(sourceTaskType, allTaskTypes) {
  // Simple similarity: shared words in task type
  const sourceWords = new Set(sourceTaskType.toLowerCase().split('_'));

  const similarities = allTaskTypes
    .filter(t => t !== sourceTaskType)
    .map(targetType => {
      const targetWords = new Set(targetType.toLowerCase().split('_'));
      const intersection = [...sourceWords].filter(w => targetWords.has(w));
      const similarity = intersection.length / Math.max(sourceWords.size, targetWords.size);

      return { taskType: targetType, similarity };
    })
    .filter(s => s.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity);

  return similarities.slice(0, 3).map(s => s.taskType);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  extractPattern,
  applyToDomains,
  batchTransfer,
  findSimilarDomains,
};

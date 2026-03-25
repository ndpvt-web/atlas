/**
 * Capy Macro - Tier 3: Claude Vision AI Fallback
 * Phase 3: When Tier 1 (hash) and Tier 2 (AX) fail, use Claude Vision
 * to locate UI elements by screenshot comparison.
 *
 * Uses AI Gateway (same as computer-use module) via HTTPS.
 * Cost: ~$0.01-0.05 per call. Model: claude-sonnet-4-6
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MACROS_DIR = '/tmp/capy-macros';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_MODEL = 'claude-sonnet-4-6';

let tier3Calls = 0;
let tier3Cost = 0;

function captureScreenBase64() {
  const tmp = `/tmp/capy-t3-${Date.now()}.jpg`;
  try {
    execSync(`${SCREENCAPTURE} -x -t jpg "${tmp}" 2>/dev/null`, { timeout: 5000, stdio: 'pipe' });
    try { execSync(`sips -s formatOptions 40 -Z 1280 "${tmp}" 2>/dev/null`, { timeout: 5000, stdio: 'pipe' }); } catch(e){}
    const d = fs.readFileSync(tmp);
    return d.toString('base64');
  } catch(e) { return null; }
  finally { try { fs.unlinkSync(tmp); } catch(e){} }
}

function loadRecordedScreenBase64(macroId, hash) {
  if (!hash) return null;
  const fp = path.join(MACROS_DIR, macroId, 'screenshots', `${hash}.jpg`);
  try {
    if (!fs.existsSync(fp)) return null;
    const d = fs.readFileSync(fp);
    const tmp = `/tmp/capy-t3r-${Date.now()}.jpg`;
    fs.writeFileSync(tmp, d);
    try { execSync(`sips -Z 1280 "${tmp}" 2>/dev/null`, { timeout: 5000, stdio: 'pipe' }); } catch(e){}
    const r = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch(e){}
    return r.toString('base64');
  } catch(e) { return null; }
}

function callVisionAPI(apiKey, messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 300, messages,
    });
    const req = https.request({
      hostname: AI_GATEWAY_HOST, port: 443,
      path: `/api/v1/bedrock/model/${AI_GATEWAY_MODEL}/invoke`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (res.statusCode >= 400) return reject(new Error(`Vision ${res.statusCode}: ${d.error?.message || body.slice(0,200)}`));
          resolve(d.content?.[0]?.text || '');
        } catch(e) { reject(new Error(`Vision parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Vision timeout 15s')); });
    req.write(payload); req.end();
  });
}

/**
 * Find a UI element via Claude Vision comparison.
 * @param {object} step - Macro step with position, axContext, screenshotHash
 * @param {string} macroId - Macro ID
 * @param {string} apiKey - AI Gateway key
 * @returns {Promise<{found, position?, confidence, method, reasoning?, elapsed?}>}
 */
async function findElementByVision(step, macroId, apiKey) {
  if (!apiKey) return { found: false, confidence: 0, method: 'vision_no_key' };
  const t0 = Date.now();

  const current = captureScreenBase64();
  if (!current) return { found: false, confidence: 0, method: 'vision_screenshot_failed' };

  const recorded = loadRecordedScreenBase64(macroId, step.screenshotHash);
  const el = step.axContext?.element || {};
  const role = el.role || 'element';
  const title = el.title || '';
  const pos = step.position || { x: 0, y: 0 };
  const app = step.axContext?.appName || step.axContext?.app || 'app';
  const desc = title ? `a ${role} labeled "${title}" in ${app}` : `a ${role} at (${pos.x},${pos.y}) in ${app}`;

  const content = [];
  if (recorded) {
    content.push({ type: 'text', text: `The user clicked ${desc} at (${pos.x},${pos.y}) during recording.\n\nRECORDED screenshot:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: recorded } });
    content.push({ type: 'text', text: 'CURRENT screenshot:' });
  } else {
    content.push({ type: 'text', text: `Find ${desc}, previously at (${pos.x},${pos.y}).\n\nCURRENT screenshot:` });
  }
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: current } });
  content.push({ type: 'text', text: `Find the same element in the current screenshot. Return ONLY JSON:\n{"found":true,"x":123,"y":456,"confidence":0.95,"reasoning":"brief"}` });

  try {
    const resp = await callVisionAPI(apiKey, [{ role: 'user', content }]);
    const m = resp.match(/\{[^}]+\}/s);
    if (!m) return { found: false, confidence: 0, method: 'vision_parse_error' };

    const r = JSON.parse(m[0]);
    const elapsed = Date.now() - t0;
    tier3Calls++; tier3Cost += 0.02;
    console.log(`[Tier3] found=${r.found} conf=${r.confidence} (${r.x},${r.y}) ${elapsed}ms calls=${tier3Calls} cost=$${tier3Cost.toFixed(2)}`);

    if (r.found && r.confidence >= 0.7 && typeof r.x === 'number') {
      return { found: true, position: { x: Math.round(r.x), y: Math.round(r.y) }, confidence: r.confidence, method: 'vision_ai', reasoning: r.reasoning, elapsed };
    }
    return { found: false, confidence: r.confidence || 0, method: 'vision_low_confidence', reasoning: r.reasoning, elapsed };
  } catch(e) {
    return { found: false, confidence: 0, method: 'vision_error', reasoning: e.message, elapsed: Date.now() - t0 };
  }
}

function getTier3Stats() { return { calls: tier3Calls, cost: tier3Cost }; }

module.exports = { findElementByVision, getTier3Stats, captureScreenBase64, loadRecordedScreenBase64 };

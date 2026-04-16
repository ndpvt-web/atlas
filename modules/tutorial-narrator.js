'use strict';

/**
 * tutorial-narrator.js
 * Handles TTS via Kokoro and subtitle delivery via WebSocket broadcast.
 * Part of the Atlas Tutorial System.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Module-level state for audio process tracking
let _currentAudioPid = null;
let _currentAudioProcess = null;
let _currentTempFile = null;

/**
 * Build an EngineResult object.
 * @param {boolean} ok
 * @param {*} data
 * @param {string|null} error
 * @param {number} durationMs
 * @returns {{ ok: boolean, data: *, error: string|null, durationMs: number }}
 */
function makeResult(ok, data, error, durationMs) {
  return { ok, data, error: error || null, durationMs: durationMs || 0 };
}

/**
 * Estimate subtitle display duration from text length.
 * ~60ms per character, min 2000ms, max 10000ms.
 * @param {string} text
 * @returns {number} milliseconds
 */
function estimateDuration(text) {
  const raw = (text || '').length * 60;
  return Math.min(Math.max(raw, 2000), 10000);
}

/**
 * Make an HTTP POST request, returning response body as Buffer.
 * @param {string} url
 * @param {object} body - JSON-serializable payload
 * @returns {Promise<Buffer>}
 */
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buf);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('HTTP request timed out after 30s'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Clean up a temp WAV file silently.
 * @param {string} filePath
 */
function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // Ignore cleanup errors
  }
}

/**
 * Play a WAV file via afplay (macOS). Non-blocking spawn.
 * Tracks PID in module-level state. Cleans up temp file on completion.
 * @param {string} wavPath
 */
function playWav(wavPath) {
  let proc;
  try {
    proc = spawn('afplay', [wavPath], {
      stdio: 'ignore',
      detached: false,
    });
  } catch (err) {
    // afplay not available (e.g., Linux dev environment) -- clean up and move on
    cleanupTempFile(wavPath);
    return;
  }

  _currentAudioProcess = proc;
  _currentAudioPid = proc.pid;
  _currentTempFile = wavPath;

  proc.on('close', () => {
    if (_currentAudioPid === proc.pid) {
      _currentAudioPid = null;
      _currentAudioProcess = null;
    }
    cleanupTempFile(wavPath);
    if (_currentTempFile === wavPath) {
      _currentTempFile = null;
    }
  });

  proc.on('error', () => {
    if (_currentAudioPid === proc.pid) {
      _currentAudioPid = null;
      _currentAudioProcess = null;
    }
    cleanupTempFile(wavPath);
    if (_currentTempFile === wavPath) {
      _currentTempFile = null;
    }
  });
}

/**
 * narrate(opts) → Promise<EngineResult>
 *
 * Sends subtitle to overlay and optionally plays TTS audio via Kokoro.
 *
 * @param {{ text: string, step?: object, broadcastFn?: function, kokoroUrl?: string, skipTTS?: boolean }} opts
 * @returns {Promise<{ ok: boolean, data: null, error: string|null, durationMs: number }>}
 */
async function narrate(opts) {
  const start = Date.now();
  const {
    text = '',
    broadcastFn,
    kokoroUrl = 'http://localhost:7892/v1/audio/speech',
    skipTTS = false,
  } = opts || {};

  const duration = estimateDuration(text);

  // 1. Send subtitle to overlay
  if (typeof broadcastFn === 'function') {
    try {
      broadcastFn({ type: 'narrate', text, duration });
    } catch (broadcastErr) {
      // Non-fatal: log and continue
      console.error('[tutorial-narrator] broadcastFn error:', broadcastErr.message);
    }
  }

  // 2. TTS via Kokoro (if not skipped)
  if (!skipTTS && text) {
    try {
      const wavBuffer = await httpPost(kokoroUrl, {
        model: 'kokoro',
        voice: 'af_heart',
        input: text,
        response_format: 'wav',
      });

      const tmpPath = `/tmp/atlas-tutorial-tts-${Date.now()}.wav`;
      fs.writeFileSync(tmpPath, wavBuffer);
      playWav(tmpPath);
    } catch (ttsErr) {
      // Degrade gracefully: subtitle already sent, just log the TTS failure
      console.error('[tutorial-narrator] TTS error (subtitle shown):', ttsErr.message);
    }
  }

  return makeResult(true, null, null, Date.now() - start);
}

/**
 * stopAudio() → void
 *
 * Kills the current afplay process (if any) and cleans up temp WAV files.
 */
function stopAudio() {
  // Kill current audio process
  if (_currentAudioProcess && _currentAudioPid) {
    try {
      _currentAudioProcess.kill('SIGTERM');
    } catch (_) {
      // Process may already be dead
    }
  }
  _currentAudioPid = null;
  _currentAudioProcess = null;

  // Clean up current tracked temp file
  if (_currentTempFile) {
    cleanupTempFile(_currentTempFile);
    _currentTempFile = null;
  }

  // Clean up any leftover temp WAV files
  try {
    const tmpFiles = fs.readdirSync('/tmp').filter(
      (f) => f.startsWith('atlas-tutorial-tts-') && f.endsWith('.wav')
    );
    for (const f of tmpFiles) {
      cleanupTempFile(path.join('/tmp', f));
    }
  } catch (_) {
    // /tmp scan failed -- non-fatal
  }
}

/**
 * generateNarration(opts) → Promise<EngineResult>
 *
 * Calls the Brain/LLM to generate natural narration text for a tutorial step.
 * Falls back to step.action if LLM call fails.
 *
 * @param {{ step: object, stepIndex: number, context?: string, brainUrl?: string }} opts
 * @returns {Promise<{ ok: boolean, data: string, error: string|null, durationMs: number }>}
 */
async function generateNarration(opts) {
  const start = Date.now();
  const {
    step = {},
    stepIndex = 0,
    context = '',
    brainUrl = 'http://localhost:7888/brain/query',
  } = opts || {};

  const fallback = step.action || step.description || `Step ${stepIndex + 1}`;

  const promptParts = [
    `You are narrating a desktop tutorial for the user.`,
    `Generate a brief, conversational narration (1-2 sentences) for the following tutorial step.`,
    `Be natural and encouraging. Do not include any markdown or formatting.`,
    ``,
    `Step index: ${stepIndex}`,
    `Step action: ${step.action || '(none)'}`,
    step.description ? `Step description: ${step.description}` : null,
    step.target ? `Target element: ${step.target}` : null,
    context ? `Additional context: ${context}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const responseBuffer = await httpPost(brainUrl, {
      query: promptParts,
      context: 'tutorial_narration',
    });

    const responseText = responseBuffer.toString('utf8');
    let narrationText = fallback;

    try {
      const parsed = JSON.parse(responseText);
      // Brain may return { response: "..." } or { answer: "..." } or { text: "..." }
      narrationText =
        parsed.response || parsed.answer || parsed.text || parsed.result || fallback;
    } catch (_) {
      // Response was plain text
      narrationText = responseText.trim() || fallback;
    }

    // Sanitize: trim and collapse excessive whitespace
    narrationText = narrationText.replace(/\s+/g, ' ').trim() || fallback;

    return makeResult(true, narrationText, null, Date.now() - start);
  } catch (err) {
    console.error('[tutorial-narrator] generateNarration LLM error, using fallback:', err.message);
    return makeResult(false, fallback, err.message, Date.now() - start);
  }
}

module.exports = { narrate, stopAudio, generateNarration };

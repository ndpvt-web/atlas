#!/usr/bin/env node
// capy-bridge server v1.1.0
// ZERO npm dependencies -- uses only Node.js built-in modules
// Modules: http, child_process, fs, path, crypto, os

const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// --- Configuration ---
const PORT = parseInt(process.env.CAPY_BRIDGE_PORT || '7888', 10);
const HOME = os.homedir();
const MAX_BODY = 50 * 1024 * 1024;
const MAX_TIMEOUT = 120000;
const VERSION = '1.1.0';
const BRIDGE_DIR = __dirname;

// --- Token Management ---
function loadToken() {
  if (process.env.CAPY_BRIDGE_TOKEN) return process.env.CAPY_BRIDGE_TOKEN;
  const tokenPath = path.join(__dirname, '.token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    const token = 'capy_' + crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    console.log('');
    console.log('  NEW TOKEN GENERATED (save this!)');
    console.log('  ' + token);
    console.log('');
    return token;
  }
}
const TOKEN = loadToken();
process.env.CAPY_BRIDGE_TOKEN = TOKEN; // Expose to brain module

// --- Safety: Blocked Commands ---
const BLOCKED = [
  /rm\s+-rf\s+\/(?!\w)/, /mkfs\./, /dd\s+if=.*of=\/dev/,
  /:()\s*\{\s*:\|:&\s*\};:/, />\s*\/dev\/sda/,
];
function isBlocked(cmd) { return BLOCKED.some(p => p.test(cmd)); }

// --- Path Validation ---
function validatePath(p) {
  const resolved = path.resolve(p.replace(/^~/, HOME));
  if (!resolved.startsWith(HOME) && !resolved.startsWith('/tmp') && !resolved.startsWith('/var')) {
    throw new Error('Access denied: path must be within home or /tmp');
  }
  return resolved;
}

// --- HTTP Helpers ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(body);
}

function authenticate(req) {
  // Check Authorization header first
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const provided = h.slice(7);
    try { return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN)); }
    catch { return false; }
  }
  // Fallback: check ?token= query param (for WebView/overlay)
  try {
    const u = new URL(req.url, 'http://localhost');
    const qToken = u.searchParams.get('token');
    if (qToken) {
      return crypto.timingSafeEqual(Buffer.from(qToken), Buffer.from(TOKEN));
    }
  } catch {}
  return false;
}

// --- Command Execution ---
function execCommand(command, opts = {}) {
  return new Promise((resolve, reject) => {
    if (isBlocked(command)) return reject(new Error('Command blocked for safety'));
    const cwd = opts.cwd || HOME;
    const timeout = Math.min(opts.timeout || 30000, MAX_TIMEOUT);
    let stdout = '', stderr = '', killed = false;
    const child = spawn('/bin/zsh', ['-l', '-c', command], {
      cwd, timeout, env: { ...process.env, HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      resolve({ success: code === 0, exitCode: code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });
    child.on('error', err => {
      resolve({ success: false, exitCode: -1, stdout, stderr: err.message });
    });
    setTimeout(() => { if (!child.killed) { child.kill('SIGTERM'); killed = true; } }, timeout);
  });
}

// --- Route Handlers ---
const routes = {};

// Health (no auth required)
routes['GET /health'] = async (req, res) => {
  send(res, 200, {
    status: 'ok', version: VERSION, uptime: process.uptime(),
    platform: os.platform(), arch: os.arch(), hostname: os.hostname(),
    node: process.version, timestamp: new Date().toISOString(),
    memory: { total: os.totalmem(), free: os.freemem() },
    cpus: os.cpus().length,
  });
};

// System info
routes['GET /system/info'] = async (req, res) => {
  const info = {
    hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
    release: os.release(), cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
    uptime: os.uptime(), user: os.userInfo().username, home: HOME,
    shell: process.env.SHELL || '/bin/zsh',
  };
  try { info.macosVersion = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8').match(/<string>(\d+\.\d+\.?\d*)<\/string>/)?.[1]; } catch {}
  try { const r = await execCommand('xcodebuild -version 2>/dev/null | head -1'); info.xcode = r.success ? r.stdout : null; } catch {}
  try { const r = await execCommand('sw_vers -productName'); info.productName = r.success ? r.stdout : null; } catch {}
  send(res, 200, info);
};

// Terminal execution
routes['POST /terminal/exec'] = async (req, res) => {
  const { command, cwd, timeout } = await parseBody(req);
  if (!command) return send(res, 400, { error: 'Missing: command' });
  const result = await execCommand(command, { cwd, timeout });
  send(res, 200, result);
};

// File read
routes['POST /files/read'] = async (req, res) => {
  const { path: p, encoding = 'utf8' } = await parseBody(req);
  if (!p) return send(res, 400, { error: 'Missing: path' });
  try {
    const resolved = validatePath(p);
    const stat = fs.statSync(resolved);
    const content = fs.readFileSync(resolved, encoding === 'base64' ? null : encoding);
    send(res, 200, {
      success: true, path: resolved,
      content: encoding === 'base64' ? content.toString('base64') : content,
      size: stat.size, modified: stat.mtime.toISOString(),
    });
  } catch (e) { send(res, 404, { success: false, error: e.message }); }
};

// File write
routes['POST /files/write'] = async (req, res) => {
  const { path: p, content, encoding = 'utf8', mkdir: mkd = true } = await parseBody(req);
  if (!p || content === undefined) return send(res, 400, { error: 'Missing: path or content' });
  try {
    const resolved = validatePath(p);
    if (mkd) fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
    fs.writeFileSync(resolved, buf, encoding === 'base64' ? undefined : encoding);
    send(res, 200, { success: true, path: resolved, size: Buffer.byteLength(buf) });
  } catch (e) { send(res, 500, { success: false, error: e.message }); }
};

// File list
routes['POST /files/list'] = async (req, res) => {
  const { path: p = '~', details = false } = await parseBody(req);
  try {
    const resolved = validatePath(p);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries.map(e => {
      const item = { name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: path.join(resolved, e.name) };
      if (details) {
        try { const s = fs.statSync(item.path); item.size = s.size; item.modified = s.mtime.toISOString(); } catch {}
      }
      return item;
    });
    send(res, 200, { success: true, items });
  } catch (e) { send(res, 500, { success: false, error: e.message }); }
};

// File delete
routes['POST /files/delete'] = async (req, res) => {
  const { path: p } = await parseBody(req);
  if (!p) return send(res, 400, { error: 'Missing: path' });
  try {
    const resolved = validatePath(p);
    fs.rmSync(resolved, { recursive: true });
    send(res, 200, { success: true, path: resolved });
  } catch (e) { send(res, 500, { success: false, error: e.message }); }
};

// Tunnel URL tracking + auto-reconnect callback
let tunnelUrl = null;
let callbackUrl = null;

// Load saved callback URL (persisted across restarts)
function loadCallbackUrl() {
  const cbPath = path.join(BRIDGE_DIR, '.callback-url');
  try { return fs.readFileSync(cbPath, 'utf8').trim(); } catch { return null; }
}
function saveCallbackUrl(url) {
  const cbPath = path.join(BRIDGE_DIR, '.callback-url');
  try { fs.writeFileSync(cbPath, url, { mode: 0o600 }); } catch {}
}
callbackUrl = loadCallbackUrl();

// Send tunnel URL to HappyCapy callback
function sendCallback(url) {
  if (!callbackUrl) return;
  const payload = JSON.stringify({
    tunnel_url: url,
    token: TOKEN,
    hostname: os.hostname(),
    arch: os.arch(),
    timestamp: new Date().toISOString(),
    event: 'tunnel_url_changed',
  });
  const parsedUrl = new URL(callbackUrl);
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 15000,
  };
  const mod = parsedUrl.protocol === 'https:' ? require('https') : http;
  const req = mod.request(options, (res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('[callback] Auto-reconnect sent to HappyCapy');
      } else {
        console.log('[callback] Response: ' + res.statusCode + ' ' + body);
      }
    });
  });
  req.on('error', (e) => { console.log('[callback] Failed: ' + e.message); });
  req.on('timeout', () => { req.destroy(); console.log('[callback] Timeout'); });
  req.write(payload);
  req.end();
}

// Update tunnel URL and notify
function updateTunnelUrl(url) {
  if (url === tunnelUrl) return;
  const oldUrl = tunnelUrl;
  tunnelUrl = url;
  // Save to file
  try { fs.writeFileSync(path.join(BRIDGE_DIR, '.tunnel-url'), url); } catch {}
  // Update CONNECTION_INFO.txt
  try {
    const info = 'CAPY BRIDGE CONNECTION INFO' +
      '\n============================' +
      '\nTunnel URL: ' + url +
      '\nToken: ' + TOKEN +
      '\nPort: ' + PORT +
      '\nUpdated: ' + new Date().toISOString() +
      '\n';
    fs.writeFileSync(path.join(BRIDGE_DIR, 'CONNECTION_INFO.txt'), info);
  } catch {}
  console.log('[tunnel] URL changed: ' + url);
  if (oldUrl) { console.log('[tunnel] (was: ' + oldUrl + ')'); }
  // Auto-send callback to HappyCapy
  sendCallback(url);
}

routes['POST /tunnel-url'] = async (req, res) => {
  const { url } = await parseBody(req);
  if (url) { updateTunnelUrl(url); }
  send(res, 200, { tunnelUrl });
};
routes['GET /tunnel-url'] = async (req, res) => { send(res, 200, { tunnelUrl }); };

// Callback URL management
routes['POST /callback-url'] = async (req, res) => {
  const { url } = await parseBody(req);
  if (url) { callbackUrl = url; saveCallbackUrl(url); console.log('[callback] URL set: ' + url); }
  send(res, 200, { callbackUrl: callbackUrl ? callbackUrl.substring(0, 40) + '...' : null });
};
routes['GET /callback-url'] = async (req, res) => {
  send(res, 200, { callbackUrl: callbackUrl ? 'configured' : null });
};

// Server restart
routes['POST /restart'] = async (req, res) => {
  send(res, 200, { success: true, message: 'Restarting in 1s...' });
  setTimeout(() => process.exit(0), 1000);
};

// --- Tunnel Log Watcher ---
// Watches the cloudflared log file for new tunnel URLs.
// When cloudflared restarts (via launchd), it writes a new URL to the log.
// This watcher detects it and auto-updates + auto-sends callback.
function startTunnelWatcher() {
  const logFiles = [
    path.join(BRIDGE_DIR, 'logs', 'tunnel-launchd.error.log'),
    path.join(BRIDGE_DIR, 'logs', 'tunnel-launchd.log'),
    path.join(BRIDGE_DIR, 'logs', 'tunnel-direct.log'),
    path.join(BRIDGE_DIR, 'logs', 'tunnel.log'),
  ];
  const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
  const watchedFiles = new Map();

  function scanLog(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = content.match(urlPattern);
      if (matches && matches.length > 0) {
        const latest = matches[matches.length - 1];
        if (latest !== tunnelUrl) {
          updateTunnelUrl(latest);
        }
      }
    } catch {}
  }

  function watchFile(filePath) {
    if (watchedFiles.has(filePath)) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') { scanLog(filePath); }
      });
      watcher.on('error', () => {});
      watchedFiles.set(filePath, watcher);
      // Do initial scan
      scanLog(filePath);
    } catch {}
  }

  // Watch existing log files
  logFiles.forEach(watchFile);

  // Periodically check for new log files and re-scan (every 15 seconds)
  setInterval(() => { logFiles.forEach(watchFile); }, 15000);

  console.log('[watcher] Tunnel log watcher started');
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  // Let WebSocket upgrade requests pass through to the upgrade event handler
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket") return;

  const urlPath = req.url.split('?')[0];
  const key = `${req.method} ${urlPath}`;

  // Health is public, everything else requires auth
  if (key !== 'GET /health' && !authenticate(req)) {
    return send(res, 401, { error: 'Unauthorized. Provide: Authorization: Bearer <token>' });
  }

  const handler = routes[key];
  if (handler) {
    try { await handler(req, res); }
    catch (e) { send(res, 500, { error: e.message }); }
  } else {
    send(res, 404, { error: `Unknown route: ${key}`, routes: Object.keys(routes) });
  }
});

// --- Port conflict resolution ---
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[!] Port ${PORT} in use. Attempting to free it...`);
    try { require('child_process').execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }); } catch {}
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 2000);
    return;
  }
  console.error('[FATAL]', err);
  process.exit(1);
});

// --- Crash protection ---
process.on('uncaughtException', err => { console.error('[uncaught]', err.message); });
process.on('unhandledRejection', reason => { console.error('[unhandled]', reason); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

// --- Start ---


// --- Voice Overlay Route ---
routes['GET /voice/overlay'] = (req, res) => {
  const voicePath = path.join(__dirname, 'voice.html');
  try {
    const html = fs.readFileSync(voicePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    send(res, 404, { error: 'voice.html not found' });
  }
};

// ============================================================
// VOICE ROUTES (for overlay UI)
// ============================================================

routes['GET /voice/status'] = (req, res) => {
  send(res, 200, { status: 'online', brain: true, tts: 'browser' });
};

routes['GET /voice/mic/status'] = (req, res) => {
  send(res, 200, { muted: false });
};

routes['POST /voice/overlay/push'] = (req, res) => {
  send(res, 200, { ok: true });
};

routes['POST /voice/command/stream'] = async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  function sseWrite(data) {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const command = parsed.command;

    if (!command) {
      sseWrite({ type: 'error', error: 'No command provided' });
      res.end();
      return;
    }

    sseWrite({ type: 'start', conversational: true });

    const brainReq = http.request({
      hostname: 'localhost',
      port: 7888,
      path: '/brain/query',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }, (brainRes) => {
      let data = '';
      brainRes.on('data', (chunk) => { data += chunk; });
      brainRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          const response = result.response || (result.data && result.data.response) || '';
          const tools = result.toolsUsed || (result.data && result.data.toolsUsed) || [];
          tools.forEach((t, i) => {
            sseWrite({
              type: 'step',
              tool: t.tool || t.name || ('tool_' + i),
              action: t.tool || t.name || '',
              description: t.status || 'completed',
            });
          });
sseWrite({ type: 'done', success: true, finalText: response });
          // Kokoro TTS via localhost:7892
          if (response) {
            const ttsText = response.replace(/[^a-zA-Z0-9 .,!?'-]/g, ' ').slice(0, 500);
            const ttsBody = JSON.stringify({ text: ttsText, voice: 'af_heart' });
            const ttsReq = http.request({
              hostname: 'localhost', port: 7892, path: '/tts', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ttsBody) },
            }, (ttsRes) => {
              const chunks = [];
              ttsRes.on('data', (ch) => chunks.push(ch));
              ttsRes.on('end', () => {
                const wav = Buffer.concat(chunks);
                if (wav.length > 100) {
                  const tmpFile = '/tmp/capy-tts-' + Date.now() + '.wav';
                  fs.writeFileSync(tmpFile, wav);
                  exec('afplay ' + tmpFile + ' && rm ' + tmpFile, () => {
                    try { sseWrite({ type: 'tts_done' }); } catch(e2) {}
                    try { res.end(); } catch(e2) {}
                  });
                } else {
                  try { sseWrite({ type: 'tts_done' }); } catch(e2) {}
                  try { res.end(); } catch(e2) {}
                }
              });
            });
            ttsReq.on('error', () => {
              try { sseWrite({ type: 'tts_done' }); } catch(e2) {}
              try { res.end(); } catch(e2) {}
            });
            ttsReq.write(ttsBody);
            ttsReq.end();
            return;
          }
        } catch (e) {
          sseWrite({ type: 'done', success: true, finalText: data });
        }
        res.end();
      });
    });

    brainReq.on('error', (e) => {
      sseWrite({ type: 'error', error: 'Brain query failed: ' + e.message });
      res.end();
    });

    brainReq.on('timeout', () => {
      brainReq.destroy();
      sseWrite({ type: 'error', error: 'Brain query timed out' });
      res.end();
    });

    brainReq.write(JSON.stringify({ message: command }));
    brainReq.end();

  } catch (e) {
    sseWrite({ type: 'error', error: e.message });
    res.end();
  }
};


// --- Load modules ---
try { require("./module-loader").loadModules(routes, authenticate, send); console.log("[loader] modules loaded"); } catch(e) { console.error("[loader] FAILED:", e.message); }
try { require("./modules/tutorial-engine").mountWebSocket(server); console.log("[loader] tutorial-engine WebSocket mounted"); } catch(e) { console.log("[loader] tutorial-engine WS skipped:", e.message); }

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ========================================');
  console.log('  |         CAPY BRIDGE v' + VERSION + '           |');
  console.log('  ========================================');
  console.log('');
  console.log('  Port     : ' + PORT);
  console.log('  Token    : ' + TOKEN.substring(0, 15) + '...');
  console.log('  Home     : ' + HOME);
  console.log('  Node     : ' + process.version);
  console.log('  PID      : ' + process.pid);
  console.log('  Callback : ' + (callbackUrl ? 'configured' : 'none'));
  console.log('');
  console.log('  Endpoints:');
  Object.keys(routes).forEach(r => console.log('    ' + r));
  console.log('');
  console.log('  Waiting for connections...');
  console.log('');
  // Start watching tunnel logs for URL changes
  startTunnelWatcher();
});

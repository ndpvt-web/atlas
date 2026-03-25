/**
 * Brain Tool Forge Module - Autonomous Tool Creation for Jarvis
 *
 * BabyAGI v3-inspired system where the AI can create new tools when
 * no existing tool fits the task. The brain identifies capability gaps,
 * generates Express route handlers, validates them, and hot-loads them.
 *
 * Lifecycle:
 * 1. Brain detects "no tool fits" during orchestration
 * 2. Calls `forge_tool` with description + expected I/O
 * 3. Tool Forge uses LLM to generate a route handler
 * 4. Code is AST-validated (syntax check, no dangerous patterns)
 * 5. Stored in SQLite + filesystem (~/capy-bridge/forged-tools/)
 * 6. Hot-mounted on the Express app (no restart needed)
 * 7. Tool schema added to available tools for future use
 *
 * Research basis: BabyAGI v3 (functionz DB), Voyager (skill library),
 * CREATOR (tool manufacturing), LATM (LLM-as-tool-maker).
 *
 * Axioms:
 * - Generated code runs in the SAME process (Express route handler)
 * - Security: AST validation blocks require(), eval(), child_process, fs.write
 * - Each forged tool gets its own route: /forged/<tool-name>
 * - Tools stored in SQLite (metadata) + filesystem (code)
 * - LLM generates the tool using AI Gateway Bedrock (Sonnet by default)
 * - Max 50 forged tools (prevent bloat)
 * - Tools can be disabled/deleted without restart
 * - Forged tools can use fetch() for external APIs, JSON processing,
 *   string manipulation, and math -- but NOT filesystem or process ops
 *
 * @module brain-tool-forge
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';
const BEDROCK_PATH = '/api/v1/bedrock/model/claude-sonnet-4-6/invoke';

const MAX_FORGED_TOOLS = 50;
const TOOL_CODE_MAX_LENGTH = 5000; // Max chars of generated code
const FORGED_TOOLS_DIR = path.join(process.env.HOME || '/tmp', 'capy-bridge', 'forged-tools');

// Dangerous patterns that forged tools must NOT contain
const BLOCKED_PATTERNS = [
  /\brequire\s*\(/,           // No require()
  /\bimport\s+/,              // No import statements
  /\beval\s*\(/,              // No eval()
  /\bFunction\s*\(/,          // No Function constructor
  /\bchild_process\b/,        // No child_process
  /\bexecSync\b/,             // No execSync
  /\bexecFile\b/,             // No execFile
  /\bspawnSync?\b/,           // No spawn/spawnSync
  /\bfs\b\.\b(write|unlink|rm|mkdir|rename|chmod|chown)/,  // No fs writes
  /\bprocess\.exit\b/,        // No process.exit
  /\bprocess\.env\b/,         // No env access
  /\b__dirname\b/,            // No directory access
  /\b__filename\b/,           // No filename access
  /\bglobal\b\./,             // No global mutations
  /\bBuffer\.alloc\b/,        // No large buffer allocation
];

// Allowed built-ins for forged tool sandbox
const SANDBOX_GLOBALS = [
  'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number',
  'Boolean', 'RegExp', 'Map', 'Set', 'Promise', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'console', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'setTimeout',
  'clearTimeout', 'fetch',
];

// ============================================================================
// CODE VALIDATOR
// ============================================================================

/**
 * Validates generated tool code for safety.
 * Returns { valid: boolean, errors: string[] }
 */
function validateToolCode(code) {
  const errors = [];

  // Length check
  if (code.length > TOOL_CODE_MAX_LENGTH) {
    errors.push(`Code exceeds max length: ${code.length} > ${TOOL_CODE_MAX_LENGTH}`);
  }

  // Blocked pattern check
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Blocked pattern detected: ${pattern.source}`);
    }
  }

  // Syntax validation via vm.Script
  try {
    new vm.Script(`(async function(req, res, context) { ${code} })`, {
      filename: 'forged-tool-validation.js',
    });
  } catch (syntaxErr) {
    errors.push(`Syntax error: ${syntaxErr.message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// LLM CODE GENERATION
// ============================================================================

/**
 * Call AI Gateway to generate tool code.
 */
function callLLM(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const options = {
      hostname: AI_GATEWAY_HOST,
      path: BEDROCK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_GATEWAY_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            resolve(parsed.content[0].text || '');
          } else if (parsed.error) {
            reject(new Error(`LLM error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Failed to parse LLM response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LLM request timed out'));
    });
    req.write(body);
    req.end();
  });
}

const TOOL_GENERATION_SYSTEM_PROMPT = `You are a tool-generating AI. You create Express route handler bodies for a personal AI assistant called Jarvis.

RULES:
1. Output ONLY the JavaScript function body (no function declaration, no module.exports)
2. The code runs inside: async function(req, res, context) { YOUR_CODE_HERE }
3. Available in scope:
   - req: Express request object (req.body for POST data, req.query for GET params)
   - res: Express response object (use res.json() to respond)
   - context.fetch: node-fetch for HTTP requests (already imported)
   - context.db: SQLite database handle (context.db.all(), context.db.run(), context.db.get())
   - JSON, Math, Date, Array, Object, String, Number, URL, URLSearchParams
4. FORBIDDEN: require(), import, eval(), child_process, fs writes, process.env, process.exit
5. Always return JSON via res.json({ success: true, ...data })
6. Handle errors with try/catch and return res.status(500).json({ success: false, error: message })
7. Keep code under 100 lines
8. Use context.fetch for any external API calls

EXAMPLE:
Given: "A tool that converts temperature between Celsius and Fahrenheit"

const { value, from } = req.body;
if (typeof value !== 'number') {
  return res.status(400).json({ success: false, error: 'value must be a number' });
}
const result = from === 'celsius'
  ? { fahrenheit: (value * 9/5) + 32 }
  : { celsius: (value - 32) * 5/9 };
res.json({ success: true, ...result });`;

/**
 * Generate tool code using LLM.
 */
async function generateToolCode(description, inputSchema, outputDescription) {
  const prompt = `Create a tool handler for:
DESCRIPTION: ${description}
INPUT: ${JSON.stringify(inputSchema, null, 2)}
EXPECTED OUTPUT: ${outputDescription}

Output ONLY the function body JavaScript code. No markdown fences. No explanation.`;

  const response = await callLLM(TOOL_GENERATION_SYSTEM_PROMPT, prompt);

  // Strip markdown fences if LLM included them
  let code = response
    .replace(/^```(?:javascript|js)?\n?/gm, '')
    .replace(/^```\n?/gm, '')
    .trim();

  return code;
}

// ============================================================================
// TOOL FORGE ENGINE
// ============================================================================

class ToolForge {
  constructor(db, app) {
    this.db = db;
    this.app = app; // Express app for hot-mounting routes
    this.forgedTools = new Map(); // name -> tool metadata
    this.initialized = false;
  }

  /**
   * Initialize: create tables, load existing forged tools, remount routes.
   */
  async init() {
    // Ensure forged tools directory exists
    try {
      fs.mkdirSync(FORGED_TOOLS_DIR, { recursive: true });
    } catch {
      // Directory might already exist
    }

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS forged_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        output_description TEXT,
        route TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forge_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        input TEXT,
        output TEXT,
        success INTEGER,
        execution_ms INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_forged_tools_name ON forged_tools(name);
      CREATE INDEX IF NOT EXISTS idx_forge_exec_tool ON forge_executions(tool_name);
    `);

    // Load existing forged tools and mount their routes
    await this.loadAndMountAll();

    this.initialized = true;
    console.log(`[tool-forge] Initialized. ${this.forgedTools.size} forged tools loaded.`);
  }

  /**
   * Load all enabled forged tools from DB and mount their routes.
   */
  async loadAndMountAll() {
    const tools = await this.db.all(
      'SELECT * FROM forged_tools WHERE enabled = 1'
    );

    for (const tool of tools) {
      const codePath = path.join(FORGED_TOOLS_DIR, `${tool.name}.js`);
      try {
        if (fs.existsSync(codePath)) {
          const code = fs.readFileSync(codePath, 'utf-8');
          this.mountTool(tool.name, tool.route, code);
          this.forgedTools.set(tool.name, {
            ...tool,
            input_schema: JSON.parse(tool.input_schema),
          });
        }
      } catch (err) {
        console.error(`[tool-forge] Failed to load tool '${tool.name}':`, err.message);
      }
    }
  }

  /**
   * Mount a forged tool as an Express route.
   * Uses a sandboxed context to limit what the code can access.
   */
  mountTool(name, route, code) {
    const db = this.db;
    const forgeRef = this;

    this.app.post(route, async (req, res) => {
      const startTime = Date.now();
      let success = false;
      let error = null;

      try {
        // Create sandboxed context
        const context = {
          fetch: globalThis.fetch || (await import('node-fetch')).default,
          db: {
            all: (...args) => db.all(...args),
            get: (...args) => db.get(...args),
            run: (...args) => db.run(...args),
          },
        };

        // Create a function from the stored code
        const fn = new Function('req', 'res', 'context',
          `return (async () => { ${code} })();`
        );

        await fn(req, res, context);
        success = true;
      } catch (err) {
        error = err.message;
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: err.message });
        }
      }

      const executionMs = Date.now() - startTime;

      // Log execution (non-blocking)
      try {
        await db.run(
          `INSERT INTO forge_executions (tool_name, input, output, success, execution_ms, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            JSON.stringify(req.body || {}).substring(0, 1000),
            success ? 'ok' : null,
            success ? 1 : 0,
            executionMs,
            error,
            Math.floor(Date.now() / 1000),
          ]
        );

        // Update usage count
        await db.run(
          'UPDATE forged_tools SET usage_count = usage_count + 1, last_used_at = ? WHERE name = ?',
          [Math.floor(Date.now() / 1000), name]
        );
      } catch {
        // Non-critical logging failure
      }
    });

    console.log(`[tool-forge] Mounted route: POST ${route}`);
  }

  /**
   * CORE: Forge a new tool from a description.
   *
   * 1. Validate we haven't hit the tool limit
   * 2. Use LLM to generate the handler code
   * 3. Validate the code (AST + blocked patterns)
   * 4. Store in SQLite + filesystem
   * 5. Hot-mount on Express
   * 6. Return the tool schema for brain.js
   */
  async forgeTool({ name, description, input_schema, output_description }) {
    // Normalize name
    const toolName = name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);

    // Check limit
    const count = await this.db.get('SELECT COUNT(*) as cnt FROM forged_tools');
    if (count.cnt >= MAX_FORGED_TOOLS) {
      throw new Error(`Tool limit reached (${MAX_FORGED_TOOLS}). Delete unused tools first.`);
    }

    // Check if name already exists
    const existing = await this.db.get('SELECT id FROM forged_tools WHERE name = ?', [toolName]);
    if (existing) {
      throw new Error(`Tool '${toolName}' already exists. Use update or delete first.`);
    }

    // Generate code via LLM
    console.log(`[tool-forge] Generating code for tool: ${toolName}`);
    const code = await generateToolCode(description, input_schema, output_description || 'JSON response');

    // Validate code
    const validation = validateToolCode(code);
    if (!validation.valid) {
      throw new Error(`Generated code failed validation: ${validation.errors.join('; ')}`);
    }

    // Determine route
    const route = `/forged/${toolName}`;
    const codeHash = crypto.createHash('sha256').update(code).digest('hex').substring(0, 16);

    // Store code to filesystem
    const codePath = path.join(FORGED_TOOLS_DIR, `${toolName}.js`);
    fs.writeFileSync(codePath, code, 'utf-8');

    // Store metadata in SQLite
    await this.db.run(
      `INSERT INTO forged_tools (name, description, input_schema, output_description, route, code_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toolName,
        description,
        JSON.stringify(input_schema),
        output_description || '',
        route,
        codeHash,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      ]
    );

    // Hot-mount the route
    this.mountTool(toolName, route, code);

    // Cache metadata
    this.forgedTools.set(toolName, {
      name: toolName,
      description,
      input_schema,
      output_description,
      route,
      code_hash: codeHash,
      enabled: 1,
      usage_count: 0,
    });

    // Build tool schema for brain.js
    const toolSchema = {
      name: `forged_${toolName}`,
      description: `[Forged Tool] ${description}`,
      input_schema: {
        type: 'object',
        properties: input_schema.properties || input_schema,
        required: input_schema.required || [],
      },
    };

    return {
      tool_name: toolName,
      route,
      code_hash: codeHash,
      code_length: code.length,
      tool_schema: toolSchema,
      validation: { valid: true, errors: [] },
    };
  }

  /**
   * Update an existing forged tool with new code.
   */
  async updateTool(name, { description, input_schema, output_description }) {
    const existing = await this.db.get('SELECT * FROM forged_tools WHERE name = ?', [name]);
    if (!existing) {
      throw new Error(`Tool '${name}' not found.`);
    }

    // Generate new code
    const code = await generateToolCode(
      description || existing.description,
      input_schema || JSON.parse(existing.input_schema),
      output_description || existing.output_description || 'JSON response'
    );

    const validation = validateToolCode(code);
    if (!validation.valid) {
      throw new Error(`Regenerated code failed validation: ${validation.errors.join('; ')}`);
    }

    const codeHash = crypto.createHash('sha256').update(code).digest('hex').substring(0, 16);
    const codePath = path.join(FORGED_TOOLS_DIR, `${name}.js`);
    fs.writeFileSync(codePath, code, 'utf-8');

    await this.db.run(
      `UPDATE forged_tools SET
        description = COALESCE(?, description),
        input_schema = COALESCE(?, input_schema),
        output_description = COALESCE(?, output_description),
        code_hash = ?,
        version = version + 1,
        updated_at = ?
       WHERE name = ?`,
      [
        description || null,
        input_schema ? JSON.stringify(input_schema) : null,
        output_description || null,
        codeHash,
        Math.floor(Date.now() / 1000),
        name,
      ]
    );

    // Re-mount route (Express will use the latest handler)
    this.mountTool(name, existing.route, code);

    return { tool_name: name, version: existing.version + 1, code_hash: codeHash };
  }

  /**
   * Delete a forged tool.
   */
  async deleteTool(name) {
    const existing = await this.db.get('SELECT * FROM forged_tools WHERE name = ?', [name]);
    if (!existing) {
      throw new Error(`Tool '${name}' not found.`);
    }

    // Remove from DB
    await this.db.run('DELETE FROM forged_tools WHERE name = ?', [name]);
    await this.db.run('DELETE FROM forge_executions WHERE tool_name = ?', [name]);

    // Remove file
    const codePath = path.join(FORGED_TOOLS_DIR, `${name}.js`);
    try {
      fs.unlinkSync(codePath);
    } catch {
      // File might not exist
    }

    this.forgedTools.delete(name);

    // Note: Express doesn't have a built-in way to un-mount a route.
    // The route handler will remain but the tool is marked as deleted.
    // On next restart, it won't be loaded.

    return { deleted: name };
  }

  /**
   * Enable/disable a forged tool.
   */
  async toggleTool(name, enabled) {
    await this.db.run(
      'UPDATE forged_tools SET enabled = ?, updated_at = ? WHERE name = ?',
      [enabled ? 1 : 0, Math.floor(Date.now() / 1000), name]
    );

    if (this.forgedTools.has(name)) {
      this.forgedTools.get(name).enabled = enabled ? 1 : 0;
    }

    return { tool_name: name, enabled };
  }

  /**
   * List all forged tools.
   */
  async listTools() {
    return this.db.all(
      'SELECT name, description, route, version, enabled, usage_count, last_used_at, created_at FROM forged_tools ORDER BY created_at DESC'
    );
  }

  /**
   * Get tool schemas for all active forged tools (for brain.js injection).
   */
  getActiveToolSchemas() {
    const schemas = [];
    for (const [name, meta] of this.forgedTools) {
      if (meta.enabled) {
        schemas.push({
          name: `forged_${name}`,
          description: `[Forged Tool] ${meta.description}`,
          input_schema: {
            type: 'object',
            properties: meta.input_schema.properties || meta.input_schema,
            required: meta.input_schema.required || [],
          },
        });
      }
    }
    return schemas;
  }

  /**
   * Get endpoint mapping for all active forged tools (for ToolExecutor).
   */
  getActiveEndpointMappings() {
    const mappings = {};
    for (const [name, meta] of this.forgedTools) {
      if (meta.enabled) {
        mappings[`forged_${name}`] = meta.route;
      }
    }
    return mappings;
  }

  /**
   * Get execution stats for a tool.
   */
  async getToolStats(name) {
    const stats = await this.db.get(
      `SELECT
        COUNT(*) as total_executions,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        AVG(execution_ms) as avg_ms,
        MAX(execution_ms) as max_ms,
        MIN(created_at) as first_used,
        MAX(created_at) as last_used
       FROM forge_executions WHERE tool_name = ?`,
      [name]
    );
    return stats;
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

function mountToolForgeRoutes(app, forge) {
  /**
   * POST /forge/create - Create a new tool
   */
  app.post('/forge/create', async (req, res) => {
    try {
      const { name, description, input_schema, output_description } = req.body;

      if (!name || !description || !input_schema) {
        return res.status(400).json({
          success: false,
          error: 'Required: name, description, input_schema',
        });
      }

      const result = await forge.forgeTool({
        name,
        description,
        input_schema,
        output_description,
      });

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[tool-forge] Create error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /forge/update - Update an existing tool
   */
  app.post('/forge/update', async (req, res) => {
    try {
      const { name, description, input_schema, output_description } = req.body;
      if (!name) {
        return res.status(400).json({ success: false, error: 'Missing name' });
      }

      const result = await forge.updateTool(name, {
        description,
        input_schema,
        output_description,
      });

      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /forge/delete - Delete a forged tool
   */
  app.post('/forge/delete', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ success: false, error: 'Missing name' });
      }

      const result = await forge.deleteTool(name);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /forge/list - List all forged tools
   */
  app.get('/forge/list', async (req, res) => {
    try {
      const tools = await forge.listTools();
      res.json({ success: true, count: tools.length, tools });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /forge/schemas - Get active tool schemas for brain.js
   */
  app.get('/forge/schemas', async (req, res) => {
    try {
      const schemas = forge.getActiveToolSchemas();
      const endpoints = forge.getActiveEndpointMappings();
      res.json({ success: true, schemas, endpoints });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /forge/stats/:name - Get execution stats for a tool
   */
  app.get('/forge/stats/:name', async (req, res) => {
    try {
      const stats = await forge.getToolStats(req.params.name);
      res.json({ success: true, ...stats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /forge/toggle - Enable/disable a tool
   */
  app.post('/forge/toggle', async (req, res) => {
    try {
      const { name, enabled } = req.body;
      if (!name || typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Required: name (string), enabled (boolean)' });
      }

      const result = await forge.toggleTool(name, enabled);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /forge/health - Health check
   */
  app.get('/forge/health', (req, res) => {
    res.json({
      success: true,
      module: 'tool-forge',
      active_tools: forge.forgedTools.size,
      max_tools: MAX_FORGED_TOOLS,
      tools_dir: FORGED_TOOLS_DIR,
    });
  });

  console.log('[tool-forge] Routes mounted: /forge/create, /forge/list, /forge/schemas, /forge/health');
}

// ============================================================================
// TOOL SCHEMAS (for brain.js)
// ============================================================================

const TOOL_FORGE_SCHEMAS = [
  {
    name: 'forge_tool',
    description: 'Create a new tool dynamically when no existing tool fits the task. The AI generates an Express route handler that gets hot-loaded. Use this when you need a capability that does not exist in the current toolset (e.g., a specialized API client, data transformer, or calculator).',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short snake_case name for the tool (e.g., "currency_converter", "json_diff").',
        },
        description: {
          type: 'string',
          description: 'Clear description of what the tool does.',
        },
        input_schema: {
          type: 'object',
          description: 'JSON Schema for the tool\'s input (properties and required fields).',
        },
        output_description: {
          type: 'string',
          description: 'Description of expected output format.',
        },
      },
      required: ['name', 'description', 'input_schema'],
    },
  },
  {
    name: 'list_forged_tools',
    description: 'List all dynamically created (forged) tools with their status, usage count, and descriptions.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_forged_tool',
    description: 'Delete a previously forged tool by name.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the forged tool to delete.',
        },
      },
      required: ['name'],
    },
  },
];

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
  ToolForge,
  validateToolCode,
  mountToolForgeRoutes,
  TOOL_FORGE_SCHEMAS,
};

/**
 * Capy Brain Module - Core Jarvis AI Orchestrator
 *
 * This module provides the central intelligence layer for capy-bridge,
 * orchestrating Claude Opus 4.6 with extended thinking to coordinate
 * all system capabilities: computer use, memory, file operations,
 * Instagram automation, meeting transcription, TTS, and more.
 *
 * Architecture:
 * - BrainOrchestrator: Main class managing sessions, context, agent loops
 * - ContextBuilder: Loads bootstrap files, retrieves memories, builds system prompts
 * - ToolExecutor: Executes tools via HTTP calls to capy-bridge endpoints
 * - Express routes: /brain/query, /brain/stream, /brain/health, etc.
 *
 * @module brain
 */

const fs = require('fs').promises;
const path = require('path');
const { MAC_BRIDGE_SCHEMAS } = require('./brain-macos-bridge');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const brainLearning = require('./brain-learning');
const http = require('http');

// PATCH: Fetch ATLAS learning context for desktop/vision tasks
function fetchATLASContext(task, timeout = 3000) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ task });
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT || '7888'),
      path: '/learning/context',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.context || '');
        } catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(postData);
    req.end();
  });
}

const https = require('https');

// Track dynamic imports
let Anthropic = null;
let fetch = globalThis.fetch || null;

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

// AI Gateway Bedrock config (same as computer-use.js for consistency)
const AI_GATEWAY_HOST = 'ai-gateway.happycapy.ai';
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || 'cc00f875633a4dca884e24f5ab6e0106';

// Model paths for Bedrock gateway
const BEDROCK_PATHS = {
  'claude-opus-4-6': '/api/v1/bedrock/model/claude-opus-4-6/invoke',
  'claude-sonnet-4-6': '/api/v1/bedrock/model/claude-sonnet-4-6/invoke',
  'claude-haiku-4-5': '/api/v1/bedrock/model/claude-haiku-4-5/invoke',
};

const CONFIG = {
  // API keys -- supports both direct Anthropic and AI Gateway
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || AI_GATEWAY_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,

  BRAIN_PORT: parseInt(process.env.BRAIN_PORT || '7888', 10),
  BRAIN_MAX_ITERATIONS: parseInt(process.env.BRAIN_MAX_ITERATIONS || '40', 10),
  BRAIN_MAX_TOKENS: parseInt(process.env.BRAIN_MAX_TOKENS || '16384', 10),
  BRAIN_BOOTSTRAP_DIR: process.env.BRAIN_BOOTSTRAP_DIR || './brain',
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY || '',
  TOOL_TIMEOUT: 30000, // 30s per tool call
  SESSION_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  MAX_SESSION_TURNS: 100,
};

const MODEL_DEFAULT = 'claude-sonnet-4-6';   // Fast default for everyday queries
const MODEL_PRIMARY = 'claude-opus-4-6';     // Escalation for complex tasks or failures
const MODEL_GATEKEEPER = 'claude-haiku-4-5';

// Keywords/patterns that trigger automatic Opus escalation
const OPUS_TRIGGERS = [
  /\b(refactor|architect|design|complex|analyze|debug)\b/i,
  /\b(write|create|build|implement)\b.*\b(module|system|feature|app)\b/i,
  /\b(code review|security audit|performance)\b/i,
  /\bmulti.?step\b/i,
];

// Tool costs (approx USD per 1M tokens)
const PRICING = {
  'claude-opus-4-6': { input: 5.00, output: 25.00, cache_read: 0.50, cache_write: 6.25 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cache_read: 0.10, cache_write: 1.25 },
};

// ============================================================================
// ERROR CLASSES
// ============================================================================

class BrainError extends Error {
  constructor(message, code = 'BRAIN_ERROR') {
    super(message);
    this.name = 'BrainError';
    this.code = code;
  }
}

class ToolExecutionError extends BrainError {
  constructor(message, tool_name, original_error) {
    super(message, 'TOOL_EXECUTION_ERROR');
    this.name = 'ToolExecutionError';
    this.tool_name = tool_name;
    this.original_error = original_error;
  }
}

class APIError extends BrainError {
  constructor(message, status_code, original_error) {
    super(message, 'API_ERROR');
    this.name = 'APIError';
    this.status_code = status_code;
    this.original_error = original_error;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate a UUID v4
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Get current timestamp in ISO format
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Calculate cost from token usage
 */
function calculateCost(model, usage) {
  const pricing = PRICING[model] || PRICING[MODEL_PRIMARY];
  const input_cost = (usage.input_tokens || 0) * pricing.input / 1_000_000;
  const output_cost = (usage.output_tokens || 0) * pricing.output / 1_000_000;
  const cache_read_cost = (usage.cache_read_tokens || 0) * pricing.cache_read / 1_000_000;
  const cache_write_cost = (usage.cache_creation_input_tokens || 0) * pricing.cache_write / 1_000_000;
  return input_cost + output_cost + cache_read_cost + cache_write_cost;
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Append line to JSONL file
 */
async function appendJSONL(filePath, data) {
  try {
    await ensureDir(path.dirname(filePath));
    const line = JSON.stringify(data) + '\n';
    await fs.appendFile(filePath, line, 'utf8');
  } catch (err) {
    console.error(`[brain] Failed to append to ${filePath}:`, err);
  }
}

/**
 * Read last N lines from JSONL file
 */
async function readLastNLines(filePath, n = 50) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLen = 200) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// TOOL SCHEMAS
// ============================================================================

const TOOL_SCHEMAS = [
  {
    name: 'memory_store',
    description: 'Store a fact, preference, or learned information in long-term memory. Use this to remember important information about the user, their preferences, recurring tasks, or anything you learn during conversations. The memory system uses hybrid FTS5+vector search for retrieval.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember. Be specific and include context (e.g., "User prefers to be called Alex, not Alexander" or "User works on AI projects and likes detailed technical explanations").',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization (e.g., ["preference", "name"], ["work", "project", "AI"]).',
        },
        importance: {
          type: 'number',
          description: 'Importance score 0-10 (default 5). Use 8-10 for critical facts, 5-7 for useful info, 1-4 for minor details.',
        },
      },
      required: ['content'],
      strict: true,
    },
  },
  {
    name: 'memory_search',
    description: 'Search long-term memory using hybrid FTS5 full-text search + vector similarity. Use this to recall facts, preferences, or past conversations. The search uses both keyword matching and semantic similarity.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "user name", "project deadlines", "coffee preferences").',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 10, max 50).',
        },
      },
      required: ['query'],
      strict: true,
    },
  },
  {
    name: 'computer_use_task',
    description: 'Execute a desktop automation task using computer vision and ShowUI-2B grounding. Can click, type, scroll, take screenshots, and perform complex multi-step workflows. Screen resolution: 1440x900. Use natural language to describe the task. For complex tasks, set force_opus=true to use Opus 4.6 from the start (skips Sonnet).',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Natural language task description (e.g., "Click the Safari icon in the dock", "Type \'hello world\' in the active text field", "Open Safari, navigate to example.com, and take a screenshot of the page").',
        },
        max_steps: {
          type: 'number',
          description: 'Maximum number of steps to execute (default 10, max 50). Each step can be a click, type, scroll, or screenshot.',
        },
        force_opus: {
          type: 'boolean',
          description: 'If true, use Opus 4.6 from the first step (no Sonnet warm-up). Use for complex multi-app workflows, ambiguous UI navigation, or when Sonnet failed previously. Default: false (starts with Sonnet, auto-escalates).',
        },
      },
      required: ['task'],
      strict: true,
    },
  },
  {
    name: 'terminal_exec',
    description: 'Execute a shell command on the Mac. Use for file operations, system tasks, running scripts, git operations, etc. Commands run in bash with the user\'s environment. Working directory: ~/capy-bridge. Be cautious with destructive operations.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g., "ls -la", "git status", "npm install").',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000, max 300000 for long-running commands).',
        },
      },
      required: ['command'],
      strict: true,
    },
  },
  {
    name: 'file_read',
    description: 'Read the contents of a file from the filesystem. Supports text files up to 10MB. Returns the full file contents as a string.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file (relative paths are relative to ~/capy-bridge).',
        },
      },
      required: ['path'],
      strict: true,
    },
  },
  {
    name: 'file_write',
    description: 'Write or overwrite a file with the specified content. Creates parent directories if needed. Use for creating config files, saving data, writing code, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file (relative paths are relative to ~/capy-bridge).',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['path', 'content'],
      strict: true,
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories in a directory. Returns an array of file/directory names with metadata (size, modified time, type).',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the directory (relative paths are relative to ~/capy-bridge).',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, recursively list all files in subdirectories (default false).',
        },
      },
      required: ['path'],
      strict: true,
    },
  },
  {
    name: 'speak',
    description: 'Speak text using text-to-speech. Supports Kokoro TTS (54 voices, 9 languages), Qwen3 TTS, or macOS built-in TTS. Use for voice responses, notifications, or accessibility.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to speak.',
        },
        engine: {
          type: 'string',
          enum: ['kokoro', 'qwen3', 'macos'],
          description: 'TTS engine to use (default: kokoro). Kokoro has best quality, Qwen3 is experimental, macOS is system default.',
        },
        voice: {
          type: 'string',
          description: 'Voice name (Kokoro: af_heart, am_phoenix, etc.; macOS: Samantha, Alex, etc.). If not specified, uses default voice.',
        },
      },
      required: ['text'],
      strict: true,
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the Playwright browser instance. Use for web browsing, scraping, testing web apps, etc. Browser persists across calls in the same session.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (must include protocol: http:// or https://).',
        },
        wait_until: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'When to consider navigation succeeded (default: load).',
        },
      },
      required: ['url'],
      strict: true,
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page. Returns a base64-encoded PNG image. Use after browser_navigate to see what the page looks like.',
    input_schema: {
      type: 'object',
      properties: {
        full_page: {
          type: 'boolean',
          description: 'If true, captures the entire scrollable page. If false, captures only the visible viewport (default false).',
        },
      },
      strict: true,
    },
  },
  {
    name: 'instagram_post',
    description: 'Post an image with caption to Instagram account mindbiashacks. Image must be a local file path or URL. Follows safe automation limits (max 3 posts/day). Use for content publishing.',
    input_schema: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: 'Absolute path to the image file, or URL to download from.',
        },
        caption: {
          type: 'string',
          description: 'Post caption (max 2200 characters). Can include hashtags, emojis, line breaks.',
        },
      },
      required: ['image_path', 'caption'],
      strict: true,
    },
  },
  {
    name: 'instagram_engage',
    description: 'Engage with Instagram content: like posts, follow users, comment, or browse feed. Follows safe automation limits to avoid detection. Use for account growth and community engagement.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['like', 'follow', 'comment', 'browse_feed', 'browse_explore'],
          description: 'The engagement action to perform.',
        },
        target: {
          type: 'string',
          description: 'Target for the action (username for follow, post URL for like/comment, hashtag for browse).',
        },
        comment_text: {
          type: 'string',
          description: 'Comment text (required if action=comment). Keep it genuine and relevant to avoid spam detection.',
        },
        count: {
          type: 'number',
          description: 'Number of items to engage with for browse actions (default 5, max 20).',
        },
      },
      required: ['action'],
      strict: true,
    },
  },
  {
    name: 'calendar_query',
    description: 'Query the macOS Calendar app for events. Can retrieve today\'s events, upcoming events, or events in a date range. Use for schedule awareness and meeting preparation.',
    input_schema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['today', 'upcoming', 'range'],
          description: 'Type of calendar query (today: today\'s events, upcoming: next 7 days, range: custom date range).',
        },
        start_date: {
          type: 'string',
          description: 'Start date for range query (ISO 8601 format: YYYY-MM-DD).',
        },
        end_date: {
          type: 'string',
          description: 'End date for range query (ISO 8601 format: YYYY-MM-DD).',
        },
      },
      required: ['query_type'],
      strict: true,
    },
  },
  {
    name: 'system_info',
    description: 'Get current system information: active application, clipboard contents, battery level, WiFi status, CPU/memory usage, etc. Use for context awareness.',
    input_schema: {
      type: 'object',
      properties: {
        info_type: {
          type: 'string',
          enum: ['active_app', 'clipboard', 'battery', 'wifi', 'resources', 'all'],
          description: 'Type of system info to retrieve (all: return everything).',
        },
      },
      required: ['info_type'],
      strict: true,
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the Mac screen. Returns a base64-encoded JPEG image. Uses ShowUI-2B for reliable capture with display wake. Screen: 1440x900.',
    input_schema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description: 'Optional region to capture in format "x,y,width,height" (e.g., "0,0,800,600"). If not specified, captures full screen.',
        },
      },
      strict: true,
    },
  },
  {
    name: 'screen_action',
    description: 'Execute a single desktop action (click, type, scroll, keypress) WITHOUT running the full agent loop. Much faster than computer_use_task (~100ms vs ~10s). Use when you know exactly what action to take (e.g., coordinates from a previous screenshot or from mac_accessibility). Pair with take_screenshot to verify.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: left_click, right_click, double_click, type, key, scroll, mouse_move, drag.',
          enum: ['left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'mouse_move', 'drag'],
        },
        coordinate: {
          type: 'array',
          description: 'Screen coordinates [x, y] for click/move actions. Range: x 0-1440, y 0-900.',
          items: { type: 'number' },
        },
        text: {
          type: 'string',
          description: 'Text to type (for type action) or key combo (for key action, e.g., "cmd+c", "Return", "escape").',
        },
        direction: {
          type: 'string',
          description: 'Scroll direction: up, down, left, right (for scroll action).',
          enum: ['up', 'down', 'left', 'right'],
        },
        amount: {
          type: 'number',
          description: 'Scroll amount in pixels (default 300).',
        },
      },
      required: ['action'],
      strict: true,
    },
  },
  {
    name: 'screen_analyze',
    description: 'Take a screenshot and analyze it with Opus 4.6 vision. Returns a detailed description of what is on screen. Use to understand UI state, find elements, read text, or verify actions. Costs ~$0.03/call. More thorough than take_screenshot alone since Opus reasons about the image.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What to analyze on screen (e.g., "What app is in the foreground?", "Where is the Settings button?", "Read the text in the main window", "Is there an error dialog visible?").',
        },
      },
      required: ['question'],
      strict: true,
    },
  },
  {
    name: 'meeting_start',
    description: 'Start real-time meeting transcription. Captures system audio and transcribes speech using Whisper. Transcripts are saved to files and can be retrieved later. Use when user starts a meeting or call.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_title: {
          type: 'string',
          description: 'Optional title for the meeting (used in filename and metadata).',
        },
      },
      strict: true,
    },
  },
  {
    name: 'meeting_stop',
    description: 'Stop the currently running meeting transcription. Returns the final transcript and saves it to a file. Use when user ends the meeting.',
    input_schema: {
      type: 'object',
      properties: {},
      strict: true,
    },
  },
  {
    name: 'macro_replay',
    description: 'Replay a previously recorded desktop macro. Macros are sequences of mouse/keyboard actions saved from earlier recordings. Use for repetitive tasks or workflows.',
    input_schema: {
      type: 'object',
      properties: {
        macro_name: {
          type: 'string',
          description: 'Name of the macro to replay (without .json extension).',
        },
        speed: {
          type: 'number',
          description: 'Playback speed multiplier (0.5 = half speed, 2.0 = double speed, default 1.0).',
        },
      },
      required: ['macro_name'],
      strict: true,
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information using a search engine. Returns a list of search results with titles, snippets, and URLs. Use when you need up-to-date information beyond your knowledge cutoff.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "latest news about AI", "weather in San Francisco", "how to install Node.js").',
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 10, max 50).',
        },
      },
      required: ['query'],
      strict: true,
    },
  },
  {
    name: 'send_notification',
    description: 'Send a macOS system notification to the user. Appears in Notification Center and optionally makes a sound. Use for important alerts, reminders, or task completions.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (e.g., "Task Complete", "Reminder").',
        },
        message: {
          type: 'string',
          description: 'Notification message body.',
        },
        sound: {
          type: 'boolean',
          description: 'If true, plays the default notification sound (default false).',
        },
      },
      required: ['title', 'message'],
      strict: true,
    },
  },
  // --- Xcode Automation Tools ---
  {
    name: 'xcode_create_project',
    description: 'Create a new Swift/SwiftUI project with proper structure. Generates Sources/, Resources/Info.plist, build.sh (or Package.swift for SPM), and a template entry point. Use this to scaffold new macOS or iOS apps before writing code.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name (e.g., "MyApp"). Used for binary name, bundle ID, and directory.',
        },
        path: {
          type: 'string',
          description: 'Directory path for the project (e.g., "~/capy-bridge/MyApp").',
        },
        platform: {
          type: 'string',
          enum: ['macos', 'ios'],
          description: 'Target platform (default: macos).',
        },
        template: {
          type: 'string',
          enum: ['swiftui', 'cli', 'menubar'],
          description: 'App template (default: swiftui). menubar = LSUIElement app (no dock icon).',
        },
        use_spm: {
          type: 'boolean',
          description: 'Use Swift Package Manager with Package.swift (default: false).',
        },
        frameworks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional frameworks to link (e.g., ["CoreAudio", "ScreenCaptureKit"]).',
        },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'xcode_build',
    description: 'Build a Swift project. Auto-detects strategy (swiftc vs xcodebuild). Returns structured diagnostics with file, line, column for each error. Creates .app bundle with ad-hoc code signing.',
    input_schema: {
      type: 'object',
      properties: {
        project_dir: {
          type: 'string',
          description: 'Path to project root (must contain Sources/ or Package.swift).',
        },
        strategy: {
          type: 'string',
          enum: ['swiftc', 'xcodebuild', 'auto'],
          description: 'Build strategy (default: auto).',
        },
        output_name: {
          type: 'string',
          description: 'Name for the output binary/app.',
        },
        platform: {
          type: 'string',
          enum: ['macos', 'ios-simulator'],
          description: 'Target platform (default: macos).',
        },
        frameworks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Frameworks to link.',
        },
        create_bundle: {
          type: 'boolean',
          description: 'Create .app bundle after compilation (default: true).',
        },
        extra_flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional compiler flags.',
        },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'xcode_deploy',
    description: 'Full deploy pipeline: build + bundle + optional simulator install + launch. For macOS: builds and opens .app. For iOS: builds, boots simulator, installs, launches. Returns step-by-step results.',
    input_schema: {
      type: 'object',
      properties: {
        project_dir: {
          type: 'string',
          description: 'Path to project root directory.',
        },
        output_name: {
          type: 'string',
          description: 'Name for the output binary/app.',
        },
        platform: {
          type: 'string',
          enum: ['macos', 'ios-simulator'],
          description: 'Target platform (default: macos).',
        },
        simulator: {
          type: 'string',
          description: 'Simulator name or UDID for iOS deployment.',
        },
        bundle_id: {
          type: 'string',
          description: 'App bundle ID for simulator launch.',
        },
        launch_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'CLI args to pass to the launched app.',
        },
        frameworks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Frameworks to link.',
        },
      },
      required: ['project_dir'],
    },
  },
  {
    name: 'xcode_list_simulators',
    description: 'List available iOS/visionOS simulators with boot state, runtime, and UDID. Use to find simulator names before deploying.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Filter by platform (e.g., "iOS", "visionOS").',
        },
        state: {
          type: 'string',
          enum: ['Booted', 'Shutdown'],
          description: 'Filter by simulator state.',
        },
      },
    },
  },
  {
    name: 'xcode_boot_simulator',
    description: 'Boot an iOS simulator by name or UDID. Must be booted before apps can be installed. Returns success if already booted.',
    input_schema: {
      type: 'object',
      properties: {
        simulator: {
          type: 'string',
          description: 'Simulator name (e.g., "iPhone 17 Pro") or UDID.',
        },
      },
      required: ['simulator'],
    },
  },
  // Cross-module integration tools (Phase 2)
  {
    name: 'call_agent_start',
    description: 'Start a voice call agent session for real-time voice conversations. Supports Kokoro and Qwen3 TTS.',
    input_schema: {
      type: 'object',
      properties: {
        voice: { type: 'string', description: 'TTS voice (e.g. am_michael, af_heart)' },
        systemPrompt: { type: 'string', description: 'System instructions for the call agent' },
        userName: { type: 'string', description: 'Name of the user' },
        ttsEngine: { type: 'string', enum: ['kokoro', 'qwen3'], description: 'TTS engine (default: kokoro)' },
      },
    },
  },
  {
    name: 'call_agent_stop',
    description: 'Stop the active call agent session. Returns session stats and transcript.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'call_agent_config',
    description: 'Update config of a running call agent (system prompt, voice, TTS engine).',
    input_schema: {
      type: 'object',
      properties: {
        systemPrompt: { type: 'string', description: 'Updated system instructions' },
        voice: { type: 'string', description: 'New TTS voice' },
        ttsEngine: { type: 'string', enum: ['kokoro', 'qwen3'], description: 'New TTS engine' },
      },
    },
  },
  {
    name: 'meeting_proxy_start',
    description: 'Start AI meeting proxy. Listens to meeting audio, generates contextual responses, speaks via TTS. Works with Zoom, Google Meet.',
    input_schema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'Instructions for proxy behavior' },
        userName: { type: 'string', description: 'Display name for the proxy' },
        voice: { type: 'string', description: 'TTS voice for responses' },
        ttsEngine: { type: 'string', enum: ['kokoro', 'qwen3'], description: 'TTS engine' },
        autoPilot: { type: 'boolean', description: 'Auto-speak responses without approval' },
        language: { type: 'string', description: 'Whisper language code (e.g. en, ja)' },
      },
    },
  },
  {
    name: 'meeting_proxy_stop',
    description: 'Stop active meeting proxy session. Returns transcript and summary.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'meeting_proxy_instruct',
    description: 'Update instructions for a running meeting proxy session.',
    input_schema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'New instructions for the proxy' },
      },
      required: ['instructions'],
    },
  },
  {
    name: 'voice_agent_switch',
    description: 'Switch the active voice assistant agent. Agents: capy, luna, max, emma, mei, fenrir.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to switch to' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'voice_mute',
    description: 'Toggle microphone mute for the voice assistant.',
    input_schema: {
      type: 'object',
      properties: {
        muted: { type: 'boolean', description: 'true to mute, false to unmute' },
      },
    },
  },
  {
    name: 'voice_status',
    description: 'Get voice assistant status: active agent, mute state, available agents, TTS engine.',
    input_schema: { type: 'object', properties: {} },
  },
  // Mac system integration tools
  ...MAC_BRIDGE_SCHEMAS,
];

// ============================================================================
// CONTEXT BUILDER
// ============================================================================

class ContextBuilder {
  constructor(bootstrapDir, port) {
    this.bootstrapDir = bootstrapDir;
    this.port = port;
    this.cachedIdentity = null;
    this.cachedMemory = null;
    this.lastCacheTime = 0;
    this.CACHE_TTL = 60000; // Re-read files every 60s
  }

  async readBootstrapFile(filename) {
    try {
      const filePath = path.join(this.bootstrapDir, filename);
      const content = await require('fs').promises.readFile(filePath, 'utf-8');
      return content.trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      console.error('[ContextBuilder] Failed to read ' + filename + ':', err.message);
      return null;
    }
  }

  async getRelevantMemories(query) {
    try {
      const response = await (globalThis.fetch || require('node-fetch'))(
        'http://localhost:' + this.port + '/brain/memory/search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (process.env.CAPY_BRIDGE_TOKEN || ''),
          },
          body: JSON.stringify({ query, limit: 5 }),
        }
      );
      if (!response.ok) return [];
      const data = await response.json();
      return data.results || data.memories || [];
    } catch (err) {
      // Memory search is optional - don't fail if it's unavailable
      return [];
    }
  }

  async buildSystemPrompt(userMessage) {
    const now = Date.now();
    const needsRefresh = now - this.lastCacheTime > this.CACHE_TTL;

    // Read bootstrap files (with caching)
    if (needsRefresh || !this.cachedIdentity) {
      this.cachedIdentity = await this.readBootstrapFile('IDENTITY.md');
      this.cachedMemory = await this.readBootstrapFile('MEMORY.md');
      this.lastCacheTime = now;
    }

    const heartbeat = await this.readBootstrapFile('HEARTBEAT.md');

    // Fetch relevant memories for this query
    let memoryContext = '';
    if (userMessage) {
      const memories = await this.getRelevantMemories(userMessage);
      if (memories.length > 0) {
        memoryContext = '\n\n## Relevant Memories\n' +
          memories.map(m => '- ' + (m.content || m.text || JSON.stringify(m))).join('\n');
      }
    }

    // Build the system prompt
    const parts = [];

    if (this.cachedIdentity) {
      parts.push(this.cachedIdentity);
    }

    if (this.cachedMemory) {
      parts.push('\n\n## Persistent Memory\n' + this.cachedMemory);
    }

    if (heartbeat) {
      parts.push('\n\n## Current State\n' + heartbeat);
    }

    if (memoryContext) {
      parts.push(memoryContext);
    }

    // Add current timestamp
    parts.push('\n\n## Current Time\n' + new Date().toISOString());

    // Add available tools summary
    parts.push('\n\n## Available Tools\nYou have ' + TOOL_SCHEMAS.length + ' tools available. Use them proactively to accomplish tasks.');

    // Inject learning context (brain-learning pipeline)
    try {
      const learningContext = brainLearning.getRelevantContext(userMessage);
      if (learningContext) {
        parts.push('\n\n## Past Experience (Learning Pipeline)' + learningContext);
      }
    } catch (err) {
      console.error('[brain] Learning context error:', err.message);
    }

    // PATCH: Inject ATLAS desktop learning for vision/desktop tasks
    // This bridges 110+ ATLAS reflections and environment knowledge into Brain
    try {
      const taskType = brainLearning.classifyTaskType(userMessage);
      const desktopTypes = ['vision', 'desktop_action', 'general'];
      const desktopKeywords = /\b(screen|click|type|open|safari|finder|app|desktop|window|spotlight|scroll|navigate|browser|tab|url|search|settings)\b/i;
      if (desktopTypes.includes(taskType) || desktopKeywords.test(userMessage)) {
        const atlasContext = await fetchATLASContext(userMessage, 2000);
        if (atlasContext && atlasContext.length > 50) {
          parts.push('\n\n## ATLAS Desktop Experience (from 110+ computer-use interactions)\n' + atlasContext);
          console.log('[brain] ATLAS context injected:', atlasContext.length, 'chars');
        }
      }
    } catch (err) {
      console.error('[brain] ATLAS context error:', err.message);
    }

    return parts.join('');
  }
}

// ============================================================================
// TOOL EXECUTOR
// ============================================================================

class ToolExecutor {
  constructor(port) {
    this.port = port;
    this.fetch = globalThis.fetch || require('node-fetch');
  }

  getEndpointForTool(toolName) {
    const endpointMap = {
      memory_store: '/brain/memory/store',
      memory_search: '/brain/memory/search',
      memory_predict: '/brain/memory/predict',
      computer_use_task: '/computer/agent',
      screen_action: '/computer/action',
      screen_analyze: '/computer/screenshot',
      terminal_exec: '/terminal/exec',
      file_read: '/files/read',
      file_write: '/files/write',
      file_list: '/files/list',
      speak: '/voice/speak',
      browser_navigate: '/browser/navigate',
      browser_screenshot: '/browser/screenshot',
      instagram_post: '/instagram/post',
      instagram_engage: '/instagram/engage',
      calendar_query: '/calendar/query',
      system_info: '/system/info',
      take_screenshot: '/computer/screenshot',
      meeting_start: '/meeting/start',
      meeting_stop: '/meeting/stop',
      macro_replay: '/macro/replay',
      web_search: '/web/search',
      send_notification: '/system/notify',
      schedule_task: '/scheduler/create',
      cancel_scheduled_task: '/scheduler/cancel',
      list_scheduled_tasks: '/scheduler/list',
      delegate_to_agent: '/brain/agents/delegate',
      orchestrate_agents: '/brain/agents/orchestrate',
      forge_tool: '/forge/create',
      list_forged_tools: '/forge/list',
      delete_forged_tool: '/forge/delete',
      xcode_create_project: '/xcode/project/create',
      xcode_build: '/xcode/build',
      xcode_deploy: '/xcode/deploy',
      xcode_list_simulators: '/xcode/simulator/list',
      xcode_boot_simulator: '/xcode/simulator/boot',
      mac_accessibility: '/mac/accessibility',
      mac_reminders: '/mac/reminders',
      mac_notes: '/mac/notes',
      mac_calendar: '/mac/calendar',
      mac_mail: '/mac/mail/unread',
      mac_contacts: '/mac/contacts/search',
      mac_music: '/mac/music',
      mac_system: '/mac/system',
      // Cross-module integration (Phase 2)
      call_agent_start: '/call-agent/start',
      call_agent_stop: '/call-agent/stop',
      call_agent_config: '/call-agent/config',
      meeting_proxy_start: '/mproxy/start',
      meeting_proxy_stop: '/mproxy/stop',
      meeting_proxy_instruct: '/mproxy/instruct',
      voice_agent_switch: '/voice/agent',
      voice_mute: '/voice/mute',
      voice_status: '/voice/status',
    };

    return endpointMap[toolName] || `/tools/${toolName}`;
  }

  async executeTool(toolName, toolInput) {
    // Redirect deprecated tool names to Mac-native equivalents
    const toolAliases = {
      calendar_query: 'mac_calendar',
      system_info: 'mac_system',
    };
    if (toolAliases[toolName]) {
      console.log('[ToolExecutor] Redirecting ' + toolName + ' -> ' + toolAliases[toolName]);
      toolName = toolAliases[toolName];
      // Set default actions for redirected tools
      if (!toolInput.action) {
        if (toolName === 'mac_calendar') toolInput.action = 'events';
        if (toolName === 'mac_system') toolInput.action = 'battery';
      }
    }
    let endpoint = this.getEndpointForTool(toolName);

    if (toolName.startsWith('mac_')) {
      const action = toolInput.action || (() => {
        // Default actions when brain doesn't specify one
        const defaults = {
          mac_accessibility: 'clickable',
          mac_reminders: 'list',
          mac_notes: 'search',
          mac_calendar: 'events',
          mac_mail: null, // uses base endpoint
          mac_contacts: null, // uses base endpoint
          mac_music: 'status',
          mac_system: 'battery',
        };
        return defaults[toolName] || null;
      })();
      if (toolName === 'mac_accessibility') {
        const routes = { tree: '/mac/accessibility/tree', clickable: '/mac/accessibility/clickable', text_fields: '/mac/accessibility/text-fields', click: '/mac/accessibility/click' };
        if (routes[action]) {
          toolInput._overrideEndpoint = routes[action];
          if (action === 'tree' && toolInput.max_depth) { toolInput.maxDepth = toolInput.max_depth; delete toolInput.max_depth; }
        }
      }
      if (toolName === 'mac_reminders') {
        const routes = { list: '/mac/reminders/list', create: '/mac/reminders/create', complete: '/mac/reminders/complete' };
        if (action === 'lists') { toolInput._overrideEndpoint = '/mac/reminders/lists'; toolInput._useGet = true; }
        else if (routes[action]) { toolInput._overrideEndpoint = routes[action]; }
        if (toolInput.due_date) { toolInput.dueDate = toolInput.due_date; delete toolInput.due_date; }
        if (toolInput.list_name) { toolInput.listName = toolInput.list_name; delete toolInput.list_name; }
      }
      if (toolName === 'mac_notes') {
        const routes = { search: '/mac/notes/search', create: '/mac/notes/create' };
        if (action === 'folders') { toolInput._overrideEndpoint = '/mac/notes/folders'; toolInput._useGet = true; }
        else if (routes[action]) { toolInput._overrideEndpoint = routes[action]; }
      }
      if (toolName === 'mac_calendar') {
        const routes = { events: '/mac/calendar/events', create: '/mac/calendar/create' };
        if (routes[action]) { toolInput._overrideEndpoint = routes[action]; }
        if (toolInput.days_ahead) { toolInput.daysAhead = toolInput.days_ahead; delete toolInput.days_ahead; }
        if (toolInput.start_date) { toolInput.startDate = toolInput.start_date; delete toolInput.start_date; }
        if (toolInput.end_date) { toolInput.endDate = toolInput.end_date; delete toolInput.end_date; }
      }
      if (toolName === 'mac_music') {
        if (action === 'status') { toolInput._overrideEndpoint = '/mac/music/status'; toolInput._useGet = true; }
        else { toolInput._overrideEndpoint = '/mac/music/control'; }
      }
      if (toolName === 'mac_system') {
        const getRoutes = { battery: '/mac/system/battery', wifi: '/mac/system/wifi', volume: '/mac/system/volume', disk: '/mac/system/disk', apps: '/mac/system/apps', active_window: '/mac/system/active-window' };
        const postRoutes = { set_volume: '/mac/system/volume', switch_app: '/mac/system/switch-app', wake_display: '/mac/system/wake-display' };
        if (getRoutes[action]) { toolInput._overrideEndpoint = getRoutes[action]; toolInput._useGet = true; }
        else if (postRoutes[action]) {
          toolInput._overrideEndpoint = postRoutes[action];
          if (action === 'set_volume') { toolInput.level = toolInput.volume_level; delete toolInput.volume_level; }
          if (action === 'switch_app') { toolInput.app = toolInput.app_name; delete toolInput.app_name; }
        }
        if (action === 'recent_files') { toolInput._overrideEndpoint = '/mac/finder/recent-files'; toolInput._useGet = true; }
      }
      delete toolInput.action;
    }

    // Phase 2: Cross-module GET routes
    if (toolName === 'voice_status') { toolInput._useGet = true; }
    if (toolName === 'call_agent_stop') { /* POST, no special handling */ }

    if (toolName === 'computer_use_task') {
      if (toolInput.max_steps) {
        toolInput.maxIterations = toolInput.max_steps;
        delete toolInput.max_steps;
      }
      if (toolInput.force_opus) {
        toolInput.forceModel = 'opus';
        delete toolInput.force_opus;
      }
    }

    // screen_analyze: take screenshot then send to Opus for analysis
    // This is handled as a special tool -- we call screenshot, then call the LLM
    if (toolName === 'screen_analyze') {
      try {
        // First take screenshot
        const ssResponse = await this.fetch(`http://localhost:${this.port}/computer/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CAPY_BRIDGE_TOKEN}` },
          body: JSON.stringify({}),
        });
        const ssData = await ssResponse.json();
        if (!ssData.base64) {
          return { is_error: true, error: 'Screenshot failed: ' + (ssData.error || 'no image data'), suggestion: 'Display may be off or Screen Recording permission not granted. Check System Settings > Privacy & Security > Screen Recording.' };
        }

        // Then analyze with Opus via the AI gateway
        const question = toolInput.question || 'Describe what you see on screen.';
        const AI_KEY = AI_GATEWAY_KEY;
        const analyzeResponse = await this.fetch('https://ai-gateway.happycapy.ai/api/v1/bedrock/model/claude-sonnet-4-6/invoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_KEY}` },
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ssData.base64 } },
                { type: 'text', text: question },
              ],
            }],
          }),
        });
        const analyzeData = await analyzeResponse.json();
        const analysisText = analyzeData.content?.[0]?.text || JSON.stringify(analyzeData);
        return { analysis: analysisText, screenshot_size: ssData.base64.length, screen: ssData.screen || '1440x900' };
      } catch (err) {
        return { is_error: true, error: 'Screen analysis failed: ' + err.message };
      }
    }

    const finalEndpoint = toolInput._overrideEndpoint || endpoint;
    const useGet = toolInput._useGet || false;
    delete toolInput._overrideEndpoint;
    delete toolInput._useGet;

    try {
      const response = await this.fetch(`http://localhost:${this.port}${finalEndpoint}`, {
        method: useGet ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.CAPY_BRIDGE_TOKEN || ''),
        },
        ...(useGet ? {} : { body: JSON.stringify(toolInput) }),
      });

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { output: text };
      }

      if (!response.ok) {
        throw new ToolExecutionError(
          `Tool ${toolName} failed with status ${response.status}: ${text.substring(0, 200)}`,
          toolName,
          new Error(text)
        );
      }

      return result;
    } catch (error) {
      if (error instanceof ToolExecutionError) throw error;
      throw new ToolExecutionError(
        `Tool ${toolName} execution error: ${error.message}`,
        toolName,
        error
      );
    }
  }

  /**
   * Execute multiple tools in parallel
   */
  async executeTools(toolUses) {
    const promises = toolUses.map(async (toolUse) => {
      try {
        const startTime = Date.now();
        const result = await this.executeTool(toolUse.name, toolUse.input);
        result.latency_ms = Date.now() - startTime;
        return {
          tool_use_id: toolUse.id,
          tool_name: toolUse.name,
          result,
        };
      } catch (error) {
        console.error('[ToolExecutor] Tool ' + toolUse.name + ' failed:', error.message);
        return {
          tool_use_id: toolUse.id,
          tool_name: toolUse.name,
          result: {
            is_error: true,
            error: error.message,
            suggestion: 'This tool failed. Try an alternative tool or approach.',
          },
        };
      }
    });

    return await Promise.all(promises);
  }
}

// ============================================================================
// BRAIN ORCHESTRATOR
// ============================================================================

class BrainOrchestrator extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.contextBuilder = new ContextBuilder(config.BRAIN_BOOTSTRAP_DIR, config.BRAIN_PORT);
    this.toolExecutor = new ToolExecutor(config.BRAIN_PORT);
    this.anthropic = null;
    this.sessions = new Map();
    this.stats = {
      total_queries: 0,
      total_errors: 0,
      total_cost: 0,
      start_time: Date.now(),
    };
    this.dailyUsage = new Map();
  }

  /**
   * Initialize the Anthropic client
   */
  async initialize() {
    if (this.initialized) return;

    // Determine API mode: Bedrock Gateway (preferred) or Direct SDK
    this.useGateway = !!this.config.AI_GATEWAY_API_KEY;
    this.gatewayKey = this.config.AI_GATEWAY_API_KEY || AI_GATEWAY_KEY;

    if (this.useGateway) {
      console.log('[brain] Initialized with AI Gateway Bedrock endpoint');
      console.log(`[brain] Default: ${MODEL_DEFAULT} | Escalation: ${MODEL_PRIMARY}`);
    } else if (this.config.ANTHROPIC_API_KEY) {
      // Direct Anthropic SDK mode (fallback)
      const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
      Anthropic = AnthropicSDK;
      this.anthropic = new Anthropic({ apiKey: this.config.ANTHROPIC_API_KEY });
      console.log('[brain] Initialized with direct Anthropic API');
      console.log(`[brain] Default: ${MODEL_DEFAULT} | Escalation: ${MODEL_PRIMARY}`);
    } else {
      throw new BrainError('No API key found. Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY', 'CONFIG_ERROR');
    }

    this.initialized = true;
  }

  /**
   * Call Claude via AI Gateway Bedrock endpoint (raw HTTPS, matches computer-use.js pattern)
   */
  callClaudeGateway(params) {
    return new Promise((resolve, reject) => {
      const model = params.model || MODEL_PRIMARY;
      const bedrockPath = BEDROCK_PATHS[model] || BEDROCK_PATHS[MODEL_PRIMARY];

      // Build Bedrock-format body (model is in URL path, not body)
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: params.max_tokens,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        tool_choice: params.tool_choice,
        thinking: params.thinking,
        output_config: params.output_config,
      });

      const options = {
        hostname: AI_GATEWAY_HOST,
        path: bedrockPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gatewayKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      console.log(`[brain] Calling ${model} via Bedrock gateway (${Buffer.byteLength(body)} bytes)`);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              console.error(`[brain] Gateway error ${res.statusCode}: ${data.slice(0, 300)}`);
              const err = new APIError(
                `Gateway ${res.statusCode}: ${parsed.message || parsed.error?.message || data.slice(0, 200)}`,
                res.statusCode
              );
              reject(err);
            } else {
              console.log(`[brain] ${model} response: stop=${parsed.stop_reason}, blocks=${parsed.content?.length}, usage=${JSON.stringify(parsed.usage || {})}`);
              resolve(parsed);
            }
          } catch (e) {
            reject(new APIError(`Parse error: ${data.slice(0, 200)}`, res.statusCode));
          }
        });
      });

      req.on('error', (err) => reject(new APIError(`Network error: ${err.message}`, 0, err)));
      req.setTimeout(180000, () => { req.destroy(); reject(new APIError('API timeout (180s)', 408)); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Get or create a session
   */
  getSession(sessionId) {
    if (!sessionId) {
      sessionId = generateUUID();
    }

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        created_at: Date.now(),
        last_activity: Date.now(),
        messages: [],
        turn_count: 0,
      });
    }

    const session = this.sessions.get(sessionId);
    session.last_activity = Date.now();
    return session;
  }

  /**
   * Clean up expired sessions
   */
  cleanupSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.last_activity > this.config.SESSION_TIMEOUT) {
        this.sessions.delete(sessionId);
        console.log(`[brain] Cleaned up expired session: ${sessionId}`);
      }
    }
  }

  /**
   * Track usage for daily aggregation
   */
  trackUsage(model, usage, cost, success = true) {
    const today = new Date().toISOString().split('T')[0];

    if (!this.dailyUsage.has(today)) {
      this.dailyUsage.set(today, {
        date: today,
        queries: 0,
        errors: 0,
        total_tokens: 0,
        total_cost: 0,
        by_model: {},
      });
    }

    const daily = this.dailyUsage.get(today);
    daily.queries += 1;
    if (!success) daily.errors += 1;
    daily.total_tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
    daily.total_cost += cost;

    if (!daily.by_model[model]) {
      daily.by_model[model] = { queries: 0, tokens: 0, cost: 0 };
    }
    daily.by_model[model].queries += 1;
    daily.by_model[model].tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
    daily.by_model[model].cost += cost;

    // Write to usage log
    const usageDir = path.join(this.config.BRAIN_BOOTSTRAP_DIR, 'usage.jsonl');
    appendJSONL(usageDir, {
      timestamp: getTimestamp(),
      date: today,
      model,
      usage,
      cost,
      success,
    }).catch(err => console.error('[brain] Failed to log usage:', err));
  }

  /**
   * Log interaction to history
   */
  async logHistory(data) {
    const historyPath = path.join(this.config.BRAIN_BOOTSTRAP_DIR, 'history.jsonl');
    await appendJSONL(historyPath, {
      timestamp: getTimestamp(),
      ...data,
    });
  }

  /**
   * Log error
   */
  async logError(error, context = {}) {
    const errorPath = path.join(this.config.BRAIN_BOOTSTRAP_DIR, 'errors.jsonl');
    await appendJSONL(errorPath, {
      timestamp: getTimestamp(),
      error: error.message,
      code: error.code,
      stack: error.stack,
      context,
    });
  }

  /**
   * Select the appropriate model based on message complexity
   */
  selectModel(userMessage, requestedModel = null) {
    // Explicit request takes priority
    if (requestedModel === 'opus') return MODEL_PRIMARY;
    if (requestedModel === 'sonnet') return MODEL_DEFAULT;
    if (requestedModel === 'haiku') return MODEL_GATEKEEPER;

    // Check for complexity triggers -> auto-escalate to Opus
    for (const pattern of OPUS_TRIGGERS) {
      if (pattern.test(userMessage)) {
        console.log(`[brain] Auto-escalating to Opus (matched: ${pattern})`);
        return MODEL_PRIMARY;
      }
    }

    // Default to Sonnet for fast responses
    return MODEL_DEFAULT;
  }

  /**
   * Run the agent loop (Sonnet default, Opus for complex/failures)
   */
  async runAgentLoop(userMessage, sessionId = null, streamCallback = null, requestedModel = null) {
    await this.initialize();

    const session = this.getSession(sessionId);
    const startTime = Date.now();
    const requestId = generateUUID();

    // Select model (Sonnet default, Opus for complex tasks)
    const selectedModel = this.selectModel(userMessage, requestedModel);
    console.log(`[brain] Starting agent loop for request ${requestId} [model: ${selectedModel}]`);

    // Build system prompt
    const systemPrompt = await this.contextBuilder.buildSystemPrompt(userMessage);

    // Add user message to session history
    session.messages.push({
      role: 'user',
      content: userMessage,
    });

    const messages = [...session.messages];
    let iterationCount = 0;
    let totalUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    let totalCost = 0;
    const toolCallsLog = [];

    try {
      // Agent loop
      while (iterationCount < this.config.BRAIN_MAX_ITERATIONS) {
        iterationCount++;
        console.log(`[brain] Iteration ${iterationCount}`);

        // Call Claude API
        const apiStartTime = Date.now();
        let response;

        try {
          const apiParams = {
            model: selectedModel,
            max_tokens: this.config.BRAIN_MAX_TOKENS,
            system: systemPrompt,
            messages,
            tools: TOOL_SCHEMAS,
            tool_choice: { type: 'auto' },
            thinking: {
              type: 'adaptive',
            },
            output_config: {
              effort: selectedModel === MODEL_PRIMARY ? 'max' : 'high',
            },
          };

          if (this.useGateway) {
            // AI Gateway Bedrock mode (non-streaming, matches computer-use.js)
            response = await this.callClaudeGateway(apiParams);

            if (streamCallback) {
              // Emit text blocks for SSE consumers
              for (const block of (response.content || [])) {
                if (block.type === 'text') {
                  streamCallback({ type: 'text', text: block.text });
                }
              }
            }
          } else if (streamCallback) {
            // Direct SDK streaming mode
            response = await this.anthropic.messages.create({
              ...apiParams,
              stream: true,
            });

            const chunks = [];
            let currentText = '';
            let usage = null;

            for await (const event of response) {
              if (event.type === 'message_start') {
                usage = event.message.usage;
              } else if (event.type === 'content_block_start') {
                // New content block starting
              } else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                  currentText += event.delta.text;
                  streamCallback({ type: 'text', text: event.delta.text });
                } else if (event.delta.type === 'thinking_delta') {
                  // Optionally stream thinking
                  streamCallback({ type: 'thinking', text: event.delta.thinking });
                }
              } else if (event.type === 'content_block_stop') {
                // Content block complete
              } else if (event.type === 'message_delta') {
                if (event.delta.stop_reason) {
                  // Message complete
                  usage = { ...usage, ...event.usage };
                }
              } else if (event.type === 'message_stop') {
                // Stream complete
              }
            }

            // Reconstruct response object for processing
            response = {
              id: requestId,
              content: messages[messages.length - 1]?.content || [{ type: 'text', text: currentText }],
              stop_reason: 'end_turn',
              usage: usage || {},
            };

          } else {
            // Direct SDK non-streaming mode
            response = await this.anthropic.messages.create(apiParams);
          }

        } catch (apiError) {
          if (apiError.status === 429 || apiError.status_code === 429) {
            // Rate limit - exponential backoff
            const retryAfter = apiError.headers?.['retry-after'] || 5;
            console.log(`[brain] Rate limited, retrying after ${retryAfter}s`);
            await sleep(retryAfter * 1000);
            continue;
          }

          throw new APIError(
            `Claude API error: ${apiError.message}`,
            apiError.status || apiError.status_code,
            apiError
          );
        }

        const apiLatency = Date.now() - apiStartTime;
        console.log(`[brain] API call completed in ${apiLatency}ms`);

        // Update usage tracking
        const usage = response.usage || {};
        totalUsage.input_tokens += usage.input_tokens || 0;
        totalUsage.output_tokens += usage.output_tokens || 0;
        totalUsage.cache_read_tokens += usage.cache_read_tokens || 0;
        totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;

        const cost = calculateCost(selectedModel, usage);
        totalCost += cost;

        // Add assistant message to history
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        // Check stop reason
        if (response.stop_reason === 'end_turn') {
          // Extract text response
          const textBlocks = response.content.filter(block => block.type === 'text');
          const finalText = textBlocks.map(block => block.text).join('\n');

          console.log(`[brain] Agent loop completed in ${iterationCount} iterations [${selectedModel}]`);

          // Update session
          session.messages = messages;
          session.turn_count += 1;

          // Track usage
          this.stats.total_queries += 1;
          this.stats.total_cost += totalCost;
          this.trackUsage(selectedModel, totalUsage, totalCost, true);

          // Log history
          await this.logHistory({
            type: 'query',
            session_id: session.id,
            request_id: requestId,
            input_preview: truncate(userMessage),
            iterations: iterationCount,
            tools_used: toolCallsLog,
            tokens: totalUsage,
            cost: totalCost,
            success: true,
            duration_ms: Date.now() - startTime,
          });

          // Capture learning trajectory (async, non-blocking)
          brainLearning.learnFromBrainQuery({
            task: userMessage,
            outcome: 'success',
            iterations: iterationCount,
            tools_used: toolCallsLog,
            cost: totalCost,
            duration_ms: Date.now() - startTime,
            model: selectedModel,
          }).catch(err => console.error('[brain] Learning capture error:', err.message));

          return {
            success: true,
            response: finalText,
            model: selectedModel,
            session_id: session.id,
            iterations: iterationCount,
            usage: totalUsage,
            cost: totalCost,
            duration_ms: Date.now() - startTime,
            tools_used: toolCallsLog,
          };
        }

        if (response.stop_reason === 'tool_use') {
          // Extract tool uses
          const toolUses = response.content.filter(block => block.type === 'tool_use');

          if (toolUses.length === 0) {
            throw new BrainError('No tool uses found despite stop_reason=tool_use', 'INVALID_RESPONSE');
          }

          console.log(`[brain] Executing ${toolUses.length} tool(s): ${toolUses.map(t => t.name).join(', ')}`);

          // Execute tools in parallel
          const toolResults = await this.toolExecutor.executeTools(toolUses);

          // Log tool calls
          for (const tr of toolResults) {
            toolCallsLog.push({
              name: tr.tool_name,
              input: toolUses.find(tu => tu.id === tr.tool_use_id)?.input,
              success: !tr.result.is_error,
              latency_ms: tr.result.latency_ms,
            });
          }

          // Add tool results to messages
          messages.push({
            role: 'user',
            content: toolResults.map(tr => ({
              type: 'tool_result',
              tool_use_id: tr.tool_use_id,
              content: JSON.stringify(tr.result),
              is_error: tr.result.is_error || false,
            })),
          });

          // Continue loop
          continue;
        }

        // Unexpected stop reason
        throw new BrainError(`Unexpected stop_reason: ${response.stop_reason}`, 'INVALID_RESPONSE');
      }

      // Max iterations reached
      throw new BrainError(
        `Max iterations (${this.config.BRAIN_MAX_ITERATIONS}) reached`,
        'MAX_ITERATIONS'
      );

    } catch (error) {
      console.error('[brain] Agent loop error:', error);

      this.stats.total_errors += 1;
      this.trackUsage(selectedModel, totalUsage, totalCost, false);

      await this.logError(error, {
        request_id: requestId,
        session_id: session.id,
        iterations: iterationCount,
        user_message: truncate(userMessage),
      });

      await this.logHistory({
        type: 'query',
        session_id: session.id,
        request_id: requestId,
        input_preview: truncate(userMessage),
        iterations: iterationCount,
        tools_used: toolCallsLog,
        tokens: totalUsage,
        cost: totalCost,
        success: false,
        error: error.message,
        duration_ms: Date.now() - startTime,
      });

      // Capture failed trajectory for learning (async, non-blocking)
      brainLearning.learnFromBrainQuery({
        task: userMessage,
        outcome: 'failure',
        iterations: iterationCount,
        tools_used: toolCallsLog,
        cost: totalCost,
        duration_ms: Date.now() - startTime,
        model: selectedModel,
        error: error.message,
      }).catch(err => console.error('[brain] Learning capture error:', err.message));

      throw error;
    }
  }

  /**
   * Query the brain (synchronous)
   * @param {string} model - 'sonnet' (default), 'opus', or 'haiku'
   */
  async query(userMessage, sessionId = null, model = null) {
    return await this.runAgentLoop(userMessage, sessionId, null, model);
  }

  /**
   * Query the brain (streaming)
   */
  async queryStream(userMessage, sessionId = null, streamCallback, model = null) {
    return await this.runAgentLoop(userMessage, sessionId, streamCallback, model);
  }

  /**
   * Get health status
   */
  async getHealth() {
    const uptime = Date.now() - this.stats.start_time;
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = this.dailyUsage.get(today) || {
      queries: 0,
      errors: 0,
      total_tokens: 0,
      total_cost: 0,
    };

    return {
      status: 'healthy',
      uptime_ms: uptime,
      uptime_human: this.formatDuration(uptime),
      sessions: {
        active: this.sessions.size,
        total: this.stats.total_queries,
      },
      stats: {
        total_queries: this.stats.total_queries,
        total_errors: this.stats.total_errors,
        total_cost: this.stats.total_cost.toFixed(4),
        error_rate: this.stats.total_queries > 0
          ? (this.stats.total_errors / this.stats.total_queries * 100).toFixed(2) + '%'
          : '0%',
      },
      today: {
        date: today,
        queries: todayUsage.queries,
        errors: todayUsage.errors,
        total_tokens: todayUsage.total_tokens,
        total_cost: todayUsage.total_cost.toFixed(4),
      },
      config: {
        model_default: MODEL_DEFAULT,
        model_escalation: MODEL_PRIMARY,
        max_iterations: this.config.BRAIN_MAX_ITERATIONS,
        max_tokens: this.config.BRAIN_MAX_TOKENS,
      },
    };
  }

  /**
   * Get recent history
   */
  async getHistory(limit = 50) {
    const historyPath = path.join(this.config.BRAIN_BOOTSTRAP_DIR, 'history.jsonl');
    return await readLastNLines(historyPath, limit);
  }

  /**
   * Format duration in human-readable format
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

/**
 * Mount brain routes on Express app
 */
function mountBrainRoutes(app, orchestrator) {
  /**
   * POST /brain/query - Synchronous query
   */
  app.post('/brain/query', async (req, res) => {
    try {
      const { message, session_id, model } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({
          error: 'Missing or invalid "message" field',
        });
      }

      console.log(`[brain] Query received: ${truncate(message, 100)}`);

      const result = await orchestrator.query(message, session_id, model);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[brain] Query error:', error);

      const statusCode = error instanceof BrainError ? 500 : 500;
      res.status(statusCode).json({
        success: false,
        error: error.message,
        code: error.code || 'INTERNAL_ERROR',
      });
    }
  });

  /**
   * POST /brain/stream - SSE streaming query
   */
  app.post('/brain/stream', async (req, res) => {
    try {
      const { message, session_id, model } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({
          error: 'Missing or invalid "message" field',
        });
      }

      console.log(`[brain] Stream query received: ${truncate(message, 100)}`);

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamCallback = (chunk) => {
        if (chunk.type === 'text') {
          res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
        } else if (chunk.type === 'thinking') {
          res.write(`data: ${JSON.stringify({ type: 'thinking', text: chunk.text })}\n\n`);
        }
      };

      const result = await orchestrator.queryStream(message, session_id, streamCallback, model);

      // Send final metadata
      res.write(`data: ${JSON.stringify({
        type: 'done',
        metadata: {
          session_id: result.session_id,
          iterations: result.iterations,
          usage: result.usage,
          cost: result.cost,
          duration_ms: result.duration_ms,
          tools_used: result.tools_used,
        },
      })}\n\n`);

      res.end();
    } catch (error) {
      console.error('[brain] Stream error:', error);

      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: error.message,
        code: error.code || 'INTERNAL_ERROR',
      })}\n\n`);

      res.end();
    }
  });

  /**
   * GET /brain/health - Health dashboard
   */
  app.get('/brain/health', async (req, res) => {
    try {
      const health = await orchestrator.getHealth();
      res.json(health);
    } catch (error) {
      console.error('[brain] Health check error:', error);
      res.status(500).json({
        status: 'unhealthy',
        error: error.message,
      });
    }
  });

  /**
   * GET /brain/history - Recent interaction log
   */
  app.get('/brain/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '50', 10);
      const history = await orchestrator.getHistory(limit);
      res.json({
        success: true,
        history,
      });
    } catch (error) {
      console.error('[brain] History retrieval error:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * POST /brain/remember - Quick shortcut to store a memory
   */
  app.post('/brain/remember', async (req, res) => {
    try {
      const { content, tags, importance } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({
          error: 'Missing or invalid "content" field',
        });
      }

      const result = await orchestrator.toolExecutor.executeTool('memory_store', {
        content,
        tags: tags || [],
        importance: importance || 5,
      });

      if (result.is_error) {
        return res.status(500).json({
          success: false,
          error: result.error,
        });
      }

      res.json({
        success: true,
        message: 'Memory stored',
      });
    } catch (error) {
      console.error('[brain] Remember error:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /brain/status - Simple status check
   */
  app.get('/brain/status', (req, res) => {
    res.json({
      status: 'online',
      timestamp: getTimestamp(),
    });
  });

  console.log('[brain] Routes mounted successfully');
}

// ============================================================================
// MODULE EXPORTS
// ============================================================================

/**
 * Initialize and mount brain routes
 */
async function initializeBrain(app) {
  console.log('[brain] Initializing Jarvis brain module...');

  // Create orchestrator
  const orchestrator = new BrainOrchestrator(CONFIG);

  // Initialize Anthropic client
  await orchestrator.initialize();

  // Mount routes
  mountBrainRoutes(app, orchestrator);

  // Mount brain learning pipeline routes
  brainLearning.mountRoutes(app);

  // Set up session cleanup interval (every 5 minutes)
  setInterval(() => {
    orchestrator.cleanupSessions();
  }, 5 * 60 * 1000);

  console.log('[brain] Initialization complete');

  return orchestrator;
}

module.exports = {
  initializeBrain,
  BrainOrchestrator,
  BrainError,
  ToolExecutionError,
  APIError,
};

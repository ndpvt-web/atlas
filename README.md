# ATLAS -- Autonomous Task Learning and Skill Synthesis

**The first desktop computer-use agent with a runtime self-evolving skill pipeline.**

ATLAS autonomously promotes experience into reusable strategies and executable tools -- without model retraining.

## What Makes ATLAS Different

Existing computer-use agents (Anthropic CUA, OpenAI Operator, Google Mariner) start from scratch every session. They have no memory of what worked before.

ATLAS is different. It learns from every task it completes, detects patterns across tasks, graduates successful patterns into reusable strategies, and can even create new tools from successful workflows -- all at runtime, stored as inspectable JSON, with zero model fine-tuning.

### The Learning Pipeline (3-Layer Phronesis)

```
Layer 1: REFLECTIONS
  Every task produces a post-mortem: tools used, iterations, cost, outcome.
  Stored in reflections.json.

Layer 2: PATTERNS
  Recurring tool-call sequences across tasks are detected automatically.
  "safari-navigate + type-url + return" appears 5 times -> pattern detected.

Layer 3: STRATEGIES
  Patterns that prove reliable (3+ occurrences, 60%+ success rate) are
  promoted to strategies. Future tasks retrieve relevant strategies
  before starting, reducing iterations and cost.
```

### Tool Forge

When a workflow succeeds repeatedly, ATLAS can generate a new executable tool (Express.js endpoint) from it. The agent literally writes its own API -- validated by AST analysis, mounted at runtime, available for future tasks.

### Vision Grounding (Hybrid AX + ShowUI)

ATLAS doesn't just read text -- it sees the screen. A hybrid grounding system combines:

- **AX Grounding** (~300ms): macOS Accessibility API via a custom Swift binary (`capy-ax`). Extracts clickable elements with exact screen coordinates.
- **ShowUI-2B Fallback** (~500ms): MLX-quantized vision model for elements that AX can't see (images, custom UI, web content).

Post-click coordinate correction snaps to the nearest AX element within 60px radius.

## Architecture

```
server.js                    -- Express server, route mounting
modules/
  computer-use.js            -- ATLAS agent core (~2800 lines)
                                Screenshot loop, action execution,
                                escalation (Sonnet -> Opus),
                                AppleScript fallback, trajectory capture
  learning.js                -- 3-layer Phronesis learning system
                                Reflections, patterns, strategies,
                                trajectory recording, graduation logic
  trajectory.js              -- Trajectory capture and replay
  ax-grounding.js            -- Hybrid AX + ShowUI grounding
  input-bridge.js            -- Keyboard routing through TCC-authorized daemon
  brain.js                   -- Orchestrator (tool selection, multi-step planning)
  brain-learning.js          -- Brain-level learning (separate from ATLAS learning)
  brain-tool-forge.js        -- LLM-generated tool creation
  brain-macos-bridge.js      -- macOS app control (Mail, Calendar, Reminders, etc.)
  brain-agents.js            -- Agent delegation (researcher, coder, reviewer, etc.)
  brain-scheduler.js         -- Task scheduling (cron, date, interval)
  brain-proactive-memory.js  -- Predictive memory retrieval
  brain-memory.js            -- SQLite + FTS5 long-term memory
  brain-heartbeat.js         -- System health monitoring
showui-worker.py             -- ShowUI-2B vision model (persistent process)
capy-ax-helper.sh            -- AX accessibility helper (routes through Terminal.app)
capy-screenshot.sh           -- Screenshot daemon (TCC-aware)
brain/IDENTITY.md            -- Agent identity and reasoning framework
```

## Key Results

| Metric | Before Learning | After Learning |
|--------|----------------|----------------|
| "Open google.com" task | 8 iterations, $1.17, 49s | 2 iterations, $0.08, 17s |
| Morning briefing | 7 tools, $0.18 | 5 tools, $0.11 |
| Screen analysis | First-time setup | 2 iterations, $0.07 |

## Comparison with Existing Work

| System | Runtime Learning | Pattern Detection | Strategy Graduation | Tool Creation | Desktop OS |
|--------|-----------------|-------------------|--------------------:|---------------|------------|
| **ATLAS** | JSON (no retrain) | Cross-task | Threshold-gated | LLM-generated endpoints | macOS |
| UFO2 (Microsoft) | Example mining | No | No | No | Windows |
| SEAgent | RL weights | No | No | No | Benchmark |
| OpenSpace (HKUDS) | SKILL.md files | Yes | Yes | Yes | No (coding agents) |
| Voyager (NVIDIA) | Code skills | No | No | Code generation | No (Minecraft) |
| Anthropic CUA | None | No | No | No | Yes |
| OpenAI Operator | None | No | No | No | Yes |

**ATLAS is the first system to combine runtime symbolic learning with tool generation on a real desktop OS.**

OpenSpace pioneered self-evolving skills for coding agents. ATLAS brings that paradigm to computer use -- where the agent must see, click, and navigate a real GUI.

## Requirements

- macOS (tested on macOS 26.x)
- Node.js 18+
- Python 3.10+ with MLX (for ShowUI-2B)
- Accessibility permissions for Terminal.app
- Claude API access (Sonnet 4.6 default, Opus 4.6 escalation)

## Development Timeline

- **March 2026**: Initial development and deployment
- **March 8-10**: Phase 1-2 computer use agent (screenshot loop, action execution)
- **March 10**: ShowUI-2B vision grounding integration
- **March 11**: AX hybrid grounding, learning pipeline, brain-ATLAS bridge
- **March 14-16**: Trajectory system, macro recording, cross-app workflows
- **March 17-18**: Input bridge (TCC keyboard fix), efficiency optimizations
- **March 25**: Public repository created

## License

Proprietary. All rights reserved.

## Author

Nivesh Dommaraju ([@ndpvt-web](https://github.com/ndpvt-web))

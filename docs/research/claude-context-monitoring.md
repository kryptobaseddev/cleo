# Claude Code Context Window Monitoring Research

**Date**: 2026-01-01
**Purpose**: Programmatic monitoring options for integration with Nexus Hub orchestration

---

## Executive Summary

Claude Code exposes context window metrics through multiple channels. The **status line hook** is the primary real-time programmatic interface, providing JSON data every ~300ms. No direct REST/socket API exists - monitoring requires hook-based integration or log parsing.

---

## Primary Programmatic Interfaces

### 1. Status Line Hook (Most Reliable Real-Time)

Configure in `.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}
```

**JSON data structure passed via stdin** (updates every ~300ms):
```json
{
  "context_window": {
    "total_input_tokens": 15234,
    "total_output_tokens": 4521,
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  }
}
```

**Example monitoring script:**
```bash
#!/bin/bash
input=$(cat)

CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size')
USAGE=$(echo "$input" | jq '.context_window.current_usage')

if [ "$USAGE" != "null" ]; then
    CURRENT=$(echo "$USAGE" | jq '.input_tokens + .cache_creation_input_tokens')
    PERCENT=$((CURRENT * 100 / CONTEXT_SIZE))

    # Export to external system (orchestrator webhook, file, socket)
    echo "{\"percent\": $PERCENT, \"tokens\": $CURRENT, \"max\": $CONTEXT_SIZE}" >> /tmp/claude-context.jsonl

    echo "⚡ ${PERCENT}%"
fi
```

### 2. OpenTelemetry Export (Enterprise Aggregation)

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

**Exposed metrics:**

| Metric | Description |
|--------|-------------|
| `claude_code.token.usage` | Token consumption per request |
| `claude_code.cost.usage` | Cost in USD |
| `claude_code.session.count` | Session tracking |

**Token counter attributes:**
```json
{"type": "input|output|cacheRead|cacheCreation", "model": "...", "value": <count>}
```

### 3. Local JSONL Logs (Historical Analysis)

Location: `~/.claude/projects/<project-hash>/` contains session transcripts.

Tools like **ccusage** parse these:
```bash
npx ccusage@latest blocks --live   # Real-time dashboard
cmonitor                            # pip install claude-monitor
```

---

## API Access Summary

**Critical insight**: Claude Code CLI does **not** expose a REST/socket API for external queries.

| Method | Access Type | Real-Time? | Latency |
|--------|-------------|------------|---------|
| Status line hook | stdin JSON | ✅ Yes | ~300ms |
| OpenTelemetry | Metrics export | ⚠️ Periodic | 60s default |
| JSONL logs | File parsing | ❌ Post-session | N/A |
| Agent SDK | `message.usage` | ✅ Per-message | Immediate |

---

## Hooks for Context Events

### PreCompact Hook

Fires when auto-compact triggers at **95% context usage**:

```json
{
  "hooks": {
    "PreCompact": [{
      "type": "command",
      "command": "/path/to/alert-context-pressure.sh"
    }]
  }
}
```

Use cases:
- Trigger orchestrator alerts
- Log context pressure events
- Auto-save session state before compaction

### Available Hook Events

| Event | Purpose | Context Access |
|-------|---------|----------------|
| `PreCompact` | Before context compaction | Yes - 95% threshold trigger |
| `SessionStart` | Session initialization | Can inject context setup |
| `SessionEnd` | Session cleanup | Can log final context state |
| `Stop`/`SubagentStop` | Agent completion | Can evaluate cleanup needs |

---

## Architecture for Orchestrator Integration

```
┌──────────────────┐     stdin JSON      ┌─────────────────┐
│   Claude Code    │ ──────────────────► │  statusline.sh  │
│    Session       │     (~300ms)        │  (your script)  │
└──────────────────┘                     └────────┬────────┘
                                                  │
                                    ┌─────────────┴─────────────┐
                                    ▼                           ▼
                           ┌───────────────┐           ┌────────────────┐
                           │  File/Socket  │           │  HTTP Webhook  │
                           │  /tmp/ctx.json│           │  orchestrator  │
                           └───────────────┘           └────────────────┘
```

### Example: Export to Orchestrator via HTTP

```bash
#!/bin/bash
input=$(cat)

# Parse context data
PERCENT=$(echo "$input" | jq -r '
  (.context_window.current_usage.input_tokens // 0) * 100 /
  (.context_window.context_window_size // 200000) | floor
')

# Send to orchestrator
curl -s -X POST http://localhost:8080/context \
  -H "Content-Type: application/json" \
  -d "{\"session\": \"$CLAUDE_SESSION_ID\", \"percent\": $PERCENT}" &

# Display in status line
echo "🔋 ${PERCENT}%"
```

### Example: Unix Socket IPC

```bash
#!/bin/bash
input=$(cat)
SOCKET="/tmp/nexus-hub-context.sock"

# Extract metrics
DATA=$(echo "$input" | jq -c '{
  timestamp: (now | todate),
  session_id: env.CLAUDE_SESSION_ID,
  context: .context_window
}')

# Send via socket if available
if [ -S "$SOCKET" ]; then
    echo "$DATA" | nc -U "$SOCKET" &
fi

# Status display
PERCENT=$(echo "$input" | jq -r '
  ((.context_window.current_usage.input_tokens // 0) * 100 /
   (.context_window.context_window_size // 200000)) | floor
')
echo "📊 ${PERCENT}%"
```

---

## Key Thresholds to Monitor

| Threshold | Event | Recommended Action |
|-----------|-------|-------------------|
| 50% | Midpoint | Log checkpoint |
| 70-80% | Warning zone | Alert orchestrator |
| 90% | Critical | Prepare for compaction |
| 95% | PreCompact fires | Auto-compact imminent |
| ~155K tokens | Effective limit | 40-45K reserved buffer |

---

## Existing Tools to Leverage

| Tool | Install | Purpose | Real-Time |
|------|---------|---------|-----------|
| **ccusage** | `npx ccusage@latest` | JSONL log analysis, billing windows | ✅ `blocks --live` |
| **cmonitor** | `pip install claude-monitor` | Terminal dashboard | ✅ |
| **ccstatusline** | GitHub | Pre-built status line | ✅ |
| **cc-statusline** | GitHub | Enhanced with progress bars | ✅ |

### ccusage Commands

```bash
npx ccusage@latest report daily     # Daily report
npx ccusage@latest blocks --live    # Real-time 5-hour window monitoring
npx ccusage@latest session          # Per-session breakdown
```

---

## Agent SDK Access (Programmatic Agents)

For custom agent implementations:

```typescript
import { query, ClaudeAgentOptions } from 'claude-agent-sdk';

const result = await query({
  prompt: "...",
  options: {
    onMessage: (msg) => {
      if (msg.usage) {
        // Send to orchestrator
        orchestrator.emit('context', {
          input: msg.usage.input_tokens,
          output: msg.usage.output_tokens,
          cache: msg.usage.cache_read_input_tokens,
          total_cost: msg.usage.total_cost_usd
        });
      }
    }
  }
});

// Final cumulative usage
console.log(`Total: ${result.usage.input_tokens + result.usage.output_tokens}`);
```

---

## Nexus Hub Integration Options

### Option A: Status Line + IPC Socket

**Pros**: Real-time (~300ms), minimal overhead, works with any session
**Cons**: Requires custom statusline script per machine/environment

```
Claude Code → statusline.sh → Unix Socket → Nexus Hub Listener
```

### Option B: Status Line + File Watch

**Pros**: Simple, debuggable, works across processes
**Cons**: File I/O overhead, potential race conditions

```
Claude Code → statusline.sh → /tmp/context.jsonl → inotify → Nexus Hub
```

### Option C: OpenTelemetry Collector

**Pros**: Standard protocol, aggregation, dashboards
**Cons**: 60s default interval (not real-time), infrastructure overhead

```
Claude Code → OTel Exporter → Collector → Prometheus/Grafana → Nexus Hub API
```

### Option D: Hybrid (Recommended)

- **Real-time alerts**: Status line + socket for <1s latency
- **Metrics/analytics**: OpenTelemetry for aggregated data
- **Recovery**: JSONL logs for session reconstruction

---

## Decision Matrix

| Requirement | Status Line | OTel | JSONL Logs | Agent SDK |
|-------------|-------------|------|------------|-----------|
| Real-time (<1s) | ✅ | ❌ | ❌ | ✅ |
| No code changes | ✅ | ✅ | ✅ | ❌ |
| Cross-session | ❌ | ✅ | ✅ | ❌ |
| Historical data | ❌ | ✅ | ✅ | ❌ |
| Custom agents | ❌ | ❌ | ❌ | ✅ |

---

## References

- [Monitoring - Claude Code Docs](https://code.claude.com/docs/en/monitoring-usage)
- [Hooks Reference - Claude Code Docs](https://code.claude.com/docs/en/hooks)
- [Status Line Config - Claude Code Docs](https://code.claude.com/docs/en/statusline)
- [Context Windows - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [GitHub: ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)
- [GitHub: Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
- [GitHub: sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline)

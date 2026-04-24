# @cleocode/mcp-adapter

External-only MCP (Model Context Protocol) adapter that exposes CLEO sentient operations as MCP tools for consumption by external LLM clients and tools.

> **Important**: This adapter is EXTERNAL-ONLY. It communicates with CLEO exclusively via CLI subprocess calls and does NOT import or wire into internal CLEO packages. MCP was removed from internal CLEO dispatch on 2026-04-04 by project decision — see project memory for context.

## What it exposes

Three MCP tools:

| Tool | CLI equivalent | Description |
|------|----------------|-------------|
| `cleo_sentient_status` | `cleo sentient status` | Query sentient subsystem state, kill-switch, Tier-2 flag |
| `cleo_sentient_propose_list` | `cleo sentient propose list` | List Tier-2 autonomous proposals |
| `cleo_sentient_propose_enable` | `cleo sentient propose enable` | Enable Tier-2 (subject to M7 gate) |

## How external tools consume it

### 1. Via MCP stdio transport (recommended)

Add to your MCP client configuration (e.g. Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "cleo-sentient": {
      "command": "npx",
      "args": ["-y", "@cleocode/mcp-adapter"],
      "env": {}
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "cleo-sentient": {
      "command": "cleo-mcp-server",
      "args": []
    }
  }
}
```

The server reads JSON-RPC 2.0 requests from stdin and writes responses to stdout.

### 2. Via programmatic API

```typescript
import { handleToolCall } from '@cleocode/mcp-adapter';

// Query status
const result = await handleToolCall(
  'cleo_sentient_status',
  { projectRoot: '/path/to/my/project' }
);
console.log(result.content[0].text);

// Enable proposals (requires M7 gate to pass on CLEO side)
const enableResult = await handleToolCall(
  'cleo_sentient_propose_enable',
  { projectRoot: '/path/to/my/project' }
);
if (enableResult.isError) {
  console.error('M7 gate blocked:', enableResult.content[0].text);
}
```

## M7 Gate

`cleo_sentient_propose_enable` is subject to the M7 gate on the CLEO side:
`cleo memory doctor --assert-clean` must pass (brain corpus must be clean)
before Tier-2 proposals can be activated. The adapter surfaces the
`E_M7_GATE_FAILED` error as `isError: true` in the MCP result so clients
receive a clear actionable signal.

To resolve: run `cleo memory sweep --approve <runId>` on the CLEO project
to stamp entries clean, then retry the enable call.

## Architecture

```
External MCP client (Claude Code / LLM tool)
        │
        │ JSON-RPC 2.0 over stdio
        ▼
@cleocode/mcp-adapter (this package)
        │
        │ execFile('cleo', [...args])
        ▼
CLEO CLI (`cleo` binary on $PATH)
        │
        │ internal dispatch + sentient domain
        ▼
sentient-state.json + tasks.db
```

No internal CLEO packages are imported. All interaction is via subprocess.

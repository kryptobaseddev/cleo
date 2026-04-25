# @cleocode/mcp-adapter

External-only MCP (Model Context Protocol) adapter that exposes CLEO sentient operations as MCP tools for consumption by external LLM clients and tools.

> **Canon (DO NOT violate)**: CLEO is CLI-only internally. This adapter is EXTERNAL-ONLY — an export bridge that lets other tools (Claude Desktop, external MCP clients) consume a narrow slice of CLEO via MCP. It communicates with CLEO exclusively via `cleo` CLI subprocess calls. It does NOT import internal CLEO packages and is NOT part of CLEO's dispatch surface.
>
> **Do NOT** add MCP to internal CLEO dispatch. Do NOT import from `@cleocode/core` or any internal dispatch layer here. Do NOT add new tools by reaching into internal APIs — new tools MUST be exposed as `cleo` CLI verbs first, then mapped here as subprocess calls. MCP was removed from internal CLEO on 2026-04-04; this adapter exists as a deliberate external-consumption exception, not as a reintroduction.

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

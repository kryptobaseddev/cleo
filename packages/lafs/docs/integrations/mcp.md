# MCP Integration

Use `wrapMCPResult` to normalize MCP `CallToolResult` into canonical LAFS envelopes.

## Producer pattern

```typescript
import { wrapMCPResult } from "@cleocode/lafs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function toLafs(mcpResult: CallToolResult, toolName: string) {
  return wrapMCPResult(mcpResult, `tools/${toolName}`);
}
```

## Validation and gating

```typescript
import { enforceCompliance } from "@cleocode/lafs";

const envelope = toLafs(result, "weather");
const gate = enforceCompliance(envelope, { checkConformance: true });
if (!gate.ok) {
  throw new Error(JSON.stringify(gate.issues));
}
```

## Consumer parsing

```typescript
import { parseLafsResponse } from "@cleocode/lafs";

const payload = parseLafsResponse(envelope);
```

## Notes

- Use `_extensions` for MCP-specific metadata.
- Keep core behavior in envelope fields (`success`, `result`, `error`).
- Prefer JSON-default output in automated agent flows.

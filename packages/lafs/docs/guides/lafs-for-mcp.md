# LAFS for MCP Tool Servers

For MCP servers, normalize `CallToolResult` into LAFS envelopes.

## Wrapper pattern

```typescript
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { enforceCompliance, wrapMCPResult } from "@cleocode/lafs";

export function wrapToolResult(result: CallToolResult, toolName: string) {
  const envelope = wrapMCPResult(result, `tools/${toolName}`);

  const gate = enforceCompliance(envelope, { checkConformance: true });
  if (!gate.ok) {
    throw new Error(JSON.stringify(gate.issues));
  }

  return envelope;
}
```

## Parse downstream

```typescript
import { parseLafsResponse } from "@cleocode/lafs";

const payload = parseLafsResponse(envelope);
```

## Notes

- `wrapMCPResult` converts MCP content/error signals into the LAFS success/error model.
- Keep transport details in `_extensions`; keep core semantics in envelope fields.

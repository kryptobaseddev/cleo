# Quick Start Guide

Set up LAFS and produce a conformant envelope quickly.

## Prerequisites

- Node.js 18+
- A service/tool boundary where you return structured responses

## Install

```bash
npm install @cleocode/lafs
```

## Your first envelope

```typescript
import { createEnvelope, validateEnvelope } from "@cleocode/lafs";

const envelope = createEnvelope({
  success: true,
  result: {
    message: "Hello from LAFS",
    timestamp: new Date().toISOString(),
  },
  meta: {
    operation: "hello.world",
    requestId: "req_001",
    transport: "http",
  },
});

const validation = validateEnvelope(envelope);
console.log("valid", validation.valid, validation.errors);
```

## Add semantic conformance checks

```typescript
import { runEnvelopeConformance } from "@cleocode/lafs";

const report = runEnvelopeConformance(envelope);
if (!report.ok) {
  for (const check of report.checks) {
    if (!check.pass) {
      console.error(`${check.name}: ${check.detail ?? "failed"}`);
    }
  }
}
```

## Parse responses with one function

```typescript
import { LafsError, parseLafsResponse } from "@cleocode/lafs";

try {
  const result = parseLafsResponse<{ message: string }>(envelope);
  console.log(result.message);
} catch (error) {
  if (error instanceof LafsError) {
    console.error(error.code, error.message, error.retryable);
  }
}
```

## Use with MCP

If your server returns MCP `CallToolResult`, use the adapter to wrap output consistently:

```typescript
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPResult } from "@cleocode/lafs";

function toLafs(result: CallToolResult, toolName: string) {
  return wrapMCPResult(result, `tools/${toolName}`);
}
```

## Before and after

Without LAFS, each integration has custom parsing. With LAFS, all boundaries converge to one parse path (`parseLafsResponse`).

## Next steps

- [Understanding Envelopes](envelope-basics.md)
- [Error Handling](error-handling.md)
- [LLM Agent Guide](../guides/llm-agent-guide.md)
- [Compliance Pipeline Guide](../guides/compliance-pipeline.md)

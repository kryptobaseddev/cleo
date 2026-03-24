# LAFS for CLI Tools

Use LAFS envelopes to make CLI output deterministic for scripts and agents.

## Producer pattern

```typescript
import { createEnvelope, enforceCompliance } from "@cleocode/lafs";

export function buildCliEnvelope(requestId: string) {
  const envelope = createEnvelope({
    success: true,
    result: { items: ["a", "b"] },
    meta: {
      operation: "cli.items.list",
      requestId,
      transport: "cli",
      strict: true,
      mvi: "standard",
      contextVersion: 0,
    },
  });

  const gate = enforceCompliance(envelope, {
    checkConformance: true,
    requireJsonOutput: true,
    flags: { jsonFlag: true },
  });

  if (!gate.ok) {
    throw new Error(JSON.stringify(gate.issues));
  }

  return envelope;
}
```

## Consumer pattern

```typescript
import { LafsError, parseLafsResponse } from "@cleocode/lafs";

try {
  const result = parseLafsResponse<{ items: string[] }>(envelopeJson);
  console.log(result.items.length);
} catch (error) {
  if (error instanceof LafsError) {
    console.error(error.code, error.message);
  }
}
```

## Diagnostic checks

```bash
lafs-conformance --envelope ./envelope.json
lafs-conformance --flags ./flags.json
```

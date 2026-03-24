# REST Integration

Wrap HTTP responses in LAFS envelopes at your boundary layer.

## Producer example (Express)

```typescript
import express from "express";
import crypto from "node:crypto";
import { createEnvelope, enforceCompliance } from "@cleocode/lafs";

const app = express();

app.get("/users", (_req, res) => {
  const envelope = createEnvelope({
    success: true,
    result: { users: [] },
    meta: {
      operation: "users.list",
      requestId: crypto.randomUUID(),
      transport: "http",
    },
  });

  const gate = enforceCompliance(envelope, { checkConformance: true });
  if (!gate.ok) {
    res.status(500).json({ error: gate.issues });
    return;
  }

  res.json(envelope);
});
```

## Consumer example

```typescript
import { LafsError, parseLafsResponse } from "@cleocode/lafs";

const envelope = await fetch("/users").then((r) => r.json());

try {
  const result = parseLafsResponse<{ users: unknown[] }>(envelope);
  console.log(result.users.length);
} catch (error) {
  if (error instanceof LafsError) {
    console.error(error.code, error.message);
  }
}
```

## Recommended defaults

- `strict: true`
- `mvi: "standard"`
- JSON output policy in agent-facing endpoints

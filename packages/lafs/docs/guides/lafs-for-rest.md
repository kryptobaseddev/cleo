# LAFS for REST APIs

Adopt LAFS at HTTP boundaries so every endpoint returns one parseable shape.

## Express example

```typescript
import crypto from "node:crypto";
import express from "express";
import { createEnvelope, enforceCompliance } from "@cleocode/lafs";

const app = express();

app.get("/api/users", (_req, res) => {
  const envelope = createEnvelope({
    success: true,
    result: { users: [] },
    meta: {
      operation: "users.list",
      requestId: crypto.randomUUID(),
      transport: "http",
      strict: true,
      mvi: "standard",
      contextVersion: 0,
    },
  });

  const gate = enforceCompliance(envelope, { checkConformance: true });
  if (!gate.ok) {
    res.status(500).json({ issues: gate.issues });
    return;
  }

  res.json(envelope);
});
```

## Error response pattern

```typescript
import { createEnvelope } from "@cleocode/lafs";

const errorEnvelope = createEnvelope({
  success: false,
  error: {
    code: "E_NOT_FOUND_RESOURCE",
    message: "user not found",
    category: "NOT_FOUND",
    retryable: false,
  },
  meta: {
    operation: "users.get",
    requestId: "req_123",
    transport: "http",
  },
});
```

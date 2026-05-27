# LLM Agent Compliance Pipeline

Use this when you need guaranteed compliant outgoing envelopes.

## Pipeline stages

| Stage | Purpose | API |
|---|---|---|
| 1 | Build candidate envelope | your code |
| 2 | Schema validation | `validateEnvelope` |
| 3 | Conformance checks | `runEnvelopeConformance` |
| 4 | Format policy enforcement | `resolveOutputFormat` + `runFlagConformance` |
| 5 | Retry/regenerate if invalid | your code |

## End-to-end middleware example

```typescript
import {
  ComplianceError,
  enforceCompliance,
  withCompliance,
  type LAFSEnvelope,
} from "@cleocode/lafs";

type EnvelopeFactory = () => Promise<LAFSEnvelope>;

export async function produceCompliantEnvelope(
  generate: EnvelopeFactory,
  maxAttempts = 2,
): Promise<LAFSEnvelope> {
  const options = {
    checkConformance: true,
    checkFlags: true,
    requireJsonOutput: true,
    flags: {
      jsonFlag: true,
      projectDefault: "json" as const,
      userDefault: "json" as const,
    },
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const envelope = await generate();

    const result = enforceCompliance(envelope, options);
    if (result.ok && result.envelope) return result.envelope;

    if (attempt === maxAttempts) {
      throw new ComplianceError(result.issues);
    }
  }

  throw new Error("Unreachable");
}

export function withDefaultCompliance(generate: EnvelopeFactory) {
  return withCompliance(generate, {
    checkConformance: true,
    requireJsonOutput: true,
    flags: { jsonFlag: true },
  });
}
```

## Failure-handling guidance

- If stage 2 fails: repair envelope shape and required fields.
- If stage 3 fails: repair semantic invariants (error/result pairing, strict behavior, pagination mode).
- If stage 4 fails: reject request-level format flags before generation.
- Keep per-attempt diagnostics so your agent can self-correct prompts or post-processors.

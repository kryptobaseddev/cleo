# LAFS for LLM Agents

This guide is the practical path for agent builders who need deterministic envelope handling.

## Contract you can rely on

- Validate envelopes with `validateEnvelope` or `assertEnvelope`.
- Check `success` before reading `result`.
- On `success: false`, expect `result: null` and a populated `error` object.
- Use `_extensions` for vendor metadata; never require it for core logic.

## Minimum parser pattern

Use built-in parser:

```typescript
import { LafsError, parseLafsResponse } from "@cleocode/lafs";

try {
  const result = parseLafsResponse(envelope);
} catch (error) {
  if (error instanceof LafsError) {
    // protocol error envelope
  }
}
```

If you need custom behavior, use this explicit variant:

```typescript
import { assertEnvelope, isRegisteredErrorCode } from "@cleocode/lafs";
import type { LAFSEnvelope } from "@cleocode/lafs";

export function parseLafsOrThrow(input: unknown): LAFSEnvelope {
  const envelope = assertEnvelope(input);

  if (!envelope.success) {
    const err = envelope.error;
    if (!err || !isRegisteredErrorCode(err.code)) {
      throw new Error("Non-conformant LAFS error envelope");
    }
    throw new Error(`${err.code}: ${err.message}`);
  }

  return envelope;
}
```

## Outgoing compliance in agent pipelines

Use a two-stage gate before sending any message:

1. `validateEnvelope` (schema)
2. `runEnvelopeConformance` (semantic checks)

```typescript
import {
  runEnvelopeConformance,
  validateEnvelope,
  type LAFSEnvelope,
} from "@cleocode/lafs";

export function enforceOutgoingCompliance(envelope: LAFSEnvelope): LAFSEnvelope {
  const validation = validateEnvelope(envelope);
  if (!validation.valid) {
    throw new Error(`Schema failure: ${validation.errors.join("; ")}`);
  }

  const report = runEnvelopeConformance(envelope);
  if (!report.ok) {
    const failed = report.checks.filter((c) => !c.pass);
    throw new Error(`Conformance failure: ${JSON.stringify(failed)}`);
  }

  return envelope;
}
```

For retry/regeneration logic, see `compliance-pipeline.md`.

## Strict JSON output policy

LAFS default behavior is JSON when no format is specified. Enforce it with `resolveOutputFormat` and reject conflicts (`E_FORMAT_CONFLICT`).

```typescript
import { LAFSFlagError, resolveOutputFormat } from "@cleocode/lafs";

export function resolveAgentOutputFormat(flags: {
  jsonFlag?: boolean;
  humanFlag?: boolean;
}): "json" {
  try {
    const resolved = resolveOutputFormat({
      jsonFlag: flags.jsonFlag,
      humanFlag: flags.humanFlag,
      projectDefault: "json",
      userDefault: "json",
    });

    if (resolved.format !== "json") {
      throw new Error("Agent policy requires json output");
    }

    return "json";
  } catch (error) {
    if (error instanceof LAFSFlagError && error.code === "E_FORMAT_CONFLICT") {
      throw new Error("Use either --json or --human, never both");
    }
    throw error;
  }
}
```

## Extending validation for custom operations

LAFS currently ships a single envelope schema. Custom message types are best modeled as operation-specific `result` schemas layered on top of base LAFS validation. See `schema-extension.md`.

## References

- `src/validateEnvelope.ts`
- `src/conformance.ts`
- `src/flagSemantics.ts`
- `schemas/v1/envelope.schema.json`

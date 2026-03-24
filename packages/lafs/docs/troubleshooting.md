# Troubleshooting

## Envelope fails validation

```typescript
import { validateEnvelope } from "@cleocode/lafs";

const result = validateEnvelope(envelope);
if (!result.valid) {
  console.error(result.errors);
}
```

Typical causes:
- missing `_meta` required fields
- invalid `mvi` value (must be `minimal|standard|full|custom`)
- `success=false` without `error`

## Envelope passes schema but fails conformance

```typescript
import { runEnvelopeConformance } from "@cleocode/lafs";

const report = runEnvelopeConformance(envelope);
const failed = report.checks.filter((c) => !c.pass);
console.log(failed);
```

Typical causes:
- strict mode with explicit `null` optional fields
- pagination fields mismatched with `page.mode`
- unregistered error code

## Pipeline gating in agents

```typescript
import { enforceCompliance } from "@cleocode/lafs";

const gate = enforceCompliance(envelope, {
  checkConformance: true,
  requireJsonOutput: true,
  flags: { jsonFlag: true },
});

if (!gate.ok) {
  console.error(gate.issues);
}
```

## CLI diagnostics

```bash
lafs-conformance --envelope ./envelope.json
lafs-conformance --flags ./flags.json
```

## MCP adapter issues

If MCP output is inconsistent, wrap raw `CallToolResult`:

```typescript
import { wrapMCPResult } from "@cleocode/lafs";
```

This normalizes success/error envelopes and optional budget metadata.

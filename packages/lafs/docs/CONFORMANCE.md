# Conformance Guide

Conformance in LAFS has two layers:

1. Schema validation (`validateEnvelope`)
2. Semantic conformance (`runEnvelopeConformance`)

## Programmatic usage

```typescript
import {
  runEnvelopeConformance,
  runFlagConformance,
  validateEnvelope,
} from "@cleocode/lafs";

const validation = validateEnvelope(envelope);
if (!validation.valid) {
  console.error(validation.errors);
}

const envelopeReport = runEnvelopeConformance(envelope);
const flagReport = runFlagConformance({ jsonFlag: true });

// tier-scoped report (core | standard | complete)
const completeTier = runEnvelopeConformance(envelope, { tier: "complete" });

console.log(envelopeReport.ok, flagReport.ok);
```

## Machine-readable tier profiles

Tier profiles are published as JSON:

- `schemas/v1/conformance-profiles.json`
- import path: `@cleocode/lafs/schemas/v1/conformance-profiles.json`

SDK helpers:

- `getConformanceProfiles()`
- `getChecksForTier(tier)`
- `validateConformanceProfiles(availableChecks)`

## Current envelope checks

- `envelope_schema_valid`
- `envelope_invariants`
- `error_code_registered`
- `meta_mvi_present`
- `meta_strict_present`
- `strict_mode_behavior`
- `pagination_mode_consistent`
- `strict_mode_enforced`
- `transport_mapping_consistent`
- `context_mutation_failure`
- `context_preservation_valid`

## CLI usage

The diagnostic binary is `lafs-conformance`.

```bash
lafs-conformance --envelope ./fixtures/valid-success-envelope.json
lafs-conformance --flags ./fixtures/flags-valid.json
lafs-conformance --envelope ./fixtures/valid-success-envelope.json --flags ./fixtures/flags-valid.json
```

## CI pattern

```bash
for file in fixtures/valid-*.json; do
  lafs-conformance --envelope "$file"
done
```

## Related references

- `src/conformance.ts`
- `src/validateEnvelope.ts`
- `schemas/v1/envelope.schema.json`

# ADR-039: LAFS Envelope Unification (CLI Canonical Shape)

**Date**: 2026-04-08
**Status**: Accepted
**Accepted**: 2026-04-08
**Related Tasks**: T335 (epic), T338 (FIX-3)
**Related ADRs**: ADR-038, ADR-036
**Keywords**: envelope, lafs, cli, unification, migration, canonical, meta, data, success
**Topics**: envelope-shape, cli-output, dispatch, token-waste, agent-contracts
**Summary**: Unifies three legacy CLI envelope shapes (`{ok,r,_m}`, `{success,result}`, `{success,error}`) into a single canonical `CliEnvelope<T>` with `success`, `data`, `error`, and `meta` fields. Breaking change; migration table provided.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

The CLEO CLI had accumulated three distinct envelope shapes that every agent and consumer had to branch on before parsing:

| Legacy shape | Origin | Fields |
|---|---|---|
| Minimal MVI | Old CLI output | `{ok: bool, r: unknown, _m: {...}}` |
| Observe command | `cleo observe` | `{success: bool, result: unknown}` |
| Error responses | Error path | `{success: bool, error: {...}}` (no meta) |

A token-waste audit (T335) found that agents were spending 15–30 tokens per response on shape detection logic. The three shapes also made shared middleware (budget enforcement, field filtering) awkward because each piece of middleware had to detect which shape it was looking at before processing.

The Wave 4 work (commit `8d1a5f3e`) introduced the canonical `CliEnvelope<T>` type but ran out of context after 32 file edits, leaving 4 TypeScript build errors and 3 test files with stale assertions.

---

## Decision

The canonical CLI envelope shape for all CLEO CLI commands is `CliEnvelope<T>` defined in `packages/lafs/src/envelope.ts`:

```ts
export interface CliMeta {
  operation: string;
  requestId: string;
  duration_ms: number;
  timestamp: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface CliEnvelopeError {
  code: number | string;
  codeName?: string;
  message: string;
  fix?: unknown;
  alternatives?: Array<{ action: string; command: string }>;
  details?: unknown;
  problemDetails?: unknown;
  [key: string]: unknown;
}

export interface CliEnvelope<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: CliEnvelopeError;
  meta: CliMeta;
  page?: LAFSPage;
}
```

Key invariants:
- `success` is **always** present.
- `meta` is **always** present (success and failure).
- `data` is present when `success === true`.
- `error` is present when `success === false`.

---

## Consequences

This is a **BREAKING** change for all consumers that read legacy field names.

### Migration table

| Legacy field | Canonical field | Notes |
|---|---|---|
| `ok` | `success` | Boolean, always present |
| `r` | `data` | Present on success |
| `_m` | `meta` | Always present |
| `result` (observe) | `data` | Same field |
| `_meta` (dispatch response) | `meta` | DispatchResponse also renamed |

### Positive

- Agents parse one shape, not three. No branching on shape before reading.
- `meta` is always present on both success and error paths — agents can always read `requestId`, `operation`, and `duration_ms`.
- Shared middleware (budget enforcement, field filtering) bridges a single shape to the LAFS SDK proto-shape via `_ProtoEnvelopeStub`.
- `CliEnvelopeError` has an index signature `[key: string]: unknown` enabling extensible vendor fields without breaking downstream consumers.

### Negative

- All agents and tooling that read `ok`, `r`, or `_m` MUST be updated.
- The LAFS SDK's internal `LAFSEnvelope` still uses `{_meta, result}` (proto-shape). Dispatch-layer middleware bridges between the two shapes via `_ProtoEnvelopeStub` in `packages/cleo/src/dispatch/lib/proto-envelope.ts`.

---

## Implementation

Cherry-picked from Wave 4 commits in the T335 epic. Wave 4 finisher (T338) closed the remaining gaps:

- `packages/lafs/src/envelope.ts`: added `[key: string]: unknown` index signature to `CliEnvelopeError`
- `packages/core/src/tasks/add.ts`: made `AddTaskOptions.description` optional (`description?: string`)
- `packages/cleo/src/dispatch/engines/task-engine.ts`: made `taskCreate` params `description` optional
- `packages/cleo/src/dispatch/lib/proto-envelope.ts` (new): extracted `_ProtoEnvelopeStub` shared by `budget.ts` and `field-filter.ts`
- `packages/cleo/src/dispatch/middleware/protocol-enforcement.ts`: bridged `DispatchNext` (canonical `meta`) to `ProtocolEnforcer.enforceProtocol` (proto-shape `_meta`) via a wrapper function
- 3 test files updated: `session-safety.test.ts`, `audit.test.ts`, `core-parity.test.ts`

---

## References

- T335 — LAFS Envelope Remediation epic
- T338 — FIX-3: Wave 4 finisher
- `packages/lafs/src/envelope.ts` — canonical `CliEnvelope`, `CliMeta`, `CliEnvelopeError` types
- `packages/cleo/src/dispatch/lib/proto-envelope.ts` — `_ProtoEnvelopeStub` bridge type
- `packages/cleo/src/dispatch/types.ts` — `DispatchResponse.meta` (renamed from `_meta`)

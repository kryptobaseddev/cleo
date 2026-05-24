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

## Amendment — T9920 (Saga T9855 / E8.1, 2026-05-24)

`CliMeta` is extended with an optional first-class
`suggestedNext?: ReadonlyArray<string>` field. The field is the **canonical**
envelope-wide LLM next-action hint: a flat array of copy-pasteable CLI
commands the agent may run next as the natural chained-reasoning step.

**Canonical shape.** `ReadonlyArray<string>` — a flat, ordered list of
self-contained, copy-pasteable command strings (e.g. `"cleo focus T1234"`,
`"cleo verify T1234 --gate implemented"`). The `Readonly` modifier is part
of the contract: producers MUST NOT mutate the array after attaching it.

**Semantic.** Each entry MUST be a self-contained, copy-pasteable command
string. The list is ordered by relevance — earliest entry is the most likely
follow-up. An empty array means "no follow-up suggested"; absent means
"the producer did not consider follow-ups". Renderers MUST omit the field
from human output when the array is empty.

**Backward compatibility.** The pre-T9920 nexus-only structured form lives
on at `meta._nexus.suggestedNext: ReadonlyArray<SuggestedNextOp>` (see
`packages/contracts/src/operations/nexus-scope.ts`). The nexus decorator
additionally projects a flat string form onto `meta.suggestedNext` under
follow-on task T9921. Existing structured-shape consumers continue
to function unchanged — this amendment **adds** the envelope-wide field
without altering the nexus-internal one.

**Producer guidance.** Operation handlers, decorators, and middleware
SHOULD use the helper
`attachSuggestedNext(envelope, suggestions)` from
`@cleocode/core/dispatch/suggested-next` (re-exported from
`@cleocode/core`) to add the field. The helper deep-clones `envelope.meta`
so the input envelope is never mutated.

---

## Amendment — T9923 (Saga T9855 / E8.4, 2026-05-24)

`CliMeta` is extended with an optional first-class
`tokens?: CliMetaTokens` field. This promotes the legacy underscore-prefixed
`meta._tokenEstimate` field into a stable, structured token-cost annotation
that renderers and orchestrators MAY use without depending on LAFS-tier
internals.

**Canonical shape.**

```ts
export interface CliMetaTokens {
  /** Approximate token count of the envelope payload. */
  estimate: number;
  /**
   * Tokenizer identifier used to compute the estimate.
   * @example "cl100k", "o200k", "approx" (heuristic fallback).
   */
  model: string;
  /** ISO 8601 timestamp of when the estimate was computed. */
  calculatedAt: string;
}
```

All three fields are REQUIRED when `meta.tokens` is present. A partial object
(e.g. `{ estimate: 42 }` without `model` and `calculatedAt`) is INVALID and
MUST be rejected by conformance checks.

**Backward compatibility.** The legacy `meta._tokenEstimate?: { estimate:
number; [key: string]: unknown }` is retained for ONE release and removed
at `v2026.7.0`. During the deprecation overlap window, an envelope MAY carry
BOTH `meta.tokens` (canonical) AND `meta._tokenEstimate` (legacy mirror) —
conformance MUST accept this configuration. Consumers SHOULD read
`meta.tokens.estimate` and ignore `_tokenEstimate` when both are present.

**Producer guidance.** Producers SHOULD set both `meta.tokens` and the
legacy `meta._tokenEstimate` until v2026.7.0, then drop the legacy mirror.
See `packages/lafs/src/envelope.ts` for the canonical type definitions.

---

## Amendment — T9922 (Saga T9855 / E8.3, 2026-05-24)

Read operations now default to **MVI (Minimum Viable Information)**
projection: the dispatch middleware trims response payloads down to the
essential fields declared in `PROJECTION_PLANS`. Agents pay a fraction of
the token cost they paid before for routine read calls.

**Canonical shape.** `CliMeta` is extended with an optional
`projection?: 'mvi' | 'full'` discriminator stamped by the
`createMviRecordProjection()` middleware (see
`packages/cleo/src/dispatch/middleware/mvi-record-projection.ts`).

**Semantics.**

- `projection: 'mvi'` — payload was trimmed per the operation's projection
  plan. This is the **default** for any read op with a registered plan in
  `PROJECTION_PLANS`.
- `projection: 'full'` — payload is the full domain record; opt-out was
  requested by the caller.
- Absent — operation does not participate in MVI projection (the
  middleware did not act on the response).

**Opt-out flags.** The CLI surfaces three equivalent opt-out flags that
all resolve to `_projection: 'full'`:

- `--verbose` — canonical opt-out flag
- `--full` — alias for `--verbose`
- `--human` — implicit opt-out (humans always get the full record)

The flag is read once per request via `getProjectionOptOut()` from the
CLI projection context. Internal callers MAY also set
`req.params._projection = 'full' | 'mvi'` directly for per-request override.

**Backward compatibility.** Existing tooling that depends on full-record
responses MUST add `--verbose` (or `--full` / `--human`) to its dispatch
call. The middleware is **default-on** for read ops with a registered
projection plan; mutate ops are unaffected.

---

## Amendment — T9924 (Saga T9855 / E8.5, 2026-05-24) — writer-allowlist principle

Renderer SSoT and stdout-write allowlist enforcement.

**Principle.** Every byte written to `process.stdout` from a CLEO CLI
command MUST flow through the canonical renderer SSoT at
`packages/core/src/render/`. Direct `process.stdout.write()` and bare
`console.log()` calls outside the allowlist are anti-patterns: they bypass
the canonical CLI envelope shape (ADR-039), the MVI projection middleware
(T9922), and the human-render contract (ADR-077).

**Enforcement.** CI gate
`scripts/lint-stdout-write-allowlist.mjs` (job: `Stdout Write Allowlist`)
maintains a baseline of legacy write sites and fails when net-new
violations are added. The companion gate
`scripts/lint-stdout-discipline.mjs` covers `console.log`/`console.error`
discipline (75-site baseline locked by T10114).

**Renderer location.** The canonical renderer-pipeline registry lives at
`packages/core/src/render/` (relocated from
`packages/cleo/src/cli/renderers/` by T10114 E11-HUMAN-RENDER-CONTRACT,
v2026.5.108). New renderers register against
`renderEnvelopeForHuman()` keyed on `(command, kind)`.

---

## Cross-reference — E7 / T9914 OperationInputContract

These E8 envelope amendments form the **output half** of the
input/output symmetry mandated by Epic T9914
(E-OPERATION-INPUT-CONTRACT, ADR-049 amendment). The OperationInputContract
defines a stable, contract-enforced shape for the **input** side of
every operation; the E8 amendments (T9920 / T9923 / T9922 / T9924) define
the matching stable shape for the **output** side:

| Side    | Contract                              | Source of truth                                              |
|---------|---------------------------------------|--------------------------------------------------------------|
| Input   | `OperationInputContract<TArgs>` (T9914) | `packages/contracts/src/operations/`                       |
| Output  | `CliEnvelope<T>` with extended `CliMeta` | `packages/lafs/src/envelope.ts`                            |

Together they guarantee that an agent inspecting any operation can
predict both the input it must construct and the output shape it will
receive — no per-operation branching, no shape detection.

---

## References

- T335 — LAFS Envelope Remediation epic
- T338 — FIX-3: Wave 4 finisher
- T9920 (Saga T9855 / E8.1) — envelope-wide `meta.suggestedNext` promotion
- T9921 (Saga T9855 / E8.2) — nexus decorator auto-populates `meta.suggestedNext`
- T9922 (Saga T9855 / E8.3) — MVI record projection default + opt-out flags
- T9923 (Saga T9855 / E8.4) — `meta.tokens` first-class token-cost annotation
- T9924 (Saga T9855 / E8.5) — stdout-write allowlist + renderer SSoT principle
- T9925 (Saga T9855 / E8.6) — this ADR amendment + LAFS conformance test extension
- T9914 (E-OPERATION-INPUT-CONTRACT) — input/output symmetry counterpart
- T10114 (E11-HUMAN-RENDER-CONTRACT) — renderer SSoT relocated to `packages/core/src/render/`
- `packages/lafs/src/envelope.ts` — canonical `CliEnvelope`, `CliMeta`, `CliEnvelopeError`, `CliMetaTokens` types
- `packages/core/src/dispatch/suggested-next.ts` — `attachSuggestedNext` helper
- `packages/core/src/dispatch/mvi-projection.ts` — `resolveProjectionMode`, projection-plan registry
- `packages/cleo/src/dispatch/middleware/mvi-record-projection.ts` — middleware that stamps `meta.projection`
- `packages/contracts/src/operations/nexus-scope.ts` — pre-existing structured `NexusScopeMeta.suggestedNext`
- `packages/cleo/src/dispatch/lib/proto-envelope.ts` — `_ProtoEnvelopeStub` bridge type
- `packages/cleo/src/dispatch/types.ts` — `DispatchResponse.meta` (renamed from `_meta`)
- `scripts/lint-stdout-write-allowlist.mjs` — writer-allowlist CI gate
- `scripts/lint-stdout-discipline.mjs` — console-write discipline CI gate

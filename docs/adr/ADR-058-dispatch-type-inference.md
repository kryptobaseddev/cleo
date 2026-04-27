# ADR-058: Dispatch Type Inference via `OpsFromCore<C>` — Pattern, Migration Recipe, and Escape Hatches

**Status**: ACCEPTED
**Date**: 2026-04-26
**Tasks**: T1447 (this ADR), T1435 (epic), T1436 (OpsFromCore helper), T1449 (Core API normalization)
**Supplements**: ADR-057 (Contracts/Core SSoT layering — prerequisite), ADR-051 (evidence-based completion gates)
**Cross-references**: AGENTS.md (no-`any` rule), `packages/cleo/src/dispatch/adapters/typed.ts`

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### The Drift Class That Motivated This Pattern

Prior to T1435 / ADR-057, CLEO's dispatch layer suffered from **dispatch-vs-contracts drift**: every handler extracted params with hand-written casts:

```typescript
// BEFORE — old pattern (579 instances across 14 handlers per T910 audit)
async handle(op: string, params: Record<string, unknown>) {
  if (op === 'tasks.add') {
    const title = params.title as string;        // ← untyped, can drift silently
    const parent = params.parentId as string;    // ← field name wrong in wire shape
    ...
  }
}
```

When a contract type was renamed, added, or removed, TypeScript saw no compile-time error because the handler had no typed connection to `@cleocode/contracts`. Drift accumulated silently until runtime failures surfaced.

**The failure class became acute at v2026.4.143/v2026.4.144**: a Wave D typed-dispatch migration (T1421-T1427) left **104 TypeScript errors** at the `Type Check` CI step. Root causes, per CHANGELOG entry:

| Domain handler | TS errors | Root cause |
|---|---|---|
| `nexus.ts` | 44 | `NexusOps` + 39 `NexusXxxParams`/`Result` types not re-exported from `@cleocode/contracts` |
| `check.ts` | 23 | Missing `CheckOps` export, 19 `ValidateXxxParams` types, 1 unused binding, 2 envelope mismatches |
| `conduit.ts` | 19 | 9 missing `ConduitXxxParams`/`Ops` exports, 2 `LafsEnvelope` generic mismatches, stray `this` refs |
| `sentient.ts` | 13 | 11 missing `SentientOps`/`AllowlistXxxParams`/`ProposeXxxParams` exports |
| `memory.ts` | 2 | Unsafe casts from `SQLOutputValue[]` to `EdgeRow[]` |
| `admin.ts` | 2 | Missing import, discriminated-union narrowing failure |
| `release-engine.ts` | 1 | `id` field not on `TaskQueryFilters` |

v2026.4.145 closed all 104 errors (T1434) by: (a) re-exporting 162+ operation types from `@cleocode/contracts/src/index.ts`, and (b) widening `TypedDomainHandler` operations return type to `LafsEnvelope<unknown>` so engine patterns infer cleanly.

### Why the Structural Fix Was Needed

Re-exporting 162 types was a symptom fix. The structural problem was that dispatch handlers maintained their own idea of what params looked like — separately from Core and from Contracts. **`OpsFromCore<C>` eliminates this third mental model entirely**: dispatch infers its op types directly from the Core function registry it calls.

---

## Decision

### D1 — `OpsFromCore<C>` is the canonical type inference mechanism for dispatch handlers

The `OpsFromCore<C>` type helper (defined in `packages/cleo/src/dispatch/adapters/typed.ts`, introduced by T1436) transforms a record of Core functions into a `TypedOpRecord` by structural inference:

```typescript
// biome-ignore lint/suspicious/noExplicitAny: mandatory for TS inference
export type OpsFromCore<C extends Record<string, (...args: any[]) => any>> = {
  [K in keyof C]: [
    Parameters<C[K]>[0] extends undefined ? Record<string, never> : Parameters<C[K]>[0],
    Awaited<ReturnType<C[K]>>,
  ];
};
```

**What this buys**:
- `[K][0]` — the exact `Params` type TypeScript sees on the Core function's first argument.
- `[K][1]` — the exact `Result` type after `await`.
- Both are **inferred at the use site**, not declared separately in contracts.

**What this does NOT do**:
- Runtime validation. The single cast `rawParams as O[K][0]` inside `typedDispatch` is the documented trust boundary (see `typed.ts` JSDoc). Runtime schema validation (zod) is a future epic.
- Replace `DomainHandler`. Existing handlers wrap via `TypedDomainHandler` adapter; the legacy interface remains for back-compat.

### D2 — Prerequisite: ADR-057 D1 uniform Core signature

`OpsFromCore<C>` inference is only sound if every Core function follows the ADR-057 D1 uniform signature:

```typescript
async function <opName>(projectRoot: string, params: <Op>Params): Promise<<Op>Result>
```

If a Core function takes positional args (`fn(projectRoot, sessionId: string)`), then `Parameters<F>[0]` resolves to `string` — breaking inference. See ADR-057 §Context for the T1435 Option A failure analysis that confirmed this constraint.

### D3 — Three implementation tiers (dispatch layer)

| Tier | When to use | Example domain |
|---|---|---|
| **Tier A — thin wrapper** | Core functions already follow ADR-057 D1; dispatch calls them directly. | `tasks`, `session`, `conduit` |
| **Tier B — engine wrapper** | Core fns normalized per D1; engine layer provides `EngineResult<T>` tuple and positional-to-params translation. | `pipeline`, `admin`, `nexus` |
| **Tier C — manual `TypedOpRecord`** | Wire shape genuinely diverges from Core (overloads, multi-step aggregation). Write the `TypedOpRecord` by hand; bypass `OpsFromCore<C>`. | nexus top-entries, handoff scope-string parsing |

All three tiers satisfy the same `TypedOpRecord` contract at the `defineTypedHandler<Ops>` callsite.

### D4 — Escape hatch: manual `TypedOpRecord`

When `OpsFromCore<C>` inference doesn't fit (multi-overload Core fns, aggregation ops, wire-shape mismatches), you MAY declare the `TypedOpRecord` manually:

```typescript
// Manual declaration — use when OpsFromCore inference is impractical.
type MyDomainOps = {
  'domain.op':        [{ inputField: string }, { outputField: string }];
  'domain.aggregate': [Record<string, never>, AggregateResult];
};
```

**Requirements**: the manual declaration MUST still satisfy `TypedOpRecord`; the handler bodies MUST still be 1-3 lines that call through to Core or an engine wrapper (no inline business logic). Add a `// SSoT-EXEMPT:<reason>` comment citing which D1/D2/D3 constraint is waived and why.

---

## How to Add a New Operation

This section is the canonical recipe for contributors. Follow it exactly — the quality gates at the bottom are hard requirements.

### Step 1: Add a Core function (ADR-057 D1 shape)

In `packages/core/src/<domain>/`:

```typescript
// packages/core/src/docs/adr-operations.ts

import type { ExampleAddParams, ExampleAddResult } from '@cleocode/contracts';

/**
 * Add a new example entry.
 *
 * @param projectRoot - Absolute project root path.
 * @param params - Operation parameters from `@cleocode/contracts`.
 * @returns The created entry.
 */
export async function exampleAdd(
  projectRoot: string,
  params: ExampleAddParams,
): Promise<ExampleAddResult> {
  // ... implementation
  return { id: 'ex_001', label: params.label };
}
```

**Required**: first arg is `projectRoot: string`; second arg is typed via `@cleocode/contracts`. No inline types.

### Step 2: Export from Core's public surface

In `packages/core/src/index.ts` (or the domain barrel):

```typescript
export { exampleAdd } from './docs/adr-operations.js';
```

### Step 3: Add to `coreOps` in the dispatch handler

In `packages/cleo/src/dispatch/domains/<domain>.ts`:

```typescript
import { exampleAdd } from '@cleocode/core/internal';

// Add the new op to the existing coreOps record:
const coreOps = {
  // ... existing ops
  'example.add': async (params: Parameters<typeof exampleAdd>[1]) =>
    exampleAdd(getProjectRoot(), params),
} as const;

// The type is automatically inferred — no manual type declaration needed:
export type ExampleOps = OpsFromCore<typeof coreOps>;
// ExampleOps['example.add'] is now [ExampleAddParams, ExampleAddResult]
```

### Step 4: Add the handler body

Inside `defineTypedHandler<ExampleOps>`:

```typescript
'example.add': async (params) => {
  const result = await coreOps['example.add'](params);
  if (!result.success) {
    return lafsError('E_ADD_FAILED', result.error?.message ?? 'add failed', 'example.add');
  }
  return lafsSuccess(result.data, 'example.add');
},
```

### Step 5: Register the op in the domain registry

In `packages/cleo/src/dispatch/registry.ts` (or the domain's registration file), add `'example.add'` to the allowed operations set for the domain. The registry validates that the op key exists before dispatch reaches the handler.

### Step 6: Run quality gates

```bash
pnpm biome check --write .
pnpm run build          # must exit 0 — catches missing exports, type errors
pnpm run test           # zero new failures
git diff --stat HEAD    # verify scope matches expectation
```

**DO NOT** mark a task done without running all four commands. See AGENTS.md §Quality Gates.

### Step 7: Verify and complete (ADR-051)

```bash
SHA=$(git rev-parse HEAD)
cleo verify T### --gate implemented \
  --evidence "commit:${SHA};files:packages/core/src/<domain>/…,packages/cleo/src/dispatch/domains/…"
cleo verify T### --gate testsPassed --evidence "tool:pnpm-test"
cleo verify T### --gate qaPassed   --evidence "tool:biome;tool:tsc"
cleo complete T###
```

---

## What You Do NOT Need to Do

Adding a new operation under `OpsFromCore<C>` does **NOT** require:

- ✗ Editing `packages/contracts/src/index.ts` to re-export op types (only needed if external consumers need the type name directly).
- ✗ Writing a `TypedOpRecord` declaration by hand.
- ✗ Adding casts (`as string`, `as unknown`) in the handler body.
- ✗ Modifying other domain handlers.

---

## Worked Example: Before/After for `session.show`

### Before (positional Core + untyped dispatch)

```typescript
// Core (session-show.ts)
export async function showSession(projectRoot: string, sessionId: string): Promise<Session>

// Engine (session-engine.ts)
export async function sessionShow(projectRoot: string, sessionId: string): Promise<EngineResult<Session>> {
  const result = await showSession(projectRoot, sessionId);  // positional
  ...
}

// Dispatch (session.ts)
async handle(op: string, params: Record<string, unknown>) {
  if (op === 'session.show') {
    const sessionId = params.sessionId as string;  // ← untyped cast
    return sessionShow(getProjectRoot(), sessionId);
  }
}
```

`Parameters<typeof showSession>[0]` resolves to `string` — not a params object. `OpsFromCore` would infer `['session.show']: [string, Session]`, which is wrong.

### After (uniform Core + OpsFromCore)

```typescript
// Core (session-show.ts)
import type { SessionShowParams } from '@cleocode/contracts';

export async function showSession(
  projectRoot: string,
  params: SessionShowParams,  // { sessionId: string; include?: string }
): Promise<Session>

// Engine (session-engine.ts) — outer signature stays positional for engine callers;
// translates to params object when calling Core. ADR-057 D4 engine layer.
export async function sessionShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  const result = await showSession(projectRoot, { sessionId });  // ← params object
  ...
}

// Dispatch (session.ts) — coreOps wraps engine, OpsFromCore infers types
const coreOps = {
  'session.show': async (params: { sessionId: string; include?: string }) =>
    sessionShow(getProjectRoot(), params.sessionId),
} as const;

export type SessionOps = OpsFromCore<typeof coreOps>;
// SessionOps['session.show'] === [{ sessionId: string; include?: string }, EngineResult<Session>]

// Handler body — typed, zero casts
'session.show': async (params) => {
  const result = await coreOps['session.show'](params);
  if (!result.success) return lafsError('E_NOT_FOUND', result.error, 'session.show');
  return lafsSuccess(result.data, 'session.show');
},
```

`params.sessionId` is now compile-time typed. A rename or removal in `SessionShowParams` breaks the build immediately, not at runtime.

---

## Overload Resolution Warning

TypeScript's `Parameters<F>` and `ReturnType<F>` pick the **last** overload of an overloaded function signature. If a Core function defines multiple overloads with materially different parameter shapes, `OpsFromCore<C>` will infer the last one only. In that case:

1. Prefer single-signature Core functions (ADR-057 D1 constraint).
2. If overloads are required for internal callers, expose a single-signature public wrapper at the dispatch boundary and annotate: `// SSoT-EXEMPT:overload-boundary — wrapper normalizes for dispatch inference`.
3. As a last resort, hand-write the `TypedOpRecord` for that op (Tier C above).

---

## Consequences

### Positive

- **Compile-time drift detection**: changing a Core function's params type breaks dispatch immediately (not at runtime). The v2026.4.143/v2026.4.144 104-error class cannot silently accumulate.
- **Zero hand-written type declarations in dispatch**: handler authors write Core code; dispatch types follow automatically.
- **Reduced dispatch LOC**: handler bodies become 1-3 lines; no param-extraction boilerplate.
- **External SDK consumers** get correct types from Core directly, with no dispatch-layer indirection.

### Negative

- **Requires ADR-057 D1 compliance**: Core functions with positional args must be normalized before `OpsFromCore<C>` is useful. This is a one-time cost per domain (see T1449 per-domain tasks).
- **Overloaded functions break inference** (see Overload Resolution Warning above).
- **Engine wrapper layer stays positional** (ADR-057 D4): `sessionShow(root, sessionId: string)` stays positional at the engine surface so dispatch callers don't change. Core changes; engine absorbs the translation.

### Risks and Mitigations

| Risk | Mitigation |
|---|---|
| biome-ignore comment on `OpsFromCore` mistaken as permission for `any` elsewhere | The `// biome-ignore` on `OpsFromCore` is MANDATORY for TS inference and SCOPED to that type definition. It does NOT waive AGENTS.md's `no-any` rule. Grep for other `any` uses; flag for removal. |
| Last-overload inference silently picks wrong shape | Enforce ADR-057 D1 single-signature rule. Use `// SSoT-EXEMPT` + wrapper when overloads are unavoidable. |
| Manual `TypedOpRecord` drifts from Core over time | The lint script (`scripts/lint-contracts-core-ssot.mjs`, ADR-057 D5) rejects dispatch handlers whose Core entry points don't match the D1 signature — catches the boundary even for Tier C handlers. |
| Future Zod validation changes `typedDispatch` internals | The single `rawParams as O[K][0]` cast is the only trust boundary. Inserting Zod here is a localized change; no per-op code changes needed. See `typed.ts` `// Future` comment. |

---

## Anti-Patterns (INSTANT REJECTION per AGENTS.md)

```typescript
// ❌ WRONG — hand-cast in handler body
'example.add': async (params) => {
  const label = (params as { label: string }).label;  // ← defeats type safety
  ...
}

// ❌ WRONG — inline type that duplicates contract
type ExampleAddParams = { label: string };  // ← use @cleocode/contracts, never inline
const coreOps = { 'example.add': async (params: ExampleAddParams) => ... };

// ❌ WRONG — any escape hatch
const coreOps = { 'example.add': async (params: any) => ... };  // ← AGENTS.md: never any

// ❌ WRONG — business logic in handler body
'example.add': async (params) => {
  if (!params.label.startsWith('ex_')) params.label = 'ex_' + params.label; // ← belongs in Core
  ...
}

// ✅ CORRECT — thin handler, all logic in Core
'example.add': async (params) => {
  const result = await coreOps['example.add'](params);
  if (!result.success) return lafsError('E_ADD_FAILED', result.error?.message ?? '', 'example.add');
  return lafsSuccess(result.data, 'example.add');
},
```

---

## Compliance Checklist

Before any dispatch domain is considered fully migrated:

- [ ] All Core functions in `coreOps` follow ADR-057 D1 signature (`projectRoot: string, params: <Op>Params`).
- [ ] `OpsFromCore<typeof coreOps>` is used for the domain's `Ops` type (or a `// SSoT-EXEMPT` manual override is present with reason + follow-up task ID).
- [ ] Handler bodies are 1-3 lines: call Core/engine, wrap in `lafsSuccess`/`lafsError`.
- [ ] No `as string` / `as unknown` / `as any` casts in handler bodies.
- [ ] `pnpm run build` exits 0 with zero new TS errors.
- [ ] `pnpm run test` exits 0 with zero new failures.
- [ ] `node scripts/lint-contracts-core-ssot.mjs --exit-on-fail` exits 0 (ADR-057 D5 lint gate).

---

## References

- **T1447** — this ADR (T1435-W3a)
- **T1435** — dispatch ops inference epic (parent)
- **T1436** — OpsFromCore<C> helper (Wave 0)
- **T1449** — Core API uniformity epic (ADR-057 prerequisite)
- **T1434** — Closed 104 TS errors at v2026.4.145 (evidence of the pre-pattern drift class)
- **ADR-057** — Contracts/Core SSoT layering (prerequisite; uniform Core signature)
- **ADR-051** — Evidence-based completion gates (MANDATORY pre-complete ritual)
- **AGENTS.md** — No-`any` rule, package boundary contract, quality gates
- `packages/cleo/src/dispatch/adapters/typed.ts` — `OpsFromCore<C>`, `defineTypedHandler`, `typedDispatch`
- `packages/core/src/tasks/ops.ts` — Tier A normalized Core ops (reference implementation)
- `packages/cleo/src/dispatch/domains/pipeline.ts` — Tier B engine-wrapper dispatch (reference implementation)
- `.cleo/agent-outputs/T1450-MIGRATION-PATTERN.md` — step-by-step migration recipe with BEFORE/AFTER traces

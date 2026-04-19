# CLEO Dispatch Adapter Specification

**Version**: 1.0.0
**Status**: APPROVED
**Date**: 2026-04-18
**Task**: T986
**Epic**: T962 (clean-code SSoT reconciliation)
**Foundation**: T974 (commit `16f29c3a8`)

---

## 1. Summary

The dispatch adapter layer is the single compile-time boundary between the
untyped registry (`Record<string, unknown>` params) and typed domain handlers
(contract-typed `Params` / `Result`). This specification documents the
`TypedDomainHandler<O>` interface, the `typedDispatch<O, K>` helper, the
`defineTypedHandler<O>` builder, and the migration path from **579 latent
casts** across 14 domain handlers to **zero**.

The typed adapter (see
[`packages/cleo/src/dispatch/adapters/typed.ts`](../../packages/cleo/src/dispatch/adapters/typed.ts))
shipped in T974 as the Wave D foundation of epic T962. Per-domain migrations
(T975-T983) are deferred to follow-on epic [T988](#9-open-questions-for-follow-on-epic-t988)
for v2026.4.98; this spec is the authoritative reference for how those
migrations MUST be performed.

**Requirement levels** follow RFC 2119 (MUST, SHOULD, MAY).

---

## 2. Problem Statement

The T910 type-safety reconciliation audit
([`.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md`](../../.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md))
enumerated every `as T` cast under `packages/cleo/src/dispatch/`:

| Metric | Count | Source |
|---|---:|---|
| Total `as SomeType` casts (non-test) | 174 | audit §Executive summary |
| `params?.xxx as Y` param casts (domains) | **579** | audit §Section 1 |
| `Record<string, unknown>` occurrences | 130 | audit §Executive summary |
| Domain handler method signatures still typed `Record<string, unknown>` | 34 | audit §Section 1 |
| Typed `*Params` interfaces in `@cleocode/contracts/src/operations/` | 2275 LOC | audit §Executive summary |

**Root cause** (audit §Section 3):
[`packages/cleo/src/dispatch/types.ts:92`](../../packages/cleo/src/dispatch/types.ts)
declares `DomainHandler.query(operation: string, params?: Record<string, unknown>)`.
The registry passes `params` untyped; every handler re-casts each field at
every call site. The typed `*Params` interfaces in
[`packages/contracts/src/operations/`](../../packages/contracts/src/operations/)
have existed since 2026-03-18 (commit `d821281bb`) but have **never** been
imported by the dispatch layer.

**Concrete examples** (audit §Section 2 Category A):
- [`packages/cleo/src/dispatch/domains/tasks.ts`](../../packages/cleo/src/dispatch/domains/tasks.ts)
  — 79 param casts; `TasksGetParams`, `TasksListParams`, etc. already exist in
  [`packages/contracts/src/operations/tasks.ts`](../../packages/contracts/src/operations/tasks.ts).
- `packages/cleo/src/dispatch/domains/admin.ts` — 107 param casts (largest offender).
- `packages/cleo/src/dispatch/domains/memory.ts` — 88 param casts.

Four handlers (`admin`, `memory`, `tasks`, `pipeline`) account for **343 / 579 = 59%**
of all drift (audit §Section 1 observation 1).

**Operator mandate** (from audit): *"there MUST BE ZERO latent schema-drift —
this must be reconciled and fixed across the codebase."*

---

## 3. Design

### 3.1 Core types

The adapter at
[`packages/cleo/src/dispatch/adapters/typed.ts:66-98`](../../packages/cleo/src/dispatch/adapters/typed.ts)
declares three exported types:

```typescript
type TypedOpRecord = Record<string, readonly [unknown, unknown]>;

interface TypedDomainHandler<O extends TypedOpRecord> {
  readonly domain: string;
  readonly operations: {
    readonly [K in keyof O]: (params: O[K][0]) => Promise<LafsEnvelope<O[K][1]>>;
  };
}

async function typedDispatch<O extends TypedOpRecord, K extends keyof O & string>(
  handler: TypedDomainHandler<O>,
  op: K,
  rawParams: unknown,
): Promise<LafsEnvelope<O[K][1]>>;

function defineTypedHandler<O extends TypedOpRecord>(
  domain: string,
  operations: TypedDomainHandler<O>['operations'],
): TypedDomainHandler<O>;
```

Concrete locations:

| Symbol | File:Line |
|---|---|
| `TypedOpRecord` | [`adapters/typed.ts:66`](../../packages/cleo/src/dispatch/adapters/typed.ts) |
| `TypedDomainHandler<O>` | [`adapters/typed.ts:88-98`](../../packages/cleo/src/dispatch/adapters/typed.ts) |
| `typedDispatch<O, K>` | [`adapters/typed.ts:135-164`](../../packages/cleo/src/dispatch/adapters/typed.ts) |
| `defineTypedHandler<O>` | [`adapters/typed.ts:190-195`](../../packages/cleo/src/dispatch/adapters/typed.ts) |
| `lafsSuccess<T>` | [`adapters/typed.ts:231-236`](../../packages/cleo/src/dispatch/adapters/typed.ts) |
| `lafsError` | [`adapters/typed.ts:260-272`](../../packages/cleo/src/dispatch/adapters/typed.ts) |

### 3.2 The single-cast trust boundary

The cast at
[`adapters/typed.ts:163`](../../packages/cleo/src/dispatch/adapters/typed.ts)
(`rawParams as O[K][0]` inside `typedDispatch`) is the **only** cast in the
typed adapter pipeline and MUST remain the only cast. The registry upstream
(see [`packages/cleo/src/dispatch/registry.ts`](../../packages/cleo/src/dispatch/registry.ts))
guarantees that `op` exists in the handler's operations map, and the
[`OperationRegistry.validateRequiredParams`](../../packages/cleo/src/dispatch/registry.ts)
invariant enforces presence before dispatch.

Per-domain handlers MUST NOT add `as T` casts inside their operation functions.
Any field-level narrowing below `typedDispatch` is handled by TypeScript generic
inference; no explicit cast is required because `params` is already narrowed
to `O[K][0]`.

### 3.3 Envelope helpers

The adapter exports envelope builders that match the LAFS contract
([`packages/contracts/src/lafs.ts`](../../packages/contracts/src/lafs.ts)):

- `lafsSuccess<T>(data: T, _operation: string): LafsSuccess<T>` — wraps a
  payload in the success envelope. The `_operation` argument is accepted for
  parity with `lafsError` but is not persisted on the CLI variant; upstream
  middleware writes it onto `GatewaySuccess._meta.operation`.
- `lafsError(code: string, message: string, _operation: string, fix?: string): LafsEnvelope<never>`
  — returns the error variant. Typed as `LafsEnvelope<never>` so it composes
  with any `LafsEnvelope<T>` return type without a union cast.

Handlers MUST use these helpers and MUST NOT build envelopes by hand.

---

## 4. Ops Record Pattern

Each typed handler declares its operation shape as a `TypedOpRecord` — a
flat object where each key is the dispatch-level op name (see
[`types.ts:CANONICAL_DOMAINS`](../../packages/cleo/src/dispatch/types.ts))
and each value is a `readonly [Params, Result]` tuple that MUST be imported
from `@cleocode/contracts`.

**Example** for the session domain, backed by the existing contracts at
[`packages/contracts/src/operations/session.ts`](../../packages/contracts/src/operations/session.ts):

```typescript
import type {
  SessionStartParams, SessionStartResult,
  SessionStatusParams, SessionStatusResult,
  SessionEndParams, SessionEndResult,
  SessionListParams, SessionListResult,
  SessionShowParams, SessionShowResult,
  SessionHistoryParams, SessionHistoryResult,
  SessionResumeParams, SessionResumeResult,
  SessionSuspendParams, SessionSuspendResult,
  SessionGcParams, SessionGcResult,
} from '@cleocode/contracts';

type SessionOps = {
  readonly 'session.status':   readonly [SessionStatusParams,   SessionStatusResult];
  readonly 'session.list':     readonly [SessionListParams,     SessionListResult];
  readonly 'session.show':     readonly [SessionShowParams,     SessionShowResult];
  readonly 'session.history':  readonly [SessionHistoryParams,  SessionHistoryResult];
  readonly 'session.start':    readonly [SessionStartParams,    SessionStartResult];
  readonly 'session.end':      readonly [SessionEndParams,      SessionEndResult];
  readonly 'session.resume':   readonly [SessionResumeParams,   SessionResumeResult];
  readonly 'session.suspend':  readonly [SessionSuspendParams,  SessionSuspendResult];
  readonly 'session.gc':       readonly [SessionGcParams,       SessionGcResult];
};
```

### 4.1 Naming rules

- Op keys MUST match the registry name exactly (`<domain>.<op>`, lowercase,
  dot-delimited) as declared in
  [`packages/cleo/src/dispatch/registry.ts`](../../packages/cleo/src/dispatch/registry.ts).
- The tuple MUST be `readonly [Params, Result]` to preserve structural
  immutability and match `TypedOpRecord`.
- Params and Result types MUST be imported from `@cleocode/contracts`. New
  contracts MUST be added to the appropriate `packages/contracts/src/operations/*.ts`
  file rather than defined inline in the handler.
- When a contract is missing (see audit §Section 1 for domains marked
  "Partial" / "No canonical"), the migration task MUST author the contract
  first, land it in `@cleocode/contracts`, and only then migrate the handler.

### 4.2 Zero-param ops

Ops with no input params MUST use `Record<string, never>` rather than `{}` or
`undefined`, matching the contract convention (see
[`operations/session.ts:31`](../../packages/contracts/src/operations/session.ts)
for `SessionStatusParams`).

---

## 5. Per-Domain Migration Plan

The 579 param casts break down by domain as follows (source: audit §Section 1).
Each domain gets its own migration task that MUST land independently, MUST
add end-to-end tests, and MUST leave `pnpm run test` green at every step.

| Wave | Task | Domain | Current casts | Target | Contract status | Status |
|:----:|:----:|--------|--------------:|------:|-----------------|--------|
| D1 | T975 | session | 31 | 0 | Complete ([`operations/session.ts`](../../packages/contracts/src/operations/session.ts), 154 LOC) | Pending |
| D2 | T976 | nexus | 34 | 0 | Complete ([`operations/nexus.ts`](../../packages/contracts/src/operations/nexus.ts), 711 LOC) | Pending |
| D3 | T977 | orchestrate | 39 | 0 | Complete ([`operations/orchestrate.ts`](../../packages/contracts/src/operations/orchestrate.ts), 199 LOC) | Pending |
| D4 | T978 | tasks | 79 | 0 | Complete ([`operations/tasks.ts`](../../packages/contracts/src/operations/tasks.ts), 22 params) | Pending |
| D5 | T979 | memory + conduit | 88 + 10 | 0 | Complete ([`operations/brain.ts`](../../packages/contracts/src/operations/brain.ts) 31 params; [`operations/conduit.ts`](../../packages/contracts/src/operations/conduit.ts)) | Pending |
| D6 | T980 | sticky + docs + intelligence | 18 + 13 + 5 | 0 | **Missing** — contracts MUST be authored first | Pending |
| D7 | T981 | pipeline | 69 | 0 | **Partial** — extend [`operations/release.ts`](../../packages/contracts/src/operations/release.ts) + [`operations/lifecycle.ts`](../../packages/contracts/src/operations/lifecycle.ts) | Pending |
| D8 | T982 | check | 58 | 0 | **Partial** — contracts live in [`validate.ts`](../../packages/contracts/src/validate.ts) | Pending |
| D9 | T983 | admin | 107 | 0 | **Missing** — break into `admin.audit` / `admin.token` / `admin.snapshot` sub-contracts | Pending |

**Totals**: 579 casts → 0 across 9 migrations.

> **Note**: Wave D migrations (T975-T983) have been **deferred to a separate
> epic (T988) for v2026.4.98 per operator decision**. This specification
> documents the plan; the migrations themselves land in the follow-on epic.
> T974 shipped the foundation (adapter module + 13 tests); T986 (this doc)
> ships the authority-level contract for how T988 MUST execute.

### 5.1 Ordering rationale

The wave order in the table above is intentional:

1. **D1-D5 land first** because their contracts already exist (audit §Section 4
   Option A "Incremental migration" ordering). These waves can proceed in
   parallel because they touch disjoint files.
2. **D6-D9 require contract authoring first**. Agents executing these waves
   MUST land the missing `@cleocode/contracts/src/operations/*.ts` file in a
   preceding commit, with its own tests, before touching the dispatch handler.
3. **D9 (admin) is last** because it is the largest (107 casts) and because
   the `admin` domain currently mixes 4+ sub-areas (`audit`, `token`, `snapshot`,
   `smoke`) that SHOULD be split into separate contract files before migration
   to keep each PR reviewable.

---

## 6. Migration Template (per-domain instructions)

This section shows exactly how ONE domain migration MUST be performed. The
session domain is used as the worked example because its contract is complete
and it has the fewest casts (31).

### 6.1 Step 1 — author the ops record

Add a new file `packages/cleo/src/dispatch/domains/session-typed.ts` alongside
the existing [`session.ts`](../../packages/cleo/src/dispatch/domains/session.ts):

```typescript
import type {
  SessionStartParams, SessionStartResult,
  SessionStatusParams, SessionStatusResult,
  // ... see §4 for full imports
} from '@cleocode/contracts';

export type SessionOps = {
  readonly 'session.start':  readonly [SessionStartParams,  SessionStartResult];
  readonly 'session.status': readonly [SessionStatusParams, SessionStatusResult];
  // ... one tuple per op
};
```

### 6.2 Step 2 — build the handler via `defineTypedHandler`

```typescript
import { defineTypedHandler, lafsError, lafsSuccess } from '../adapters/typed.js';
import { sessionStart, sessionStatus /* ... */ } from '../lib/engine.js';
import { getProjectRoot } from '@cleocode/core';
import type { SessionOps } from './session-typed.js';

export const sessionHandler = defineTypedHandler<SessionOps>('session', {
  'session.start': async (params) => {
    const result = await sessionStart(getProjectRoot(), params);
    return lafsSuccess(result, 'session.start');
  },
  'session.status': async (_params) => {
    const result = await sessionStatus(getProjectRoot());
    return lafsSuccess(result, 'session.status');
  },
  // ... one entry per op
});
```

### 6.3 Before/After code comparison

The legacy handler at
[`domains/session.ts:74-92`](../../packages/cleo/src/dispatch/domains/session.ts)
(`session.show` case) demonstrates the anti-pattern:

**Before** (legacy `DomainHandler`, casts at every field):

```typescript
async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
  switch (operation) {
    case 'show': {
      const sessionId = params?.sessionId as string;           // cast #1
      if (!sessionId) {
        return errorResult(/*…*/ 'sessionId is required', /*…*/);
      }
      const include = params?.include as string | undefined;    // cast #2
      if (include === 'debrief') {
        const result = await sessionDebriefShow(projectRoot, sessionId);
        return wrapResult(result, 'query', 'session', operation, startTime);
      }
      const result = await sessionShow(projectRoot, sessionId);
      return wrapResult(result, 'query', 'session', operation, startTime);
    }
  }
}
```

**After** (typed handler, zero casts):

```typescript
'session.show': async (params) => {                               // params: SessionShowParams
  const { sessionId, include } = params;                          // both narrowed
  if (include === 'debrief') {
    const result = await sessionDebriefShow(getProjectRoot(), sessionId);
    return lafsSuccess(result, 'session.show');
  }
  const result = await sessionShow(getProjectRoot(), sessionId);
  return lafsSuccess(result, 'session.show');
}
```

Net change: two `as T` casts removed, presence-check replaced by compile-time
guarantee (contract declares `sessionId: string` as required), one envelope
helper swapped (`wrapResult` → `lafsSuccess`).

### 6.4 Step 3 — wire the typed handler to the registry

The registry MUST route the op through `typedDispatch`. In the interim migration
window, the dispatcher MAY wrap the typed handler in a legacy bridge adapter
that implements `DomainHandler` (audit §Section 4 Option A "Incremental
migration"):

```typescript
// temporary bridge during per-domain rollout
class TypedBridge<O extends TypedOpRecord> implements DomainHandler {
  constructor(private typed: TypedDomainHandler<O>) {}
  async query(op: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const fullOp = `${this.typed.domain}.${op}` as keyof O & string;
    const envelope = await typedDispatch(this.typed, fullOp, params);
    return lafsToDispatchResponse(envelope, /*…*/);
  }
  // ... mutate(), getSupportedOperations()
}
```

Once all 9 migrations complete (T975-T983), the bridge MUST be removed and
`DomainHandler` MAY be deprecated (see §9 open question 4).

### 6.5 Step 4 — delete legacy handler and remove casts

The per-domain task MUST end with:
- Legacy handler file deleted (or reduced to a `TypedBridge` wrapper).
- All `params?.x as Y` casts in the domain removed.
- `grep -rE "params\?.\w+ as " packages/cleo/src/dispatch/domains/<domain>.ts`
  returns zero results.
- Test suite green.
- `pnpm biome check --write .` clean.

### 6.6 Constraints on migrating agents

Per CLEO agent quality rules
([`AGENTS.md`](../../AGENTS.md)), each migration:

1. MUST NOT use `any` or `unknown` as shortcut types.
2. MUST NOT use `as unknown as X` casting chains.
3. MUST NOT mock or inline types — import from `@cleocode/contracts`.
4. MUST add TSDoc on exported symbols.
5. MUST run `pnpm biome check --write . && pnpm run build && pnpm run test`
   before complete.

---

## 7. Runtime Validation (Phase 2)

This specification covers **Phase 1** — compile-time narrowing only. Runtime
validation (zod schemas parsing `rawParams` at the boundary) is a planned
follow-up epic, explicitly out of scope for T962.

### 7.1 Phase 1 scope (T974 / T988)

- Single-point compile-time cast at [`typed.ts:163`](../../packages/cleo/src/dispatch/adapters/typed.ts).
- Handlers declare `TypedOpRecord` backed by contract types.
- `tsc --noEmit` catches drift between contract and handler at build time.
- **No runtime guard** — `rawParams` of the wrong shape reaches the handler
  and MAY produce a runtime error downstream.

### 7.2 Phase 2 scope (separate follow-on epic)

Phase 2 MUST be a separate epic (tentatively T989+) and is explicitly **NOT**
part of T962. It layers zod schemas on top of the Phase 1 adapter:

```typescript
// future (Phase 2)
export async function typedDispatch<O extends TypedOpRecord, K extends keyof O & string>(
  handler: TypedDomainHandler<O>,
  op: K,
  rawParams: unknown,
): Promise<LafsEnvelope<O[K][1]>> {
  const schema = OpSchemas[handler.domain][op];
  const parsed = schema.safeParse(rawParams);
  if (!parsed.success) {
    return lafsError('E_VALIDATION', parsed.error.message, `${handler.domain}.${op}`);
  }
  return handler.operations[op](parsed.data);
}
```

This shape is documented in the `Future` comment at
[`typed.ts:150-161`](../../packages/cleo/src/dispatch/adapters/typed.ts) —
the adapter is designed to accept this change as a localized edit inside one
function.

**Phase 2 additional scope** (beyond the adapter itself):
- Zod schemas MUST be generated from contracts (tooling choice is open; see §9).
- All Studio HTTP handlers (see
  [`CLEO-STUDIO-HTTP-SPEC.md`](./CLEO-STUDIO-HTTP-SPEC.md))
  MUST validate request bodies via the same schemas — currently zero input
  validation, a known security gap.
- `@cleocode/contracts` MUST be republished with the schema exports on a major
  version bump.

Phase 2 is **out of scope for this spec**. Deferring runtime validation is
documented as a conscious trade-off in audit §Section 4 Option A
("Ship A now to kill drift at compile time, then layer C on top for runtime
hardening").

---

## 8. Testing Strategy

### 8.1 Adapter-layer tests (shipped with T974)

The adapter test suite at
[`packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts)
contains 13 tests covering five categories:

| Category | Tests | Lines |
|---|---:|---|
| Compile-time narrowing (via `@ts-expect-error` fixtures) | 2 | [`typed.test.ts:86-133`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts) |
| Runtime success path | 3 | [`typed.test.ts:139-185`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts) |
| `defineTypedHandler` shape | 2 | [`typed.test.ts:191-213`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts) |
| `lafsSuccess` / `lafsError` envelope structure | 5 | [`typed.test.ts:219-284`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts) |
| `TypedOpRecord` constraint | 1 | [`typed.test.ts:290-301`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts) |

The `@ts-expect-error` lines at
[`typed.test.ts:121-130`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts)
are the compile-time gate: if generic inference loosens, the build fails.
This suite MUST NOT be deleted during per-domain migrations.

### 8.2 Per-domain migration tests

Each migration task (T975-T983) MUST add:

1. **Shape assertion**: a compile-time test that asserts the typed handler's
   output matches the contract's `Result` shape. Example:
   ```typescript
   const result: SessionStartResult = await typedDispatch(sessionHandler, 'session.start', {
     scope: 'global',
   } satisfies SessionStartParams).then(env => {
     if (env.success) return env.data;
     throw new Error('unreachable');
   });
   ```
2. **Parity test**: a runtime test that dispatches through the legacy
   `dispatcher.dispatch()` entry point and asserts the typed handler produces
   the same envelope as the legacy handler for a representative input.
3. **Negative assertion**: a `@ts-expect-error` line confirming the handler
   rejects malformed params at compile time.

### 8.3 End-to-end tests

The existing parity tests at
[`packages/cleo/src/dispatch/__tests__/parity.test.ts`](../../packages/cleo/src/dispatch/__tests__/parity.test.ts)
verify the registry ↔ OPERATIONS alignment. Per-domain migrations MUST NOT
reduce parity coverage; if a migration changes the wire shape, the contract
and parity test MUST be updated atomically in the same PR (audit §Section 4
Option A "Testing strategy").

### 8.4 CI enforcement

Post-migration, a `forge-ts` rule (see
[`docs/specs/CORE-PACKAGE-SPEC.md`](./CORE-PACKAGE-SPEC.md) for forge-ts
integration pattern) SHOULD fail the build if any `params?.\w+ as ` pattern
appears under `packages/cleo/src/dispatch/domains/`. This rule MUST land in
the final Wave D task (T983 or a follow-up gate task) and gate regressions.

---

## 9. Open Questions for Follow-on Epic T988

These questions were raised in audit §Section 6 and remain unresolved at
the time of this spec. The T988 epic MUST answer them before Wave D-x
migrations ship:

1. **Atomic zod adoption vs incremental per-domain?** Do we gate T988 on
   adopting zod across all domains at once (Option C atomic), or ship
   compile-time typing domain-by-domain first and layer zod on afterwards
   (Option A then C — recommended by audit §Section 4)?

2. **Auto-generate zod schemas from TS types, or hand-author?** Tooling
   choices include `ts-to-zod`, `drizzle-zod`'s `createInsertSchema` pattern
   (already in use elsewhere in the monorepo, see the `drizzle-orm` skill),
   or custom codegen from `@cleocode/contracts`. Each has different trade-offs
   for maintenance and drift detection.

3. **Studio HTTP handler validation.** Currently zero input validation on
   Studio routes (see
   [`CLEO-STUDIO-HTTP-SPEC.md`](./CLEO-STUDIO-HTTP-SPEC.md)).
   Should T988 extend validation to the HTTP boundary, or is that a separate
   Studio-focused epic? Audit §Section 5 flags this as a known security gap.

4. **`DomainHandler` deprecation policy** (audit §Section 6 question 4).
   Once all 14 handlers migrate:
   - (a) Remove the legacy interface outright.
   - (b) Keep it forever as a back-compat shim for external plugins.
   - (c) Mark it `@deprecated` with a target removal version.
   The choice affects external consumers that may have embedded the canonical
   domain handlers.

5. **`DispatchRequest.params` generic parameter.** Currently typed as
   `Record<string, unknown>` at
   [`types.ts:92`](../../packages/cleo/src/dispatch/types.ts). Once handlers
   are typed, should `DispatchRequest` become generic
   `DispatchRequest<P = Record<string, unknown>>`? Impacts middleware surface
   across [`packages/cleo/src/dispatch/middleware/`](../../packages/cleo/src/dispatch/middleware/).

6. **`as Parameters<typeof coreFn>[0]` anti-pattern** (audit §Section 2
   Category A1, 10 sites). These tie dispatch to internal core signatures. Do
   we:
   - (a) Export new `Parameters` types from contracts (fast, mirrors current).
   - (b) Refactor the core fn signatures to match contracts (correct, larger).

7. **Missing contracts for `sticky`, `docs`, `intelligence`**
   (audit §Section 1 table). T988 scope MUST either include authoring these
   contracts or gate Waves D6-D9 on a preceding contracts epic.

---

## 10. References

### 10.1 Code SSoT

- **Adapter module**:
  [`packages/cleo/src/dispatch/adapters/typed.ts`](../../packages/cleo/src/dispatch/adapters/typed.ts)
  (285 LOC, T974 commit `16f29c3a8` on 2026-04-18)
- **Adapter tests**:
  [`packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts`](../../packages/cleo/src/dispatch/adapters/__tests__/typed.test.ts)
  (301 LOC, 13 tests)
- **Registry**:
  [`packages/cleo/src/dispatch/registry.ts`](../../packages/cleo/src/dispatch/registry.ts)
  (operation registration; source of `op` validity that `typedDispatch` trusts)
- **Dispatch types**:
  [`packages/cleo/src/dispatch/types.ts`](../../packages/cleo/src/dispatch/types.ts)
  (`CANONICAL_DOMAINS`, `DomainHandler`, `DispatchRequest`, `DispatchResponse`)
- **CLI adapter**:
  [`packages/cleo/src/dispatch/adapters/cli.ts`](../../packages/cleo/src/dispatch/adapters/cli.ts)
  (dispatchFromCli entry point; parallel adapter that sits at the other boundary)
- **Contracts**:
  [`packages/contracts/src/operations/`](../../packages/contracts/src/operations/)
  — per-domain typed `*Params` / `*Result` interfaces
- **LAFS envelope**:
  [`packages/contracts/src/lafs.ts`](../../packages/contracts/src/lafs.ts)
  — `LafsEnvelope<T>`, `LafsSuccess<T>`, `LafsError`

### 10.2 Authority documents

- [`docs/specs/CLEO-API-AUTHORITY.md`](./CLEO-API-AUTHORITY.md) — pointer
  document naming the Code SSoT files that this adapter bridges.
- [`docs/specs/CORE-PACKAGE-SPEC.md`](./CORE-PACKAGE-SPEC.md) — style model
  for this spec; defines the `@cleocode/core` contract the dispatch layer
  consumes.
- [`docs/specs/SCHEMA-AUTHORITY.md`](./SCHEMA-AUTHORITY.md) — parallel
  authority pointer for the DB schema layer.
- [`docs/specs/CLEO-OPERATION-CONSTITUTION.md`](./CLEO-OPERATION-CONSTITUTION.md)
  — full op catalogue; each op listed there has (or will have) a matching
  entry in a `TypedOpRecord`.

### 10.3 Evidence trail

- [`\.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md`](../../.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md)
  — T910 audit that quantified the 579 casts and laid out Options A/B/C.
- [`\.cleo/adrs/ADR-051-evidence-based-gates.md`](../../.cleo/adrs) —
  evidence-based completion gate used to verify each migration.

### 10.4 Commits

| Commit | Task | Date | Description |
|---|:---:|---|---|
| [`16f29c3a8`](https://github.com/cleocode/cleocode/commit/16f29c3a8) | T974 | 2026-04-18 | `feat(dispatch): T974 — TypedDomainHandler + typedDispatch adapter` |
| [`0cb9f1100`](https://github.com/cleocode/cleocode/commit/0cb9f1100) | T962 | 2026-04-18 | `chore(T962): straggler cleanup — blank-line + test docstring + lockfile sync` |

---

*End of spec.*

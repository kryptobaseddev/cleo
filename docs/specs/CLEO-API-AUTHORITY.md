# CLEO API Authority

**Version**: 2.0.0
**Status**: AUTHORITY — pointer document, cite on disagreement
**Scope**: All CLEO dispatch operations, HTTP surfaces, and wire-format contracts
**Style model**: `docs/specs/SCHEMA-AUTHORITY.md`
**Target release**: v2026.4.97 (T962 Wave A+B+D0)

This document defines the authority chain for the CLEO API. When any other
document disagrees with the sources listed here, the sources win. This file is
itself a pointer — it does NOT duplicate content from the canonical sources; it
tells you where to look and in what order.

> **Normative language**: Requirements in this document use RFC 2119 terms
> (MUST, MUST NOT, SHOULD, MAY). Every factual claim carries a
> `file:line` citation.

> **Companion specs**:
> - `docs/specs/CLEO-TASKS-API-SPEC.md` — narrative spec for the TASKS domain
> - `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` — current + proposed HTTP surface
> - `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` — Studio `/tasks` UI contract
> - `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — per-op reference tables

---

## 1. Authority Chain

```
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 · CODE SSoT (binding)                                              │
│   packages/contracts/src/operations/*.ts     ← wire-format types           │
│   packages/contracts/src/{brain,conduit,lafs,task,session,...}.ts ← shapes │
│   packages/cleo/src/dispatch/registry.ts     ← runtime op registration     │
│   packages/cleo/src/dispatch/domains/*.ts    ← dispatch handlers (LAFS)    │
│   packages/cleo/src/dispatch/adapters/typed.ts ← TypedDomainHandler<O>     │
│   packages/brain/src/                         ← @cleocode/brain (T969)     │
│                                                                            │
│   RULE: when code and docs disagree, code wins.                            │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 2 · POINTER (this file)                                              │
│   docs/specs/CLEO-API-AUTHORITY.md                                         │
│                                                                            │
│   RULE: names files, not facts. Update when a new layer-1 file or layer-3  │
│   narrative spec lands.                                                    │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 3 · NARRATIVE SPECS (human-readable, cite code)                      │
│   docs/specs/CLEO-TASKS-API-SPEC.md          ← per-domain                  │
│   docs/specs/CLEO-STUDIO-HTTP-SPEC.md        ← HTTP surface                │
│   docs/specs/CLEO-TASK-DASHBOARD-SPEC.md     ← UI-level contract           │
│   docs/specs/CLEO-OPERATION-CONSTITUTION.md  ← full op catalogue           │
│   docs/specs/CLEO-NEXUS-ARCHITECTURE.md      ← NEXUS                       │
│   docs/specs/memory-architecture-spec.md     ← memory (brain.db)           │
│   docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md   ← CONDUIT IPC                 │
│                                                                            │
│   RULE: narrative MUST cite the Layer-1 file:line for every factual claim. │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 4 · AUTO-GENERATED                                                   │
│   docs/generated/typescript-api.md  (renamed from api-reference.md)        │
│     — forge-ts dump of TypeScript exports; NOT a dispatch op catalogue     │
│   docs/generated/llms-full.txt · llms.txt · SKILL-monorepo/                │
│                                                                            │
│   RULE: never hand-edit. Regenerate via forge-ts. See §6 for rename.       │
└────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Files | Authority | Update path |
|-------|-------|-----------|-------------|
| 1 — Code SSoT | `packages/contracts/src/operations/*.ts`, `packages/cleo/src/dispatch/registry.ts`, `packages/cleo/src/dispatch/domains/*.ts`, `packages/cleo/src/dispatch/adapters/typed.ts`, `packages/brain/src/` | Binding | Code change + tests |
| 2 — Pointer | `docs/specs/CLEO-API-AUTHORITY.md` (this file) | Non-binding | PR when a Layer-1 or Layer-3 file lands |
| 3 — Narrative | `docs/specs/CLEO-*-SPEC.md`, `CLEO-OPERATION-CONSTITUTION.md` | Non-binding; cites Layer 1 | PR after Layer-1 change |
| 4 — Generated | `docs/generated/typescript-api.md`, `llms-full.txt`, `SKILL-monorepo/` | Non-binding; regenerated | `forge-ts` CI job |

---

## 2. Domain Directory

Every CLEO operation lives at an intersection of (contract file, implementation,
dispatch domain handler, HTTP route prefix, narrative spec). The table below is
the single map from domain to all five.

The canonical domain set is defined at
`packages/cleo/src/dispatch/types.ts:54-70` and contains **15 domains** as of
T964 (v2026.4.97). CONDUIT was promoted from `orchestrate.conduit.*` subops to
a first-class domain in commit `90534e50c`, superseding ADR-042 Decision 1.
A 16th domain slot — `brain` — is RESERVED for the unified-graph super-domain
(T968 contracts shipped; dispatch wire-up is PLANNED, see §2.2).

Citations use absolute paths rooted at the monorepo.

### 2.1 Shipped domains (15 canonical)

| Domain | Contract file | Implementation | Dispatch domain handler | HTTP route prefix | Narrative spec |
|--------|---------------|----------------|-------------------------|-------------------|----------------|
| **tasks** | `packages/contracts/src/operations/tasks.ts` | `packages/core/src/tasks/` | `packages/cleo/src/dispatch/domains/tasks.ts` | `/api/tasks/*` (Studio, read-only today) | `docs/specs/CLEO-TASKS-API-SPEC.md` |
| **session** | `packages/contracts/src/operations/session.ts` | `packages/core/src/sessions/` | `packages/cleo/src/dispatch/domains/session.ts` | *(none)* — PROPOSED `/api/sessions/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.2 |
| **memory** | `packages/contracts/src/operations/memory.ts` (31 ops, renamed from `brain.ts` per T965 at commit `7413b6562`) | `packages/core/src/memory/` | `packages/cleo/src/dispatch/domains/memory.ts` | `/api/brain/*` today — PLANNED `/api/memory/*` per T970 (see §5) | `docs/specs/memory-architecture-spec.md` + `docs/specs/stdp-wire-up-spec.md` |
| **check** | `packages/contracts/src/operations/validate.ts` | `packages/core/src/validation/` | `packages/cleo/src/dispatch/domains/check.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.11 + `docs/specs/T832-gate-integrity-spec.md` |
| **pipeline** | `packages/contracts/src/operations/release.ts` + `operations/lifecycle.ts` | `packages/core/src/release/` + `packages/cleo/src/dispatch/engines/release-engine.ts` | `packages/cleo/src/dispatch/domains/pipeline.ts` (lifecycle + release route here) | *(none)* | `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` + `docs/specs/T832-gate-integrity-spec.md` |
| **orchestrate** | `packages/contracts/src/operations/orchestrate.ts` | `packages/core/src/orchestration/` + `packages/cleo/src/dispatch/domains/orchestrate.ts` | `packages/cleo/src/dispatch/domains/orchestrate.ts` | *(none)* — PROPOSED `/api/orchestrate/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.6 + `docs/adr/ADR-052-sdk-consolidation.md` + `docs/adr/ADR-053-playbook-runtime.md` |
| **tools** | `packages/contracts/src/operations/skills.ts` + `operations/issues.ts` + `operations/research.ts` | `packages/skills/`, `packages/core/src/issues/`, `packages/core/src/research/` | `packages/cleo/src/dispatch/domains/tools.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.7-6.8 + §6.12 |
| **admin** | `packages/contracts/src/operations/system.ts` | `packages/core/src/system/` | `packages/cleo/src/dispatch/domains/admin.ts` | `/api/health` (partial) | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.10 |
| **nexus** | `packages/contracts/src/operations/nexus.ts` (22 ops, T963) | `packages/nexus/src/` | `packages/cleo/src/dispatch/domains/nexus.ts` | `/api/nexus/*` + `/api/search` (Studio, read) + `/api/project/*` (Studio, CLI-backed write) | `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` |
| **sticky** | *(shape types only)* | `packages/core/src/sticky/` | `packages/cleo/src/dispatch/domains/sticky.ts` | *(none)* | `docs/specs/STICKY-NOTES-SPEC.md` |
| **intelligence** | *(undocumented in Constitution)* | `packages/cleo/src/dispatch/domains/intelligence.ts` | `packages/cleo/src/dispatch/domains/intelligence.ts` | *(none)* | *(none)* |
| **diagnostics** | *(shape types only)* | `packages/core/src/diagnostics/` | `packages/cleo/src/dispatch/domains/diagnostics.ts` | *(none)* | *(none)* |
| **docs** | *(shape types only)* | `packages/core/src/docs/` | `packages/cleo/src/dispatch/domains/docs.ts` | *(none)* | *(none — PROPOSED)* |
| **playbook** | `packages/contracts/src/playbook.ts` | `packages/playbooks/` | `packages/cleo/src/dispatch/domains/playbook.ts` | *(none)* | `docs/adr/ADR-053-playbook-runtime.md` |
| **conduit** | `packages/contracts/src/operations/conduit.ts` (5 ops) + `packages/contracts/src/conduit.ts` | `packages/core/src/conduit/` | `packages/cleo/src/dispatch/domains/conduit.ts` (promoted T964, commit `90534e50c`) | *(none)* | `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` |

### 2.2 Reserved / planned

| Domain | Contract file | Implementation | Dispatch status | HTTP route prefix |
|--------|---------------|----------------|-----------------|-------------------|
| **brain** (unified-graph super-domain) | `packages/contracts/src/operations/brain.ts` (8 ops, T968 at commit `62bcdc25e`) | `packages/brain/src/` (T969, extracted from `packages/studio/src/lib/server/living-brain/`) | PLANNED — no registry entries yet; the 8 ops today are served by the `/api/living-brain/*` SvelteKit routes as a separate HTTP surface | `/api/living-brain/*` today — PLANNED `/api/brain/*` per T971 |

The 8 BRAIN ops defined at `packages/contracts/src/operations/brain.ts`:

| Op | Params type | Location |
|----|-------------|----------|
| `brain.query` | `BrainQueryParams` | `brain.ts:211` |
| `brain.node` | `BrainNodeParams` | `brain.ts:253` |
| `brain.substrate` | `BrainSubstrateParams` | `brain.ts:293` |
| `brain.stream` | `BrainStreamParams` | `brain.ts:385` |
| `brain.bridges` | `BrainBridgesParams` | `brain.ts:429` |
| `brain.neighborhood` | `BrainNeighborhoodParams` | `brain.ts:472` |
| `brain.search` | `BrainSearchParams` | `brain.ts:532` |
| `brain.stats` | `BrainStatsParams` | `brain.ts:587` |

**Cross-references (sibling Node IDs are substrate-prefixed** —
`"task:T949"`, `"memory:O-abc"`, `"nexus:pkg/file.ts::Symbol"`; see
`packages/contracts/src/operations/brain.ts:62-79`).

---

## 3. BRAIN vs memory — Terminology

The distinction between BRAIN and memory MUST be preserved in all new
documentation; the two have been conflated historically and this is the
single-line disambiguation.

- **BRAIN** (super-domain) = unified cross-substrate graph. Wraps
  `memory + nexus + tasks + conduit + signaldock` into a single super-graph.
  Served at `/api/brain/*` (post-T971 rename; today at `/api/living-brain/*`).
  Implemented in `@cleocode/brain` (`packages/brain/src/`, T969). Wire-format
  contracts at `packages/contracts/src/operations/brain.ts:1-32` (8 ops).

- **memory** (subdomain of BRAIN) = cognitive memory store: observations,
  patterns, decisions, learnings, references + memory tiers
  (`short | medium | long`). Served at `/api/memory/*` (planned post-T970
  rename; today at `/api/brain/*` as the legacy name of the memory tables
  endpoint). Implemented in `packages/core/src/memory/` (lifecycle, retrieval,
  search, STDP, consolidator, plasticity) + `packages/core/src/store/memory-*.ts`
  (renamed from `store/brain-*.ts` per T966 at commit `d4ef8be47`).
  Wire-format contracts at `packages/contracts/src/operations/memory.ts` (31
  ops; renamed from `operations/brain.ts` per T965 at commit `7413b6562`).

- **"Deferred"** (Studio UI label) = `status='cancelled'` epics projected to
  the UI. It is NOT a DB field; the column remains `status` on the
  `tasks` table. Rename the label to "Cancelled epics" pending a UI polish
  task (out of scope for T984).

### Citations for the taxonomy

| Claim | Source |
|-------|--------|
| memory subdomain lives in `packages/core/src/memory/` | `.cleo/agent-outputs/T910-reconciliation/brain-memory-reconciliation.md` §7 |
| memory has 31 ops | `packages/contracts/src/operations/memory.ts:1-6` (header TSDoc) |
| BRAIN super-domain has 8 ops | `packages/contracts/src/operations/brain.ts:1-4` (header TSDoc) |
| BRAIN substrates are `memory | nexus | tasks | conduit | signaldock` | `packages/contracts/src/operations/brain.ts:50` |
| BRAIN today lives under `/api/living-brain/*` | `packages/studio/src/routes/api/living-brain/{+server.ts,node/[id],stream,substrate/[name]}` |
| memory today lives under `/api/brain/*` (legacy name) | `packages/studio/src/routes/api/brain/{observations,decisions,graph,quality,tier-stats}/+server.ts` |
| Node IDs are substrate-prefixed | `packages/contracts/src/operations/brain.ts:62-79` |
| `@cleocode/brain` is extracted from `packages/studio/src/lib/server/living-brain/` | Commit `725fc4231` (T969) |
| memory command file renamed to `memory.ts` | Commit `85c9be327` (T967) — `packages/cleo/src/cli/commands/memory.ts` |

---

## 4. `@cleocode/brain` Package

As of T969 (commit `725fc4231`), the BRAIN super-graph machinery has been
extracted into a standalone workspace package. Before T969, the substrate
adapters, the `LBNode`/`LBEdge`/`LBGraph` types, and the `getAllSubstrates()`
merger lived inside `packages/studio/src/lib/server/living-brain/`. They now
live in `packages/brain/src/` and `@cleocode/studio` consumes them via a
`workspace:*` dependency.

### 4.1 Package metadata

- **Name**: `@cleocode/brain` (`packages/brain/package.json:2`)
- **Version**: `2026.4.96` (`packages/brain/package.json:3`) — shipping as
  `2026.4.97` with T962 close.
- **Description**: "CLEO unified-graph Brain substrate — BRAIN + NEXUS +
  TASKS + CONDUIT + SIGNALDOCK projection" (`packages/brain/package.json:6`)
- **Exports**: root + `./adapters` (`packages/brain/package.json:9-18`)
- **Dependencies**: `@cleocode/contracts` only (`packages/brain/package.json:50-52`)
- **Studio wire**: `@cleocode/brain: "workspace:*"`
  (`packages/studio/package.json:18`)

### 4.2 Five substrates

Every request against the BRAIN super-domain runs five per-substrate adapters
in parallel and merges their outputs via substrate-prefixed IDs:

| Substrate | Adapter source | DB |
|-----------|----------------|-----|
| `memory` | `packages/brain/src/adapters/brain.ts` (projects `brain.db` typed memory tables) | `.cleo/brain.db` |
| `nexus` | `packages/brain/src/adapters/nexus.ts` | `~/.local/share/cleo/nexus.db` (global) |
| `tasks` | `packages/brain/src/adapters/tasks.ts` | `.cleo/tasks.db` |
| `conduit` | `packages/brain/src/adapters/conduit.ts` | `.cleo/conduit.db` |
| `signaldock` | `packages/brain/src/adapters/signaldock.ts` | `~/.local/share/cleo/signaldock.db` (global) |

> **Note on the substrate-name collision.** The `memory` substrate name in
> `BrainSubstrateName` (`packages/contracts/src/operations/brain.ts:50`)
> refers to the **brain.db-backed memory store**, distinct from the `memory`
> dispatch domain (§2). This matches the T965 rename and is documented in
> `packages/contracts/src/operations/brain.ts:41-48`.

Full architecture audit: `.cleo/agent-outputs/T910-reconciliation/living-brain-architecture.md`
(including the 27-test bridge synthesis coverage, SSE stream events, and the
5 cross-substrate edge mechanisms).

---

## 5. Dispatch Adapter Layer — `TypedDomainHandler<O>`

The legacy `DomainHandler` interface accepts `Record<string, unknown>` params
on every operation. The T910 audit
(`.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md`) enumerated
**579** `params?.foo as string` casts across 14 domain handlers — latent
schema drift with zero compile-time enforcement against the typed `*Params`
contracts that already live in `packages/contracts/src/operations/`.

### 5.1 The adapter (T974)

Commit `16f29c3a8` introduced `packages/cleo/src/dispatch/adapters/typed.ts`,
a single-point cast boundary that bridges typed per-op contracts and the
untyped registry surface.

The module exports four primitives:

| Export | Purpose | Source |
|--------|---------|--------|
| `TypedOpRecord` | `Record<string, readonly [Params, Result]>` — op-map generic | `adapters/typed.ts:66` |
| `TypedDomainHandler<O>` | Typed handler interface (domain + per-op fn map) | `adapters/typed.ts:88-98` |
| `typedDispatch<O, K>` | Single-cast bridge from `unknown` → `O[K][0]` | `adapters/typed.ts:135-164` |
| `defineTypedHandler<O>` | Convenience builder | `adapters/typed.ts:190-195` |
| `lafsSuccess` / `lafsError` | LAFS envelope constructors for typed handlers | `adapters/typed.ts:231-272` |

The cast on `adapters/typed.ts:163` is the **documented trust boundary**: the
registry upstream guarantees `op` exists on the handler; the contracts package
defines the typed Params shape. Every downstream call site sees the narrowed
`O[K][0]` type.

### 5.2 Scope — this module MUST NOT

- Replace `DomainHandler` (handler migrations are Wave D, T975-T983, and are a
  separate epic).
- Perform runtime validation. Runtime zod schemas layered on top of this
  module are a follow-up (see `adapters/typed.ts:150-162` for the documented
  placeholder).

### 5.3 Migration status

| Wave | Scope | Status |
|------|-------|--------|
| Wave A (T963) | Resync contract↔impl drift (5 sampled ops fixed) | SHIPPED — commit `0119a6518` |
| Wave B (T965-T969) | File renames, new contracts, `@cleocode/brain` extraction | SHIPPED — see §3-4 |
| Wave D0 (T974) | `TypedDomainHandler` + `typedDispatch` foundation | SHIPPED — commit `16f29c3a8` |
| Wave D1-D3 (T975-T983) | Per-domain handler migrations + zod runtime guard | PLANNED — follow-up epic |
| T970 | `/api/brain/*` → `/api/memory/*` HTTP rename | PLANNED |
| T971 | `/api/living-brain/*` → `/api/brain/*` HTTP rename | PLANNED |

---

## 6. How to Add a New Operation

This is the authority walk-through. Every contributor MUST follow it in this
order.

### Step 1 — Author the contract

Edit the domain's contract file under `packages/contracts/src/operations/`.
Add a `{OpName}Params` and `{OpName}Result` type pair. Reuse existing shared
types from `packages/contracts/src/status-registry.ts`, `task.ts`, `session.ts`,
`brain.ts`, etc. — never redeclare.

```ts
// packages/contracts/src/operations/tasks.ts
export interface TasksFooBarParams {
  taskId: string;
  flavor?: 'plain' | 'spicy';
}
export interface TasksFooBarResult {
  task: TaskOp;
  sideEffects: string[];
}
```

Re-export from `packages/contracts/src/operations/index.ts` if that domain is
already barrel-exported. Do NOT introduce a new operation type without tests.

### Step 2 — Implement the core logic

Write the pure business function in `packages/core/src/<domain>/<op>.ts`. Core
MUST be transport-agnostic: no envelopes, no HTTP, no argv. It accepts the
`*Params` shape and returns the `*Result` shape (or throws a domain error).

### Step 3 — Register in the dispatch domain

Add the handler in `packages/cleo/src/dispatch/domains/<domain>.ts`. Wire it
into `packages/cleo/src/dispatch/registry.ts` under the correct
`CANONICAL_DOMAINS` entry with `{ name, tag: 'query' | 'mutate', gateway,
tier, requiredParams }`. Registry is the binding SSoT for op existence.

New handlers SHOULD use the `TypedDomainHandler<O>` pattern (§5.1) for
compile-time enforcement against the typed `*Params` contracts; legacy
handlers MAY continue to implement the untyped `DomainHandler` interface
during the Wave D migration window.

### Step 4 — (Optional) Expose via HTTP

If the operation should be reachable over the wire, add a handler in
`packages/studio/src/routes/api/<domain>/<op>/+server.ts`. Per
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §4, handlers MUST be thin adapters that
call the same Dispatcher used by the CLI. This guarantees the HTTP response
envelope is identical to the CLI response envelope (LAFS).

**Route prefix discipline** (post T962):

| Domain | Canonical HTTP prefix | Notes |
|--------|----------------------|-------|
| `memory` | `/api/memory/*` (planned T970) | Legacy `/api/brain/*` routes remain until the rename ships |
| `brain` (super-graph) | `/api/brain/*` (planned T971) | Today at `/api/living-brain/*` |
| `tasks` | `/api/tasks/*` | read-only today |
| `nexus` | `/api/nexus/*` + `/api/search` + `/api/project/*` | |
| `conduit` | *(none)* — CLI only | |

### Step 5 — Document in the narrative spec

Add one row to the relevant per-domain table in
`docs/specs/CLEO-<DOMAIN>-API-SPEC.md`:

- CLI verb
- HTTP verb + path (or `(CLI only)`)
- Request type (`{OpName}Params`)
- Response type (`{OpName}Result`)
- Error codes (from `packages/contracts/src/exit-codes.ts`)
- Idempotent? (Y/N + reason)
- One-line description

If the operation crosses an ADR gate (e.g. ADR-051 evidence),
cite the ADR file:line on the same row.

Update `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.x op table. Constitution
entries MUST match the registry. See §8 for the drift gate.

---

## 7. Envelopes and Errors

All CLEO operations MUST return LAFS envelopes
(`packages/contracts/src/lafs.ts:52-299`). The shape is:

```ts
// Success
{ success: true, data: T, _meta?: { gateway, domain, durationMs, ... } }
// Error
{ success: false, error: { code, category, message, fix?, details? }, _meta? }
```

HTTP callers derive status code from `error.code` via the mapping in
`packages/contracts/src/exit-codes.ts` + `docs/specs/CLEO-STUDIO-HTTP-SPEC.md`
§3. Canonical pairs:

| CLI ExitCode | HTTP status | Meaning |
|--------------|-------------|---------|
| `SUCCESS` (0) | 200 / 201 | OK |
| `NO_DATA` (100), `NO_CHANGE` (102) | 200 | idempotent no-op |
| `NOT_FOUND` (4) | 404 | |
| `PARENT_NOT_FOUND` (10), `SESSION_NOT_FOUND` (31) | 404 | |
| `INVALID_INPUT` (2), `VALIDATION_ERROR` (6), `INVALID_GATE` (42) | 400 | |
| `LIFECYCLE_GATE_FAILED` (80), `AUDIT_MISSING` (81) | 422 | |
| `HAS_CHILDREN` (16), `HAS_DEPENDENTS` (19), `TASK_CLAIMED` (35) | 409 | |
| `LOCK_TIMEOUT` (7) | 423 (Locked) | |
| `NEXUS_PERMISSION_DENIED` (72) | 403 | |
| other | 500 | |

ExitCode name MUST always be echoed into `error.code` so REST callers map
identically to CLI callers.

Evidence atoms (`commit:`, `files:`, `tool:`, `test-run:`, `note:`,
`url:`) for gate verification are specified in
`docs/specs/T832-gate-integrity-spec.md` (ADR-051 normative).

---

## 8. SSoT Drift Detection

The Constitution (`docs/specs/CLEO-OPERATION-CONSTITUTION.md`) is human-
maintained but derived from `packages/cleo/src/dispatch/registry.ts`. Drift is
inevitable unless enforced.

**Existing controls:**

- `packages/cleo/src/__tests__/` — runtime registry tests verify every registry
  entry has a contract counterpart.
- Constitution file itself states "When conflicts exist between this document
  and the registry, the registry wins." (`CLEO-OPERATION-CONSTITUTION.md:14`).
- T963 (commit `0119a6518`) resynced 5 sampled ops where contract drifted
  from implementation (`tasks.create`, `tasks.update`, `orchestrate.spawn`,
  `brain.observe` → `memory.observe`, `nexus.context`).

**Proposed drift gate (not yet shipped — @HITL):**

- CI check that walks `CANONICAL_DOMAINS` in
  `packages/cleo/src/dispatch/types.ts:54-70`, extracts op names per domain,
  and compares against:
  - Constitution §6.x op tables (warn on mismatch, fail on missing)
  - Narrative per-domain specs (warn on mismatch)
  - `docs/specs/CLEO-API-AUTHORITY.md` §2 (warn on new domain not listed)

Ticket: `@HITL` Q1 — owner confirmation on severity (warn vs fail) and
tolerance window ("re-sync within 7 days of registry change").

---

## 9. Generated Artifacts — Naming and Rename Notice

### Rename: `api-reference.md` → `typescript-api.md`

The file at `/mnt/projects/cleocode/docs/generated/api-reference.md` (3.1 MB,
128,485 lines, last regenerated 2026-04-06) is **not** a dispatch API
reference. It is a forge-ts dump of TypeScript exports across all 15 packages.
None of the canonical Tasks ops, memory ops, BRAIN ops, or NEXUS ops appear in
it by their dispatch name.

Keeping the file under the name `api-reference.md` is misleading. Action per
T910:

1. Rename `docs/generated/api-reference.md` → `docs/generated/typescript-api.md`.
2. Rename sibling `api-reference.mdx` → `typescript-api.mdx`.
3. Update `docs/generated/llms.txt` to point at the new paths.
4. Regenerate on the next forge-ts run (currently stale as of 2026-04-17).

The Constitution remains the human-readable op catalogue. The new
`typescript-api.md` name correctly advertises its content.

### Generated files inventory (for auditability)

Per `docs/CLEO-DOCUMENTATION-SOP.md:19-28`, generated content lives under
`docs/generated/`:

| File | Kind | Generator | Update cadence |
|------|------|-----------|----------------|
| `docs/generated/typescript-api.md` | TS export dump | forge-ts | CI on merge to main |
| `docs/generated/typescript-api.mdx` | MDX variant | forge-ts | same |
| `docs/generated/llms-full.txt` | LLM context | forge-ts | same |
| `docs/generated/llms.txt` | index pointer | forge-ts | same |
| `docs/generated/packages/*/api/{functions,types,examples,index}.mdx` | per-package TS API | forge-ts | same |
| `docs/generated/SKILL-monorepo/{SKILL.md,references/*.md}` | skill surface | forge-ts | same |

**None of these are Layer-1 SSoT.** They are downstream of the code layer and
never authoritative on op contracts.

---

## 10. ADR Cross-References

### Superseded

- `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` — **SUPERSEDED-BY
  T962 / T964** (v2026.4.97). Decision 1 (fold `conduit` under `orchestrate` to
  preserve a 10-domain invariant) was a rule-enforcement patch, not a
  semantic decision. The invariant had already lapsed (count reached 14 with
  `intelligence`, `diagnostics`, `docs`, `playbook`); CONDUIT is now
  domain #15 at `packages/cleo/src/dispatch/types.ts:69`. Full rationale:
  `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md`.

### Binding

- `docs/adr/ADR-051-programmatic-gate-integrity.md` (T832) — evidence atoms
  for gate verification; `cleo verify --all` without `--evidence` is REJECTED
  with `E_EVIDENCE_MISSING`.
- `docs/adr/ADR-052-sdk-consolidation.md` — SDK-backed spawn providers
  (Claude Agent SDK, OpenAI Agents SDK, LangGraph).
- `docs/adr/ADR-053-playbook-runtime.md` — playbook DSL runtime and
  `playbook` domain.

### Pending (authored after T962 Wave A+B+D0 ships)

- **ADR-054 — CONDUIT as canonical domain #15**. Formalizes the T964
  supersession of ADR-042 Decision 1. Draft rationale lives in
  `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md` §4.
- **ADR-055 — `@cleocode/brain` package + BRAIN vs memory taxonomy**.
  Formalizes T965/T968/T969 together: the `operations/brain.ts` →
  `operations/memory.ts` rename, the new `operations/brain.ts` super-domain
  contracts, and the `@cleocode/brain` extraction. Draft rationale lives in
  `.cleo/agent-outputs/T910-reconciliation/brain-memory-reconciliation.md` and
  `.cleo/agent-outputs/T910-reconciliation/living-brain-architecture.md`.

---

## 11. Relationship to Other Authorities

- `docs/specs/SCHEMA-AUTHORITY.md` owns storage-layer SSoT (DB schemas,
  migrations, status enums).
- `docs/specs/VERB-STANDARDS.md` owns verb canonicalisation.
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` owns the per-op summary tables
  for every canonical domain.
- `docs/specs/CLEO-API-AUTHORITY.md` (this file) owns the **authority chain**
  and **domain directory** — who is SSoT for what.

When editing any of these, the others MUST be re-read for consistency.

---

## 12. Contributor Checklist

Before marking API work complete:

- [ ] Contract types in `packages/contracts/src/operations/<domain>.ts` exist
  and are re-exported from `index.ts`.
- [ ] Dispatch registration in `packages/cleo/src/dispatch/registry.ts` lists
  the op with correct tag / gateway / tier / requiredParams.
- [ ] Dispatch handler in `packages/cleo/src/dispatch/domains/<domain>.ts`
  returns a LAFS envelope via `packages/lafs/`. New handlers SHOULD use
  `TypedDomainHandler<O>` (§5.1).
- [ ] `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.x table updated.
- [ ] Per-domain narrative spec (if it exists) updated with a new row.
- [ ] `docs/specs/CLEO-API-AUTHORITY.md` domain directory entry updated if a
  new row is needed.
- [ ] Tests added: unit + dispatch registration assertions.
- [ ] HTTP handler (if exposed) added to `docs/specs/CLEO-STUDIO-HTTP-SPEC.md`
  §2 endpoint table.
- [ ] `pnpm run build && pnpm run test && pnpm biome check --write .` green.

---

## References

- `packages/cleo/src/dispatch/registry.ts` — executable dispatch SSoT
- `packages/cleo/src/dispatch/types.ts:54-70` — CANONICAL_DOMAINS (15 entries)
- `packages/cleo/src/dispatch/adapters/typed.ts` — TypedDomainHandler + typedDispatch (T974)
- `packages/contracts/src/operations/` — per-domain wire types
  (`brain.ts`, `conduit.ts`, `index.ts`, `issues.ts`, `lifecycle.ts`,
  `memory.ts`, `nexus.ts`, `orchestrate.ts`, `params.ts`, `release.ts`,
  `research.ts`, `session.ts`, `skills.ts`, `system.ts`, `tasks.ts`,
  `validate.ts`)
- `packages/contracts/src/lafs.ts` — envelope contract
- `packages/contracts/src/exit-codes.ts` — error → status mapping source
- `packages/brain/` — `@cleocode/brain` unified-graph package (T969)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — derived per-op tables
- `docs/specs/SCHEMA-AUTHORITY.md` — companion, storage-layer authority
- `docs/specs/VERB-STANDARDS.md` — verb canonicalisation (ADR-017)
- `docs/CLEO-DOCUMENTATION-SOP.md` — docs organisation SOP
- `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` (SUPERSEDED)
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- `docs/adr/ADR-052-sdk-consolidation.md`
- `docs/adr/ADR-053-playbook-runtime.md`
- T910 evidence base: `.cleo/agent-outputs/T910-reconciliation/`
  - `brain-memory-reconciliation.md`
  - `conduit-collision-research.md`
  - `dispatch-cast-audit.md`
  - `living-brain-architecture.md`
  - `type-safety-audit.md`
- T910 docs-audit base: `.cleo/agent-outputs/T910-docs-audit/`
  - `api-docs-inventory.md`
  - `http-endpoint-inventory.md`
  - `task-schema-audit.md`
  - `studio-tasks-ui-audit.md`
  - `studio-tasks-architecture.md`

### T962 shipped commits (feat/t942-sentient-foundations → v2026.4.97)

| Commit | Task | Title |
|--------|------|-------|
| `0119a6518` | T963 | Resync contract↔impl drift (5 ops fixed) |
| `7413b6562` | T965 | `operations/brain.ts` → `operations/memory.ts` |
| `85c9be327` | T967 | `memory-brain.ts` CLI command → `memory.ts` |
| `d4ef8be47` | T966 | `store/brain-*.ts` → `store/memory-*.ts` importers |
| `90534e50c` | T964 | Promote CONDUIT to domain #15 (supersedes ADR-042) |
| `62bcdc25e` | T968 | `operations/brain.ts` — 8 unified-graph BRAIN ops |
| `725fc4231` | T969 | Extract `@cleocode/brain` from studio/living-brain |
| `16f29c3a8` | T974 | `TypedDomainHandler` + `typedDispatch` adapter |
| `0cb9f1100` | T962 | Straggler cleanup — blank-line + test docstring + lockfile sync |

---

## Open Questions (HITL)

- **Q1**: Drift-gate severity and window — should the CI check be warn-only,
  warn-with-7-day-window, or fail-closed?
- **Q2**: `/api/brain/*` → `/api/memory/*` and `/api/living-brain/*` →
  `/api/brain/*` route renames (T970/T971): ship atomically with a deprecation
  window, or flip in one release? External Studio consumers would see breakage.
- **Q3**: Wave D1-D3 ordering for `TypedDomainHandler` migration — session +
  nexus + tasks first (typed contracts already published), then memory,
  then admin (the 107-cast flagship)?
- **Q4**: ADR-054 / ADR-055 authorship — gate them on T984 close, or fold
  rationale into a single combined ADR?

---

**End.** Report new issues via `cleo issues create bug --title "..."` and
link to this file.

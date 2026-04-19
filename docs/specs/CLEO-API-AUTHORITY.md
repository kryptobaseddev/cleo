# CLEO API Authority

**Version**: 1.0.0
**Status**: AUTHORITY — pointer document, cite on disagreement
**Scope**: All CLEO dispatch operations, HTTP surfaces, and wire-format contracts
**Style model**: `docs/specs/SCHEMA-AUTHORITY.md`

This document defines the authority chain for the CLEO API. When any other
document disagrees with the sources listed here, the sources win. This file is
itself a pointer — it does NOT duplicate content from the canonical sources; it
tells you where to look and in what order.

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
│   docs/specs/memory-architecture-spec.md     ← BRAIN                       │
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
| 1 — Code SSoT | `packages/contracts/src/operations/*.ts`, `packages/cleo/src/dispatch/registry.ts`, `packages/cleo/src/dispatch/domains/*.ts` | Binding | Code change + tests |
| 2 — Pointer | `docs/specs/CLEO-API-AUTHORITY.md` (this file) | Non-binding | PR when a Layer-1 or Layer-3 file lands |
| 3 — Narrative | `docs/specs/CLEO-*-SPEC.md`, `CLEO-OPERATION-CONSTITUTION.md` | Non-binding; cites Layer 1 | PR after Layer-1 change |
| 4 — Generated | `docs/generated/typescript-api.md`, `llms-full.txt`, `SKILL-monorepo/` | Non-binding; regenerated | `forge-ts` CI job |

---

## 2. Domain Directory

Every CLEO operation lives at an intersection of (contract file, implementation,
dispatch domain handler, HTTP route prefix, narrative spec). The table below is
the single map from domain to all five.

Citations use absolute paths rooted at the monorepo.

| Domain | Contract file | Implementation | Dispatch domain handler | HTTP route prefix | Narrative spec |
|--------|---------------|----------------|-------------------------|-------------------|----------------|
| **tasks** | `packages/contracts/src/operations/tasks.ts` | `packages/core/src/tasks/` (38 files) | `packages/cleo/src/dispatch/domains/tasks.ts` | `/api/tasks/*` (Studio, read-only today) | `docs/specs/CLEO-TASKS-API-SPEC.md` |
| **session** | `packages/contracts/src/operations/session.ts` | `packages/core/src/sessions/` | `packages/cleo/src/dispatch/domains/session.ts` | *(none)* — PROPOSED `/api/sessions/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.2 |
| **orchestrate** | `packages/contracts/src/operations/orchestrate.ts` | `packages/core/src/orchestration/` + `packages/cleo/src/dispatch/domains/orchestrate.ts` | `packages/cleo/src/dispatch/domains/orchestrate.ts` | *(none)* — PROPOSED `/api/orchestrate/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.6 + `docs/adr/ADR-052-sdk-consolidation.md` + `docs/adr/ADR-053-playbook-runtime.md` |
| **lifecycle** | `packages/contracts/src/operations/lifecycle.ts` | `packages/core/src/lifecycle/` | `packages/cleo/src/dispatch/domains/pipeline.ts` (lifecycle routes here historically) | *(none)* | `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` + `docs/specs/T832-gate-integrity-spec.md` |
| **release** | `packages/contracts/src/operations/release.ts` | `packages/core/src/release/` + `packages/cleo/src/dispatch/engines/release-engine.ts` | `packages/cleo/src/dispatch/domains/pipeline.ts` | *(none)* | `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` |
| **research** | `packages/contracts/src/operations/research.ts` | `packages/core/src/research/` | *(routed through `docs.ts` / `tools.ts`)* | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.7 |
| **skills** | `packages/contracts/src/operations/skills.ts` | `packages/skills/` | `packages/cleo/src/dispatch/domains/tools.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.8 |
| **system** | `packages/contracts/src/operations/system.ts` | `packages/core/src/system/` | `packages/cleo/src/dispatch/domains/admin.ts` | `/api/health` (partial) | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.10 |
| **validate / check** | `packages/contracts/src/operations/validate.ts` | `packages/core/src/validation/` | `packages/cleo/src/dispatch/domains/check.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.11 + `docs/specs/T832-gate-integrity-spec.md` |
| **issues** | `packages/contracts/src/operations/issues.ts` | `packages/core/src/issues/` | `packages/cleo/src/dispatch/domains/tools.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.12 |
| **sticky** | *(shape types only)* | `packages/core/src/sticky/` | `packages/cleo/src/dispatch/domains/sticky.ts` | *(none)* | `docs/specs/STICKY-NOTES-SPEC.md` |
| **docs** | *(shape types only)* | `packages/core/src/docs/` | `packages/cleo/src/dispatch/domains/docs.ts` | *(none)* | *(none — PROPOSED)* |
| **BRAIN (memory)** | `packages/contracts/src/brain.ts`, `memory.ts` — **NO** `operations/brain.ts` yet | `packages/core/src/memory/` | `packages/cleo/src/dispatch/domains/memory.ts` | `/api/brain/*` (Studio, read-only, direct SQL) | `docs/specs/memory-architecture-spec.md` + `docs/specs/stdp-wire-up-spec.md` |
| **CONDUIT** | `packages/contracts/src/conduit.ts` — NO dispatch ops (IPC only) | `packages/core/src/conduit/` | `packages/cleo/src/dispatch/domains/conduit.ts` *(limited surface per ADR-042)* | *(none)* | `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` |
| **NEXUS** | `packages/contracts/src/code-symbol.ts`, `graph.ts` — **NO** `operations/nexus.ts` yet | `packages/nexus/src/` | `packages/cleo/src/dispatch/domains/nexus.ts` | `/api/nexus/*` + `/api/search` (Studio, read) + `/api/project/*` (Studio, CLI-backed write) | `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` |
| **intelligence** | *(undocumented in Constitution)* | `packages/cleo/src/dispatch/domains/intelligence.ts` | `packages/cleo/src/dispatch/domains/intelligence.ts` | *(none)* | *(none)* |
| **playbook** | `packages/contracts/src/playbook.ts` | `packages/playbooks/` | `packages/cleo/src/dispatch/domains/playbook.ts` | *(none)* | `docs/adr/ADR-053-playbook-runtime.md` |
| **signaldock / agents** | `packages/contracts/src/agent-registry.ts`, `agent-registry-record.ts` | `packages/agents/`, `packages/cleo-os/` | *(no dispatch domain — CLI-only via admin)* | partial via `/api/living-brain?substrate=signaldock` | `docs/concepts/SIGNALDOCK-PROTOCOL.md` (if exists) |

**Open gaps** (flagged for follow-up; see §6 "Contract gaps"):

- MISSING: `packages/contracts/src/operations/brain.ts`, `conduit.ts`, `nexus.ts`.
- MISSING: narrative specs for `docs`, `intelligence`, `signaldock`, `sticky` beyond what currently exists.
- DRIFT RISK: `packages/cleo/src/dispatch/registry.ts` vs Constitution §6 op tables — see §5.

---

## 3. How to Add a New Operation

This is the authority walk-through. Every contributor MUST follow it in this
order.

### Step 1 — Author the contract

Edit the domain's contract file under `packages/contracts/src/operations/`.
Add a `{OpName}Params` and `{OpName}Result` type pair. Reuse existing shared
types from `packages/contracts/src/status-registry.ts`, `task.ts`, `session.ts`,
etc. — never redeclare.

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

### Step 4 — (Optional) Expose via HTTP

If the operation should be reachable over the wire, add a handler in
`packages/studio/src/routes/api/<domain>/<op>/+server.ts`. Per
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §4, handlers MUST be thin adapters that
call the same Dispatcher used by the CLI. This guarantees the HTTP response
envelope is identical to the CLI response envelope (LAFS). A shared helper
`dispatchAsHttp(gateway, domain, op, params)` is PROPOSED to centralise the
`ExitCode` → HTTP status mapping.

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
entries MUST match the registry. See §5 for the drift gate.

---

## 4. Envelopes and Errors

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
`docs/specs/T832-gate-integrity-spec.md`.

---

## 5. SSoT Drift Detection

The Constitution (`docs/specs/CLEO-OPERATION-CONSTITUTION.md`) is human-
maintained but derived from `packages/cleo/src/dispatch/registry.ts`. Drift is
inevitable unless enforced.

**Existing controls:**

- `packages/cleo/src/__tests__/` — runtime registry tests verify every registry
  entry has a contract counterpart.
- Constitution file itself states "When conflicts exist between this document
  and the registry, the registry wins." (`CLEO-OPERATION-CONSTITUTION.md:14`).

**Proposed drift gate (not yet shipped — @HITL):**

- CI check that walks `CANONICAL_DOMAINS` in
  `packages/cleo/src/dispatch/registry.ts`, extracts op names per domain,
  and compares against:
  - Constitution §6.x op tables (warn on mismatch, fail on missing)
  - Narrative per-domain specs (warn on mismatch)
  - `docs/specs/CLEO-API-AUTHORITY.md` §2 (warn on new domain not listed)

Ticket: `@HITL` Q1 — owner confirmation on severity (warn vs fail) and
tolerance window ("re-sync within 7 days of registry change").

---

## 6. Generated Artifacts — Naming and Rename Notice

### Rename: `api-reference.md` → `typescript-api.md`

The file at `/mnt/projects/cleocode/docs/generated/api-reference.md` (3.1 MB,
128,485 lines, last regenerated 2026-04-06) is **not** a dispatch API
reference. It is a forge-ts dump of TypeScript exports across all 13 packages.
None of the 22 canonical Tasks ops, none of the 18 BRAIN ops, none of the 28+
NEXUS ops appear in it by their dispatch name.

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

## 7. Relationship to Other Authorities

- `docs/specs/SCHEMA-AUTHORITY.md` owns storage-layer SSoT (DB schemas,
  migrations, status enums).
- `docs/specs/VERB-STANDARDS.md` owns verb canonicalisation.
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` owns the per-op summary tables
  for every canonical domain.
- `docs/specs/CLEO-API-AUTHORITY.md` (this file) owns the **authority chain**
  and **domain directory** — who is SSoT for what.

When editing any of these, the others MUST be re-read for consistency.

---

## 8. Contributor Checklist

Before marking API work complete:

- [ ] Contract types in `packages/contracts/src/operations/<domain>.ts` exist
  and are re-exported from `index.ts`.
- [ ] Dispatch registration in `packages/cleo/src/dispatch/registry.ts` lists
  the op with correct tag / gateway / tier / requiredParams.
- [ ] Dispatch handler in `packages/cleo/src/dispatch/domains/<domain>.ts`
  returns a LAFS envelope via `packages/lafs/`.
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
- `packages/contracts/src/operations/` — per-domain wire types (12 files)
- `packages/contracts/src/lafs.ts` — envelope contract
- `packages/contracts/src/exit-codes.ts` — error → status mapping source
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — derived per-op tables
- `docs/specs/SCHEMA-AUTHORITY.md` — companion, storage-layer authority
- `docs/specs/VERB-STANDARDS.md` — verb canonicalisation (ADR-017)
- `docs/CLEO-DOCUMENTATION-SOP.md` — docs organisation SOP
- `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md`
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- `docs/adr/ADR-052-sdk-consolidation.md`
- `docs/adr/ADR-053-playbook-runtime.md`
- T910 evidence base: `.cleo/agent-outputs/T910-docs-audit/`
  - `api-docs-inventory.md`
  - `http-endpoint-inventory.md`
  - `task-schema-audit.md`
  - `studio-tasks-ui-audit.md`
  - `studio-tasks-architecture.md`

---

## Open Questions (HITL)

- **Q1**: Drift-gate severity and window — should the CI check be warn-only,
  warn-with-7-day-window, or fail-closed?
- **Q2**: Should `packages/contracts/src/operations/brain.ts`, `conduit.ts`,
  and `nexus.ts` be authored to close the gap, or do those domains remain
  contract-less (shape types only)?
- **Q3**: Is the old ADR-053 at `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md`
  vs the new ADR-053 at `docs/adr/ADR-053-playbook-runtime.md` a renumber?
  (Flagged in `.cleo/agent-outputs/T910-docs-audit/api-docs-inventory.md` §5 Q5.)

---

**End.** Report new issues via `cleo issues create bug --title "..."` and
link to this file.

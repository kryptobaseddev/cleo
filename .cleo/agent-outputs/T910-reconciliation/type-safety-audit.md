# T910 Cross-Cutting Type Safety Audit

**Audit date**: 2026-04-17
**Mandate**: ZERO latent schema-drift across the codebase.
**Scope**: All 14 packages under `packages/` (excluding `.d.ts`, `dist/`, test files).
**Auditor**: Security Engineer (threat-model framing: latent drift = runtime contract violation vector).

---

## Executive Summary

The codebase is **substantially more type-safe than expected**: zero `: any` type usages in source (all apparent hits are comments). However, **latent drift is concentrated in two specific patterns**:

1. **Dispatch handlers** (`packages/cleo/src/dispatch/domains/*.ts`) use `params?.X as Y` to cast an unvalidated `Record<string, unknown>` into typed engine arguments. **579 such casts** — the single largest drift surface. This bypasses every contract in `packages/contracts/`.
2. **JSON.parse with type assertion** (126 sites) where runtime data is cast to a TS type without zod/ajv validation. 245 `JSON.parse` calls in `core` alone; 87 of those casted.

**Critical finding**: 5/5 sampled operations showed contract-implementation drift. Contracts in `packages/contracts/src/operations/*.ts` are **stale** relative to live code (orchestrate.spawn is missing `protocolType` and `tier`; tasks.create is missing `type`, `acceptance`, `phase`, `size`, `notes`, `files`, `dryRun`, `parentSearch`).

---

## Section 1: Quantification Dashboard

Per-package type-safety markers in **source files only** (test/dist/.d.ts excluded):

| Package       | `:any` | `:unknown` | ` as T` casts | `Record<string,unknown>` | JSON.parse | JSON.parse-cast | `as unknown as` |
|---------------|--------|------------|---------------|--------------------------|------------|-----------------|-----------------|
| contracts     | 0      | 26         | 3             | 27                       | 0          | 0               | 0               |
| core          | 0*     | 176        | 620           | 539                      | 245        | 87              | 35              |
| cleo          | 0*     | 239        | 471           | 401                      | 49         | 15              | 3               |
| studio        | 0*     | 8          | 114           | 13                       | 21         | 3               | 2               |
| adapters      | 0      | 18         | 23            | 34                       | 20         | 5               | 1               |
| playbooks     | 0      | 15         | 18            | 31                       | 1          | 1               | 2               |
| cant          | 0      | 21         | 29            | 23                       | (uncounted)| 0               | 0               |
| caamp         | 0      | 42         | 93            | 98                       | 21         | 6               | 2               |
| runtime       | 0      | 0          | 0             | 0                        | 0          | 0               | 0               |
| nexus         | 0      | 31         | 64            | 7                        | 2          | 0               | 9               |
| lafs          | 0      | 51         | 61            | 122                      | 3          | 0               | 4               |
| cleo-os       | 0*     | 13         | 28            | 31                       | 13         | 9               | 1               |
| agents        | 0      | 0          | 0             | 0                        | 0          | 0               | 0               |
| skills        | 0      | 0          | 0             | 6                        | 0          | 0               | 0               |
| **TOTAL**     | **0**  | **640**    | **1,544**     | **1,332**                | **375**    | **126**         | **59**          |

*Note: `: any` grep reported `1` for several packages, but manual inspection confirmed ALL are comment substrings ("any error", "any task", "any ready task"). Zero actual `any` type annotations in production source. This is a **positive** finding.

**Zod validation presence**:
- `contracts`: 115 uses (operation schemas)
- `core`: 70 uses
- `studio`: 0 uses (**critical gap** — all HTTP handlers unvalidated)
- `adapters`, `cleo`, all others: 0 uses

**Evidence commands** reproducing these numbers:
```bash
# any (false positives only)
grep -rnE ":\s*any(\s|[,;>)\[])" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".d.ts" | grep -vE "\.test\.ts|\.spec\.ts"
# 579 dispatch casts
grep -rnE "params\?\.[a-zA-Z_]+ as " packages/cleo/src/dispatch/domains --include="*.ts" | wc -l
# 97 Drizzle .all() as X casts
grep -rn "\.all()\s*as\s" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".d.ts" | grep -vE "\.test\.ts|\.spec\.ts" | wc -l
```

---

## Section 2: Top 10 Hotspot Files

Ranked by total count of `any|unknown|cast|Record<string,unknown>`:

| Rank | Count | File | Purpose | Risk |
|------|-------|------|---------|------|
| 1 | 115 | `packages/cleo/src/cli/index.ts` | CLI bootstrap, argv parsing | Low — boundary code |
| 2 | 72  | `packages/cleo/src/dispatch/engines/system-engine.ts` | System operations engine | **High** — untyped SQL row shapes |
| 3 | 55  | `packages/cleo/src/cli/commands/nexus.ts` | Nexus CLI command | Med — `metaJson as string` casts |
| 4 | 43  | `packages/cleo/src/dispatch/engines/task-engine.ts` | Task domain engine | **High** — runtime drift risk |
| 5 | 41  | `packages/cleo/src/dispatch/engines/release-engine.ts` | Release orchestration | Med — operates on pkg.json |
| 6 | 37  | `packages/core/src/config.ts` | Config file parsing | Med — should use zod |
| 7 | 36  | `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | Orchestrate engine | **High** — touches spawn contract |
| 8 | 36  | `packages/cleo/src/cli/renderers/system.ts` | Output rendering | Low — display-only |
| 9 | 36  | `packages/cleo/src/cli/commands/memory-brain.ts` | Memory commands | Med |
| 10 | 34 | `packages/cant/src/bundle.ts` | CANT DSL bundle loader | Med |

**Pattern**: 7 of the top 10 are in `packages/cleo/src/` (dispatch + commands). This is where the drift concentrates. **`core` has more total casts (620) but they are spread across ~200 files — thin and mostly legitimate DB adapter code.**

---

## Section 3: Contract ⇔ Implementation Drift Findings

### Sample 1: `TasksCreateParams` vs `taskCreate()` — **SEVERE DRIFT**

Contract (`packages/contracts/src/operations/tasks.ts:160-168`):
```typescript
export interface TasksCreateParams {
  title: string;
  description: string;
  parent?: string;
  depends?: string[];
  priority?: TaskPriority;
  labels?: string[];
}
```

Dispatch (`packages/cleo/src/dispatch/domains/tasks.ts:278-294`) accepts **8 additional undocumented fields**:
- `type`, `acceptance`, `phase`, `size`, `notes`, `files`, `dryRun`, `parentSearch`

**Severity**: High. API consumers reading the contract will omit fields that the implementation requires. Tests pass because tests call the impl directly, not the contract boundary.

### Sample 2: `TasksUpdateParams` vs `taskUpdate()` — **MODERATE DRIFT**

Contract declares all update fields including `addLabels`, `removeLabels`, etc. Dispatch adds:
- `acceptance` (missing from contract)
- `pipelineStage` (missing from contract — T834 / ADR-051 decision 4)

**Severity**: Medium. Contract predates recent lifecycle work.

### Sample 3: `BrainObserveParams` vs `memoryObserve()` — **MOSTLY ALIGNED**

Contract fields: `text`, `title`, `type`, `project`, `sourceSessionId`, `sourceType`, `agent`, `sourceConfidence`, `attachmentRefs`, `crossRef`.

Dispatch (`packages/cleo/src/dispatch/domains/memory.ts:561-600`) consumes: same 8 fields + inline `attach` parsing (comma-string → string[]). Contract uses `attachmentRefs: string[]`, dispatch also accepts string shorthand `attach`.

**Severity**: Low-Medium. Contract correct, but dispatch layer adds an undocumented `attach` alias. Also: `sourceConfidence` and `crossRef` from contract are **dropped** by dispatch handler — not forwarded to `memoryObserve`. Silent data loss.

### Sample 4: `NexusContextParams` vs `nexus context` impl — **CONTRACT MISSING**

**`packages/contracts/src/operations/nexus.ts` has no `NexusContextParams` type at all.** The CLI command at `packages/cleo/src/cli/commands/nexus.ts:1162-1450` and its dispatcher operate entirely on an un-contracted surface. 55 casts in that file alone.

**Severity**: Severe. The contract package claims to be SSoT. Nexus context/impact/clusters/flows are absent.

### Sample 5: `OrchestrateSpawnParams` vs `orchestrateSpawn()` — **SEVERE DRIFT**

Contract (`packages/contracts/src/operations/orchestrate.ts:132-147`):
```typescript
export interface OrchestrateSpawnParams {
  taskId: string;
  skill?: string;
  model?: string;
}
```

Implementation (`packages/cleo/src/dispatch/engines/orchestrate-engine.ts`):
```typescript
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
)
```

**None of `skill`, `model` exist in the engine. None of `protocolType`, `tier` exist in the contract.** Contract is 100% misaligned with reality. T882 (v2026.4.85) shipped the tier system but never updated the contract.

**Severity**: Severe. This is exactly the kind of drift the operator mandated zero-tolerance for.

### Summary of 5/5 samples

| Sample | Status | Severity |
|--------|--------|----------|
| tasks.create | Mismatch (8 missing fields) | High |
| tasks.update | Mismatch (2 missing fields) | Medium |
| brain.observe | Mostly aligned (2 unused contract fields + 1 undocumented alias) | Low-Medium |
| nexus.context | No contract at all | Severe |
| orchestrate.spawn | Total mismatch (0 field overlap) | Severe |

---

## Section 4: Fix Prioritization Matrix

| Fix Category | Effort | Risk-of-introducing-bugs | Payoff | Priority |
|--------------|--------|--------------------------|--------|----------|
| **Replace `params?.X as Y` with contract-sourced validated parser** | M | Low (behavior preserved if mapping correct) | Eliminates 579 casts + catches every future drift | **P0** |
| **Re-sync contracts with actual implementations** (5/5 sampled ops diverged) | M | Low (docs-level change) | Closes the drift vector permanently | **P0** |
| **Add zod validation to Studio HTTP handlers** | S | Low | Blocks untrusted body injection; currently zero validation | **P0** |
| **Validate JSON.parse at boundary** (126 cast sites) | L | Medium | Removes silent data-shape drift from disk/stdout | P1 |
| **Generate contract types from zod schemas** (single SSoT) | L | Medium | Drift becomes structurally impossible | P1 |
| **Type Drizzle query results** (97 `.all() as X`) | M | Low (drizzle already infers) | Reduces casts; exposes schema changes at compile time | P2 |
| **Replace `Record<string, unknown>` in internal lib functions** (1,332 sites — most are legit envelope shapes) | L | Medium | Marginal; many are LAFS-envelope contract-valid | P3 |

---

## Section 5: Recommended Execution Order

### Step 1 — Publish accurate contracts (P0, effort S, risk Low)
**Files**: `packages/contracts/src/operations/tasks.ts`, `orchestrate.ts`, `nexus.ts`, `brain.ts`.
**Change**: Update each contract to match the current engine signatures exactly.
- `TasksCreateParams`: add `type`, `acceptance`, `phase`, `size`, `notes`, `files`, `dryRun`, `parentSearch`.
- `TasksUpdateParams`: add `acceptance`, `pipelineStage`.
- `OrchestrateSpawnParams`: replace `{taskId, skill, model}` with `{taskId, protocolType, tier}`. Deprecate `skill`/`model` with a changelog note.
- `BrainObserveParams`: add `attach` alias field or remove it from dispatch.
- `nexus.ts`: add `NexusContextParams/Result`, `NexusImpactParams/Result`, `NexusClustersParams/Result`, `NexusFlowsParams/Result`.

**Expected impact**: Zero runtime change. Zero test break. Agents using contracts get accurate surface. Risk: low — pure type-level refinement.

### Step 2 — Generate zod schemas from contracts (P0, effort M, risk Low)
**Files**: add `packages/contracts/src/schemas/*.ts` per operation.
**Change**: Declare `z.object({...})` schema for each `*Params` type, then derive `type X = z.infer<typeof xSchema>` so the type and schema cannot drift.

**Expected impact**: One runtime validator per operation. Dispatch layer can call `schema.parse(params)` instead of 579 hand-rolled casts.

### Step 3 — Dispatch layer validated parser (P0, effort M, risk Low)
**Files**: `packages/cleo/src/dispatch/domains/*.ts` (tasks, memory, orchestrate, nexus, session, conduit).
**Change**: Replace `const x = params?.field as Y` blocks with `const parsed = Schema.parse(params)` from step 2. `parsed.field` is then correctly typed.

**Expected impact**: Removes 579 casts. Bad input fails loudly at dispatch boundary (better error surfaces). Fewer hidden null-prop crashes in engines.

### Step 4 — Studio HTTP body validation (P0, effort S, risk Low)
**Files**: all `packages/studio/src/routes/api/**/+server.ts` that do `await request.json()`. Specifically `project/clean`, `project/scan`, `project/switch`, and any future POST endpoints.
**Change**: Parse body through a zod schema. Return `400 + LAFS envelope` on invalid.

**Expected impact**: Closes an unvalidated-input security hole. Currently an attacker can send any shape and the code trusts it.

### Step 5 — JSON.parse hardening at persistence boundaries (P1, effort L, risk Medium)
**Files**: `packages/core/src/store/*.ts`, `packages/core/src/memory/*.ts`, `packages/core/src/sessions/*.ts`. Focus on the 87 cast sites in `core` first.
**Change**: When reading `*_json` columns, parse through a schema. Use `z.string().transform((s) => schema.parse(JSON.parse(s)))` pattern, or a dedicated `readTypedJson<T>(raw, schema): T` helper in `@cleocode/core/internal`.

**Expected impact**: Detects corrupted DB rows and stale serialization formats. May surface currently-hidden bugs (medium risk). Best rolled out per domain.

---

## Section 6: Open HITL Questions

1. **Contract breaking change policy**: Updating `OrchestrateSpawnParams` from `{taskId, skill, model}` to `{taskId, protocolType, tier}` is technically a breaking API change in `@cleocode/contracts`. Do downstream consumers (external agents) exist that would break? If yes: add a deprecation layer in v2026.4.91 and remove in v2026.5.0. If no: ship directly.

2. **Should `skill` and `model` be re-added to `orchestrate.spawn`?** The existing contract names suggest an intent that was never implemented. Should the engine be extended with skill/model parameters (alignment option A), or should the contract be culled (alignment option B)?

3. **Studio envelope contract**: Studio API currently returns `{tasks, total}` directly, not the LAFS `{success, data, error, meta}` envelope (ADR-039). Is Studio considered "outside" LAFS (browser UI is a different consumer) or should it conform too? T889 orchestration coherence may have answered this — confirming before changing.

4. **JSON.parse scope for P1 hardening**: 126 cast sites span DB rows, config files, session debriefs, and spawn stdin. Do we harden all in one epic (T911?) or per-domain (T911a-tasks, T911b-brain, etc.)? Recommend per-domain to keep blast radius small.

5. **Nexus contract ownership**: Nexus package has its own internal types. Should `packages/contracts/src/operations/nexus.ts` mirror those, or should nexus publish its own operation contracts (and the aggregate contracts package re-export)?

---

## Appendix A — Evidence grep commands

```bash
# Total casts (1,544)
grep -rnE " as [A-Z][A-Za-z]+" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".d.ts" | grep -vE "/(test|tests|__tests__)/" | grep -v "\.test\.ts" | grep -v "\.spec\.ts" | grep -v "as const" | wc -l

# Dispatch casts (579)
grep -rnE "params\?\.[a-zA-Z_]+ as " packages/cleo/src/dispatch/domains --include="*.ts" | wc -l

# Drizzle .all() casts (97)
grep -rn "\.all()\s*as\s" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".d.ts" | wc -l

# JSON.parse with type cast (126)
grep -rn "JSON.parse" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -vE "/(test|tests|__tests__)/" | grep -v "\.test\.ts" | grep -v "\.spec\.ts" | grep -E " as [A-Z]| as Record" | wc -l

# Studio zod usage (0)
grep -rn "z\.\(object\|string\|safeParse\)" packages/studio --include="*.ts" | grep -v node_modules | grep -v dist | grep -vE "\.test\.ts|\.spec\.ts" | wc -l

# : any in source (0 real, all false-positive comments)
grep -rnE ":\s*any(\s|[,;>)\[])" packages/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".d.ts" | grep -vE "\.test\.ts|\.spec\.ts" | grep -v "//\|/\*\|\*" | wc -l
```

## Appendix B — Legitimate unknowns vs problematic

**Legitimate (keep)**:
- Boundary parsers where validation follows: `const parsed: unknown = JSON.parse(raw); const ok = Schema.safeParse(parsed)`
- LAFS envelope `{ data?: unknown }` — type erasure is the whole point of the envelope.
- `Record<string, unknown>` on `params` parameter to `DomainHandler.mutate/query` — this IS the dispatch contract surface; the problem is downstream casts, not the type here.

**Problematic (fix)**:
- `const x = JSON.parse(raw) as SomeType` without post-parse validation (126 sites).
- `const y = params?.X as Y` in engine calls (579 sites).
- `db.prepare(sql).all() as TaskRow[]` in Studio (direct DB-row leakage to HTTP client).
- `as unknown as X` chain casts (59 sites) — always indicates a missing type bridge.

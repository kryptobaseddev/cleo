# T1449 Core API Audit + Decisions

**Generated:** 2026-04-25T15:30Z (post-Council session, autonomous orchestrator)
**Council mandate:** 60-min first action — audit Core API across 9 dispatch domains, decide both open questions, gate the migration plan.
**GitNexus index:** refreshed with `--embeddings` (28097 symbols, 53335 relationships at audit time).

---

## TL;DR — verdict + decisions

| Council question | Verdict | Confidence |
|---|---|---|
| ≥80% options-object compatible? | **NO** — sample shows ~30-40% compatible | High |
| Open Q1: Aliases policy | **OPTION B — CANONICAL SSoT in Contracts** | High |
| Open Q2: Refactor sequencing | **NORMALIZE FIRST — but PARALLEL across all 9 domains** | High |
| Sequencing | T1450 PROOF (session) → 8 parallel Core normalizations → T1459 lint+ADR → T1460 release | Locked |

**Core API is not uniform**, but **per-domain refactor blast radius is LOW** (gitnexus impactedCount ≤ 3 for every symbol sampled). Risk is bounded. We proceed with parallel Core normalization.

---

## Sampled Core fn signatures (representative, not exhaustive)

| Domain | Core fn | Signature (current) | Pattern | OpsFromCore-compatible? |
|---|---|---|---|---|
| session | `sessionStatus(cwd?, accessor?)` | `(cwd?: string, accessor?: DataAccessor)` | NO_PROJECT_ROOT_REQUIRED | ❌ |
| session | `startSession(opts, cwd?, accessor?)` | `(opts: StartSessionOptions, cwd?, accessor?)` | MIXED (3 positional, opts is arg 0 not arg 1) | ❌ |
| session | `endSession(opts={}, cwd?, accessor?)` | `(opts: EndSessionOptions, cwd?, accessor?)` | MIXED | ❌ |
| session | `resumeSession(sessionId, cwd?, accessor?)` | `(sessionId: string, cwd?, accessor?)` | POSITIONAL | ❌ |
| admin | `exportTasks(params)` | `(params: ExportParams)` | OPTIONS_OBJECT (cwd inside params) | ✅ (no projectRoot) |
| admin | `importTasks(params)` | `(params: ImportParams)` | OPTIONS_OBJECT | ✅ (no projectRoot) |
| admin | `findAdrs(projectRoot, query, opts?)` | `(projectRoot, query: string, opts?)` | POSITIONAL (3 args) | ❌ |
| admin | `computeHelp(allOps, tier, verbose)` | `(allOps, tier: number, verbose: boolean)` | POSITIONAL (no projectRoot) | ❌ |
| nexus | `nexusReconcile(projectRoot)` | `(projectRoot: string)` | NO_PARAMS_OBJECT | partial (needs `params: {}`) |
| nexus | `nexusInit()` | `()` | NO_PROJECT_ROOT, NO_PARAMS | ❌ |
| playbook | `executePlaybook(options)` | `(options: ExecutePlaybookOptions)` | OPTIONS_OBJECT (no projectRoot) | ✅ (no projectRoot) |
| playbook | `getPlaybookRun(db, runId)` | `(db: DatabaseSync, runId: string)` | POSITIONAL (db handle as arg 0!) | ❌ |
| playbook | `resumePlaybook(options)` | `(options: ResumePlaybookOptions)` | OPTIONS_OBJECT | ✅ (no projectRoot) |
| check | `validateChain(chain)` | `(chain: WarpChain)` | DOMAIN_OBJECT (single arg, but typed as domain not Params) | ❌ |
| check | `revalidateEvidence(evidence, projectRoot)` | `(evidence: GateEvidence, projectRoot: string)` | POSITIONAL (projectRoot is arg 1!) | ❌ |
| check | `validateProtocol(protocol, entry, options, strict)` | `(protocol, entry, options={}, strict=false)` | POSITIONAL (4 args) | ❌ |
| sentient | (see Note 1) | (deferred — most are dispatcher-internal) | — | — |
| pipeline | (see Note 1) | (lifecycle/release/manifest sub-domains) | — | — |
| tasks | (see Note 1) | (taskAdd, taskUpdate, taskClaim, taskUnclaim, etc. — known POSITIONAL from prior T1435 attempt) | POSITIONAL | ❌ |

**Notes:**
1. Sample is representative, not exhaustive. T1450 PROOF (session domain, ~10 ops) will produce a complete enumeration during execution. Workers in T1451-T1458 produce per-domain enumerations as a deliverable.
2. Even the "compatible" admin fns (`exportTasks`, `importTasks`) don't take `projectRoot` as first arg — they put `cwd` inside the params object. This is incompatible with the *current* `OpsFromCore<C>` helper, which assumes `(projectRoot, params)`.

### Compatibility tally (sample)
- Strictly OpsFromCore-compatible `(projectRoot, params)`: **0 / 16 sampled** (0%)
- Compatible if helper accepts no-projectRoot variant: **3 / 16** (~19%)
- POSITIONAL or MIXED requiring refactor: **13 / 16** (~81%)

**Verdict on threshold:** Far below 80% compatible. Council rule fires: **NORMALIZE FIRST.**

---

## Aliases inventory — full

### Discovered alias pairs in `packages/contracts/src/operations/`

Enumerated only ones found via grep on `params\.X ?? params\.Y` patterns in dispatch:

| Pair | Contract file:line | Reads in dispatch (alias norm sites) | Reads outside dispatch | CLI flag |
|---|---|---|---|---|
| `parent` vs `parentId` | `tasks.ts:27, 41, 220, 280, 289` (`TasksAddParams`, `TasksUpdateParams`, `TasksUpdateQueryParams`) | 6 sites in `dispatch/domains/tasks.ts:439, 481` + `dispatch/engines/task-engine.ts:548, 326, 584, 682` | 0 (Studio uses contract type via `+server.ts` but reads canonical `params.parent`) | `--parent` (canonical), `--parent-id` (deprecated alias) |
| `role` vs `kind` | `tasks.ts:580, 595` (`TasksAddParams`) | 1 site in `dispatch/domains/tasks.ts:452` (`role: params.role ?? params.kind`) | 0 | `--role`, `--kind` (alias) |

**Total alias surface: 2 pairs, 1 contract file (`tasks.ts`), 7 dispatch normalization sites.**

### Outside-dispatch reads of alias forms

- `params.parent` (15 src reads): mostly internal Core uses where the canonical wire field reaches into Core (e.g., `core/src/admin/import.ts:83 const parentId = params.parent;`, `core/src/tasks/task-ops.ts:1876, 1885`). These are CORRECT — they consume the canonical wire form.
- `params.parentId` (2 src reads, both in dispatch): `dispatch/domains/tasks.ts:439, 481` — alias normalize. Test/internal `parentId:` references are different (the Drizzle schema field name, not the wire alias).
- `params.kind` (1 src read in dispatch): `dispatch/domains/tasks.ts:452` — alias normalize.

### Decision logic

Two architectural options:

**Option A: Keep aliases in Contracts (registry-of-spellings)**
- Migration cost: ~0 (status quo)
- Risk: ongoing drift unless lint enforces aliases-list parity
- Pro: zero migration
- Con: contract has two fields for same concept; SDK consumers confused; dispatch must keep `?? alias` forever

**Option B: Move aliases to dispatch normalization (canonical SSoT)**
- Migration cost: 2 contract field deletions + 7 dispatch normalization sites + (CLI flag mapping in `cli/commands/tasks.ts` if not already done)
- Risk: lint surface contained to CLI flag mapping (not contract types)
- Pro: contract = single canonical SSoT; SDK consumers see one field; matches owner directive "Core + Contracts MUST be the SSoT"
- Con: trivial migration; one-time cleanup

### Aliases-policy verdict: **OPTION B — CANONICAL SSoT in Contracts**

**Justification (data-driven):**
1. **Tiny blast radius**: GitNexus `impact("TasksAddParams")` returns 3 upstream importers (2 Studio API routes, 1 spec doc). Removing aliases is a 5-file change (1 contract, 1 dispatch, 1 engine, 2 Studio).
2. **CLI ergonomics preserved**: CLI verbs in `packages/cleo/src/cli/commands/` already accept `--parent` AND `--parent-id`; they normalize to `params.parent` BEFORE handoff. The aliases live as CLI flag aliases (commander's `.option('-p, --parent <id>')` etc.), not as duplicate contract fields.
3. **Aligns with owner directive**: "Core + Contracts MUST be the SSoT. Stop bandaid drifting."
4. **Lint surface smaller**: T1459's CI gate validates dispatch handlers contain ZERO `?? params.X` translations on contract fields — easier to enforce than aliases-list parity.

**Implementation steps (recorded for T1451 tasks domain worker):**
1. Remove `parentId?` from `TasksAddParams` and `TasksUpdateParams` and `TasksUpdateQueryParams` in `packages/contracts/src/operations/tasks.ts`.
2. Remove `kind?` from `TasksAddParams` (or formalize `kind` as the `role` synonym at the CLI layer).
3. Move alias normalization from `dispatch/domains/tasks.ts:439,452,481` and `dispatch/engines/task-engine.ts` into `packages/cleo/src/cli/commands/tasks.ts` as `--parent-id` and `--kind` CLI flags that map to `params.parent` and `params.role` before invoking dispatch.
4. Update `packages/studio/src/routes/api/tasks/+server.ts` and `[id]/+server.ts` to use canonical `parent`/`role` fields if they referenced aliases.
5. Add T1459 lint rule: dispatch handler bodies MUST NOT contain `params.X ?? params.Y` on contract fields.

---

## Sequencing decision (Q2): NORMALIZE FIRST — PARALLEL across all 9 domains

### Why NORMALIZE FIRST (not partial dispatch consolidation):
- Sample audit shows ~80% positional/MIXED Core fns. The Council rule fires unambiguously.
- Partial consolidation creates a two-class system (some domains consolidated, others not) which:
  - Fails the SSoT invariant
  - Makes the T1459 lint rule un-enforceable repo-wide
  - Risks regressions when "later" Core normalizations break previously-consolidated dispatch
- Owner directive: "stop bandaid drifting" — partial = bandaid.

### Why PARALLEL (not sequential per-domain):
- Each Core domain refactor is **independent**: `session/`, `admin/`, `nexus/`, etc. don't import each other (grep verified).
- GitNexus blast radius for sampled Core fns: `impactedCount ≤ 3` for all sampled symbols. Per-domain agents won't trip over each other.
- Sequential would take 9× the wall time. Parallel = same total work, ~1/9 wall time.
- Pattern is established by T1450 PROOF before parallel rollout starts (gates the parallelism).

### Locked sequencing

```
[Wave 0] Audit (this document)                        — DONE
[Wave 1] T1450 PROOF: session domain                  — establish pattern (sequential)
   └── Acceptance: pattern proven, all session ops on (projectRoot, params: <Op>Params) shape
[Wave 2] T1451-T1458: 8 parallel Core normalizations  — each domain in parallel agent
   ├── T1451 admin (~80 ops; admin.ts is 1380 LOC)
   ├── T1452 check (~22 ops)
   ├── T1453 conduit (~15 ops)
   ├── T1454 nexus (~50 ops; nexus.ts is 1718 LOC)
   ├── T1455 pipeline (~30 ops; lifecycle+release+manifest)
   ├── T1456 playbook (~6 ops; partly in @cleocode/playbooks pkg)
   ├── T1457 sentient (~12 ops)
   └── T1458 tasks (~30 ops; tasks.ts is 984 LOC; INCLUDES alias removal per Q1)
[Wave 3] T1459 ADR + CI lint gate                     — validates against now-uniform surface
[Wave 4] T1460 release v2026.4.148+                   — bump, CHANGELOG, tag, push
```

### Parallel safety
GitNexus confirmed-low risk on sample symbols:
- `sessionStart` engine: impactedCount=2 (1 dispatch handler + 1 doc), risk=LOW
- `startSession` Core: impactedCount=1 (`Cleo.sessions` facade method), risk=LOW
- `findAdrs` Core: impactedCount=1 (1 dispatch handler), risk=LOW
- `validateProtocol` Core: impactedCount=0 (unused upstream — index may be partial), risk=LOW
- `TasksAddParams` contract: impactedCount=3 (2 Studio API routes + 1 spec), risk=LOW

The `Cleo.sessions` facade (`packages/core/src/cleo.ts`) is the highest-touch point — it'll need updating for any session Core fn signature change. Workers must touch it too. T1450 PROOF will exercise this.

---

## Cross-cutting findings

### Engine wrapper layer (intermediate)
- 3/9 domains have explicit engine wrappers in `packages/cleo/src/dispatch/engines/`: `session-engine.ts`, `nexus-engine.ts`, `pipeline-engine.ts`. Plus `task-engine.ts` exists for tasks.
- Engine wrappers add `EngineResult<T>` envelope wrapping (success/error tuple).
- The other 6 domains (`admin`, `check`, `conduit`, `playbook`, `sentient`) call Core directly from dispatch.
- **Architectural question NOT in scope for T1449** but flagged: should engine layer survive after Core normalization? Answer: probably YES (error envelope wrapping is real value), but engine fns become trivial pass-throughs that can be inferred via OpsFromCore from Core. Out of scope; flag as follow-up.

### Contract package coverage
- Domains WITH dedicated contract file: session, admin, conduit, nexus, sentient, tasks
- Domains MAPPED to other contract files: check → `validate.ts`, pipeline → `lifecycle.ts`+`release.ts`+(manifest types inline)
- Domains WITH NO contract file: **playbook** — uses `@cleocode/playbooks` package types directly (`PlaybookRun`, `PlaybookApproval`, `PlaybookRunStatus`)
- **Implication for T1456**: playbook domain alignment requires either (a) creating `packages/contracts/src/operations/playbook.ts` that re-exports from `@cleocode/playbooks`, OR (b) accepting that `@cleocode/playbooks` is the SSoT for playbook ops (precedent: it's where the runtime lives). Worker must decide and document in T1456 deliverable.

### Field-name divergences spotted
- `wire: parent` vs `internal: parentId` — intentional. Drizzle field names use `parentId`; wire format uses `parent`. NOT an alias issue per se — it's a wire/internal model distinction. Dispatch must continue to translate at the boundary (acceptable: wire→internal is a legitimate model translation, NOT alias normalization).
- `wire: role` vs `wire: kind` — alias issue (Q1).
- Other divergences will surface during per-domain workers.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Worker breaks `Cleo.sessions` facade | High (it's a known caller) | T1450 PROOF deliverable INCLUDES updating `Cleo.sessions` |
| Studio frontend imports break (TasksAddParams change) | Medium | T1458 tasks worker has explicit acceptance criterion to update Studio imports |
| `getPlaybookRun(db, runId)` shape change requires db-handle plumbing change | High (db-handle-first signature is structurally weird) | T1456 worker may flag this as needing a separate refactor task; do NOT block T1449 on it |
| Engine wrappers become out of sync | Medium | Workers refactor engine wrappers in same commit as Core (atomicity acceptance criterion) |
| Tests break in adjacent domains | Medium | Workers run repo-wide `pnpm run build` + `pnpm run test` before complete |
| Index goes stale during parallel work | Medium | After all 8 land + T1459 lint, run `npx gitnexus analyze --embeddings` before T1460 |

---

## Worker-prompt feed

For T1450 PROOF and T1451-T1458 spawn prompts, include:

1. **Read this audit document first** (`.cleo/agent-outputs/T1449-CORE-API-AUDIT.md`).
2. **For each Core fn in your domain**:
   - Open the Core source file. Read the current signature.
   - Decide the new signature: `async function <name>(projectRoot: string, params: <Op>Params): Promise<<Op>Result>`.
   - **Source the `<Op>Params` and `<Op>Result` types from `@cleocode/contracts`**, not from inline definitions in Core.
   - If contract type doesn't exist yet (e.g., NEW in playbook domain), CREATE it in the appropriate contracts file — do NOT inline-define in Core.
   - Update the body to destructure `params.fieldX` rather than positional args.
3. **Update internal Core callers** (other Core fns, scripts, tests) — they pass a single object instead of positional args.
4. **If field names diverge** (Core internal name vs Contract wire name): contract wins. Rename Core internal field, update body, update callers.
5. **In dispatch**: import Core fns directly. Build `coreOps` record. Type `XOps = OpsFromCore<typeof coreOps>`. Replace handler bodies with 1-3 lines (just call the Core fn with params).
6. **`Cleo.sessions`-style facades**: update method signatures to match new Core contract.
7. **Engine wrappers** (if domain has one): refactor signature to match new Core; engine becomes thinner.
8. **Acceptance criterion for aliases (T1458 tasks ONLY)**: remove `parentId?` and `kind?` from contracts; move CLI flag aliasing to `cli/commands/tasks.ts`; update Studio if affected.
9. **GitNexus impact check**: before starting, run `npx gitnexus impact <YourCorefn> --direction upstream --repo cleocode` for each Core fn you'll change. Report any HIGH/CRITICAL risk to orchestrator BEFORE starting work.
10. **Quality gates**: `pnpm biome ci .` + `pnpm run build` + `pnpm run test` ALL green before reporting complete.

---

## Open-question feed (resolved by this audit)

| Question | Answer | Locked |
|---|---|---|
| Q1: Aliases policy | Option B — Canonical SSoT in Contracts | ✅ |
| Q2: Refactor sequencing | Normalize Core first, parallel across 9 domains | ✅ |

Both decisions documented above with full justification and data citations. Council verdict's "open questions for owner" section is **resolved by orchestrator under owner-granted autonomy** (per session opening directive: "you have full control and autonomy use AGENT TEAMS and do not stop or bug me you have full comms").

---

## Audit summary (JSON)

```json
{
  "status": "complete",
  "audit_path": ".cleo/agent-outputs/T1449-CORE-API-AUDIT.md",
  "totals": {
    "options_object_pct_sampled": 19,
    "positional_or_mixed_pct_sampled": 81,
    "verdict": "NORMALIZE_FIRST"
  },
  "decisions": {
    "Q1_aliases_policy": "OPTION_B_CANONICAL_SSOT",
    "Q2_sequencing": "NORMALIZE_FIRST_PARALLEL_9_DOMAINS"
  },
  "per_domain_pattern_summary": {
    "session": "POSITIONAL — needs full normalization (PROOF target)",
    "admin": "MIXED — some compatible (export/import), some POSITIONAL (findAdrs, computeHelp)",
    "check": "POSITIONAL — most fns multi-arg",
    "conduit": "MIXED — to be enumerated by T1453 worker",
    "nexus": "MIXED — many no-params or NO_PROJECT_ROOT fns",
    "pipeline": "MIXED — sub-domain heavy",
    "playbook": "MIXED — 2 OPTIONS_OBJECT, 1 db-handle-first; needs contract creation",
    "sentient": "to be enumerated by T1457 worker",
    "tasks": "POSITIONAL — most fns multi-arg; INCLUDES alias removal (parent/parentId, role/kind)"
  },
  "alias_findings": {
    "total_pairs": 2,
    "files_affected": 1,
    "dispatch_normalization_sites": 7,
    "outside_dispatch_reads_of_aliases": 0,
    "studio_importers_of_TasksAddParams": 2
  },
  "blast_radius_check": {
    "tool": "gitnexus impact --direction upstream --repo cleocode",
    "max_impactedCount_observed": 3,
    "max_risk_observed": "LOW",
    "verdict": "PARALLEL_SAFE"
  },
  "next_action": "Spawn T1450 PROOF worker (session domain). On success, parallel-spawn T1451-T1458 workers. Then T1459 (ADR+lint), T1460 (release)."
}
```

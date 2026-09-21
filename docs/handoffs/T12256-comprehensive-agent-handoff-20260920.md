# CLEO trustworthy knowledge, repair, and coding-agent integration — comprehensive handoff

## Context

The owner explicitly requested: **stop building/testing, commit all work, and prepare this comprehensive handoff for another agent.** No new build or test was started after that request. The previous full suite had already finished. Three worker agents hit their usage limit and could not continue. This is a preservation checkpoint, not completion of the approved program.

Begin by reading this document, the canonical closure ledger, and the repository instructions. Do not assume the installed CLI or checked-in source corresponds to the last tested artifact. Do not resume expensive builds or tests merely because this document lists future verification; wait for the owner's instruction to resume implementation/verification. Read-only orientation and inspection of the committed WIP are the immediate next actions.

**Primary source checkout:** `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T12256`

**Branch:** `feat/T12256-trustworthy-closure`

**Integration code checkpoint:** `9e591edd0d16667fdf9a76882bf3627a12ca5d10`. The later documentation-only handoff commit contains this document. No push, remote merge, release, retag, republish, version bump, global install, or broad Axiom data repair was performed at handoff.

**Separate interrupted WIP:** `b661a7ab4` on `task/T12292-requirements-integration`, worktree `.../T12292`. This preserves the incomplete saga completion implementation and tests in two existing files. It is **not merged into the integration branch, not validated, and not declared complete**. Its prerequisite shared validator `f9b52fe1c` is integrated. Review the WIP before deciding to merge or revise it; do not discard it.

**Other agent's checkout:** `/mnt/projects/cleocode`, branch `fix/hierarchy-depth-cap-subtask-unreachable`, clean at `a741ce9fb95f91ce09f5b2caef228326accff4d2` when inspected. This is the owner's separate hierarchy agent's work. Preserve it; do not reset, overwrite, or use it as this work's implementation checkout. PR #1499 remains open and unintegrated here.

## Non-negotiable owner decisions and completion contract

- The owner **waived the npm human support step** for #1478. Do not request a ticket number or treat support submission as a blocker. Publication acceptance, actual installability, requested dist-tag agreement, and installed content still require independent evidence. Never retag, republish, or bump an accepted version to conceal delay. Package size does not establish the cause of registry delay.
- The installation's typed requirement creation and cross-epic readiness defects are part of the entire program, not optional follow-ups. They must also work with the other agent's Saga/Epic/Task/Subtask structure changes.
- Completion means independently verified behavior for every finding. Successful command execution, green checks, a merged PR, or accurate reporting of an unresolved defect do not close the finding.
- Preserve the original 26-command Axiom audit unchanged. One command may cover multiple findings; its exit code cannot close all of them. Do not blindly replay mutating audit commands such as pruning.
- Unrecoverable authentic evidence and unresolved scientific authority remain open. Static analysis must never claim complete runtime-call discovery.
- Track implemented, verified, deployed/installed, repaired in Axiom, externally blocked, and unresolved separately. No “100% complete” claim.
- Canonical production documents, task data, evidence, snapshots, and repairs use CLEO APIs/CLI. Do not read/write raw production databases, attachment stores, or blob stores. Synthetic isolated fixtures are different and were used for controlled fault injection.
- Preserve existing transactions and forward fixes. Do not “restore” obsolete behavior from historical assumptions. Do not automatically split ambiguous acceptance text, delete evidence, or rewrite authority based on scores or recency.
- Every repair needs a proposal, immutable preconditions, snapshot where applicable, receipt, postcondition, and guarded recovery. No background repair model or new agent engine.

## Canonical orientation and records

Primary epic: **T12256**, active, `noAutoComplete=true`. Root session: `ses_20260919172346_fefd8d`. Last fresh child population: **43 matched/returned, 18 active, 25 pending**, no truncation, archives explicitly excluded. These are bookkeeping statuses, not percentages of verified findings. No program tasks were falsely closed at handoff.

Canonical closure ledger:

```text
cleo docs fetch trustworthy-knowledge-closure-ledger-20260919
```

At the last byte-verified checkpoint it was **412780 bytes**, SHA256 `7a011ffd1edbb402e5a2fc7a642657404eccdc348dd6087d86e000fd27fa3574`. This handoff supersedes its older “full run in progress” status, without deleting that history. The ledger contains the earlier implementation history, findings, original observations, and receipts; this document gives the current resume state.

Handoff slug: **t12256-comprehensive-agent-handoff-20260920**. Created and published through `cleo docs`, not as an unregistered raw canonical file.

Canonical CLI used for administrative records from the integration worktree:

```bash
env CLEO_SESSION_ID=ses_20260919172346_fefd8d \
  NODE_OPTIONS='--import /tmp/cleo-budget-zero-d_1ixnks/guard.mjs' \
  node packages/cleo/dist/cli/index.js docs fetch trustworthy-knowledge-closure-ledger-20260919 --json
```

That guard denies subprocess/network/listener activity for bookkeeping; it is **not** appropriate for actual Git, gate execution, or provider workflows. It can produce cancelled encounter-registration diagnostics. Preserve diagnostic failures instead of interpreting them as empty data. The compiled CLI is build 18, even though the source branch now contains subsequent commits.

Important local resume/evidence indexes:

- `/var/tmp/cleo-T12256-pending-integration-queue.json` — latest local pointer; the final handoff updates it.
- `/var/tmp/cleo-T12256-handoff-owned-worktrees.json` — heads and status of 53 related worktrees.
- `/var/tmp/cleo-T12256-handoff-full18-failures.json` — exact final failures.
- `/var/tmp/cleo-T12256-eighteenth-verification-receipt.json` — build/run receipt, updated at handoff.
- `/var/tmp/cleo-T12256-handoff-stopped-checks.json` — no owned checks still running when stop was applied.

The `/var/tmp` and `/tmp` paths are local evidence, not remote durable storage. They exist on this machine at handoff. Preserve or attach needed evidence before cleaning temporary directories. Never replace authentic payloads with reconstructed guesses if an artifact later disappears.

## State

Exact source/artifact distinction and verification results follow.

### Last built artifact: build 18

Source: **43443e14d5dd86c6038a6b95bc6090b417791a6d**.

- `pnpm run build`: passed in **57.746 seconds**.
- Native built CLI `show T12292 --full`: passed.
- Owned artifact inventory: **7467 files, zero symlinks**, SHA256 `406f578bd25b851c57e02fd5067ec6f2d7a679e44811f82ae2cd06e8db569a52`.
- Inventory: `/var/tmp/cleo-T12256-eighteenth-built-artifact-inventory.json`.
- Build log: `/var/tmp/cleo-T12256-eighteenth-build.log`.
- CLI receipt: `/var/tmp/cleo-T12292-eighteenth-native-cli.json`.
- Native stderr still reported cancelled project encounter registration and that tracked promises settled while producer outcomes were unassessed. **Quiet durable teardown is not established.**

### Full suite completed before the stop request

On build-18 source/artifact:

- **1612 test files passed, 3 failed, 4 skipped.**
- **23358 tests passed, 7 failed, 48 skipped, 51 todo; 23464 total.**
- Duration **648.60 seconds**.
- Full log: `/var/tmp/cleo-T12256-eighteenth-full-tests.log`.
- Genuine Vitest JSON: `/var/tmp/cleo-T12256-eighteenth-full-vitest.json`.
- Exact extracted failures: `/var/tmp/cleo-T12256-handoff-full18-failures.json`.

Failures:

1. `packages/cleo/__tests__/integration/stdout-envelope-only.test.ts`: **durably records files and waiver and correction provenance**. Actual public `cleo log --task ... --operation task_created` returned an empty entries array instead of the committed dependency waiver. Keep this public-command assertion unchanged.
2. `packages/core/src/tasks/__tests__/update.test.ts`: **reads committed audit receipts from the modern store without a legacy tasks.db**. This is a real modern-write/public-read oracle.
3. `packages/core/src/tasks/__tests__/mutation-controls.test.ts`, five cases:
   - verifiable committed severity assertion with owner policy false;
   - same with owner policy true;
   - task/criteria/dependency-waiver/signed-decision rollback on receipt persistence failure;
   - update/signed-decision rollback on audit persistence failure;
   - duplicate bypass provenance only on committed transaction.

The first two expose the real canonical audit reader/writer mismatch described below. The mutation-control fixtures still read or inject faults into `main.audit_log`; the accessor now writes `tasks_audit_log`. Correct their target only after independently establishing the canonical receipt path, preserving every rollback/signature/provenance assertion. Do not weaken expectations to get green.

The previous build-16 full run had **23249 passed and one native SIGSEGV** during fixture epic creation, before delete executed. Build 18's force/cascade paths passed; that is **not proof of the earlier crash's cause or closure**. Build-16 log/report/receipt remain under `/var/tmp/cleo-T12256-sixteenth-*`. No retained core/kernel evidence explained the crash. A 45-process bounded replay did not reproduce it. Signal diagnostics were improved, not a proven native fix.

### Other quality checks on frozen build-18 source

| Check | Actual result |
| --- | --- |
| Biome `check --write .` | Passed; 4022 files, no fixes, two legacy warnings |
| Architecture baseline | 22/22 passed |
| Strict architecture | 12 pass, 10 legacy script failures, no newly failing script; not a green strict run |
| Static circular-dependency comparison | 2218 current/2169 baseline reachable modules; 13 SCCs each; zero new cyclic edges |
| Static-analysis limits | Two unresolved workspace imports, 20 nonliteral dynamic imports; not runtime completeness |
| Forge full report | 14248 errors, 12873 warnings; one new E008 and 233 resolved errors versus original baseline |
| New Forge error | `shutdownCliRuntime` linked moved/unresolvable `StepOutcome`; later one-file fix is integrated, but full Forge was not rerun after stop |
| Core standard noEmit | Passed on frozen source |
| CLI standard noEmit | Failed three TS2307 diagnostics for `@cleocode/animations` and `@cleocode/animations/render` |

The build-18 inventory already contained **zero animations output files before tests**. `packages/animations/package.json` points to `dist/src/index.js`, declarations, and `dist/src/render/*`, but its dist is absent. Investigate the root build/package graph; do not hide this with type casts, aliases, or stale output. An owned worker checkout's CLI noEmit passed, so its extra outputs differed from the clean integrated build. This is an open build-integrity finding.

Reports: `...-eighteenth-biome.log`, `...-eighteenth-arch-baseline.log`, `...-eighteenth-arch-strict-comparison.json`, `...-eighteenth-cycles.json`, `...-eighteenth-tsdoc-comparison.json`, `...-eighteenth-core-types.log`, `...-eighteenth-cleo-types.log` in `/var/tmp/cleo-T12256-*`.

The first Forge comparison normalized only file paths and falsely counted 109 new errors because diagnostic messages embedded checkout paths. It was preserved as `...-eighteenth-tsdoc-path-only-comparison.json`; the corrected comparison normalizes only the two known roots in both file and message and preserves multiplicities and complete pages. Do not reuse the preliminary count.

### Commits integrated after build 18, without new build/tests

These were individually checked by workers before the stop request, then merged for handoff. They are **absent from build-18 dist** and lack final combined verification:

| Commit | Work | Existing worker evidence |
| --- | --- | --- |
| `a8f24a073` | Fix actual shutdown TSDoc link | One-file Forge target zero errors; no suppression |
| `f9b52fe1c` | Extract shared typed completion result/receipt validator into existing gate-runner leaf | 78 focused tests pass; actor/payload tampering controls; no new runtime edge |
| `1a6147c94` | Bootstrap/unblock use shared global dependency policy | 47 focused tests pass; archive, cancelled/missing dependencies, required read failures |
| `940d1f366` | Versioned quarantine rollback write footprint preserving legitimate later usage | 122 doctor tests pass; original positive failed `E_REPAIR_STALE` |
| `56d904d01` | Document versioned recovery boundaries in tier-0 instructions | Documentation checkpoint |

The worker branch also contains `212f6e6e0`, equivalent to the already integrated saga adapter argument correction. Merge preserved history. No version was bumped.

All source edits from this session are committed. The only remaining untracked items identified in related older trees are **generated native build artifacts**, not authored changes: `packages/worktree/native/worktree-napi.cjs` (2412 bytes) and `.linux-x64-gnu.node` (3167776 bytes) in T12255 and T12273. They were preserved, not added to git or deleted. Runtime databases/configs were never staged.

## Highest-priority next work once the owner resumes implementation

### 1. T12306: canonical audit readers and authentic legacy history

Accessor commit `cea1fff6e` correctly moved `appendLog` and accessor `queryAuditLog` to canonical `tasksAuditLog` on the same transaction handle. Native receipt-trigger rollback proofs exist. However public `packages/core/src/system/audit.ts` still imports legacy `auditLog` from `tasks-schema`, reading physical `audit_log`. Thus the new receipts vanish from public `cleo log` even while present in the canonical table.

T12306 explicitly tracks reconciliation of all audit consumers and legacy history accessibility. **No source fix has yet been made for this reader gap.** Inspect existing contracts/utilities first. Preserve authentic legacy rows, source/project provenance, and duplicate/conflicting-ID handling. Do not silently migrate, delete, or hide legacy history. Do not conflate legacy historical rows with new canonical receipts when validating completion evidence. Keep required read failures explicit.

Use the real public-command full-suite failure and real updateTask/public-query test as independent negative oracles. Fix canonical reading and historical access; then adjust obsolete synthetic receipt triggers/read targets while keeping their substantive assertions. Do not “fix” the public test by querying a private table directly.

### 2. T12292: typed requirements and every completion path

Original Axiom report was authentically recovered through CLEO:

- project `/mnt/projects/axiom-analytics`;
- slug `complete-partner-company-system-plan`;
- attachment `12c8cc0a-058a-4286-8107-a638efb49bed`;
- 21236 bytes, SHA256 `e62046ad69e6581480d96836d85d45efef5e82b83572ecadc1632247c1100f69`;
- fetch `/var/tmp/cleo-axiom-requirement-gate-report-fetch.json`;
- decoded `/var/tmp/cleo-axiom-requirement-gate-report-verified.txt`.

It documented req creation routing rejection, typed update rejection, readiness inaccuracies, and required missing-harness refusal. One example omitted a required description; valid fixtures supplied it rather than treating that omission as the actual routing defect.

Implemented/integrated:

- Schema/input/dispatch routes for actual req add/list/query migration preview/mutation, with four legitimate operation registrations. CLI schema/help inventory reflects those additions.
- Canonical typed `AcceptanceItem[]` preservation through read projections and unrelated mutations; strict literal input normalization remains separate.
- Gate execution uses actual target exit/capture, original execution context/deadline, explicit resource limits/capability failures, task/project/criterion/artifact bindings, and canonical receipt validation.
- `verify` performs execution outside SQL, then transactional CAS revalidation of task/AC/prior result/file bytes and stores result/bindings/hashed receipt together. Receipt faults and cancellation rollback have controlled evidence.
- Direct completion and parent auto-completion reject missing/failed/stale/coherently mismatched hard typed evidence. Generic literal waivers cannot replace hard typed proof. Advisory ordinal/duplicate-text cases are covered.
- `ee0dc01a6` prevents child-add from stringifying every parent's typed gate; `df5b8a80a` prevents the same loss in projection rebuild/removal and refuses malformed evidence.
- `beecb2bc8` rejects completion even when all typed JSON objects were erased but normalized evidence-bound rows remain.
- `acce8b957` removes accidental req route strings inserted as extra saga adapter arguments by earlier `ed66af49a7`; real route registration remains. Bundler build alone had missed TS2554.

**Actual CLI evidence:** build 17 exposed parent completion bypass because child-add demoted gates to strings. Original `/var/tmp/cleo-T12292-built17-gates.json` retained. Build 18 proves missing target refusal, repaired actual target success, both gate-first/child-first parent orderings preserving typed gates, and unmet hard proof refusal. Positive parent typed isolation used an explicitly documented synthetic binding for an already completed child; it is not a whole natural workflow proof.

**Two critical remaining findings:**

1. Actual build-18 `saga reconcile T008 --dry-run` predicted close and mutation marked saga done despite an unmet hard typed gate. Ordinary rollup kept it pending. Evidence: `/var/tmp/cleo-T12292-built18-gates.json`. `sagas/reconcile.ts` directly upserted done with replacement verification. Shared validator extraction `f9b52fe1c` is integrated. Interrupted wiring/testing is committed as **b661a7ab4** in T12292, not integrated. Its whole-operation deadline, transaction, dry-run assessment, receipt validation, and cycle behavior need review and verification.
2. Generated `child_task` parent AC rows remain uncovered after the real child completes. `computeAcCoverage` is binding-only; completeTask creates no child-derived binding, while documented PM-Core semantics derive this projection's satisfaction from child state. Preserve the actual refusal. Implement a bounded, evidence-backed derivation consistent with hierarchy work; do not waive all parent criteria or mistake synthetic test bindings for production closure.

Other pending typed work:

- Min-count report schemas are integrated (`d35a4d9ff`, 89 tests). Runtime minimum-count execution remains unsupported/pending. Preserve captured genuine Vitest report and saved draft `/var/tmp/cleo-T12292-mincount-runtime-test-draft.patch`.
- HTTP `startCommand` owned startup/probe/cleanup lifecycle remains unsupported/pending.
- Reuse strict report schemas in existing evidence consumers only after compatibility proof; do not infer test success from exit zero, stale files, or zero assertions.
- Final actual installed-artifact workflows and tier-0 instruction synchronization remain required.

### 3. T12293, T12304, T12294: readiness and hierarchy integration

Implemented shared execution dependency semantics: done/archived resolve; pending/cancelled/missing block. Global canonical lookup is separate from selected populations; required read failures propagate. Completion waivers are a distinct policy and were not generalized into execution readiness.

Integrated readiness commits include `3c63d70ed`, `4c199f697`, `b0780f4b0`, `2f77ef5a0`, and newly merged `1a6147c94`. Covered consumers include enriched waves, analyzeEpic/getReadyTasks, deps-ready, plan/next, and bootstrap/unblock. Archive exclusions do not inflate selected progress/population. BlockedBy lists actual unresolved IDs. “High impact” transitive potential is not immediate readiness.

Still pending: query-ops orchestrateReport, remaining pure classifiers/frontier/generic-ready/blocked/briefing/task operation consumers, actual saga/installed cross-epic parity, and consistent population/admission semantics. Last ready call gave 42 candidates and budget 8; T12293 admitted, hierarchy T12304 deferred. Do not falsely complete tasks to manipulate admission.

Other agent's PR1499 head `a741ce9...` adds reachable subtask depth, decompose, auto-decompose, reconcile scope, memory-aware test budget, and compact injection updates. T12304 tracks integration. Last preview had nine conflicts in CLI schema/dispatch, contracts registry/snapshot/operations, help snapshot, core task index/session-scope, and vitest memory defaults. Preview `/var/tmp/cleo-T12304-hierarchy-a741-merge-preview.txt`; re-evaluate against the current integration head. Preserve all of the other agent's work and this branch's typed requirements/durable contracts.

T12294 separately tracks decomposition atomicity with concurrent typed requirements. Review the final integrated implementation rather than assuming earlier preflight/strip/add/compensation behavior is current. Inject failures and concurrency; no partial creation or lost typed criteria.

### 4. T12277: repair lifecycle, inventory, usage-preserving rollback

Existing job store was strengthened with durable leases, owner/heartbeat/fencing, scoped immutable idempotency, cancellation, attempts/checkpoints, explicit contention budgets, and atomic receipt writes. Opening a client must not reclaim live work. All action families and crash/publication journals are **not** complete.

`437d6dbad` includes guarded full resource images in proposal identity, preventing unchanged semantic IDs from pointing to stale immutable jobs after citation changes. Existing full CAS was preserved.

`e23eff53e` adds bounded generic persistent candidate pages; SQL project/operation/keyset filters and LIMIT precede payload parsing; UTF-8 row/aggregate bounds; stable submitted cursor; last-scanned behavior even for empty actor pages; corruption/read/deadline diagnostics. Mutable lease claimant is not original actor. `00525cfd4` authenticates knowledge proposal schema/hash/project/actor at service level; `56c876fef` rejects malformed cursors. `7bbcf4e18` exposes CLI `doctor knowledge --jobs --actor ... --limit ... --cursor ...` and exact inspect arguments; no in-memory manager or guessed latest job needed.

New source `940d1f366` adds explicit versioned observation-quarantine write footprints:

- Full original before/after evidence and hashes retained/authenticated.
- Only `invalid_at` is restored; legitimate current usage metadata is preserved.
- Protected-field conflicts, malformed receipts, decrements, invalid or inconsistent timestamps refuse recovery.
- Valid first use from zero count/NULL timestamp is constrained by protected creation time and observation time; it does not invent a prior usage event.
- Original non-null usage timestamps require a valid monotonic paired update.
- Legacy receipts without this explicit footprint keep strict full-row behavior; no retrofit.
- Rollback preparation captures current full state and retains strict prepared CAS; later changes require fresh preparation.
- Rollback receipt records actual current-before/restored-after images; preserved usage means full restored hash need not equal the original pre-repair hash.

122 focused doctor tests passed before handoff, including actual immediate citation read→rollback. This code is **not in build 18**. Initial suspected subsecond regression was corrected: the failing draft fixture actually had NULL prior timestamp. Timestamp truncation was source-observed only, not a reproduced defect. Do not carry the mistaken diagnosis forward.

Pending: all repair action families (authority/quarantine/backfill/evidence links/index publication/source configuration/managed instructions), filesystem-plus-database journals/checkpoints, cancellation at each checkpoint, resource-level rollback, immutable context snapshots, final packed replay, and live providers on the corrected artifact.

### 5. Provider certification and instruction delivery

Keep declared, installed, delivery-verified, workflow-verified, and lifecycle-verified separate. External provider CLI use and CleoOS spawning are separate capabilities. No agent is globally “supported” solely from a manifest.

Frozen packed runtime `/var/tmp/cleo-packed-smoke-Hxenjy` was built from **b469809826ebacdffb9ed8c261a5ad86fc076397**, not current source. Actual installed Git/version/init, Studio canonical task readback, and native embedding passed with owned outputs and bounded cleanup. Earlier `/var/tmp/cleo-packed-smoke-ScISXb` also has retained evidence. Never reuse the older known-recursive Git fixture.

- **Codex:** two actual b469 workflows demonstrated: main repair/rollback; separate authentic stale apply rejection→new proposal/reassessment→apply→rollback. Read the actual receipts, not only agent text. `/var/tmp/T12286-b469-codex-main-proof.json` and related T12286 files. Earlier ScISXb recovery evidence is preserved separately.
- **Claude:** actual bootstrap read verified, stale refusal and new repair application evidenced; later historical retrieval changed usage metadata and strict rollback refused; timeout retained. Not certified. New rollback code has not been replayed live.
- **Kimi:** prepared/applied a new job, but required authenticated stale chain and complete recovery were not demonstrated; timed-out discovery attempts retained. Not certified.

All used isolated HOME/XDG/CLEO/provider roots, bounded execution, normal policy, objective-only prompts, copied selected auth with mode 0600 and cleanup. No answers were supplied in prompts. Auth copies/scopes were cleaned in completed attempts. Do not expose credentials or copy all configuration wholesale. Live workflows are still required after final coherent packed installation.

Audit packaged template→installed template→global hub→project instructions→provider files→skills→bridges→spawn prompts. Preserve user-authored bytes outside managed regions; detect broken references/cycles/duplication/stale versions and behavior drift. Global installed injection remains stale in places, including PR/CI automatically satisfying gates. Source tier-0 updates do not prove global delivery. Use the universal orient/check authority+coverage/inspect/act/verify/learn protocol and runtime-validated commands.

### 6. Axiom rollout and authentic recovery remain largely unapplied

Axiom parent identity: `/mnt/projects/axiom-analytics`, project ID **db32a754-b6e2-41ef-b29a-f0657a79f71c**. Included Git repository: `axiom-app`. Preserve parent project binding while resolving Git through included roots.

Original immutable audit:

- `/tmp/axiom-cleo-audit-2026-09-18/evidence.json`
- 72320 bytes; SHA256 `b20358dd1617094a8f174268e53fb36f374fcf4ac2c4ace7d8e33ad03b32698a`
- Reconfirmed unchanged before handoff.

Read-only T136 reassessment `/var/tmp/cleo-T12256-axiom-T136-reassessment.json` reported 4239 persisted inventory requested, 3958 completed, 281 unassessed, 182 changed, one missing, stale/pending, zero proposals/receipts. This was bounded persisted-inventory work, **not a complete fresh filesystem inventory**. Its guard blocked Git; lack of revision there is not independent proof of resolver failure. Do not reuse any historical counts as current observations.

Authentic historical T136 documents recovered but **not reconnected**:

| Slug | Bytes | SHA256 |
| --- | ---: | --- |
| ahk-cu-received-form-method-qualification-hold-2026-08-27 | 6033 | cd884c1166c981cf73b4c17167c0aac2611ac2239f7b61792b0b2499bebde5db |
| ghk-cu-intact-complex-qualification-2026-08-27 | 3768 | 77c60325b376d7ade9c1086ca908812b36566a0669ce543ba5f39fc8e6223520 |

Preserve their exact historical bytes. Current files have different hashes. Add sourced successors separately. Documentary recovery **does not resolve scientific authority or authorize changing measured results/governing criteria**.

Missing `O-mspmgvbg-0`: canonical read-only snapshot searches in two authentic backups found no payload; transcript search also found no authentic payload. This is not exhaustive absence. Keep an explicit missing-record reference and recovery open. Backup evidence:

- 20260918-134233, 62136320 bytes, SHA e153a1e25f35a4793a66833cbd855be2bcd1192f3a2e1b96632e8c3a332bfe0b.
- 20260918-133253, 62111744 bytes, SHA 8c080c4ef322a97eddb15e3f950546c048e90c5f57ca218802c2b1062fa0ccbe.
- `/var/tmp/cleo-T12278-axiom-retry-receipt.json`, SHA a80cd0cf636a0385686b65afbc31545954b98739a784d4f2ad6f5ee1b9d019a5.
- Content hashes/inode/size/mode/mtime/ctime unchanged; three atimes advanced and were disclosed.

Still required: precise `orgNameTaken` route GET/nested callback callers, removal of test-local mock false production relationship, direct-call versus file/module distinction; sourced rationale from a55686d8… and 51e354f7… linking commits/tasks/schema/code without promoting quoted owner assertions; T136 focus mandatory coverage/details, included-root Git fix, bare context coverage contract, D001→D004 sourced authority/history/briefing, fresh `rushDueAt` callers, T448 file-evidence precision. Legacy 572 omitted relationships/330 global fallbacks/186 imports-only code files are original-generation observations, not newly measured counts.

Do not apply broad Axiom repairs before trustworthy writes, enumeration, parser/resolution, receipt and rollback prerequisites are verified. Snapshot via canonical APIs, prepare guarded repairs, publish a validated staged generation, then replay original probes and finding-specific postconditions. No such broad rollout is complete.

## Remaining approved program contract beyond the immediate fixes

The closure ledger has detailed historical evidence. The following are mandatory remaining acceptance areas, not suggestions:

| Area | Required completion and limits |
| --- | --- |
| T12198 durable mutations | Preserve existing transactions; central field/storage mapping; every accepted field persisted; fresh-process reads; failure between task/AC/dependency writes rolls everything back; concurrent/interleaved project IDs/ownership correct; rejected mutations nonzero in every output mode; diagnostic reads explicit. Substantial source/tests integrated, final finding closure remains. |
| T12197 normalization | One boundary for add/update/batch/saga; canonical arrays, invalid elements rejected, original delimiter failures covered. Historical fused criteria repaired only from explicit provenance; literal pipes/quoted unions/ambiguity preserved. |
| T12199 projections | Every partial record declares missing fields, even tiny budgets; correct UTF-8 measurement; impossible mandatory-truth budgets rejected. |
| T12200 populations | Shared filter/count/find/list/IDs/table population; matched versus returned and archive exclusions explicit. Fresh complete enumeration before historical assessment. |
| T12201 matching | Default lexical; fuzzy explicit and explains kind/field; semantic explicitly named. |
| T12254 / #1480 evidence | Task/classification/gate/AC context; artifacts and actual verification; PR/CI provenance not automatic implementation/test/review. Docs-only/unrelated PR rejected for code fixes; appropriate doc/research evidence allowed; no parent bypass. Append corrections preserving T11830 and program history. Source exists; final closure pending. |
| Knowledge shared contract | Project identity, included roots, per-root revision/inventory/freshness; requested/completed capabilities; current/stale/partial/missing/failed; precision/unresolved/diagnostics/follow-up; authority/corrections/history/pending repair on impact/context/full-context/symbols/footprint/focus/briefing/diagnostics. UNKNOWN vs assessed NONE; compact truth fields mandatory. |
| Parser/lexical model | Controlled capacity fixtures; remove artificial cutoff where supported; original Unicode; worker memory/cancel/deadline; unified lexical declaration/call/access resolution with nested functions/methods/callbacks/params/destructuring/shadowing; qualified identities and span/generation anonymous IDs. Lexical/import resolution before global candidates. Preserve ambiguity/external/dynamic spans/candidates/reasons. Every original omitted/fallback relationship needs auditable disposition. |
| Capability coverage | Executable declarations/references/imports/control; SQL objects/migrations/triggers/constraints/literal refs with dynamic explicit; Markdown documentary; JSON role; assets resource evidence. Unsupported executable gaps; images/generated snapshots should not falsely degrade caller analysis. Retain exclusions; nested repo ownership explicit. |
| Freshness/index | Full persisted inventory, no old 500 ceiling; edits/additions/renames/deletions/revision/scope/parser changes. Staged graph/inventory/endpoints/provenance validation; immediate source/generation recheck; atomic publication receipt; retain previous on fault/cancel/interruption; historical evidence independent; active+previous and recovery-referenced generations retained. |
| Retrieval/authority | Same eligibility for lexical/fallback/semantic/graph/briefing; successor resolution/history; decision-only filtering/type rejection; sourced explicit authority replacement; historical handoffs/corrections separate; cross-project provenance; incidents above empty traces; prevent stubs/quarantine proven noise reversibly; foreground learning without separate model credentials. Scores never establish authority. |
| Unified repair | Core services and existing runtime only; immutable proposal/context/receipt lifecycle; prepare/apply/inspect/cancel/resume/rollback; preserve doctor repair DB semantics, extend doctor knowledge. All action families, leases/fences/recovery/crash/cancel checkpoints, idempotency scope, atomic DB receipt, filesystem journals, user edit preservation/resource rollback, postcommit cancellation truth. Shared two-second maintenance budget; timers are not synchronous DB preemption. |
| Context loop | Immutable budgeted snapshots of task scope/authority/coverage/capabilities/evidence/pending repairs; record action snapshot identity; orientation/start/pre-edit/evidence/completion/handoff integration; temporal provenance/selective injection/durable checkpoints/stage evaluation. No age deletion or automatic model authority. |
| Instructions/providers | Complete delivery audit, managed bytes, tier-0 maintenance, command/flag validation, independent capability levels, actual Claude/Codex/Kimi installed workflows with guarded repair/receipt/stale rejection/verification/rollback. No accounts/interface means unverified, not assumed success. |
| Test isolation | No host browser, uncontrolled listeners, real stores, leaked descendants. Mock browser launch before import. Bounded workers/heap/isolated HOME/XDG/provider directories. Native crash remains unexplained. |
| #1439 startup CI | Actual required PR and merge-group job executes ratchet; prohibited import must fail real job. Source wiring alone not deployed proof. |
| T12239 runtime handles | Main and worker realms, identity/lifecycle/scope/observed pragmas, missing realms explicit; durable quiet writes end to end. Preserve teardown fixes, don't overclaim producer success. |
| T12242 binding inventory | Reproduce authentic inventory, reachability and symbol identity, evidence-backed classification. Do not substitute speculative semantic lint or runtime completeness. Original 6130/5247/883 and non-test3941/3724/217 counts are historical. |
| #1491/T12255 Studio | Trace client import graph, browser-safe leaves, Node/LLM orchestration server-side; externalize only after packed runtime proof. Existing packed Git/Studio/embed results are partial scope. |
| #1494 release artifact | Ordinary CI classifier fixtures and release-shaped packed checks for relevant PR/merge groups; retain tarball/manifest/hashes. |
| Release workflow budget | Structural workflow parsing, movement/rename tests; no comment-anchored parsing. |
| #1495 installability | Publication accepted, version installable, requested tag matches and installed content verified independently. No concealment via retag/republish/bump. |
| #1496 watcher | Keep GitHub schedule; last observation/trigger/staleness; require observed scheduled execution of new implementation, not old historical run. |
| #1497 docs | Preserve canonical handoff/provenance while fixing validation; open PR is not merged. |
| Final rollout | Focused then required broad checks, no baseline increases; packed installed artifact/provider workflows; snapshot-backed Axiom repair and exact probes; explicitly separate source, installed, Axiom and external/knowledge status. |

## Task map and notable earlier source work

All under T12256 unless explicitly noted. “Implemented” here is source progress, not task closure:

- T12257 ledger/release observations; T12258 mutation exit modes, persistence and signal diagnostics; T12259 structural workflow budgets.
- T12260 migration scope; T12261 mutation controls/attestation; T12262 parser capacity; T12263 job ownership; T12264 lexical reference identity; T12265 scope/background lifecycle; T12266 included-root Git; T12267 explicit project registration.
- T12268 source-root contract; T12269 managed bytes; T12270 awaited index publication; T12271 revisions; T12272 Studio canonical contexts; T12273 semantic packed checks; T12274 task file evidence on impact failure; T12275 explicit accessor lifetime; T12276 scoped Studio health; T12277 repairs; T12278 canonical historical snapshot inspection.
- T12279 bound legacy SQL; T12280 explicit session/evidence scope; T12281 compact manifest guidance; T12282 canonical manifest writes/history; T12283 first-use schema serialization; T12284 Vitest temp parent; T12285 isolated Nexus registry.
- T12286 provider certification; T12287 full persisted freshness; T12288 PR1497 docs; T12289 role/capability coverage; T12290 watcher diagnostics; T12291 stdout AST ratchet; T12292 typed requirements; T12293 readiness; T12294 atomic decomposition.
- T12302 exact bounded lineage: task-token boundaries, bounded Git calls, independent history fixtures, explicit diagnostic failures, dispatch/citation/primary-write lifecycle fences. Backfill relocation/atomicity separately T12305. No whole graph-pattern transaction or timer preemption claim.
- T12303 installed Git shim recursion/root identity and bounded packed fixture commands. Earlier 1019 owned descendants were identified/cleaned; no blanket process kill. Runtime capture and systemd scope evidence preserved.
- T12304 hierarchy integration; T12305 legacy audit backfill relocation/unified repair; T12306 audit consumers/legacy history.

Important canonical notes (fetch by slug):

- `typed-verification-receipt-t12292-20260920`
- `typed-completion-proof-t12292-20260920`
- `typed-cli-parent-type-loss-t12292-20260920`
- `t12277-resource-bound-reassessment-identity-20260920`
- `t12277-bounded-durable-job-candidate-pages-20260920`
- `t12277-standalone-authenticated-repair-inventory-20260920`
- `t12265-bounded-producer-shutdown-20260920`
- `t12265-typed-shutdown-diagnostics-20260920`
- `t12258-cli-signal-diagnostics-20260920`
- `t12293-ready-consumers-source-20260920`
- `t12293-bootstrap-unblock-dependency-evidence-20260920`
- `t12302-dispatch-citation-primary-write-fences-20260920`
- `t12286-codex-installed-repair-rollback-demonstration-20260920`

Fresh PR/issue status snapshots: `/var/tmp/cleo-T12256-seventeenth-pr-observation.json` and `...-seventeenth-issue-observation.json`. PRs1485–1490 are draft/open, their original heads integrated locally in dependency order; PR1497 and1499 open. Findings1439/1478/1480/1491/1494/1495/1496 are issues. The initial pulls endpoint returned404 for issues; that was corrected, not treated as missing evidence. Main last observed `9ea09d7f94188bc44871e139dc32c25925334b35`.

## Working protocol and traps

- Read applicable AGENTS.md, actual runtime help, and tier-0 skills. Local instruction text itself has known drift; owner instructions win. `ct-orchestrator`/`ct-dev-workflow` were used for scoped delegation and manifest/canonical reporting. The handoff skill is adapted to canonical CLEO docs rather than inventing a GSD project.
- Existing worker scopes were max three product files per checkpoint, in canonical owned worktrees. Core domain logic stays core, shared types contracts, CLI thin, Nexus indexing, CAAMP packaging, cleo-os harness. Add package-boundary acceptance for introduced modules. No `any`/shortcut unknown/unsafe casts; exported TSDoc required.
- Use one coherent compiled artifact. Before rebuilding, have every worker explicitly release shared dist; never emit through symlinks or overwrite another worker's outputs. Owned copies require realpath/byte inventory proof. Build18 is currently usable for old-artifact inspection, not new-source certification.
- Test commands with incorrect explicit paths were preserved and corrected. Vitest can report success while silently omitting nonexistent paths when another path matches. Confirm exact test collection; locate paths instead of guessing. Existing assert-vitest-collected infrastructure is relevant.
- Do not change correct public assertions to conceal reader mismatches. Distinguish malformed synthetic fixtures from actual defects and keep original failure evidence.
- No direct pushes to main; all intended releases/merges follow repository PR/merge-queue policy. Owner's documented admin escape hatch is intentional, not a defect to “fix”. Do not bump architecture baselines to hide regressions.
- Never commit `.cleo/cleo.db`, brain.db, config.json or project-info.json. Keep production repair via canonical APIs. Old tasks.db and empty bare tasks table are known decoys; modern tasks live in prefixed tables in cleo.db.
- A killed write is not proof of rollback; inspect its exact identity from a fresh process before retrying. Preserve committed-after-cancellation truth.
- A proposed dynamic native-instrumentation experiment was automatically rejected by safety review and stopped without launch. Do not retry, rephrase or reroute that blocked technique. Ordinary existing diagnostics/unit tests are distinct; no causal SIGSEGV claim was established.
- No external messages or npm support submission were authorized or sent. No new build/test is authorized by the handoff itself; the owner explicitly stopped them.

## Next-Steps

Concrete resume sequence after owner authorization:

1. Confirm integration branch/head, separate saga WIP, original hierarchy checkout, canonical ledger, and source-versus-dist distinction. Inspect full18 failure JSON and current audit contracts before editing.
2. Finish T12306 canonical reader/history treatment with independent public-path and transactional fault oracles. Preserve all seven failed expectations' intended behavior.
3. Review/finish saga WIP b661a7ab4 using shared validator; fix natural child-derived AC satisfaction with documented semantics and evidence. Then finish minimum-count and HTTP gate runtime capabilities.
4. Complete remaining readiness consumers and integrate hierarchy PR1499 carefully; verify atomic decomposition with typed/concurrent requirements.
5. Resolve missing animations artifacts in the real clean build graph; retain actual source/packed identities. Integrate any remaining source checkpoints, then perform newly authorized coherent verification. Do not attach prior full results to a different source head.
6. Pack/install the corrected artifact and re-run actual required provider workflows, especially Claude rollback after retrieval and Kimi authenticated stale/repair/recovery. Existing provider artifacts do not contain new fixes.
7. Continue parser/resolution/coverage/freshness/index-generation and unified repair/context/instruction requirements, then guarded Axiom rollout and full original/finding-specific replay.
8. Close release/runtime/CI observations only with deployed/installed evidence. Keep authentic missing content and unresolved scientific authority open unless actually resolved.

This document is the transfer of incomplete work, with all known implementation and verification boundaries stated. It is not a completion certificate.

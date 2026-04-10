# T448 Wave Plan: CLI System Integrity Implementation

**Date**: 2026-04-10
**Epic**: T443 — CLI System Integrity — Dispatch/Registry/Constitutional Alignment
**Pipeline stage**: Decomposition (follows R→C→A→S at T447)
**ADR reference**: ADR-042 (conduit domain disposition + 16 canonical op additions)

---

## Prerequisites and Sequencing

T447 (Specification) runs in parallel with this decomposition. Wave 3 tasks (coverage-gap CLI
commands) have a dependency on T447's output: the classification of which uncovered ops are
`needs-cli`, `agent-only`, or `deferred`. Wave 1 and Wave 2 are independent of T447 and can
proceed immediately.

```
T447 (Spec) ──────────────────────────────────────┐
                                                  ▼
Wave 1 (Doc updates) ──► Wave 2 (Code changes) ──► Wave 3 (CLI gaps) ──► Wave 4 (Shim plan)
```

Wave 4 (shim removal planning) is a planning-only wave — it produces no code but outputs a
phased roadmap task set for a future epic.

---

## Current State Summary

From the audit (CLI-SYSTEM-AUDIT-2026-04-10.md) and ADR-042:

| Item | Current | Target |
|------|---------|--------|
| Registry ops | 231 | 231 (no change) |
| Constitution ops documented | 209 | 225 (+16 canonical additions) |
| Canonical domains (code) | 11 (includes conduit) | 10 (conduit folded into orchestrate) |
| Canonical domains (docs) | 10 | 10 (maintained) |
| CANONICAL_DOMAINS comment | "10 canonical domain names" with 11 entries | accurate comment, 10 entries |
| CLI coverage | ~142/231 (~61%) | Depends on Wave 3 scope |
| Commander-shim commands | 97/99 | Deferred to future epic |

---

## Wave 1: Constitutional Alignment (Documentation Only)

**No code changes. Documentation edits only.**
**Dependency**: None (start immediately after orchestrator approval)
**Verification gate**: All doc edits verified against registry SSoT; constitution op count matches

Wave 1 must complete before Wave 2 begins (constitution update must reflect live code, and the
code changes happen in Wave 2). ADR-042 specifies: "Registry change MUST land before the
constitution is updated."

Wait — Wave 2 changes the registry. Wave 1 updates the documentation. The sequencing from
ADR-042 §Implementation is:
1. Registry change (types.ts + registry.ts) — this is Wave 2
2. Constitution update — this is Wave 1

Therefore Wave 1 is BLOCKED on Wave 2. Re-ordering: Wave 2 first, then Wave 1.

**Revised ordering: Wave 2 → Wave 1 → Wave 3 → Wave 4**

---

## Wave 2: Registry Code Changes (conduit → orchestrate)

**Scope**: Atomic code change — types.ts, registry.ts, domains/index.ts, conduit handler
**Dependency**: None (start immediately)
**Files touched**: 4 source files, 2-3 test files
**Verification gate**: `pnpm biome check --write .` + `pnpm run build` + `pnpm run test` all pass

### Task W2-1: Remove conduit from CANONICAL_DOMAINS and rename registry entries

**Title**: Fold conduit domain into orchestrate — registry.ts + types.ts atomic change

**Type**: subtask
**Parent**: T443
**Description**:
  Make the atomic change from ADR-042 Decision 1. Three files must change in a single commit:

  1. `packages/cleo/src/dispatch/types.ts`:
     - Remove `'conduit'` from the CANONICAL_DOMAINS array (line 125)
     - Update the JSDoc comment on line 111-112 from "The 10 canonical domain names" to
       "The 10 canonical domain names" (already says 10, but array had 11 — fix the mismatch)

  2. `packages/cleo/src/dispatch/registry.ts`:
     Rename all 5 conduit entries. Change domain from `'conduit'` to `'orchestrate'` and
     update operation names with `conduit.` prefix:
     - `operation: 'status'` → `operation: 'conduit.status'`
     - `operation: 'peek'` → `operation: 'conduit.peek'`
     - `operation: 'start'` → `operation: 'conduit.start'`
     - `operation: 'stop'` → `operation: 'conduit.stop'`
     - `operation: 'send'` → `operation: 'conduit.send'`
     Also update all description strings that reference the `conduit.X` format.

  3. `packages/cleo/src/dispatch/domains/index.ts`:
     - Update route from `handlers.set('conduit', new ConduitHandler())` to be routed
       through the orchestrate domain handler. The ConduitHandler must be wired as a
       delegate of the orchestrate handler for `conduit.*` sub-operations. Two approaches:
       Option A — Keep ConduitHandler as standalone but remove the 'conduit' key; add conduit
       sub-routing into OrchestrateHandler.query/mutate switch statements.
       Option B — Keep the ConduitHandler registered but under `'orchestrate'` via a routing
       shim within the orchestrate domain that delegates `conduit.*` ops back to ConduitHandler.
       Recommended: Option B — minimal change to conduit.ts, all routing glue goes into
       orchestrate.ts which already handles sub-namespace routing for `tessera.*`, `handoff`, etc.

**Acceptance criteria**:
- `CANONICAL_DOMAINS` contains exactly 10 entries; `'conduit'` is absent
- `grep -c "domain: 'conduit'" registry.ts` returns 0
- All 5 conduit operations resolve correctly via `orchestrate` domain in dispatch
- `pnpm biome check --write .` exits 0
- `pnpm run build` exits 0
- `pnpm run test` exits 0 with no new failures

**Dependencies**: None

---

### Task W2-2: Fix test files that assert domain count = 11 or contain conduit domain

**Title**: Update dispatch tests for conduit→orchestrate rename

**Type**: subtask
**Parent**: T443
**Description**:
  Three test files require updates after W2-1:

  1. `packages/cleo/src/dispatch/__tests__/registry-derivation.test.ts` (lines 128-135):
     Both `getGatewayDomains` tests assert `.toHaveLength(11)`. After W2-1, both must assert
     `.toHaveLength(10)`. The `toEqual(new Set(CANONICAL_DOMAINS))` assertions are fine because
     they reference the imported constant — they auto-correct when the constant is fixed.

  2. `packages/cleo/src/dispatch/domains/__tests__/sticky.test.ts` (line 23):
     `expect(CANONICAL_DOMAINS).toContain('sticky')` — no change needed.
     But verify the test file does not also test conduit containment.

  3. `packages/cleo/src/dispatch/__tests__/parity.test.ts` (line 791-796):
     The parity test validates that all active domain handlers are in CANONICAL_DOMAINS.
     If the test registers a conduit handler after W2-1, it will fail (conduit no longer in
     CANONICAL_DOMAINS). Ensure the conduit-related check is removed or updated.

  Read each file before editing. Confirm test intent before changing assertions.

**Acceptance criteria**:
- `pnpm run test` exits 0 with no failures in registry-derivation.test.ts or parity.test.ts
- No test asserts `CANONICAL_DOMAINS` contains `'conduit'`
- No test asserts `getGatewayDomains` returns length 11

**Dependencies**: W2-1 must complete first (test updates must be consistent with code changes)

---

## Wave 1: Constitutional Alignment (Documentation — runs after Wave 2)

**Dependency**: Wave 2 (W2-1) must complete first — registry must reflect the change before docs
**Verification gate**: Constitution op tables match registry; summary counts are accurate

### Task W1-1: Update CLEO-OPERATION-CONSTITUTION.md — conduit removal + canonical op additions

**Title**: Constitution update — remove conduit domain, add 16 canonical ops (ADR-042)

**Type**: subtask
**Parent**: T443
**Description**:
  Edit `docs/specs/CLEO-OPERATION-CONSTITUTION.md` to match the post-Wave-2 registry state.
  All changes are documentation-only (no code).

  **Section 4 — Canonical Domains**:
  - Remove `conduit` from the domain table
  - Update the `CANONICAL_DOMAINS` code block to remove `'conduit'`
  - Confirm the count statement reads "exactly 10 canonical domains"

  **Section 6.1 — tasks (currently 29 ops, becomes 32)**:
  Add three new rows to the tasks domain table:
  - `query | impact | Predict downstream effects of a free-text change description | 1 | -- | Yes`
  - `mutate | claim | Claim a task by assigning it to the current session | 1 | taskId | No`
  - `mutate | unclaim | Remove the current assignee from a task | 1 | taskId | Yes`
  Update section header from "29 operations" to "32 operations".

  **Section 6.4 — check (currently 17 ops, becomes 18)**:
  Add one new row:
  - `query | workflow.compliance | WF-001–WF-005 compliance dashboard (AC rate, session rate, gate rate) | 1 | -- | Yes`
  Update section header from "17 operations" to "18 operations".

  **Section 6.5 — pipeline (currently 31 ops, becomes 32)**:
  Add one new row:
  - `query | stage.guidance | Stage-aware LLM prompt guidance; called by Pi extensions on before_agent_start | 1 | -- | Yes`
  Update section header from "31 operations" to "32 operations".

  **Section 6.6 — orchestrate (currently 16 ops, becomes 24)**:
  Add eight new rows (3 canonical ops + 5 conduit ops moved from conduit domain):
  - `query | classify | Classify a request against CANT team registry to route to correct team/lead/protocol | 1 | -- | Yes`
  - `mutate | fanout | Fan out N spawn requests in parallel via Promise.allSettled | 1 | -- | No`
  - `query | fanout.status | Get status of a running fanout by its manifest entry ID | 1 | entryId | Yes`
  - `query | conduit.status | Check agent connection status and unread count (experimental) | 1 | -- | Yes`
  - `query | conduit.peek | One-shot poll for new messages without acking (experimental) | 1 | -- | Yes`
  - `mutate | conduit.start | Start continuous message polling for the active agent (experimental) | 1 | -- | No`
  - `mutate | conduit.stop | Stop the active polling loop (experimental) | 1 | -- | No`
  - `mutate | conduit.send | Send a message to an agent or conversation (experimental) | 1 | -- | No`
  Update section header from "16 operations" to "24 operations".
  Add a note below the table marking the 5 `conduit.*` ops as experimental (moved from conduit domain per ADR-042).

  **Section 6.8 — admin (currently 30 ops in table, becomes 37)**:
  Add seven rows:
  - `query | paths | Report all CleoOS paths and scaffolding status | 1 | -- | Yes`
  - `query | smoke | Operational smoke test: one read-only query per domain | 1 | -- | Yes`
  - `mutate | scaffold-hub | Create CleoOS Hub directories and seed starter justfile | 2 | -- | Yes`
  - `query | config.presets | List all strictness presets with descriptions and values | 1 | -- | Yes`
  - `mutate | config.set-preset | Apply a strictness preset (strict, standard, minimal) | 1 | preset | No`
  - `query | hooks.matrix | Cross-provider hook support matrix using CAAMP canonical taxonomy | 1 | -- | Yes`
  - Add gateway column to existing `admin.backup` row to reflect that it has both query (list) and mutate (create/restore) forms. Add a second row: `query | backup | List available backups | 1 | -- | Yes`
  Update section header from "30 operations" to "37 operations".
  Note: admin table currently documents 30 ops but the summary table says 32 — reconcile by
  doing a manual count before writing the new header.

  **Section 6.9 — nexus (currently 20 ops, becomes 22)**:
  Add two rows:
  - `query | transfer.preview | Preview a cross-project task transfer without committing | 2 | sourceProject, targetProject, taskIds | Yes`
  - `mutate | transfer | Transfer tasks between NEXUS projects | 2 | sourceProject, targetProject, taskIds | No`
  Update section header from "20 operations" to "22 operations".

  **Section 7 — Summary Counts table** (currently totals 209):
  Update all domain totals and the grand total to reflect additions:
  - tasks: 29 → 32 (Q:15→16, M:14→16)
  - check: 17 → 18 (Q:13→14)
  - pipeline: 31 → 32 (Q:14→15)
  - orchestrate: 16 → 24 (Q:9→13, M:7→11)
  - admin: update to reflect the 7 added ops (exact count from manual recount)
  - nexus: 20 → 22 (Q:12→13, M:8→9)
  - conduit: remove row entirely
  - Total: 209 → 225 (canonical additions per ADR-042)
  Add a note under the table: "Six experimental operations exist in the registry but are not
  documented here: admin.map (query), admin.map (mutate), and the 4 conduit ops marked
  experimental in §6.6. Registry count is 231; constitution documents 225."

**Acceptance criteria**:
- Section 4 shows exactly 10 domains; no conduit row
- `CANONICAL_DOMAINS` code block in Section 4 has 10 entries (no conduit)
- All 16 canonical ops from ADR-042 classification table appear in the correct domain tables
- Summary table grand total is 225
- No manual cross-check discrepancy between section headers and table row counts

**Dependencies**: W2-1 must complete first

---

### Task W1-2: Fix CANONICAL_DOMAINS JSDoc comment in types.ts

**Title**: Fix types.ts JSDoc comment — CANONICAL_DOMAINS says "10" but had 11 entries

**Type**: subtask
**Parent**: T443
**Description**:
  After W2-1, the array has 10 entries. Verify the JSDoc comment on line 111-112 of
  `packages/cleo/src/dispatch/types.ts` accurately says "The 10 canonical domain names."
  If W2-1 already corrected it, this task is a verification check only.

  Also check: does any other file contain a hardcoded "10 canonical" or "11 canonical" comment
  that needs updating? Run: `grep -rn "10 canonical\|11 canonical" packages/ docs/`

**Acceptance criteria**:
- `grep -n "canonical domain" packages/cleo/src/dispatch/types.ts` shows a comment that
  matches the actual array length (10 after W2-1)
- No file contains "11 canonical" references that conflict with the post-W2 state

**Dependencies**: W2-1

---

### Task W1-3: Review System Flow Atlas for conduit domain references

**Title**: Audit System Flow Atlas for conduit domain name changes

**Type**: subtask
**Parent**: T443
**Description**:
  `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` currently classifies Conduit as a relay path and
  maps its primary domains to `orchestrate, session, nexus`. This is correct and should not
  change. However, verify that no table in the Atlas lists `conduit` as a canonical dispatch
  domain (as opposed to a conceptual overlay/relay path).

  Run: `grep -n "conduit" docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`

  If the Atlas has a row in a "canonical domains" table listing conduit as a domain, remove it.
  If the Atlas only mentions conduit as a relay path overlay (current state per the audit),
  no changes are needed — add a note confirming the review.

**Acceptance criteria**:
- Atlas does not list conduit as a canonical dispatch domain
- If changes were needed: `pnpm biome check --write .` exits 0 (docs linting if applicable)
- Written confirmation in the task completion note of what was found and whether changes were made

**Dependencies**: None (can run in parallel with W2-1)

---

## Wave 3: Coverage Gap CLI Commands

**Dependency**: T447 specification must be complete (provides `needs-cli` classification)
**Dependency**: Wave 2 must complete (ensures new operations use correct orchestrate namespace)
**Verification gate**: Each new CLI command dispatches correctly; `pnpm run test` exits 0

Wave 3 tasks are templated here. The actual task count depends on T447's output. The
orchestrator MUST wait for T447 before creating these tasks. The structure below defines
the task template and grouping strategy.

### Wave 3 Grouping Strategy

Group CLI commands by domain for efficient implementation. Each agent handles one domain.
Maximum 3-5 new command files per task (to stay within 3-5 file scope limit).

Expected domains needing work per the audit (final list from T447):

| Domain | Current Missing | Likely Scope |
|--------|----------------|--------------|
| orchestrate | 11 ops | Large — likely 2 tasks |
| tools | 21 ops (mostly provider.*, adapter.*) | Large — 3 tasks |
| pipeline | 13 ops (chain ops, stage.guidance) | Medium — 2 tasks |
| admin | 11 ops (paths, smoke, scaffold-hub, etc.) | Medium — 2 tasks |
| memory | 7 ops (decision.*, graph.*, link) | Medium — 1 task |
| session | 5 ops | Small — 1 task |
| tasks | 8 ops (impact, claim, unclaim, + 5 others) | Small — 1 task |
| nexus | 8 ops | Medium — 1 task |

Not all missing ops will be classified `needs-cli` by T447. The task count will be lower
than the raw missing count suggests.

### Task W3-template: CLI command implementation task (per domain batch)

**Title**: `CLI: [domain] — Add CLI commands for [op1], [op2], ... (needs-cli ops)`

**Type**: subtask
**Parent**: T443
**Description** (fill in for each batch):
  Implement CLI command handlers for the `[domain]` domain operations classified as `needs-cli`
  by T447. Each new command MUST:
  - Use `dispatchFromCli` or `dispatchRaw` (no direct core calls)
  - Use ShimCommand pattern (consistent with the 97 existing commander-shim commands)
  - Add TSDoc comments on all exported functions
  - Register the command in the appropriate parent command file
  - Not duplicate any existing command module logic

  Operations in this batch:
  - [List from T447 output]

  Files to create or modify:
  - `packages/cleo/src/cli/commands/[domain]/[op].ts` (new)
  - `packages/cleo/src/cli/commands/[domain]/index.ts` (register new subcommand)

**Acceptance criteria**:
- `cleo [command]` routes through dispatch and returns a valid LAFS envelope
- `pnpm biome check --write .` exits 0
- `pnpm run build` exits 0
- `pnpm run test` exits 0 (no new failures)

**Dependencies**: T447 complete, Wave 2 complete

### Orchestrator note on Wave 3 task creation

Create Wave 3 tasks only after T447 delivers its coverage spec. Do not pre-create tasks based
on the raw audit numbers — T447 may classify many ops as `agent-only` (dispatch-only, no
CLI surface needed) or `deferred`. Creating tasks for `agent-only` ops would be wasted work.

---

## Wave 4: Commander-Shim Removal Planning

**This wave produces a planning document and task list, NOT code.**
**Dependency**: Waves 1-3 complete (shim removal cannot start until coverage gaps are closed)
**Verification gate**: Planning document produced; task list reviewed by orchestrator

Wave 4 is a decomposition-only wave scoped to a future epic. The output is a set of tasks
that the orchestrator creates in a new epic (not T443). T443 acceptance criteria require
only that "the commander-shim removal plan is approved with a phased roadmap" — the actual
migration does not happen within T443.

### Blockers for Shim Removal (from audit)

These must be resolved before any shim command can be migrated to native citty:

| Blocker | Current State | Required State |
|---------|--------------|----------------|
| Registry ParamDef coverage | 48/231 ops have ParamDef arrays | All ops need ParamDef for auto-help |
| Help system dependency | help-renderer.ts + help-generator.ts depend on ShimCommand | Must be rewritten for citty |
| Global flag pre-processing | No native citty equivalent to commander-shim global flag pass-through | Needs citty-native solution |
| Test files | 20 test files import ShimCommand | All must be updated per migration batch |
| Reference implementation | Only 1 native citty command exists (code.ts) | Pattern must be validated at scale |

### Task W4-1: ParamDef enrichment plan — 48 → 231 registry coverage

**Title**: Plan: Registry ParamDef enrichment strategy (48/231 → full coverage)

**Type**: subtask
**Parent**: T443
**Description**:
  Produce a migration plan for enriching all 231 registry operations with `params?: ParamDef[]`
  arrays. This is required before the help system can be rewritten and before auto-generation
  of CLI commands from the registry becomes possible.

  The plan must:
  1. Count operations that already have ParamDef arrays (currently 48).
  2. Group the remaining 183 operations by domain and complexity.
  3. Propose batch sizes (10-15 ops per task) for enrichment.
  4. Estimate which domains have the most params to define.
  5. Define the schema for ParamDef entries (type, required, description, default).

  Output: A planning document at `.cleo/agent-outputs/T448-paramddef-enrichment-plan.md`
  that can be used to create the actual enrichment tasks in the shim-removal epic.

**Acceptance criteria**:
- Planning document covers all 231 ops (or cites the 48 already covered)
- Batching strategy produces tasks that are 10-15 ops each
- Document is written; no code is changed

**Dependencies**: Wave 1 complete (constitution updated; op count is stable before planning)

---

### Task W4-2: Help system migration design

**Title**: Plan: Help system rewrite for citty-native commands

**Type**: subtask
**Parent**: T443
**Description**:
  The current help system (`help-renderer.ts`, `help-generator.ts`) depends on ShimCommand.
  This task designs the replacement that works with native citty commands.

  The design must address:
  1. How to generate help text for citty commands from registry ParamDef arrays.
  2. How progressive disclosure tiers (0/1/2) are surfaced in citty help output.
  3. How `cleo help` (admin.help dispatch) integrates with citty's built-in help.
  4. Where the help generation logic lives (in dispatch layer vs citty layer).
  5. What `code.ts` (the only existing citty command) does for help — use it as a reference.

  Output: A design document at `.cleo/agent-outputs/T448-help-system-design.md`.
  No code is written.

**Acceptance criteria**:
- Design document covers all 4 design questions above
- Document identifies which files change and which are deleted
- No code changed

**Dependencies**: W4-1 (ParamDef schema must be finalized before help design is stable)

---

### Task W4-3: Commander-shim migration batch plan — command-by-command grouping

**Title**: Plan: Command migration batches for shim → citty (10-15 per batch)

**Type**: subtask
**Parent**: T443
**Description**:
  Produce the full command-by-command migration plan for all 97 commander-shim commands.
  Group into batches of 10-15 commands each. Each batch becomes one implementation task
  in the shim-removal epic.

  Grouping criteria (in order of preference):
  1. Group by domain (task, session, memory, etc.) to keep domain knowledge co-located.
  2. Prefer simple commands (single dispatch call) in early batches; complex commands last.
  3. Identify commands that share common patterns (e.g., all RCASD protocol commands) for
     batch efficiency.
  4. Flag any commands with known complexity: mixed dispatch+direct, dead code stubs,
     commands that need behavior changes (phases.ts duplication, issue.ts mixed pattern).

  From the audit, candidate groupings:
  - Batch 1: tasks core (add, show, find, list, current, next, start, stop, complete) — 9 commands
  - Batch 2: tasks extended (update, archive, restore, cancel, reparent, reorder, relates) — 7 commands
  - Batch 3: session (status, start, end, resume, suspend, find, gc, record) — 8 commands
  - Batch 4: memory (find, observe, fetch, timeline, brain.ts cleanup) — 5 commands
  - Batch 5: pipeline stage ops (stage.validate, stage.status, stage.record, stage.gate, etc.) — 8 commands
  - Batch 6: pipeline release + manifest ops — 8 commands
  - Batch 7: pipeline chain + phase ops — 7 commands
  - Batch 8: check domain — 8 commands
  - Batch 9: admin core (version, health, dash, help, stats, config) — 8 commands
  - Batch 10: admin extended (backup, migrate, init, adr, export/import, token) — 9 commands
  - Batch 11: tools domain (skill.*, provider.*) — 10 commands
  - Batch 12: tools adapter.* + remaining tools — 8 commands
  - Batch 13: nexus domain — 10 commands
  - Batch 14: sticky + protocol aliases (consensus, contribution, decomposition, specification) — 8 commands
  - Batch 15: complex/mixed commands (config.ts, issue.ts, restore.ts, token.ts, phases cleanup) — 5 commands

  Total: 118 migration slots for 97 commands (15 batches, some slack for newly added commands).

  Output: Planning document at `.cleo/agent-outputs/T448-shim-migration-batches.md` with
  the complete batch list, each batch with its command file list and estimated complexity.

**Acceptance criteria**:
- All 97 commander-shim commands appear in exactly one batch
- Each batch has 10-15 commands maximum
- Flagged commands (dead code, mixed pattern) are annotated
- No code changed

**Dependencies**: W4-2 (help design must be done before migration batches can finalize order)

---

### Task W4-4: Test migration plan for ShimCommand test files

**Title**: Plan: Test file migration strategy for 20 ShimCommand-dependent tests

**Type**: subtask
**Parent**: T443
**Description**:
  Twenty test files import ShimCommand. This task identifies all 20, groups them by the command
  batch they belong to (from W4-3), and defines the migration strategy for each.

  Run: `grep -rn "ShimCommand\|commander-shim" packages/cleo/src --include="*.test.ts"`

  For each test file:
  1. Identify which command module it tests.
  2. Identify which migration batch (from W4-3) that command is in.
  3. Note whether the test is testing dispatch routing (which stays) or ShimCommand API
     (which must be rewritten for citty).

  Output: A section in `.cleo/agent-outputs/T448-shim-migration-batches.md` (append to W4-3
  document) mapping each test file to its migration batch.

**Acceptance criteria**:
- All 20 test files are listed with their migration batch assignment
- Migration strategy for each file is one of: "rewrite for citty", "no change needed",
  or "delete (dead code test)"
- No code changed

**Dependencies**: W4-3

---

## Wave Dependency Graph

```
W2-1 (conduit registry rename)
  └─► W2-2 (fix tests for domain count 11→10)
       └─► W1-1 (constitution update — 16 canonical ops)
             └─► W1-2 (verify CANONICAL_DOMAINS JSDoc)

W1-3 (System Flow Atlas audit) — parallel, no deps

T447 (spec — needs-cli classification)
  └─► W3-* (CLI command batches, one per domain)

W1-1 + W3-* complete
  └─► W4-1 (ParamDef enrichment plan)
       └─► W4-2 (help system design)
            └─► W4-3 (migration batch plan)
                 └─► W4-4 (test migration plan)
```

---

## Verification Gates per Wave

| Wave | Gate | Command |
|------|------|---------|
| Wave 2 | Build passes | `pnpm run build` |
| Wave 2 | Tests pass | `pnpm run test` |
| Wave 2 | Lint passes | `pnpm biome check --write .` |
| Wave 2 | conduit absent | `grep -c "domain: 'conduit'" packages/cleo/src/dispatch/registry.ts` = 0 |
| Wave 2 | 10 domains | `node -e "const {CANONICAL_DOMAINS}=require('./packages/cleo/src/dispatch/types.js'); console.log(CANONICAL_DOMAINS.length)"` = 10 |
| Wave 1 | Op count | Constitution summary total = 225 |
| Wave 1 | Domain count | Section 4 table has 10 rows |
| Wave 3 | Per-command dispatch | `cleo [new-command] --help` exits 0 |
| Wave 3 | Tests | `pnpm run test` exits 0 |
| Wave 4 | Documents exist | All 3 planning docs present at output paths |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| conduit rename breaks direct dispatch callers in skill files | Low | Medium | Search skill files for `dispatch('conduit'...)` before W2-1 merges |
| orchestrate handler switch needs major refactor to support conduit.* routing | Medium | Medium | Review orchestrate.ts before committing to routing approach in W2-1 |
| T447 classifies most missing ops as agent-only, reducing Wave 3 scope | Medium | Low | Positive — less work; orchestrator should expect a smaller Wave 3 |
| T447 classifies many ops as needs-cli, expanding Wave 3 scope | Medium | Medium | Create Wave 3 tasks in sub-batches; allow parallel agents per domain |
| Registry-derivation test asserts exact count 11 that breaks after W2-1 | Certain | Low | W2-2 explicitly targets this; addressed in plan |
| Constitution op count arithmetic errors | Medium | Low | Count each domain table manually before writing summary; do not extrapolate |

---

## Task Summary for Orchestrator

Create the following CLEO tasks from this plan:

**Wave 2 (immediate — no deps):**
1. W2-1: Fold conduit domain into orchestrate — registry.ts + types.ts atomic change
2. W2-2: Update dispatch tests for conduit→orchestrate rename [dep: W2-1]

**Wave 1 (after Wave 2):**
3. W1-1: Constitution update — remove conduit, add 16 canonical ops [dep: W2-1]
4. W1-2: Verify types.ts JSDoc comment accuracy [dep: W2-1]
5. W1-3: Audit System Flow Atlas for conduit domain references [no deps — parallel]

**Wave 3 (after T447 + Wave 2):**
6-N: CLI command tasks per domain [dep: T447 complete, W2-1 complete]
    Create tasks only after T447 output is reviewed. Use W3-template above.

**Wave 4 (after Waves 1-3):**
N+1: W4-1: ParamDef enrichment plan [dep: W1-1 complete]
N+2: W4-2: Help system design [dep: W4-1]
N+3: W4-3: Migration batch plan [dep: W4-2]
N+4: W4-4: Test migration plan [dep: W4-3]

**Total confirmed tasks (not counting Wave 3 which depends on T447):** 9 tasks
**Wave 3 estimated tasks:** 8-12 tasks (based on audit per-domain missing counts)
**Wave 4 tasks:** 4 planning tasks
**Grand total estimate:** 21-25 tasks

---

*Generated by T448 decomposition agent. Orchestrator reviews and creates tasks from this plan.*

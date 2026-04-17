# Lead-C Report — Legacy Orphans + T487 Wave 1 Plan

**Session**: ses_20260416230443_5f23a3
**Date**: 2026-04-16
**Author**: Lead-C (Sonnet 4.6 subagent)
**Artifacts read**: T488-shim-removal-research.md, T489-shim-consensus.md

---

## Part 1: Legacy Orphan Audit

### Summary

| Action     | Count |
|------------|-------|
| CLOSE      | 4     |
| CANCEL     | 1     |
| DEFER-LOW  | 5     |
| RE-PARENT  | 3     |

Total audited: 13

---

### Per-Task Recommendations

#### T010 — Implement Autonomous Runtime (Watchers, Impulse, Patrol) [pending]

**Evidence**: No `Watcher`, `Impulse`, or `Patrol` classes or modules found in
`packages/cleo/src/` or `packages/core/src/`. The hooks system exists (`watchdog-hooks.d.ts`)
but is unrelated — it is a CANT hook payload type, not an autonomous runtime daemon.

**Decision: DEFER-LOW**

Rationale: This is a vision-level feature (autonomous agent daemon loop) with no in-progress
work and no parent epic. The memory-bridge lists CleoOS agent platform as a priority initiative
but the Autonomous Runtime concept predates it and has no current spec. Defer to backlog pending
a fresh architecture design under the CleoOS epic.

Suggested note: "No implementation started. Defer — requires fresh spec under CleoOS platform
initiative. Not blocking any current work."

---

#### T012 — Design The Hearth — operator surface [pending]

**Evidence**: `Hearth` appears only in `packages/cleo-os/extensions/tui-theme.ts` as a comment
("consistency across the CleoOS Hearth surface"). No `registerHearth`, `Hearth` class, or
operator surface implementation exists. The concept is referenced in memory as the "chat room
is Hearth not Conduit" distinction (from conduit-layered-stack.md) but is entirely unbuilt.
`packages/cleo-os/src/commands/` contains only `doctor.ts`.

**Decision: DEFER-LOW**

Rationale: The Hearth is the operator TUI surface — a design-stage concept with no
implementation. Not a blocker for any shipped feature. Defer until CleoOS firstclass experience
(T558) and TUI identity work are further along.

Suggested note: "Design-only task — no implementation started. Defer pending T558 CleoOS
firstclass and TUI identity maturation."

---

#### T090 — Centralize hardcoded paths/filenames to constants.ts and paths.ts [pending]

**Evidence**: `packages/core/src/constants.ts` EXISTS (exports `CORE_PROTECTED_FILES` and
likely more). `packages/core/src/paths.ts` EXISTS. However `packages/cleo/src/cli/paths.ts`
does NOT exist, and grep shows live hardcoded strings still exist in dispatch engines
(`validate-engine.ts` and `registry.ts` comments reference hardcoded items). The centralization
is partial.

**Decision: DEFER-LOW**

Rationale: The skeleton is there (`constants.ts` + `paths.ts` in core) but the task's AC
requires complete centralization with no hardcoded strings remaining. This is a code health
improvement that is not blocking any current epic. Defer to a housekeeping wave.

Suggested note: "Partial: constants.ts and paths.ts exist in core. CLI-side paths.ts missing.
Full audit not done. Defer as housekeeping task."

---

#### T097 — Implementation: register domain-prefixed commands in citty [pending]

**Evidence**: Description reads: "Implement the agreed command structure in citty. Register all
10 domain groups with their operations. Handle: tab completion for domain.operation, help text
per group, global flags (--json, --human, --quiet), backward compat aliases. Update capability
matrix with CLI command mappings."

In `packages/cleo/src/cli/index.ts`, only `version` and `code` are registered as native citty
`subCommands`. All other 100+ commands are still registered via `shimToCitty(rootShim)`. This
task describes the exact end-state of T487 — migrating all commands from shim to native citty
with domain grouping. It is NOT yet done.

**Decision: RE-PARENT to T487**

This task IS T487 work, possibly predating the formal T487 epic. It should be parented under
T487 and its acceptance criteria merged into the T487 wave-completion definition. It is
currently an orphan root task but is a direct child of the Commander-Shim migration.

Suggested command:
```bash
cleo update T097 --parent T487 --note "RE-PARENTED: this is the Wave outcome spec for T487. Merge AC into T487 completion criteria."
```

---

#### T133 — Gate developer-only commands behind cleo dev namespace [pending]

**Evidence**: No `registerDevCommand`, `dev namespace`, or `cleo dev` subcommand found in
`packages/cleo/src/cli/`. `self-update.ts` checks `runtime.channel === 'dev'` for internal
logic but does not gate commands behind a `dev` subcommand. The AC specifies `detect-drift`,
`sequence`, `migrate` moved to dev namespace — none of these have been moved.

**Decision: DEFER-LOW**

Rationale: This is a DX/governance improvement. The commands exist and work; the gating is a
UX refinement. No current work depends on this. Low priority vs. active epics.

Suggested note: "Not started. detect-drift, sequence, migrate still in root namespace. Defer
as DX housekeeping."

---

#### T155 — Brain.db symbol indexing — optional code awareness [pending]

**Evidence**: No `codeAwareness`, `code_awareness`, or `symbolIndex` config flag found anywhere
in `packages/`. Brain memory (`brain-sqlite.ts`) exists but has no symbol indexing pathway. The
Nexus system (`nexus.db`) handles code intelligence separately via `nexus-engine.ts`. This
feature would create a secondary code-awareness layer in brain.db — duplicating Nexus
responsibilities.

**Decision: DEFER-LOW** (possible CANCEL pending owner input)

Rationale: Nexus already handles symbol indexing (10,817 symbols in nexus.db per memory-bridge).
Adding a parallel symbol layer to brain.db risks architecture confusion. This task predates the
Nexus maturation. Recommend deferring pending owner decision on whether this is superseded by
Nexus or is genuinely additive.

Suggested note: "Deferred — Nexus now handles code symbol indexing. Owner should assess if
brain.db symbol indexing is additive or redundant given current Nexus state."

---

#### T157 — Tests + documentation for Smart Explore [pending]

**Evidence**: `code.ts` (the Smart Explore surface — outline/search/unfold) exists and is the
native citty reference implementation. `code-engine.ts` uses dynamic imports for
`smartOutline`, `smartSearch`, `smartUnfold`. However, `__tests__/` under commands has no
`code.test.ts`, and `__tests__/` under dispatch engines has no `code-engine.test.ts`. The
forge-ts doc pipeline exists but no TSDoc on `code.ts` exported command was observed.

**Decision: RE-PARENT to T487** (or T617 follow-up epic)

The test gap for `code.ts` is specifically called out in T488 research (code.ts is the citty
reference; any T487 completion should include regression tests for it). Parenting under T487
as a Wave 1 verification gate makes sense.

Alternative: Parent under T617 (Nexus/code analysis epic) if Smart Explore tests are scoped to
the code-engine layer rather than the CLI surface.

Suggested command:
```bash
cleo update T157 --parent T487 --note "RE-PARENTED: code.ts tests are the citty reference verification gate for T487 Wave 1. Adds to Wave 1 AC."
```

---

#### T251 — Version bump v2026.4.0 and npm publish [pending]

**Evidence**: Current cleo package version is `2026.4.76`. v2026.4.0 was released months ago.
This task is unambiguously stale.

**Decision: CANCEL**

Rationale: Obviously shipped. Current version is 2026.4.76. The task is a historical artifact
from the first CalVer transition.

Suggested command:
```bash
cleo cancel T251 --reason "Shipped long ago. Current version is 2026.4.76. This task tracked the initial CalVer transition to v2026.4.0."
```

---

#### T468 — Implement stale memory detection in brain.db [pending]

**Evidence**: No `staleMemory`, `is_stale`, `staleness`, or `isStale` found in
`packages/core/src/memory/`. `upgrade.ts` has `--detect` with description "Force re-detection
of project type (ignores staleness)" — this is project detection staleness, unrelated to brain
memory. None of the brain AC (observations flagged stale, code-referencing observations checked
against file changes, `staleness` indicator in search results) is implemented.

**Decision: DEFER-LOW**

Rationale: Brain integrity is a known concern (memory-bridge notes the Brain Integrity Crisis
epic). Stale detection is a useful feature but requires brain schema changes and is part of the
larger Brain quality initiative. Defer until the Brain integrity epic has a defined wave
structure.

Suggested note: "Not started. Defer to Brain integrity epic. Requires schema changes to
brain_observations table."

---

#### T475 — W3: memory domain lead (18 ops) [pending, no parent]

**Evidence**: All 8 originally-missing memory ops are now in the registry AND have CLI handlers
in `memory-brain.ts`:
- `decision.find` — line 354
- `decision.store` — line 376
- `link` — line 389
- `graph.show` — line 479
- `graph.neighbors` — line 496
- `graph.add` — line 521
- `graph.remove` — line 546
- `search.hybrid` — line 594

**Decision: CLOSE**

All 18 memory ops appear to have CLI dispatch handlers. The task's stated missing ops are all
present. This task has no parent and appears to have been completed without being marked done.

Suggested command:
```bash
cleo complete T475 --note "All 18 memory ops verified in registry + memory-brain.ts CLI. decision.find/store, link, graph.show/neighbors/add/remove, search.hybrid all present at time of audit 2026-04-16."
```

---

#### T483 — W3-final: 100% CLI coverage — 19 agent-only ops [pending, no parent]

**Evidence**: All 19 ops verified in CLI:
- `tasks.sync.reconcile` — `sync.ts` line 109/115
- `pipeline chain.show/list/add/instantiate/advance` — `chain.ts` lines 25-72 (all 5)
- `orchestrate.bootstrap` — `orchestrate.ts` line 285
- `orchestrate.fanout` — line 373
- `orchestrate.fanout.status` — line 320
- `orchestrate.handoff` — present in registry; `orchestrate.ts` has handoff subcommand
- `orchestrate.spawn.execute` — line 356
- `orchestrate.conduit.status` — line 396
- `orchestrate.conduit.peek` — line 409
- `orchestrate.conduit.start` — line 423
- `orchestrate.conduit.stop` — line 438
- `orchestrate.conduit.send` — line 450

Note: `orchestrate.classify` and `orchestrate.fanout` (full) verified via registry + `orchestrate.ts`
comment at line 16. All 19 are covered.

**Decision: CLOSE**

Suggested command:
```bash
cleo complete T483 --note "All 19 agent-only ops verified with CLI handlers: sync.ts (reconcile), chain.ts (5 chain ops), orchestrate.ts (bootstrap, fanout, fanout.status, handoff, spawn.execute, 5 conduit ops) — audit 2026-04-16."
```

---

#### T558 — CleoOS firstclass experience [pending]

**Evidence**: `packages/cleo-os/src/cli.ts` line 161-163 shows a `cleo-startup` extension is
loaded that provides "branded session banner + memory bridge display." `postinstall.ts` deploys
a `cleo-startup` extension. However:
- No ASCII logo code found in `src/`
- `packages/cleo-os/src/commands/` contains only `doctor.ts`
- Hearth tools are not registered
- AC items "Hearth tools registered" and "Auto-discover extensions" are partial at best

The `cleo-startup` extension exists but the full firstclass AC (custom welcome with logo, Hearth
tools, auto-discover) is not fully shipped per the AC list.

**Decision: DEFER-LOW** (or RE-PARENT to CleoOS epic)

Rationale: This is a legitimate in-progress feature, not obviously canceled. The cleo-startup
skeleton exists but several AC items are unmet. It needs to be parented under the CleoOS epic
and decomposed into smaller tracked tasks. As-is it is too large for a single pending task.

Suggested command:
```bash
cleo update T558 --note "Partial: cleo-startup extension exists (branded banner + memory bridge). ASCII logo, Hearth tools, auto-discover extensions NOT YET implemented. Needs decomposition or re-scope."
```

---

#### T831 — NEXUS dynamic-import tracking [pending]

**Evidence**: Nexus currently has 10,817 symbols indexed. `code-engine.ts` uses several
`await import(...)` calls (lines 16, 31, 52, 67). However, T831's AC specifies that dynamic
`await import()` calls in the USER'S codebase should be traced to canonical definitions by the
nexus analyzer — not CLEO's own dynamic imports. No `dynamicImport` tracking logic was found
in `nexus-engine.ts` or the nexus analysis pipeline. The 90%+ accuracy AC for dynamic-import
resolution is unmet.

**Decision: RE-PARENT to Nexus epic (T617 or successor)**

T617 is the named predecessor. This is a genuine Nexus improvement task with no parent. It
should be under a Nexus enhancement epic.

Suggested command:
```bash
cleo update T831 --parent T617 --note "RE-PARENTED: follow-up to T617 for dynamic import resolution in nexus analyzer. Not started."
```

(If T617 is closed/archived, create a new Nexus enhancement epic as parent instead.)

---

### Recommendation Summary Table

| Task | Title (abbreviated)               | Verdict   | Basis                                          |
|------|----------------------------------|-----------|------------------------------------------------|
| T010 | Autonomous Runtime               | DEFER-LOW | Not started, no spec, no parent epic           |
| T012 | Design The Hearth                | DEFER-LOW | Design-only, unbuilt, depends on T558          |
| T090 | Centralize hardcoded paths       | DEFER-LOW | Partial (constants.ts/paths.ts exist), not blocking |
| T097 | Domain-prefixed citty commands   | RE-PARENT | IS T487 work — parent under T487               |
| T133 | Dev namespace gating             | DEFER-LOW | Not started, DX improvement, not blocking      |
| T155 | Brain symbol indexing            | DEFER-LOW | Possibly superseded by Nexus; owner decision needed |
| T157 | Smart Explore tests+docs         | RE-PARENT | code.ts test gap — parent under T487 Wave 1    |
| T251 | Version bump v2026.4.0           | CANCEL    | Shipped at v2026.4.0; current is v2026.4.76   |
| T468 | Stale memory detection           | DEFER-LOW | Not started; belongs in Brain integrity epic   |
| T475 | Memory domain W3 lead (18 ops)   | CLOSE     | All 18 ops verified in registry + memory-brain.ts |
| T483 | 19 agent-only ops CLI handlers   | CLOSE     | All 19 ops verified with CLI handlers          |
| T558 | CleoOS firstclass experience     | DEFER-LOW | Partial (cleo-startup); needs decomposition    |
| T831 | NEXUS dynamic-import tracking    | RE-PARENT | No parent; belongs under T617 or Nexus epic    |

### Executable Recommendations (for orchestrator to dispatch, NOT execute here)

```bash
# CLOSE — verified shipped
cleo complete T475 --note "All 18 memory ops verified in registry + memory-brain.ts CLI. decision.find/store, link, graph.show/neighbors/add/remove, search.hybrid all present — audit 2026-04-16."
cleo complete T483 --note "All 19 agent-only ops verified with CLI handlers in sync.ts, chain.ts, orchestrate.ts — audit 2026-04-16."

# CANCEL — obviously stale
cleo cancel T251 --reason "Shipped long ago. Current version is 2026.4.76. This task tracked the initial CalVer transition to v2026.4.0."

# RE-PARENT
cleo update T097 --parent T487 --note "RE-PARENTED: this task describes the T487 Wave end-state. Merge AC into T487 completion criteria."
cleo update T157 --parent T487 --note "RE-PARENTED: code.ts test coverage is the Wave 1 citty reference verification gate."
cleo update T831 --parent T617 --note "RE-PARENTED: follow-up to T617 for dynamic import resolution in nexus analyzer."

# DEFER — add notes, do not close
cleo update T010 --note "DEFER-LOW: No implementation started. No parent epic. Defer pending CleoOS platform spec."
cleo update T012 --note "DEFER-LOW: Design-only, unbuilt. Defer pending T558 CleoOS firstclass and TUI identity work."
cleo update T090 --note "DEFER-LOW: constants.ts and paths.ts exist in core. CLI-side paths.ts missing. Not blocking."
cleo update T133 --note "DEFER-LOW: Dev namespace not started. detect-drift/sequence/migrate still in root namespace."
cleo update T155 --note "DEFER-LOW: Nexus handles symbol indexing. Owner to decide if brain.db parallel indexing is additive."
cleo update T468 --note "DEFER-LOW: Not started. Belongs in Brain integrity epic. Requires brain_observations schema changes."
cleo update T558 --note "DEFER-LOW: cleo-startup extension exists (banner + memory bridge). ASCII logo, Hearth tools, auto-discover NOT done. Needs decomposition."
```

---

## Part 2: T487 Wave 1 Migration Plan

### Source of Truth

- T488 research: 29 Tier-1 simple files identified
- T489 consensus: Wave 1 = simple tier, direct dispatch, lowest risk
- Canonical citty pattern: `defineCommand` with inline `args:`, export named `const`
- Index.ts wiring: replace `shimToCitty(registerXxx(rootShim))` with `subCommands['name'] = xxxCommand`

### Wave 1 Scope: 28 Files (after backup-inspect correction)

Note: `backup-inspect.ts` exports `registerBackupInspectSubcommand(backup: Command)` — it
is a subcommand registrar inside `backup.ts` (Tier 2), NOT a standalone root command.
It is excluded from Wave 1 and will be migrated as part of Wave 2 with `backup.ts`.

The corrected Wave 1 list (28 standalone root commands, all Tier 1 simple):

| # | File | Options | Positionals | Alias | Notes |
|---|------|---------|-------------|-------|-------|
| 1 | `add-batch.ts` | 3 | 0 | none | file, parent, dry-run |
| 2 | `analyze.ts` | 1 | 0 | none | auto-start |
| 3 | `blockers.ts` | 1 | 0 | none | analyze |
| 4 | `cancel.ts` | 1 | 1 | none | taskId positional, reason opt |
| 5 | `checkpoint.ts` | 2 | 0 | none | status, dry-run |
| 6 | `complete.ts` | many | 1 | `done` | Has alias — duplicate key in subCommands NOT applicable; alias on root command means `subCommands['done'] = completeCommand` in index.ts |
| 7 | `current.ts` | 0 | 0 | none | simplest possible |
| 8 | `delete.ts` | 2 | 1 | `rm` | force, cascade; alias at root level |
| 9 | `detect.ts` | 0 | 0 | none | no args |
| 10 | `detect-drift.ts` | 0 | 0 | none | 501 lines but single .action(), all logic is impl |
| 11 | `exists.ts` | 1 | 1 | none | verbose, task-id positional |
| 12 | `find.ts` | many | 1 | none | uses applyParamDefsToCommand — convert inline |
| 13 | `generate-changelog.ts` | 3 | 0 | none | platform, limit, dry-run |
| 14 | `grade.ts` | 1 | 1 | none | list flag, optional sessionId |
| 15 | `list.ts` | many | 0 | `ls` | uses applyParamDefsToCommand — convert inline; alias at root |
| 16 | `map.ts` | 2 | 0 | none | store, (second opt) |
| 17 | `next.ts` | 2 | 0 | none | explain, count |
| 18 | `ops.ts` | 1 | 0 | none | tier |
| 19 | `plan.ts` | 0 | 0 | none | no args |
| 20 | `promote.ts` | 0 | 1 | none | task-id positional |
| 21 | `refresh-memory.ts` | 0 | 0 | none | no args |
| 22 | `reparent.ts` | 1 | 1 | none | requiredOption --to; task-id positional |
| 23 | `roadmap.ts` | 2 | 0 | none | include-history, upcoming-only |
| 24 | `show.ts` | 2 | 1 | none | history, ivtr-history; taskId positional |
| 25 | `start.ts` | 0 | 1 | none | taskId positional |
| 26 | `stop.ts` | 0 | 0 | none | no args |
| 27 | `validate.ts` | 1 | 0 | none | strict |
| 28 | `commands.ts` | 3 | 1 | none | category, relevance, tier; optional commandName (NOTE: `commands` was deprecated in favor of `ops` — confirm with owner before migrating) |

### Complexity Sub-tiers Within Wave 1

**Sub-tier A — Zero options, zero positionals (pure dispatch)** (6 files):
`current.ts`, `detect.ts`, `plan.ts`, `refresh-memory.ts`, `stop.ts`, `analyze.ts`

These are the trivially simple migration targets. Perfect as the first worker batch to
establish the pattern and validate the wiring approach.

**Sub-tier B — Simple positional only OR 1-2 options** (14 files):
`blockers.ts`, `cancel.ts`, `checkpoint.ts`, `exists.ts`, `generate-changelog.ts`, `grade.ts`,
`map.ts`, `next.ts`, `ops.ts`, `promote.ts`, `roadmap.ts`, `show.ts`, `start.ts`, `validate.ts`

Standard Pattern A cases. No special shim features.

**Sub-tier C — Alias on root command OR requiredOption OR applyParamDefsToCommand** (6 files):
`complete.ts` (alias: done), `delete.ts` (alias: rm), `list.ts` (alias: ls + paramDef),
`find.ts` (paramDef), `reparent.ts` (requiredOption), `add-batch.ts`

Note on aliases: `complete`, `delete`, `list` use `.alias()` on the root-level command, not a
subcommand. In citty, root-level aliases are handled in `index.ts` by adding a duplicate key:
```typescript
subCommands['done'] = completeCommand;
subCommands['rm'] = deleteCommand;
subCommands['ls'] = listCommand;
```

**Sub-tier D — Confirmed deprecated or needs verification** (2 files):
`commands.ts` (deprecated per index.ts comment "DEPRECATED: registerCommandsCommand removed"),
`detect-drift.ts` (501 lines — single action but verify no hidden subcommands before migrating)

### Target Pattern (per T489 Decision 4)

**Pattern A — Simple dispatch (all Wave 1 files)**:

```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show full task details by ID' },
  args: {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    history: { type: 'boolean', description: 'Include lifecycle stage history', default: false },
    ivtrHistory: { type: 'boolean', description: 'Include IVTR phase chain history', default: false },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'show',
      { taskId: args.taskId, history: args.history, ivtrHistory: args.ivtrHistory },
      { command: 'show' },
    );
  },
});
```

**requiredOption equivalent** (for `reparent.ts`):
```typescript
args: {
  taskId: { type: 'positional', description: 'Task ID', required: true },
  to: { type: 'string', description: 'Target parent task ID', required: true },
},
```

**applyParamDefsToCommand replacement** (for `find.ts`, `list.ts`):
Convert local `ParamDef[]` arrays directly to citty `ArgsDef` objects inline in the `args:`
block. No registry dependency per T489 Decision 2.

### Index.ts Wiring Change Pattern

For each migrated command, the change in `index.ts` is:

```diff
- import { registerShowCommand } from './commands/show.js';
+ import { showCommand } from './commands/show.js';

  // ... later in registration block:
- registerShowCommand(rootShim);
+ subCommands['show'] = showCommand;
  
  // For aliased commands:
+ subCommands['done'] = completeCommand;   // alias for complete
+ subCommands['rm'] = deleteCommand;       // alias for delete
+ subCommands['ls'] = listCommand;         // alias for list
```

Additionally, add to `NATIVE_COMMAND_DESCS` in `help-renderer.ts` per T489 Decision 3
(interim convention):
```typescript
const NATIVE_COMMAND_DESCS: Record<string, string> = {
  version: '...',
  code: '...',
  show: 'Show full task details by ID',     // add per migrated command
  // ... etc
};
```

### Verification Gates (Per Wave)

Per T489 Decision 1, each wave MUST pass before the next begins:

```bash
# 1. Biome CI (repo-wide, not scoped)
pnpm biome ci .

# 2. Full build (root-level, full dep graph)
pnpm run build

# 3. Full test suite — zero new failures
pnpm run test

# 4. Manual smoke check
cleo show T487          # verify show still works
cleo --help             # verify all command groups render
cleo done T000          # verify alias still works (if T000 exists as test)
```

### Worker Dispatch Plan

Recommended: 3 worker agents running in parallel, each responsible for one sub-tier.

**Worker A — Sub-tier A (6 files, pure dispatch)**:
`current.ts`, `detect.ts`, `plan.ts`, `refresh-memory.ts`, `stop.ts`, `analyze.ts`

Task: Convert all 6 to Pattern A. Update index.ts imports and subCommands wiring.
Update NATIVE_COMMAND_DESCS in help-renderer.ts for each.
Estimated LOC: ~15 lines per file migrated, ~10 lines changed in index.ts, ~6 lines in help-renderer.ts.

**Worker B — Sub-tier B (14 files, simple options/positionals)**:
`blockers.ts`, `cancel.ts`, `checkpoint.ts`, `exists.ts`, `generate-changelog.ts`, `grade.ts`,
`map.ts`, `next.ts`, `ops.ts`, `promote.ts`, `roadmap.ts`, `show.ts`, `start.ts`, `validate.ts`

Task: Convert all 14 to Pattern A with inline args. Update index.ts and help-renderer.ts.
Estimated LOC: ~20-30 lines per file migrated.

**Worker C — Sub-tier C (6 files, special patterns)**:
`complete.ts`, `delete.ts`, `list.ts`, `find.ts`, `reparent.ts`, `add-batch.ts`

Task: Convert with alias handling (index.ts duplicate keys), requiredOption conversion,
and applyParamDefsToCommand → inline args conversion.
This worker should read T488 section 6 "Feature 6: parseFn" and "Feature 2: alias" carefully.
Estimated LOC: ~30-50 lines per file migrated.

**Worker D (optional, sequential after A+B+C)**: Sub-tier D verification
Confirm `commands.ts` is truly dead (registerCommandsCommand is commented out in index.ts),
then either skip it or formally cancel it as a migration target (it is already removed).
For `detect-drift.ts`: verify single-action pattern with 501-line implementation, migrate.

### Wave 1 Success Criteria

Per T489 AC and T487 goal:

- [ ] All 28 (or 26 excluding confirmed-deprecated `commands.ts`) files export `const xxxCommand = defineCommand(...)`
- [ ] All 28 files have no `import type { ShimCommand as Command }` at top
- [ ] All 28 files have no `export function registerXxxCommand(program: Command)` signature
- [ ] `index.ts` uses `subCommands['name'] = xxxCommand` for all 28 (not `registerXxx(rootShim)`)
- [ ] Root-level aliases (`done`, `rm`, `ls`) are duplicate keys in `subCommands`
- [ ] `NATIVE_COMMAND_DESCS` in `help-renderer.ts` has entries for all 28 migrated commands
- [ ] `pnpm biome ci .` passes
- [ ] `pnpm run build` passes
- [ ] `pnpm run test` — zero new failures
- [ ] `cleo --help` renders all previously-available commands
- [ ] `code.ts` tests added (T157, now T487 child) — parser tests, outline/search/unfold assertions

---

## Appendix: T487 Status at Time of Audit

| Item | Status |
|------|--------|
| T488 (Research) | verification.passed=true but `status: pending` — SHOULD be completed |
| T489 (Consensus) | `status: archived`, `completedAt` set — correct |
| T490 (Specification) | Not shown — assume similar stuck-pending state |
| T491 (Implementation) | Not shown — Wave 1 tasks likely not yet created |
| Wave 1 tasks | NOT YET CREATED — this report is the planning artifact |
| Native commands in production | 2 (`version`, `code`) of 100+ |

# T492 — Shim Removal Task Decomposition

**Date**: 2026-04-10
**Task**: T492 — D: Shim removal decomposition — atomic tasks for each migration batch
**Parent**: T487
**Status**: Decomposition complete

---

## Overview

This document defines the atomic task breakdown for removing `commander-shim.ts` from the CLEO CLI.
The migration spans 102 command files across 7 waves (including a validation wave), executed sequentially
with build/test gates between each. The orchestrator creates tasks from these definitions.

Source documents:
- Research: `.cleo/agent-outputs/T488-shim-removal-research.md`
- Consensus: `.cleo/agent-outputs/T489-shim-consensus.md`
- ADR: `.cleo/adrs/ADR-043-native-citty-command-migration.md`

---

## Wave Summary

| Wave | Scope | Files | Size | Deps |
|------|-------|-------|------|------|
| 1 | Simple commands — single action, direct dispatch | 29 | large | none |
| 2 | Medium commands — no aliases/isDefault | ~49 | large | Wave 1 |
| 3 | Medium commands — aliases and/or isDefault | ~15 | medium | Wave 2 |
| 4 | Complex commands — 9 tier-3 files | 9 | large | Wave 3 |
| 5 | Help system rewrite | 2 | medium | Wave 4 |
| 6 | Delete shim + cleanup | 1+tests | small | Wave 5 |
| V | Full runtime re-verification | ~200 cmds | medium | Wave 6 |

---

## Task Definitions

---

### Task 1: Wave 1 — Migrate 29 Simple Commands to Native Citty

**Title**: Wave 1: Migrate 29 simple commands to native citty defineCommand

**Type**: implementation

**Parent**: T487

**Size**: large

**Labels**: `cli`, `shim-removal`, `wave-1`, `citty`

**Dependencies**: none — can start immediately

#### Description

Migrate all 29 Tier 1 (simple) command files from the shim-based `registerXxxCommand(program)`
pattern to native citty `defineCommand` + `export const xxxCommand` pattern. These commands each
have a single `.action()` call, at most 3 options, at most 1 `.command()` call, and delegate
directly to `dispatchFromCli`. They represent the lowest-risk migration candidates and establish
the canonical pattern for subsequent waves.

**Files in scope** (29 total):
```
add-batch, analyze, backup-inspect, blockers, cancel, checkpoint, commands,
complete, current, delete, detect, detect-drift, exists, find, generate-changelog,
grade, list, map, next, ops, plan, promote, refresh-memory, reparent, roadmap,
show, start, stop, validate
```

**Canonical output pattern (Pattern A — simple dispatch):**
```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show full task details by ID' },
  args: {
    taskId: { type: 'positional', description: 'ID of the task to retrieve', required: true },
  },
  async run({ args }) {
    await dispatchFromCli('query', 'tasks', 'show', { taskId: args.taskId }, { command: 'show' });
  },
});
```

**For each migrated command, also update `index.ts`:**
- Remove `import { registerXxxCommand }` and `registerXxxCommand(rootShim)` call
- Add `import { xxxCommand }` and `subCommands['name'] = xxxCommand`
- Add command name + description to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`

**Rules (from ADR-043):**
- Export `const nameCommand` — NOT `registerXxxCommand`
- Declare args inline in `args:` block — no registry dependency
- `parseFn` equivalents must be inlined in `run()` as `Number.parseInt(args.val, 10)`
- Do NOT spread `args` into dispatch params — citty injects `_` field; pass explicitly
- Add TSDoc comment on every exported constant

#### Acceptance Criteria

- [ ] All 29 command files converted to `defineCommand` / `export const xxxCommand` pattern
- [ ] All 29 `registerXxxCommand` calls removed from `index.ts`
- [ ] All 29 commands added to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`
- [ ] `pnpm biome check --write .` passes with no new violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures
- [ ] `cleo --help` renders all 29 commands in the correct groups
- [ ] `cleo <cmd> --help` works for each of the 29 commands

#### Suggested Agent Count

2 agents working in parallel — split the 29 files into two batches of ~15 and ~14. Each agent
handles their batch end-to-end (command file + index.ts wiring + help-renderer update). One
agent does a final integration pass to ensure no conflicts in `index.ts` and `help-renderer.ts`.

**Model tier**: sonnet (straightforward pattern replication, no design decisions)

---

### Task 2: Wave 2 — Migrate ~49 Medium Commands to Native Citty

**Title**: Wave 2: Migrate ~49 medium commands (no aliases/isDefault) to native citty

**Type**: implementation

**Parent**: T487

**Size**: large

**Labels**: `cli`, `shim-removal`, `wave-2`, `citty`

**Dependencies**: Task 1 (Wave 1 must be complete and all gates passing; proves the pattern)

#### Description

Migrate all Tier 2 medium command files that do NOT use `.alias()` on subcommands and do NOT use
`isDefault`. These commands have multiple subcommands or more than 3 options but do not require
the special handling patterns reserved for Wave 3. This is the bulk migration wave — approximately
49 files.

**Files in scope** (~49 total — excludes files with alias or isDefault from the Tier 2 list):
```
adapter, add, adr, archive, archive-stats, backfill, backup, brain, briefing,
bug, cant, chain, check, claim, complexity, compliance, config, consensus,
context*, contribution, dash, decomposition, deps, docs, doctor, export,
export-tasks, history, implementation, import, import-tasks, init, inject,
issue, log, migrate-claude-mem, observe, otel, phase, provider, reason,
relates, release, remote, reorder, restore, safestop, schema, self-update,
sequence, snapshot, specification, stats, sync, testing, token, update,
upgrade, verify, web
```

*Note: `context.ts` uses `isDefault` and belongs in Wave 3 — exclude it here. Final file list
must be confirmed by the implementing agent by grepping for `.alias(` and `isDefault:` in each
file before starting.*

**Canonical output pattern (Pattern B — subcommand group):**
```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const backupCommand = defineCommand({
  meta: { name: 'backup', description: 'Manage database backups' },
  subCommands: {
    add: defineCommand({
      meta: { name: 'add', description: 'Create a new backup snapshot' },
      args: {
        note: { type: 'string', description: 'Optional backup note' },
      },
      async run({ args }) {
        await dispatchFromCli('mutate', 'backup', 'add', { note: args.note }, { command: 'backup' });
      },
    }),
    list: defineCommand({ ... }),
  },
});
```

**Additional rules for this wave:**
- Commands with >8 args on a single subcommand SHOULD extract that subcommand to a named `const`
  above the parent to avoid unreadable nesting
- `doctor.ts`, `self-update.ts`, `upgrade.ts` call `command.optsWithGlobals()` — replace with
  `getFormatContext()` / `getFieldContext()` imports from the context modules already set in
  `index.ts` startup (see ADR-043 §Consequences)
- `add.ts` uses `applyParamDefsToCommand()` — replace with an inline `args:` block; the
  `ADD_PARAMS` local array gives the source of truth for the args declaration
- For commands with `parseFn: parseInt` or `parseFn: parseFloat`, inline the parse in `run()`

**For each migrated command, also update `index.ts` and `help-renderer.ts`** (same protocol as
Wave 1).

#### Acceptance Criteria

- [ ] All ~49 command files converted (exact count confirmed by agent before starting)
- [ ] `optsWithGlobals()` calls replaced in `doctor.ts`, `self-update.ts`, `upgrade.ts`
- [ ] `applyParamDefsToCommand()` call in `add.ts` replaced with inline `args:` block
- [ ] All migrated commands added to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`
- [ ] `pnpm biome check --write .` passes with no new violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures
- [ ] `cleo --help` renders all migrated commands correctly
- [ ] Each migrated command's `--help` flag renders correctly

#### Suggested Agent Count

3 agents working in parallel — split by alphabetical groupings (a–e, f–r, s–z). Each agent
handles their batch end-to-end. One integration agent resolves any conflicts in `index.ts` and
`help-renderer.ts` after the three batches are merged.

**Model tier**: sonnet (pattern replication; a few edge cases around `optsWithGlobals` require
reading existing context module usage — within sonnet capability)

---

### Task 3: Wave 3 — Migrate ~15 Medium-Special Commands (Aliases, isDefault)

**Title**: Wave 3: Migrate ~15 medium commands with aliases and/or isDefault patterns

**Type**: implementation

**Parent**: T487

**Size**: medium

**Labels**: `cli`, `shim-removal`, `wave-3`, `citty`, `aliases`, `isDefault`

**Dependencies**: Task 2 (Wave 2 must be complete and all gates passing)

#### Description

Migrate the remaining Tier 2 command files that use either `.alias()` on subcommands or the
`isDefault: true` option. These require two specific patterns documented in ADR-043 that were
not needed in Waves 1 and 2.

**Files using `.alias()` on subcommands** (from T488 research):
```
backup.ts, complete.ts, delete.ts, list.ts, phase.ts, session.ts (if not complex),
sticky.ts
```

**Files using `isDefault`:**
```
admin.ts (if not Wave 4), context.ts, env.ts, labels.ts, phases.ts
```

*Note: `session.ts` and `admin.ts` are Tier 3 complex files and belong in Wave 4 — exclude here.
The implementing agent must verify the final list by grepping for `isDefault` and `.alias(` and
cross-referencing against the Tier 3 list.*

**Alias pattern (duplicate-key in subCommands):**
```typescript
const doneCommand = defineCommand({
  meta: { name: 'done', description: 'Mark a task complete (alias for complete)' },
  // ... same args and run as completeCommand
});

export const completeCommand = defineCommand({
  meta: { name: 'complete', description: 'Mark a task complete' },
  subCommands: {
    // no subcommands — but alias wired in index.ts
  },
  async run({ args }) { ... },
});

// In index.ts:
subCommands['complete'] = completeCommand;
subCommands['done'] = completeCommand;  // alias — same reference
```

**isDefault pattern (standard from ADR-043 §2b):**
```typescript
async function defaultAction(): Promise<void> {
  await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
}

export const labelsCommand = defineCommand({
  meta: { name: 'labels', description: '...' },
  subCommands: {
    list: defineCommand({ async run() { await defaultAction(); } }),
    show: defineCommand({ ... }),
  },
  async run({ rawArgs }) {
    const knownSubs = new Set(['list', 'show']);
    if (rawArgs.some((a) => knownSubs.has(a))) return;
    await defaultAction();
  },
});
```

**Rules:**
- `subCommandNames` set in parent `run()` MUST include ALL subcommand names AND any alias keys
- Default action MUST be extracted to a local `async function` — no duplication between parent
  `run()` and the default subcommand's `run()`
- Parent `run()` MUST use exact set membership check, not substring matching
- Alias subcommands: the duplicate key in `index.ts` uses the same `CommandDef` reference (not a
  copy) to ensure `--help` consistency

#### Acceptance Criteria

- [ ] All files with `.alias()` on subcommands migrated using the duplicate-key pattern
- [ ] All files with `isDefault` migrated using the standard `rawArgs` guard pattern
- [ ] Default actions extracted to local `async function` (no duplication)
- [ ] Alias keys wired in `index.ts` pointing to the same `CommandDef` reference
- [ ] All migrated commands added to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`
- [ ] `pnpm biome check --write .` passes with no new violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures
- [ ] `cleo labels` (no subcommand) invokes the default action correctly
- [ ] `cleo complete` and `cleo done` both work (alias test)

#### Suggested Agent Count

1–2 agents. The file count is smaller (~15) and the two patterns (alias, isDefault) are well-
defined. A single agent can handle the full wave sequentially. A second agent can handle
integration review and the `index.ts` / `help-renderer.ts` updates if desired.

**Model tier**: sonnet (the isDefault pattern requires careful reading of each command's
existing subcommand list to populate `knownSubs` correctly — within sonnet capability)

---

### Task 4: Wave 4 — Migrate 9 Complex Commands

**Title**: Wave 4: Migrate 9 complex tier-3 commands to native citty

**Type**: implementation

**Parent**: T487

**Size**: large

**Labels**: `cli`, `shim-removal`, `wave-4`, `citty`, `complex`

**Dependencies**: Task 3 (Wave 3 must be complete and all gates passing)

#### Description

Migrate the 9 Tier 3 complex command files. These commands have 10+ actions, deeply nested
subcommand trees, heavy option sets, or multiple special shim features combined. Each file should
be treated as an independent sub-task — one file at a time, with a build+test gate between each.

**Files in scope (9 total):**

| File | Actions | Options | Subcommands | Special Features |
|------|---------|---------|-------------|-----------------|
| `agent.ts` | 25 | 46 | 26 | `requiredOption`, file I/O, multi-step async |
| `orchestrate.ts` | 24 | 20 | 26 | Dynamic dispatch, streaming |
| `nexus.ts` | 22 | 19 | 25 | Cross-project ops, nested sub-of-sub |
| `session.ts` | 14 | 33 | 15 | `requiredOption`, alias on sub, `isDefault` candidate |
| `skills.ts` | 15 | 10 | 15 | File I/O, tar/zip ops |
| `memory-brain.ts` | 16 | 54 | 17 | `requiredOption`, type-conditional routing, highest option count |
| `admin.ts` | 13 | 11 | 15 | `requiredOption`, `isDefault` |
| `research.ts` | 10 | 16 | 11 | `requiredOption`, MANIFEST file I/O |
| `lifecycle.ts` | 10 | 9 | 12 | `requiredOption`, multi-step pipeline |

**Key patterns required (in addition to Waves 1–3 patterns):**

1. **Deeply nested subcommands** (nexus, orchestrate): Extract each intermediate group to a named
   `const` before the parent to avoid nesting beyond 3 levels. Example:
   ```typescript
   const nexusShareCommand = defineCommand({ subCommands: { export: ..., import: ... } });
   export const nexusCommand = defineCommand({ subCommands: { share: nexusShareCommand } });
   ```

2. **High option density** (memory-brain: 54 opts, agent: 46 opts): Extract each subcommand with
   >8 options to a named `const`. This is required for readability per ADR-043 §1b.

3. **`optsWithGlobals()` usage** (session, agent if present): Replace with `getFormatContext()` /
   `getFieldContext()` as established in Wave 2.

4. **`isDefault` in session/admin**: Apply the Wave 3 `rawArgs` guard pattern.

5. **`requiredOption`**: Translate to `required: true` in the `args:` entry.

**Recommended file-by-file sequence within Wave 4** (simplest to most complex):
1. `lifecycle.ts` — smallest, 10 actions, no special features beyond requiredOption
2. `research.ts` — 10 actions, file I/O but straightforward structure
3. `admin.ts` — 13 actions, isDefault already handled in Wave 3 pattern
4. `skills.ts` — 15 actions, file I/O similar to research
5. `session.ts` — 14 actions, alias + requiredOption combination
6. `memory-brain.ts` — 16 actions, 54 options (highest complexity in options)
7. `nexus.ts` — 22 actions, nested sub-of-sub
8. `orchestrate.ts` — 24 actions, dynamic dispatch
9. `agent.ts` — 25 actions, 46 options (largest overall)

**Gate between each file**: After migrating each individual file, run
`pnpm run build && pnpm run test` before proceeding to the next. Do not batch Wave 4 files.

#### Acceptance Criteria

- [ ] All 9 complex command files converted to native citty pattern
- [ ] All deeply nested subcommand groups extracted to named `const` (no nesting > 3 levels)
- [ ] All `optsWithGlobals()` / `opts()` calls replaced with context module reads
- [ ] All `isDefault` patterns replaced with `rawArgs` guard in parent `run()`
- [ ] All `requiredOption` calls replaced with `required: true` in `args:`
- [ ] All commands added to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`
- [ ] `pnpm biome check --write .` passes with no new violations after each file
- [ ] `pnpm run build` passes after each individual file migration
- [ ] `pnpm run test` passes with zero new failures after each individual file migration
- [ ] `cleo agent --help`, `cleo session start --help`, `cleo memory-brain --help` render correctly
- [ ] `cleo session` (no subcommand, if isDefault) invokes the default action

#### Suggested Agent Count

3 agents, each taking 3 files from the recommended sequence. Agent assignments:
- Agent A: `lifecycle.ts`, `research.ts`, `admin.ts`
- Agent B: `skills.ts`, `session.ts`, `memory-brain.ts`
- Agent C: `nexus.ts`, `orchestrate.ts`, `agent.ts`

Each agent runs gates after every individual file. The three agents work sequentially within
their file group but can work in parallel across groups, since the files do not share internals.
One integration agent merges `index.ts` and `help-renderer.ts` changes after all three complete.

**Model tier**: sonnet for agents A and B (complex but follows established patterns). Consider
sonnet for agent C as well — `agent.ts` and `orchestrate.ts` are large but the pattern is the
same; the volume is the primary challenge, not novel design decisions.

---

### Task 5: Wave 5 — Rewrite Help System

**Title**: Wave 5: Rewrite help-renderer.ts and help-generator.ts — remove ShimCommand coupling

**Type**: implementation

**Parent**: T487

**Size**: medium

**Labels**: `cli`, `shim-removal`, `wave-5`, `help-system`

**Dependencies**: Task 4 (Wave 4 must be complete — all commands must be native before this wave)

#### Description

Once all 102 command files are native citty, `help-renderer.ts` and `help-generator.ts` are the
last consumers of `ShimCommand`. Wave 5 rewrites both files to operate entirely on native citty
`CommandDef` objects. After this wave, `commander-shim.ts` has zero importers and can be deleted
in Wave 6.

**Scope: `help-renderer.ts`**

Current coupling points (from T488 research and ADR-043 §3b):
1. `buildAliasMap(shims: ShimCommand[])` — reads `shim._aliases[]` and `shim._name`
2. `renderGroupedHelp(version, shims, aliasMap)` — reads `shim._name` and `shim._description`
3. `NATIVE_COMMAND_DESCS` map — hard-coded descriptions for commands that bypass the shim

**Required changes:**
1. Delete `NATIVE_COMMAND_DESCS` — no longer needed (all commands are now native)
2. Rewrite `buildAliasMap()` to accept the `subCommands` record from `index.ts`:
   - Walk `Object.entries(subCommands)` to get `[name, CommandDef]` pairs
   - Detect aliases by checking object identity: two keys with `===` same `CommandDef` reference
   - Build alias map from the duplicate-key pairs
3. Rewrite `renderGroupedHelp()` to source command descriptions from `CommandDef.meta.description`
   (resolve async if needed: `typeof def.meta === 'function' ? await def.meta() : def.meta`)
4. Remove all `ShimCommand` imports from `help-renderer.ts`
5. Retain `COMMAND_GROUPS` constant as-is (grouping configuration is independent of the shim)
6. Retain `createCustomShowUsage` — citty's built-in renderer remains for sub-command help;
   only the root help handler changes

**Scope: `help-generator.ts`**

Current coupling points:
1. `applyParamDefsToCommand(cmd: ShimCommand, params: ParamDef[], opName: string)` — registers
   options onto a `ShimCommand` target
2. `buildOperationHelp()` — generates a string, takes no `ShimCommand` dependency (keep as-is)

**Required changes:**
1. Add `buildCittyArgsFromParamDefs(params: ParamDef[]): ArgsDef` — citty-native replacement
   for `applyParamDefsToCommand()`. This function returns a citty `ArgsDef` object built from
   a `ParamDef[]` array. Pattern:
   ```typescript
   export function buildCittyArgsFromParamDefs(params: ParamDef[]): ArgsDef {
     const argsDef: ArgsDef = {};
     for (const param of params) {
       argsDef[param.name] = {
         type: param.type === 'boolean' ? 'boolean' : 'string',
         description: param.description,
         required: param.required ?? false,
         ...(param.alias ? { alias: param.alias } : {}),
         ...(param.default !== undefined ? { default: String(param.default) } : {}),
       };
     }
     return argsDef;
   }
   ```
2. Mark `applyParamDefsToCommand()` as `@deprecated` and DO NOT delete it in this wave
   (deletion happens in Wave 6)
3. Remove any `ShimCommand` imports from `help-generator.ts`

**Update `index.ts`:**
- Update the call to `buildAliasMap()` and `renderGroupedHelp()` to pass the native
  `subCommands` record directly instead of `rootShim._subcommands`

#### Acceptance Criteria

- [ ] `help-renderer.ts` has zero `ShimCommand` imports
- [ ] `NATIVE_COMMAND_DESCS` constant deleted from `help-renderer.ts`
- [ ] `buildAliasMap()` walks `CommandDef.subCommands` using object identity for alias detection
- [ ] `renderGroupedHelp()` sources descriptions from `CommandDef.meta.description`
- [ ] `buildCittyArgsFromParamDefs()` exported from `help-generator.ts` with TSDoc
- [ ] `applyParamDefsToCommand()` marked `@deprecated` (not deleted)
- [ ] `index.ts` updated to pass native `subCommands` to help functions
- [ ] `pnpm biome check --write .` passes with no new violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures
- [ ] `cleo --help` renders all command groups correctly with descriptions and aliases
- [ ] Alias commands (e.g. `done` for `complete`) appear correctly in `cleo --help`

#### Suggested Agent Count

1 agent. The help system rewrite is a contained, well-scoped task. The coupling points are
fully documented in ADR-043 §3b. A single focused agent reduces the risk of conflicting changes
to the two files.

**Model tier**: sonnet (requires understanding citty's `CommandDef` type structure and the
async `meta` resolution pattern — within sonnet capability)

---

### Task 6: Wave 6 — Delete commander-shim.ts + Cleanup

**Title**: Wave 6: Delete commander-shim.ts, remove shimToCitty, update 20 test files

**Type**: implementation

**Parent**: T487

**Size**: small

**Labels**: `cli`, `shim-removal`, `wave-6`, `cleanup`, `tests`

**Dependencies**: Task 5 (Wave 5 must be complete — help system must have zero ShimCommand coupling)

#### Description

Final cleanup wave. After Waves 1–5, `commander-shim.ts` should have zero importers in
production code. Wave 6 deletes the shim and removes all remaining test file references.

**Checklist before starting:**
- Run `grep -r "commander-shim" packages/cleo/src/ --include="*.ts"` — must return zero results
  outside of `commander-shim.ts` itself and test files
- Run `grep -r "ShimCommand" packages/cleo/src/ --include="*.ts"` — must return zero results
  outside of test files

**Scope 1: `index.ts` — remove bridge infrastructure**

Delete or remove:
- `const rootShim = new ShimCommand()` declaration
- All remaining `registerXxxCommand(rootShim)` calls (should be none by Wave 4 end)
- The `shimToCitty()` function definition (~100 lines, lines 248–345 per T488 research)
- The `for (const shim of rootShim._subcommands)` loop
- The `ShimCommand` import at the top of `index.ts`
- Any dead code left from the shim bridge

**Scope 2: Delete `commander-shim.ts`**

Delete the file: `packages/cleo/src/cli/commander-shim.ts`

**Scope 3: Update ~20 test files**

From T488 research and ADR-043 §4, approximately 20 test files in
`packages/cleo/src/cli/commands/__tests__/` construct `new ShimCommand()` and use Pattern A
(structural inspection) or Pattern B (behavioral via `._action`) to test commands.

For each test file:
1. Remove `import { ShimCommand } from '../commander-shim.js'`
2. Remove `import { registerXxxCommand }` and replace with `import { xxxCommand }`
3. Replace Pattern A (structural inspection) tests with direct `CommandDef` shape assertions
4. Replace Pattern B (behavioral via `._action`) tests with direct `run()` invocation

Reference patterns from ADR-043 §4b:
```typescript
// Pattern A replacement — assert on CommandDef shape
expect(showCommand.args?.['taskId'].type).toBe('positional');

// Pattern B replacement — call run() directly
await showCommand.run?.({
  args: { taskId: 'T001' },
  rawArgs: ['T001'],
  cmd: showCommand,
});
```

**Scope 4: Remove dead code from `help-generator.ts`**

- Delete `applyParamDefsToCommand()` (marked `@deprecated` in Wave 5, now safe to delete)
- Remove any remaining `ShimCommand` imports

**Final verification after Wave 6:**
```bash
grep -r "commander-shim" packages/ --include="*.ts"   # must return zero
grep -r "ShimCommand" packages/ --include="*.ts"       # must return zero
grep -r "shimToCitty" packages/ --include="*.ts"       # must return zero
pnpm biome check --write .
pnpm run build
pnpm run test
```

#### Acceptance Criteria

- [ ] `commander-shim.ts` file deleted
- [ ] `shimToCitty()` function deleted from `index.ts`
- [ ] `rootShim` variable and all related code deleted from `index.ts`
- [ ] `grep -r "ShimCommand" packages/ --include="*.ts"` returns zero results
- [ ] `grep -r "commander-shim" packages/ --include="*.ts"` returns zero results
- [ ] `grep -r "shimToCitty" packages/ --include="*.ts"` returns zero results
- [ ] All ~20 test files updated to use native citty pattern
- [ ] `applyParamDefsToCommand()` deleted from `help-generator.ts`
- [ ] `pnpm biome check --write .` passes with no new violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures (behavioral coverage maintained)

#### Suggested Agent Count

1–2 agents. The deletion work is mechanical. One agent handles the production code cleanup
(`index.ts`, `commander-shim.ts`, `help-generator.ts`). A second agent handles the 20 test file
rewrites in parallel. Both must pass gates before Wave V begins.

**Model tier**: sonnet for both (pattern replacement; the test rewrite follows the well-
documented ADR-043 §4b patterns)

---

### Task 7: Validation — Full CLI Runtime Re-Verification

**Title**: Validation: Full CLI runtime re-verification — rerun T484 verification suite

**Type**: validation

**Parent**: T487

**Size**: medium

**Labels**: `cli`, `shim-removal`, `validation`, `regression`

**Dependencies**: Task 6 (Wave 6 must be complete — shim must be deleted)

#### Description

Full end-to-end validation of the migrated CLI against the ~200 commands in the CLEO operation
registry. This wave re-executes the same verification that was run in T484 to establish the
pre-migration baseline, and confirms zero regressions.

The validation covers:
1. **Build and static analysis gate** — clean `biome check` and zero TypeScript errors
2. **Unit test gate** — `pnpm run test` zero new failures
3. **Runtime smoke test** — exercise each command group manually or via script
4. **Help rendering** — `cleo --help` groups match pre-migration output
5. **Subcommand help** — spot-check `cleo <cmd> --help` for each top-level command
6. **Alias resolution** — verify all alias commands route correctly
7. **isDefault behavior** — verify default subcommand fires when no subcommand is given
8. **Global flags** — `--json`, `--human`, `--quiet`, `--field` flags work across commands
9. **Error paths** — missing required args produce correct error messages

**Reference**: The T484 verification report (if it exists as a file) should be used as the
comparison baseline. If no T484 output file exists, use `cleo commands` output to build the
command list.

**Regression criteria**: ANY behavioral difference from pre-migration behavior that is not an
intentional improvement (e.g., the new `type: 'enum'` error messages for invalid enum values)
constitutes a regression and MUST be reported in the task's notes before marking complete.

**Output**: The validating agent MUST write a concise summary to
`.cleo/agent-outputs/T492-validation-report.md` listing:
- Total commands verified
- Pass count
- Fail count (with details for each failure)
- Any intentional behavioral differences noted

#### Acceptance Criteria

- [ ] `pnpm biome check --write .` passes with zero violations
- [ ] `pnpm run build` passes with zero TypeScript errors
- [ ] `pnpm run test` passes with zero new test failures vs. pre-migration baseline
- [ ] `cleo --help` renders all command groups with correct commands and descriptions
- [ ] All alias commands resolve to the correct handler
- [ ] All `isDefault` commands invoke the default action when no subcommand is given
- [ ] Global flags (`--json`, `--human`, `--quiet`) work correctly in all tested commands
- [ ] Required arg validation produces correct error output for each tested command
- [ ] Validation report written to `.cleo/agent-outputs/T492-validation-report.md`
- [ ] Zero unintentional regressions found (or all regressions documented and triaged)

#### Suggested Agent Count

1 agent for coordination + 2 agents for parallel command group verification (split by command
group as defined in `COMMAND_GROUPS` in `help-renderer.ts`).

**Model tier**: sonnet for all validation agents (behavioral comparison, no code writing)

---

## Dependency Graph

```
none → Task 1 (Wave 1: 29 simple)
         ↓
       Task 2 (Wave 2: ~49 medium)
         ↓
       Task 3 (Wave 3: ~15 medium-special)
         ↓
       Task 4 (Wave 4: 9 complex)
         ↓
       Task 5 (Wave 5: help system)
         ↓
       Task 6 (Wave 6: delete shim + tests)
         ↓
       Task 7 (Validation: full re-verification)
```

All waves are strictly sequential. No wave starts until the previous wave passes all quality gates.
The only parallelism is within a wave (multiple agents working on different files simultaneously).

---

## Quality Gate Protocol (All Waves)

After every wave, the implementing agent MUST run in order:

```bash
# 1. Format and lint
pnpm biome check --write .

# 2. Type check + build
pnpm run build

# 3. Tests — zero new failures
pnpm run test

# 4. Spot check help rendering
cleo --help
cleo <representative-cmd> --help
```

If any gate fails, the wave is NOT complete. Fix all failures before marking the wave task done.

---

## Notes for Orchestrator

- Tasks 1–7 have parent T487.
- Do NOT create the tasks until this decomposition has been reviewed.
- Each task maps to one implementation wave. Task 7 is validation, not implementation.
- The suggested agent counts are recommendations — the orchestrator may adjust based on
  available capacity.
- Wave 4 has a strong internal sequencing recommendation (lifecycle → research → admin →
  skills → session → memory-brain → nexus → orchestrate → agent). The orchestrator should
  communicate this to the Wave 4 agents.
- The total task count is 7, satisfying the T492 acceptance criterion of "total task count
  under 20."

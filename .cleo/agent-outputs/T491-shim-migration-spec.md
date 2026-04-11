# T491 — Shim Removal Migration Plan: Batch Ordering and Verification Gates

**Date**: 2026-04-10
**Task**: T491 — S: Shim removal spec — migration plan with batch ordering and verification gates
**Parent**: T487
**Status**: Specification complete
**Sources**: T488 research, T489 consensus, ADR-043

---

## Overview

This specification defines the execution plan for removing `commander-shim.ts` from
`packages/cleo/src/cli/` and migrating all 102 shim-based command files to native citty
`defineCommand()` patterns. The migration proceeds in six waves. The shim remains functional
through Wave 5; Wave 6 is the only destructive step.

**Total scope**: 102 command files across 4 tiers (plus 4 native/stub files excluded from
migration). 20 test files require updates. 2 help-system files require rewrites.

---

## Pre-Wave: Exclusions

The following 4 files are **excluded from migration** — they require no changes:

| File | Reason |
|------|--------|
| `code.ts` | Already native citty — the reference implementation |
| `agent-profile-status.ts` | Utility module — no CLI registration, helper functions only |
| `agents.ts` | Deprecated no-op stub — kept for import compatibility |
| `dynamic.ts` | Future auto-generation stub — currently a no-op |

---

## Wave 0 — Compatibility Adapter (Prerequisite, Not a Wave)

**Scope**: `help-renderer.ts`, `help-generator.ts`, `index.ts`

Wave 0 is not a code-migration wave — it is the prerequisite infrastructure that makes
incremental migration possible. It MUST be completed before any command file is migrated.

### help-renderer.ts changes

Introduce the `CommandMeta` abstraction:

```typescript
/** Unified metadata shape for root help rendering — source-agnostic. */
interface CommandMeta {
  name: string;
  description: string;
  aliases: string[];
}
```

Add two extraction functions:
- `metaFromShim(shim: ShimCommand): CommandMeta` — wraps existing shim commands
- `metaFromCittyDef(name: string, def: CommandDef): CommandMeta` — wraps native commands

Update `buildAliasMap` and `renderGroupedHelp` to accept `CommandMeta[]` rather than
`ShimCommand[]`. Update call site in `index.ts` to produce a merged `CommandMeta[]` from
both the shim list and the native subCommands map.

Eliminate the `NATIVE_COMMAND_DESCS` hard-code once all commands produce their own
`CommandMeta` — this occurs at the end of Wave 4.

### help-generator.ts changes

Add `buildCittyArgsFromParamDefs(params: ParamDef[]): ArgsDef` — a citty-native replacement
for `applyParamDefsToCommand()`. Required before migrating `show.ts` (which uses
`SHOW_PARAMS`) and `add.ts` (which uses `ADD_PARAMS`).

`applyParamDefsToCommand()` itself remains in place until Wave 6.

### Verification gate (Wave 0)

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Spot-check: `cleo --help` must render all command groups correctly. `cleo show --help` and
`cleo add --help` must render correctly.

---

## Wave 1 — Simple Commands (29 files)

**Rationale**: Single `.action()` call, ≤3 options, ≤1 `.command()` call. Direct
`dispatchFromCli` delegation. Zero subcommands. Lowest risk. Establishes the canonical pattern
for all subsequent waves.

### Files in scope (29)

```
add-batch.ts
analyze.ts
backup-inspect.ts
blockers.ts
cancel.ts
checkpoint.ts
commands.ts
complete.ts
current.ts
delete.ts
detect.ts
detect-drift.ts
exists.ts
find.ts
generate-changelog.ts
grade.ts
list.ts
map.ts
next.ts
ops.ts
plan.ts
promote.ts
refresh-memory.ts
reparent.ts
roadmap.ts
show.ts
start.ts
stop.ts
validate.ts
```

### Migration pattern (Pattern A — Simple dispatch)

Each file is converted from:
```typescript
export function registerNameCommand(program: Command): void {
  program.command('name <arg>')
    .option('--flag', 'description')
    .action(async (arg, opts) => {
      await dispatchFromCli(...);
    });
}
```

To:
```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const nameCommand = defineCommand({
  meta: { name: 'name', description: 'Single-line description' },
  args: {
    arg: { type: 'positional', description: 'Argument description', required: true },
    flag: { type: 'boolean', description: 'Flag description' },
  },
  async run({ args }) {
    await dispatchFromCli('gateway', 'domain', 'operation', { arg: args.arg }, { command: 'name' });
  },
});
```

### index.ts changes per file

Remove: `import { registerNameCommand } from './commands/name.js';`
Remove: `registerNameCommand(rootShim);`
Add: `import { nameCommand } from './commands/name.js';`
Add: `subCommands['name'] = nameCommand;`

As each file migrates, add it to the merged `CommandMeta[]` builder in `index.ts` (using
`metaFromCittyDef`) so `cleo --help` remains accurate.

### Verification gate (Wave 1)

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Spot-check (5 commands minimum):
```bash
cleo show --help
cleo find --help
cleo next --help
cleo complete --help
cleo cancel --help
```

Each must respond with usage information and exit 0. `cleo --help` must show all 29 migrated
commands in their correct groups.

### Commit strategy

One commit per file, or batched in groups of 5–10 files where changes are mechanical and the
test gate passes cleanly between batches. Commit message format:
`feat(cli): migrate <name> command to native citty (Wave 1)`

---

## Wave 2 — Medium Commands Without Special Features (~49 files)

**Rationale**: Multiple subcommands OR >3 options, but no `.alias()` on subcommands and no
`isDefault`. The bulk of the migration effort. No new patterns required beyond Wave 1.

### Files in scope (49)

```
adapter.ts
add.ts
adr.ts
archive.ts
archive-stats.ts
backfill.ts
backup.ts
brain.ts
briefing.ts
bug.ts
cant.ts
chain.ts
check.ts
claim.ts
complexity.ts
compliance.ts
config.ts
consensus.ts
contribution.ts
dash.ts
decomposition.ts
deps.ts
docs.ts
doctor.ts
export.ts
export-tasks.ts
history.ts
implementation.ts
import.ts
import-tasks.ts
init.ts
inject.ts
issue.ts
log.ts
migrate-claude-mem.ts
observe.ts
otel.ts
provider.ts
reason.ts
relates.ts
release.ts
remote.ts
reorder.ts
restore.ts
safestop.ts
schema.ts
self-update.ts
sequence.ts
snapshot.ts
specification.ts
stats.ts
sync.ts
testing.ts
token.ts
update.ts
upgrade.ts
verify.ts
web.ts
```

### Notable complexity drivers

| File | Complexity driver |
|------|------------------|
| `check.ts` | 34 options across 7 subcommands |
| `token.ts` | 31 options across 7 subcommands |
| `update.ts` | 20 options (single action, heavy flag set) |
| `issue.ts` | 15 options across 5 subcommands |
| `compliance.ts` | 10 options across 9 subcommands |

For files with >8 args per subcommand, extract each subcommand to a named `const` above the
parent `defineCommand` for readability (per ADR-043 Decision 2c).

### Special handling: optsWithGlobals() files

Three files in this wave call `command.optsWithGlobals()` inside their action:
`doctor.ts`, `self-update.ts`, `upgrade.ts`.

After migration, replace `command.optsWithGlobals().json` etc. with reads from the
format/field context modules set in `index.ts` startup:

```typescript
import { getFormatContext } from '../../output/format-context.js';
// inside run():
const { json, human, quiet } = getFormatContext();
```

The startup block in `index.ts` already calls `setFormatContext()` and `setFieldContext()`
before any command runs — these values are available at `run()` time.

### Migration pattern (Pattern B — Subcommand group)

Parent command declares `subCommands:` object literal. Each subcommand is a `defineCommand`
inline or extracted `const`. No `run()` on the parent unless the command has a direct root
action (in which case it uses the standard `dispatchFromCli` call, not the `isDefault`
pattern — that is Wave 3).

### Verification gate (Wave 2)

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Spot-check (5 commands minimum):
```bash
cleo session status --help
cleo backup list --help
cleo check task --help
cleo token usage --help
cleo init --help
```

All subcommands must respond correctly. `cleo --help` must show all migrated commands.

### Commit strategy

Group files by functional domain where possible (e.g., backup + restore + snapshot in one
commit). Each commit must pass the quality gate before the next begins.

---

## Wave 3 — Medium Commands With Aliases or isDefault (~15 files)

**Rationale**: These files introduce two patterns not present in Waves 1–2: subcommand aliases
(duplicate-key pattern) and `isDefault` subcommands (explicit `run()` with rawArgs guard).
Treating them separately isolates the risk of these patterns.

### Files in scope (15)

Files using `.alias()` on subcommands (8 files):
```
backup.ts      — alias on subcommand(s)
complete.ts    — alias: 'done'
delete.ts      — alias on subcommand(s)
list.ts        — alias on subcommand(s)
nexus.ts       — alias on subcommand(s) [NOTE: nexus.ts is also Tier 3; see Wave 4]
phase.ts       — alias on subcommand(s)
session.ts     — alias on subcommand(s) [NOTE: session.ts is also Tier 3; see Wave 4]
sticky.ts      — alias on subcommand(s)
```

Files using `isDefault` (5 files):
```
admin.ts       — isDefault [NOTE: admin.ts is Tier 3; see Wave 4]
context.ts     — isDefault
env.ts         — isDefault
labels.ts      — isDefault
phases.ts      — isDefault
```

**Clarification on Tier 3 files appearing here**: `backup.ts`, `complete.ts`, `delete.ts`,
`list.ts`, `phase.ts`, and `sticky.ts` are Tier 2 files that also use aliases. The Tier 3
files (`admin.ts`, `session.ts`, `nexus.ts`) are held for Wave 4 where their full complexity
receives dedicated attention. Wave 3 migrates only the non-Tier-3 alias/isDefault files.

**Wave 3 actual file list (non-Tier-3 only)**:
```
backup.ts
complete.ts
context.ts
delete.ts
env.ts
labels.ts
list.ts
phase.ts
phases.ts
sticky.ts
```

### Alias pattern (duplicate-key in subCommands)

Per ADR-043 Decision 2a, aliases are duplicate keys pointing to the same `CommandDef`
reference:

```typescript
const doneSubCommand = defineCommand({
  meta: { name: 'done', description: 'Mark task complete' },
  args: { taskId: { type: 'positional', required: true } },
  async run({ args }) { await dispatchFromCli(...); },
});

export const completeCommand = defineCommand({
  meta: { name: 'complete', description: 'Mark task(s) complete' },
  subCommands: {
    task: doneSubCommand,
    done: doneSubCommand,  // alias — same reference
  },
});
```

In `index.ts`, add alias keys for commands with top-level aliases:
```typescript
subCommands['complete'] = completeCommand;
subCommands['done'] = completeCommand;  // top-level alias if applicable
```

### isDefault pattern

Per ADR-043 Decision 2b, the canonical `isDefault` replacement is an explicit `run()` on the
parent that guards with exact set membership:

```typescript
async function defaultAction(): Promise<void> {
  await dispatchFromCli('query', 'domain', 'operation.default', {}, { command: 'name' });
}

export const nameCommand = defineCommand({
  meta: { name: 'name', description: '...' },
  subCommands: {
    default: defineCommand({ meta: { name: 'default', ... }, async run() { await defaultAction(); } }),
    other: defineCommand({ ... }),
  },
  async run({ rawArgs }) {
    const subCommandNames = new Set(['default', 'other']);
    if (rawArgs.some((a) => subCommandNames.has(a))) return;
    await defaultAction();
  },
});
```

Rules:
- `subCommandNames` MUST include ALL keys in `subCommands`, including alias keys.
- The default action MUST be extracted to a local `async function` to avoid duplication.
- The parent `run()` MUST return early when a subcommand is detected.

### Verification gate (Wave 3)

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Spot-check (5 commands minimum, focused on alias and default behavior):
```bash
cleo complete --help          # verify complete and done alias both resolve
cleo labels --help            # verify default shows 'list' behavior
cleo env --help               # verify isDefault runs without subcommand
cleo context --help
cleo backup list --help
```

Manually verify alias resolution:
```bash
cleo done T001 --dry-run 2>&1 | head -5   # alias must route correctly
```

---

## Wave 4 — Complex Commands (9 files)

**Rationale**: Highest option density (up to 54 options), deeply nested subcommand trees (up
to 26 subcommands), `requiredOption`, `isDefault`, `optsWithGlobals()`, and multi-step async
logic. Each file in this wave MUST be treated as its own sub-unit with a dedicated commit and
full gate verification before the next file begins.

### Files in scope (9)

| File | Actions | Options | Subcommands | Special features |
|------|---------|---------|-------------|-----------------|
| `agent.ts` | 25 | 46 | 26 | `requiredOption`, file I/O, multi-step async |
| `orchestrate.ts` | 24 | 20 | 26 | Dynamic dispatch, streaming |
| `nexus.ts` | 22 | 19 | 25 | Cross-project ops, subcommand aliases |
| `session.ts` | 14 | 33 | 15 | `requiredOption`, subcommand alias, `isDefault` candidate |
| `skills.ts` | 15 | 10 | 15 | File I/O, tar/zip operations |
| `memory-brain.ts` | 16 | 54 | 17 | `requiredOption`, type-conditional routing, highest option count |
| `admin.ts` | 13 | 11 | 15 | `requiredOption`, `isDefault` |
| `research.ts` | 10 | 16 | 11 | `requiredOption`, MANIFEST file I/O |
| `lifecycle.ts` | 10 | 9 | 12 | `requiredOption`, multi-step pipeline |

### Recommended processing order within Wave 4

Process least-complex first to validate patterns before the highest-density files:

1. `lifecycle.ts` (10 actions, 9 options, 12 subcommands)
2. `research.ts` (10 actions, 16 options, 11 subcommands)
3. `admin.ts` (13 actions, 11 options, 15 subcommands — has `isDefault`)
4. `skills.ts` (15 actions, 10 options, 15 subcommands)
5. `session.ts` (14 actions, 33 options, 15 subcommands — has alias + `isDefault` candidate)
6. `orchestrate.ts` (24 actions, 20 options, 26 subcommands)
7. `nexus.ts` (22 actions, 19 options, 25 subcommands — has alias)
8. `memory-brain.ts` (16 actions, 54 options, 17 subcommands — highest option count)
9. `agent.ts` (25 actions, 46 options, 26 subcommands — highest action count)

### Nested subcommand extraction rule

For files with deeply nested subcommand groups (3+ levels), each intermediate `defineCommand`
MUST be extracted to a named `const` above the parent. Example for `nexus.ts`:

```typescript
// Declare leaf subcommands first
const nexusShareExportCommand = defineCommand({ ... });
const nexusShareImportCommand = defineCommand({ ... });

// Declare intermediate groups
const nexusShareCommand = defineCommand({
  meta: { name: 'share', description: 'Share operations' },
  subCommands: {
    export: nexusShareExportCommand,
    import: nexusShareImportCommand,
  },
});

// Declare root command last
export const nexusCommand = defineCommand({
  meta: { name: 'nexus', description: 'Cross-project NEXUS operations' },
  subCommands: {
    share: nexusShareCommand,
    init: defineCommand({ ... }),
  },
});
```

### requiredOption handling

Every `.requiredOption('--name <val>', 'desc')` becomes:
```typescript
name: { type: 'string', description: 'desc', required: true }
```

This is syntactically different from the shim but semantically identical.

### Verification gate (Wave 4) — per file

After each of the 9 files:

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Spot-check the specific file's commands:
```bash
cleo agent list --help
cleo session start --help
cleo memory find --help
cleo admin help --help
cleo nexus share --help
```

Functional smoke test (verify no crash):
```bash
cleo agent list 2>&1 | head -5
cleo session status 2>&1 | head -5
```

---

## Wave 5 — Help System Rewrite

**Scope**: `help-renderer.ts`, `help-generator.ts`

**Trigger**: All 102 command files are native citty. `rootShim._subcommands` is empty.

### help-renderer.ts rewrite

Remove all `ShimCommand` imports and coupling. The two functions that walked `ShimCommand[]`
are rewritten to walk the `CommandDef.subCommands` tree from `index.ts`:

**`buildAliasMap` rewrite**:
- Input changes from `ShimCommand[]` to the `subCommands: Record<string, CommandDef>` map.
- Alias detection: iterate `Object.entries(subCommands)`. Two entries with identical object
  references (`===`) indicate an alias relationship. The canonical name is the first-seen
  entry; subsequent identical references are aliases.

**`renderGroupedHelp` rewrite**:
- Input changes from `ShimCommand[]` to `CommandMeta[]`.
- `CommandMeta` is now sourced exclusively from `metaFromCittyDef()` — no shim path remains.
- `COMMAND_GROUPS` constant is retained unchanged (it is shim-independent grouping config).
- `NATIVE_COMMAND_DESCS` is deleted — all commands are now native and self-describing via
  `meta.description`.

**`createCustomShowUsage` rewrite**:
- The custom root-help renderer is updated to consume `CommandMeta[]` from the native
  `subCommands` tree.
- The split between custom root help (citty custom renderer) and sub-command help (citty
  built-in) is preserved.

### help-generator.ts cleanup

Remove `applyParamDefsToCommand()` (now dead code — no command file calls it).
Retain `buildOperationHelp()` (still used for `meta.description` generation).
Retain `buildCittyArgsFromParamDefs()` (introduced in Wave 0 — still in use).

### Verification gate (Wave 5)

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

Full help verification:
```bash
cleo --help                          # root help — all groups present
cleo session --help                  # subcommand group help
cleo session start --help            # leaf subcommand help
cleo agent list --help               # complex nested help
cleo done --help                     # alias resolves and shows help
cleo labels --help                   # isDefault command shows help
```

Verify group ordering matches pre-migration `cleo --help` output.

---

## Wave 6 — Shim Deletion

**Scope**: `commander-shim.ts`, `index.ts` (shim code), 20 test files

**Trigger**: Wave 5 is complete. Zero files import `commander-shim.ts`.

### Deletions in index.ts

Remove in order:
1. `const rootShim = new ShimCommand()` — the root shim instantiation
2. All `registerXxxCommand(rootShim)` calls — none should remain after Waves 1–4
3. The `shimToCitty()` function (lines 248–345 approximately)
4. The `for (const shim of rootShim._subcommands)` bridge loop
5. All `import { registerXxxCommand }` imports — none should remain
6. The `import { ShimCommand } from './commander-shim.js'` import

After removals, `index.ts` is a flat import-and-assign pattern:
```typescript
import { showCommand } from './commands/show.js';
import { sessionCommand } from './commands/session.js';
// ... all 102 native command imports ...
subCommands['show'] = showCommand;
subCommands['session'] = sessionCommand;
subCommands['done'] = completeCommand;  // aliases
// ... all assignments ...
```

### File deletion

Delete: `packages/cleo/src/cli/commander-shim.ts`

Verify no remaining imports:
```bash
grep -r "commander-shim" /mnt/projects/cleocode/packages/cleo/src/ --include="*.ts"
grep -r "ShimCommand" /mnt/projects/cleocode/packages/cleo/src/ --include="*.ts"
grep -r "shimToCitty" /mnt/projects/cleocode/packages/cleo/src/ --include="*.ts"
```

All three must return zero results.

### Test file updates (20 files)

The following test files import `ShimCommand` or call `registerXxxCommand()` and must be
rewritten to use the native `CommandDef` pattern:

**In `packages/cleo/src/cli/commands/__tests__/`** (10 files):
```
add-description.test.ts
agent-attach.test.ts
agent-list-global.test.ts
agent-remove-global.test.ts
backup-export.test.ts
backup-import.test.ts
backup-inspect.test.ts
nexus.test.ts
restore-finalize.test.ts
schema.test.ts
```

**In `packages/cleo/src/cli/__tests__/`** (10 files):
```
checkpoint.test.ts
commands.test.ts
docs.test.ts
export-tasks.test.ts
help-generator.test.ts
import-tasks.test.ts
safestop.test.ts
startup-migration.test.ts
testing.test.ts
web.test.ts
```

### Test rewrite rules

**Pattern A (structural) tests** — replace with `CommandDef` shape assertions:

```typescript
// Before
const program = new ShimCommand();
registerSchemaCommand(program);
const cmd = program.commands.find(c => c.name() === 'schema');
expect(cmd).toBeDefined();

// After
import { schemaCommand } from '../schema.js';
describe('schemaCommand', () => {
  it('is defined', () => {
    expect(schemaCommand).toBeDefined();
    expect(schemaCommand.meta).toBeDefined();
  });
});
```

**Pattern B (behavioral) tests** — call `run()` directly:

```typescript
// Before
await schemaCmd._action(operationArg, { format: 'json', includeGates: true });

// After
vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

await schemaCommand.run?.({
  args: { operation: operationArg, format: 'json', includeGates: true },
  rawArgs: [operationArg, '--format', 'json'],
  cmd: schemaCommand,
});

expect(dispatchFromCli).toHaveBeenCalledWith(
  'query', 'tasks', 'schema', { operation: operationArg }, expect.any(Object),
);
```

### Verification gate (Wave 6)

```bash
# Verify zero shim references
grep -r "ShimCommand\|shimToCitty\|commander-shim\|registerXxxCommand" \
  /mnt/projects/cleocode/packages/cleo/src/ --include="*.ts" | wc -l
# Must output: 0

pnpm biome check --write .
pnpm run build
pnpm run test
```

Full functional smoke test:
```bash
cleo --help
cleo show T001
cleo session status
cleo agent list
cleo memory find "recent"
```

---

## Verification Gates Summary

| Wave | Files | Build | Lint | Test | Spot-check |
|------|-------|-------|------|------|------------|
| 0 | 3 (help-renderer, help-generator, index.ts) | MUST PASS | MUST PASS | MUST PASS | `cleo --help` renders all groups |
| 1 | 29 simple | MUST PASS | MUST PASS | MUST PASS | 5 commands `--help` |
| 2 | ~49 medium | MUST PASS | MUST PASS | MUST PASS | 5 subcommand `--help` |
| 3 | ~10 alias/isDefault | MUST PASS | MUST PASS | MUST PASS | 5 commands + alias resolution |
| 4 | 9 complex (per file) | MUST PASS | MUST PASS | MUST PASS | Per-file functional smoke test |
| 5 | 2 help files | MUST PASS | MUST PASS | MUST PASS | Full `--help` regression |
| 6 | 1 deletion + 20 tests | MUST PASS | MUST PASS | MUST PASS | Zero shim references confirmed |

The standard command sequence for every gate:

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

No wave may begin until the previous wave's gate passes with zero new failures.

---

## Rollback Strategy

Each wave is committed in discrete, atomic git commits. If any commit introduces failures:

1. **Identify the failing commit** via `git log --oneline`.
2. **Revert the specific commit**: `git revert <sha>` — do NOT use `git reset --hard`.
3. **Diagnose the root cause** before re-attempting.
4. **Fix the underlying issue** in the command file or pattern.
5. **Re-stage and create a NEW commit** — do not amend history.

The shim remains fully functional through Wave 5. A reverted Wave 1–4 commit restores the
shim-based command with no loss of CLI functionality. Wave 6 is the only irreversible step;
it MUST NOT begin until the Wave 5 gate passes completely.

**Rollback is safe for any wave** because:
- The `shimToCitty()` bridge in `index.ts` still converts any shim-registered command.
- Native command assignments in `index.ts` simply override the shim path for that name.
- Removing a native assignment and re-adding the `registerXxxCommand(rootShim)` call restores
  the original shim behavior for that command.

---

## index.ts Transition Specification

### State during Waves 1–4

Both shim registrations and native `subCommands` assignments coexist. The `rootShim` is still
instantiated. The `shimToCitty()` bridge loop still runs for any command not yet migrated.

```typescript
// Native commands (migrated — assigned directly)
import { showCommand } from './commands/show.js';
import { codeCommand } from './commands/code.js';
subCommands['show'] = showCommand;
subCommands['code'] = codeCommand;

// Shim commands (not yet migrated — bridge still active)
registerSessionCommand(rootShim);  // until session.ts is migrated in Wave 4
for (const shim of rootShim._subcommands) {
  subCommands[shim._name] = shimToCitty(shim);
  for (const alias of shim._aliases) {
    subCommands[alias] = shimToCitty(shim);
  }
}
```

The `CommandMeta[]` builder in `index.ts` merges both sources:
```typescript
const nativeMetas = Object.entries(nativeSubCommands)
  .filter(([, def], idx, arr) => arr.findIndex(([, d]) => d === def) === idx)  // dedupe aliases
  .map(([name, def]) => metaFromCittyDef(name, def));

const shimMetas = rootShim._subcommands.map(metaFromShim);

const allMetas = [...nativeMetas, ...shimMetas];
```

### State during Wave 5

All commands are native citty. `rootShim._subcommands` is empty. The bridge loop runs but
processes zero commands. `help-renderer.ts` is rewritten to walk `CommandDef.subCommands`
directly.

### State after Wave 6

`index.ts` is pure citty. No `ShimCommand` import. No `shimToCitty()` function. No
`rootShim` variable. No bridge loop. The `subCommands` record is built entirely from direct
`import` + assignment:

```typescript
import { showCommand }        from './commands/show.js';
import { sessionCommand }     from './commands/session.js';
import { agentCommand }       from './commands/agent.js';
// ... all 102 native command imports ...

const subCommands: Record<string, CommandDef> = {
  show: showCommand,
  session: sessionCommand,
  agent: agentCommand,
  done: completeCommand,     // alias
  // ...
};
```

---

## Acceptance Criteria Checklist

- [ ] Wave 0: `CommandMeta` adapter in `help-renderer.ts`; `buildCittyArgsFromParamDefs` in `help-generator.ts`
- [ ] Wave 1: All 29 simple commands migrated; gate passes; `--help` verified for 5+ commands
- [ ] Wave 2: All ~49 medium commands without special features migrated; gate passes
- [ ] Wave 3: All ~10 medium commands with aliases/isDefault migrated; alias resolution verified
- [ ] Wave 4: All 9 complex commands migrated (one per commit); per-file gate passes
- [ ] Wave 5: `help-renderer.ts` rewritten; `NATIVE_COMMAND_DESCS` deleted; full `--help` regression passes
- [ ] Wave 6: `commander-shim.ts` deleted; zero `ShimCommand` references; 20 test files updated; all gates pass

---

## Out of Scope

The following are explicitly excluded from this migration:

- **ParamDef enrichment** of `registry.ts` (T4897 — tracked separately; 183 ops still have empty `params[]`)
- **`dynamic.ts` auto-generation** (blocked by ParamDef coverage gap; independent of this migration)
- **Variadic positional args** (citty has no native equivalent; existing commands receive as string and split manually — this behavior is preserved as-is)
- **Changes to the dispatch layer** (`dispatchFromCli`, `dispatchRaw`, `handleRawError` are unchanged)
- **Global flag resolution** in `index.ts` startup (`setFormatContext`, `setFieldContext` calls remain unchanged)

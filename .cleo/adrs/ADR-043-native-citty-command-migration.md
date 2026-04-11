# ADR-043 — Native Citty Command Architecture for Shim Removal

**Status**: PROPOSED
**Date**: 2026-04-10
**Task**: T490 (A: Shim removal ADR — native citty command architecture)
**Parent Epic**: T487

---

## Context

The CLEO CLI currently operates through a two-layer indirection:

1. **`commander-shim.ts`** (`ShimCommand`) — a Commander.js-compatible API that captures command definitions (name, args, options, subcommands, actions) at registration time.
2. **`shimToCitty()`** in `index.ts` — a translation function that converts every captured `ShimCommand` tree into a citty `CommandDef` at startup.

Every command file (102 of 106) calls `registerXxxCommand(rootShim)` and uses the shim API. Only `code.ts` uses native citty directly, wired via `subCommands['code'] = codeCommand` in `index.ts`.

This architecture was introduced as a migration bridge when the codebase moved from Commander.js to citty. The bridge was always intended to be temporary. The shim now creates ongoing costs:

- Every CLI startup pays the O(n) `shimToCitty()` translation over ~102 command trees.
- `help-renderer.ts` is coupled to `ShimCommand[]` internals (`_subcommands`, `_aliases`, `_description`).
- 20+ test files construct `new ShimCommand()` and access internal fields (`._action`, `.commands`, `.options`, `._args`) — coupling tests to the shim's implementation rather than the command's behavior.
- New commands must use the shim API rather than the native citty pattern already established by `code.ts`.
- The shim blocks adoption of citty features not expressible through the Commander-compatible API (e.g., `type: 'enum'` ArgDef).

The research report for T488 catalogued 106 command files across four complexity tiers, identified five shim-specific features requiring design decisions, and confirmed that citty's `defineCommand` API can express all current shim patterns with explicit workarounds for three gaps (`isDefault`, `optsWithGlobals`, `parseFn`).

---

## Decisions

### Decision 1: Target Command Pattern

All migrated commands MUST export a named `CommandDef` constant rather than a `registerXxx(program)` function. The constant name MUST follow the convention `<name>Command` (matching `codeCommand` in the reference implementation).

#### 1a. Simple Commands (Single Action)

Commands with a single action and no subcommands use the flat `defineCommand` form. The `show` command illustrates the pattern before and after:

**Before (shim pattern):**
```typescript
export function registerShowCommand(program: Command): void {
  const cmd = program.command('show').description('...');
  applyParamDefsToCommand(cmd, SHOW_PARAMS, 'tasks.show');
  cmd.action(async (taskId: string) => {
    await dispatchFromCli('query', 'tasks', 'show', { taskId }, { command: 'show' });
  });
}
```

**After (native citty pattern):**
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

Rules for simple commands:
- `meta.description` MUST be a single-line description. Multi-line `buildOperationHelp()` strings MAY be used in `meta.description` — citty renders them verbatim in `--help` output.
- Positional arguments MUST use `type: 'positional'` in `args:`. They MUST NOT be encoded in the command name string (the shim pattern of `program.command('show <taskId>')`).
- Options MUST declare `type: 'string'` or `type: 'boolean'`. Required options MUST set `required: true`.
- The `run` function signature is `async run({ args })` where `args` is typed by the `args:` declaration.
- `dispatchFromCli` calls pass `args` fields explicitly — no spread of the full `args` object unless all fields map 1:1 to dispatch params.

#### 1b. Subcommand Groups

Commands with multiple subcommands use `subCommands:` in `defineCommand`. The `session` command illustrates the pattern:

**Before (shim pattern):**
```typescript
export function registerSessionCommand(program: Command): void {
  const session = program.command('session').description('Manage work sessions');
  session.command('start')
    .requiredOption('--scope <scope>', 'Session scope')
    .requiredOption('--name <name>', 'Session name')
    .option('--focus <taskId>', 'Set initial task')
    .action(async (opts) => {
      await dispatchFromCli('mutate', 'session', 'start', { scope: opts['scope'], name: opts['name'], focus: opts['focus'] }, { command: 'session', operation: 'session.start' });
    });
  session.command('status')
    .description('Show current session status')
    .action(async () => { ... });
}
```

**After (native citty pattern):**
```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage work sessions' },
  subCommands: {
    start: defineCommand({
      meta: { name: 'start', description: 'Start a new session' },
      args: {
        scope: { type: 'string', description: 'Session scope (epic:T### or global)', required: true },
        name:  { type: 'string', description: 'Session name', required: true },
        focus: { type: 'string', description: 'Set initial task to work on' },
        agent: { type: 'string', description: 'Agent identifier' },
        grade: { type: 'boolean', description: 'Enable behavioral grading audit logging' },
      },
      async run({ args }) {
        await dispatchFromCli(
          'mutate', 'session', 'start',
          { scope: args.scope, name: args.name, focus: args.focus, grade: args.grade },
          { command: 'session', operation: 'session.start' },
        );
      },
    }),
    status: defineCommand({
      meta: { name: 'status', description: 'Show current session status' },
      async run() {
        // ... dispatch call
      },
    }),
    // additional subcommands ...
  },
});
```

Rules for subcommand groups:
- The parent `defineCommand` MUST declare `subCommands:` as an object literal with one key per subcommand.
- The parent MAY omit a `run()` function when it has no direct action (citty shows usage automatically for unrouted subcommand groups). See Decision 2 for the `isDefault` exception.
- Each subcommand is a `defineCommand({...})` call — inline or extracted to a `const` if the definition is large.
- Subcommands with many args (>8) SHOULD extract their `defineCommand` to a named `const` above the parent for readability.

#### 1c. Dispatch Integration

The `run({ args })` callback MUST call `dispatchFromCli` (or `dispatchRaw`) following the existing call signature:

```typescript
await dispatchFromCli(gateway, domain, operation, params, context);
```

Where:
- `gateway` is `'query'` or `'mutate'` — unchanged from the shim pattern.
- `params` MUST be built explicitly from `args` fields — no `{ ...args }` spread, because citty injects internal fields (`_`) into `args` alongside declared args.
- `context` carries `{ command: 'name', operation?: 'domain.op' }` — unchanged.

Custom value parsing (the shim's `parseFn`) MUST be done inline before the dispatch call:

```typescript
async run({ args }) {
  const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
  await dispatchFromCli('query', 'session', 'find', { limit }, { command: 'session' });
}
```

#### 1d. Option Mapping to Citty Args

| Shim API | Citty `args:` entry |
|----------|---------------------|
| `.option('--dry-run', 'desc')` | `'dry-run': { type: 'boolean', description: 'desc' }` |
| `.option('--scope <s>', 'desc')` | `scope: { type: 'string', description: 'desc' }` |
| `.option('-s, --scope <s>', 'desc')` | `scope: { type: 'string', alias: 's', description: 'desc' }` |
| `.requiredOption('--scope <s>', 'desc')` | `scope: { type: 'string', description: 'desc', required: true }` |
| `.option('--limit <n>', 'desc', parseInt)` | `limit: { type: 'string', description: 'desc' }` + inline parse in `run()` |
| `.option('--limit <n>', 'desc', parseInt, 10)` | `limit: { type: 'string', description: 'desc', default: '10' }` + inline parse |
| `program.command('show <taskId>')` (positional) | `taskId: { type: 'positional', description: 'desc', required: true }` |
| `program.command('find [query]')` (optional positional) | `query: { type: 'positional', description: 'desc', required: false }` |

Enum values (currently expressed as description text hints in the shim) SHOULD use citty's `type: 'enum'` where appropriate:

```typescript
status: { type: 'enum', options: ['active', 'ended', 'orphaned'], description: 'Filter by status' }
```

This is a citty capability not expressible through the shim and SHOULD be adopted during migration.

---

### Decision 2: Subcommand Group Strategy

#### 2a. Converting `.command('name').action(...)` Chains

Each `.command('name')` chain on a parent shim becomes one key in the `subCommands:` object literal. The key is the subcommand name string.

**Mapping rule:**
```
parent.command('start').option(...).action(fn)
  →
subCommands: { start: defineCommand({ args: {...}, run: fn }) }
```

Subcommand aliases registered with `.alias('end')` on a subcommand become duplicate keys in `subCommands:` pointing to the same `defineCommand` reference:

```typescript
const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop the current session' },
  args: { note: { type: 'string', description: 'Stop note' } },
  async run({ args }) { ... },
});

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage work sessions' },
  subCommands: {
    stop: stopCommand,
    end: stopCommand,  // alias: same reference
  },
});
```

The 8 files using `.alias()` on subcommands MUST use this duplicate-key pattern.

#### 2b. The `isDefault` Pattern

The shim's `{ isDefault: true }` option has no equivalent in citty. Five files use it: `admin.ts`, `context.ts`, `env.ts`, `labels.ts`, and `phases.ts`.

The canonical replacement is an explicit `run()` on the parent `defineCommand` that:
1. Inspects `rawArgs` to determine whether any subcommand name was passed.
2. If no subcommand was passed, invokes the default subcommand's handler directly.
3. If a subcommand was passed, returns immediately (citty handles routing).

The `rawArgs` inspection MUST use exact set membership, not substring matching, to avoid misfires when a flag value equals a subcommand name.

**Standard `isDefault` pattern:**
```typescript
// Default action extracted to a named async function for reuse
async function listLabels(): Promise<void> {
  await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
}

export const labelsCommand = defineCommand({
  meta: { name: 'labels', description: 'List all labels with counts or show tasks with specific label' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all labels with task counts (default)' },
      async run() { await listLabels(); },
    }),
    show: defineCommand({
      meta: { name: 'show', description: 'Show tasks with specific label' },
      args: { label: { type: 'positional', description: 'Label name', required: true } },
      async run({ args }) {
        await dispatchFromCli('query', 'tasks', 'list', { label: args.label }, { command: 'labels' });
      },
    }),
    stats: defineCommand({
      meta: { name: 'stats', description: 'Show detailed label statistics' },
      async run() { await listLabels(); },
    }),
  },
  // Explicit default: run 'list' when no subcommand is given
  async run({ rawArgs }) {
    const subCommandNames = new Set(['list', 'show', 'stats']);
    if (rawArgs.some((a) => subCommandNames.has(a))) return;
    await listLabels();
  },
});
```

Rules for the `isDefault` pattern:
- The `subCommandNames` set MUST include ALL subcommand names AND their aliases registered as duplicate keys.
- The default action MUST be extracted to a local `async function` so both the parent `run()` and the default subcommand's `run()` can call it without duplication.
- The parent `run()` MUST guard with the rawArgs check first and return early if a subcommand is present — this mirrors the `shimToCitty()` bridge's existing guard logic.

#### 2c. Nested Subcommand Groups

Citty supports arbitrary nesting through `subCommands:` at any depth. The pattern extends naturally:

```typescript
// e.g. cleo nexus share export
export const nexusCommand = defineCommand({
  meta: { name: 'nexus', description: 'Cross-project NEXUS operations' },
  subCommands: {
    share: defineCommand({
      meta: { name: 'share', description: 'Share operations' },
      subCommands: {
        export: defineCommand({
          meta: { name: 'export', description: 'Export shared tasks' },
          args: { ... },
          async run({ args }) { ... },
        }),
        import: defineCommand({ ... }),
      },
    }),
    init: defineCommand({ ... }),
  },
});
```

For deeply nested groups (3+ levels), each intermediate `defineCommand` SHOULD be extracted to a named `const` in the same file to avoid unreadable nesting. For example, `nexusShareCommand` would be declared before `nexusCommand` and referenced in `subCommands: { share: nexusShareCommand }`.

---

### Decision 3: Help Generation

#### 3a. Per-Command Help (Sub-Command `--help`)

Sub-command help (e.g., `cleo session start --help`) currently flows through citty's built-in renderer, which reads `meta.description`, `meta.name`, and the `args:` object. This works identically for native citty commands. No change is required for per-command help during or after migration.

`buildOperationHelp()` in `help-generator.ts` generates a multi-line description string. This function takes no dependency on `ShimCommand` — it generates a plain `string`. Migrated commands MAY continue to call `buildOperationHelp()` and pass its result to `meta.description`. Citty renders `meta.description` verbatim; the multi-line output will appear in `--help` exactly as it does today.

`applyParamDefsToCommand()` in `help-generator.ts` does take a `ShimCommand` as its target and registers options onto it. This function MUST NOT be called in migrated commands. Migrated commands that previously used `applyParamDefsToCommand()` MUST declare their args explicitly in the `args:` object of `defineCommand`. A replacement utility `buildCittyArgsFromParamDefs(params: ParamDef[]): ArgsDef` MUST be introduced in `help-generator.ts` to preserve the ParamDef-driven generation path for commands like `show.ts` and `add.ts`.

#### 3b. Root Help (`cleo --help`)

The current `help-renderer.ts` implementation has two coupling points to `ShimCommand`:

1. `buildAliasMap(shims: ShimCommand[])` — reads `shim._aliases[]` and `shim._name` for each registered command.
2. `renderGroupedHelp(version, shims, aliasMap)` — reads `shim._name` and `shim._description` to build the command description map.

The `NATIVE_COMMAND_DESCS` constant hard-codes descriptions for commands that bypass the shim (`version`, `code`). Every new native citty command must be added to this map manually, which is the current blocker for incremental migration.

**Transition strategy — compatibility adapter:**

During the migration period (while both shim-based and native commands coexist), `help-renderer.ts` MUST be extended with a `CommandMeta` abstraction that can be sourced from either a `ShimCommand` or a native citty `CommandDef`:

```typescript
/** Unified metadata shape for root help rendering — source-agnostic. */
interface CommandMeta {
  name: string;
  description: string;
  aliases: string[];
}

/** Extract CommandMeta from a ShimCommand (existing shim-based commands). */
function metaFromShim(shim: ShimCommand): CommandMeta { ... }

/** Extract CommandMeta from a native citty CommandDef. */
async function metaFromCittyDef(name: string, def: CommandDef): Promise<CommandMeta> { ... }
```

`renderGroupedHelp` and `buildAliasMap` MUST be updated to accept `CommandMeta[]` rather than `ShimCommand[]`. The call site in `index.ts` MUST produce a merged `CommandMeta[]` from both the shim list and the native command map.

This adapter approach allows each command to be migrated independently without requiring a simultaneous rewrite of `help-renderer.ts`. The `NATIVE_COMMAND_DESCS` hard-code is eliminated once all commands are native.

**End state (post-migration):**

Once all commands are native citty, `buildAliasMap` and `renderGroupedHelp` MUST be rewritten to walk the `main.subCommands` tree directly. The walk is straightforward — `Object.entries(subCommands)` yields `[name, CommandDef]` pairs, and duplicate keys (aliases) are identified by detecting that two keys reference the same object identity (`===`). No `ShimCommand` import remains.

#### 3c. Citty Built-In Help vs. Custom Rendering

Citty's `showUsage` / `renderUsage` functions render a flat arg listing from `meta` and `args:`. They are used today for all sub-command help. This decision does NOT change that behavior. The custom renderer (`createCustomShowUsage` in `help-renderer.ts`) remains the root help handler; citty's built-in renderer remains the sub-command help handler. This split MUST be preserved post-migration.

---

### Decision 4: Test Mock Replacement

#### 4a. What the Shim Provides to Tests Today

Current tests use `ShimCommand` in two distinct ways:

**Pattern A — structural inspection (most common):**
Tests construct a `ShimCommand`, call `registerXxxCommand(program)`, then inspect `.commands`, `.options`, `._action`, `.registeredArguments` to verify that the command was wired correctly.

```typescript
// Pattern A — structural (safestop.test.ts, commands.test.ts, etc.)
const program = new ShimCommand();
registerSafestopCommand(program);
const cmd = program.commands.find((c) => c.name() === 'safestop');
expect(cmd).toBeDefined();
const reasonOpt = cmd!.options.find((o) => o.long === '--reason');
expect(reasonOpt!.required).toBe(true);
```

**Pattern B — behavioral (schema.test.ts, backup-inspect.test.ts, etc.):**
Tests construct a `ShimCommand`, register the command, extract `._action`, and call it directly with crafted arguments to verify dispatch behavior.

```typescript
// Pattern B — behavioral (schema.test.ts)
const program = new ShimCommand();
registerSchemaCommand(program);
const schemaCmd = program.commands.find((c) => c.name() === 'schema');
await schemaCmd._action(operationArg, { format: 'json', includeGates: true });
```

#### 4b. Replacement Pattern for Native Citty Commands

Native citty commands export a `CommandDef` constant directly. Tests MUST import the constant and interact with it through the citty API. No `ShimCommand` construction is needed.

**For Pattern A (structural verification):**

Structural inspection of registration is largely unnecessary for native citty commands because there is no registration ceremony — the constant IS the command definition. Tests SHOULD instead assert on the shape of the exported `CommandDef` directly:

```typescript
import { showCommand } from '../show.js';

describe('showCommand', () => {
  it('declares taskId as a required positional arg', () => {
    const argsDef = showCommand.args as Record<string, { type: string; required?: boolean }>;
    expect(argsDef['taskId'].type).toBe('positional');
    expect(argsDef['taskId'].required).toBe(true);
  });

  it('has the correct meta name', async () => {
    const meta = typeof showCommand.meta === 'function' ? await showCommand.meta() : showCommand.meta;
    expect(meta?.name).toBe('show');
  });
});
```

**For Pattern B (behavioral verification):**

Tests call `run()` directly on the exported command or on a specific subcommand. The `run` function receives a context object; tests construct a minimal context:

```typescript
import { showCommand } from '../show.js';

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

it('calls dispatchFromCli with the taskId', async () => {
  const { dispatchFromCli } = await import('../../../dispatch/adapters/cli.js');

  // run() receives { args, rawArgs, cmd }
  await showCommand.run?.({ args: { taskId: 'T001' }, rawArgs: ['T001'], cmd: showCommand });

  expect(dispatchFromCli).toHaveBeenCalledWith(
    'query', 'tasks', 'show', { taskId: 'T001' }, expect.objectContaining({ command: 'show' }),
  );
});
```

For subcommand groups, the test accesses the specific subcommand through `subCommands`:

```typescript
import { sessionCommand } from '../session.js';

it('session start calls dispatch with scope and name', async () => {
  const startCmd = (sessionCommand.subCommands as Record<string, CommandDef>)['start'];
  await startCmd.run?.({ args: { scope: 'global', name: 'test' }, rawArgs: ['start', '--scope', 'global', '--name', 'test'], cmd: startCmd });
  expect(dispatchFromCli).toHaveBeenCalledWith('mutate', 'session', 'start', { scope: 'global', name: 'test', ... }, ...);
});
```

#### 4c. What Replaces `vi.mock('../commander-shim.js', ...)`

No test file currently uses `vi.mock('../commander-shim.js')` with a factory mock of the ShimCommand class itself. Tests import `ShimCommand` and construct real instances. After migration, these imports simply disappear from test files — the `ShimCommand` constructor calls are replaced by direct imports of the exported `CommandDef` constants.

The mock targets that DO change are dispatch mocks. The pattern `vi.mock('../../dispatch/adapters/cli.js', () => ({ dispatchFromCli: vi.fn() }))` remains unchanged and continues to work identically for native citty tests.

---

### Decision 5: Registration Pattern

#### 5a. How Commands Are Registered in `index.ts`

Native citty commands are registered by importing the exported `CommandDef` constant and assigning it directly to the `subCommands` record in `index.ts`. The `codeCommand` already demonstrates this pattern:

```typescript
// index.ts — current native registration (lines 358-360)
import { codeCommand } from './commands/code.js';
subCommands['code'] = codeCommand;
```

Every migrated command MUST follow this same pattern. The `registerXxxCommand(rootShim)` call is removed, the import changes from the register function to the command constant, and the assignment into `subCommands` is added.

**Example — migrating the `show` command:**

```typescript
// Before (index.ts)
import { registerShowCommand } from './commands/show.js';
// ...
registerShowCommand(rootShim);

// After (index.ts)
import { showCommand } from './commands/show.js';
// ...
subCommands['show'] = showCommand;
```

For commands with aliases (8 files), the alias key is added as a duplicate assignment:

```typescript
// Example: 'complete' has alias 'done'
import { completeCommand } from './commands/complete.js';
subCommands['complete'] = completeCommand;
subCommands['done'] = completeCommand;  // alias — same reference
```

#### 5b. How the Entrypoint Changes

The full migration changes `index.ts` in four areas:

**Area 1 — Import block:** All `import { registerXxxCommand }` imports are replaced with `import { xxxCommand }` imports as commands are migrated.

**Area 2 — `rootShim` construction and registration block:** The `const rootShim = new ShimCommand()` and all subsequent `registerXxxCommand(rootShim)` calls are removed as each command migrates. The `rootShim` variable is deleted once the last shim-based command is migrated.

**Area 3 — `shimToCitty()` function:** Deleted once no shim-based command remains in the registration block.

**Area 4 — `buildAliasMap` and `createCustomShowUsage` call:** Updated to source `CommandMeta[]` from the native `subCommands` record instead of `rootShim._subcommands`. See Decision 3b.

**Incremental migration shape of `index.ts`:**

During migration, both patterns coexist. The `subCommands` object is built in phases — native commands are assigned directly, shim commands are still processed through `shimToCitty()`:

```typescript
// Native commands (migrated)
import { showCommand } from './commands/show.js';
import { codeCommand } from './commands/code.js';
subCommands['show'] = showCommand;
subCommands['code'] = codeCommand;

// Shim commands (not yet migrated) — shimToCitty bridge still runs
for (const shim of rootShim._subcommands) {
  subCommands[shim._name] = shimToCitty(shim);
  for (const alias of shim._aliases) {
    subCommands[alias] = shimToCitty(shim);
  }
}
```

Once `rootShim._subcommands` is empty (all commands migrated), the `for` loop and `shimToCitty` are deleted.

#### 5c. The `version` Command

The inline `version` command defined in `index.ts` is NOT a candidate for extraction to a separate file — it is a three-line inline `defineCommand` with no dispatch call. It remains in `index.ts` as-is.

---

## Consequences

### Positive

- **Startup performance**: Eliminates the O(n) `shimToCitty()` translation on every CLI invocation. 102 command trees no longer need to be walked and converted.
- **Type safety**: Native citty `CommandDef` carries full TypeScript types for `args`. Shim internal fields (`._action`, `._subcommands`, `._options`) accessed by tests become unnecessary.
- **Citty feature access**: Commands can use `type: 'enum'` ArgDef and other citty capabilities currently blocked by the shim API surface.
- **Reduced surface area**: `commander-shim.ts` (250+ lines), `shimToCitty()` (100 lines), and the `ShimCommand` import in 20 test files are all eliminated.
- **Clearer architecture**: The CLI entry point becomes a flat import-and-assign pattern rather than a registration ceremony followed by a translation pass.

### Negative / Risks

- **Migration volume**: 102 command files must be migrated in waves. The Tier 3 files (9 complex commands) require careful attention to `isDefault`, `optsWithGlobals`, and multi-step async logic.
- **Test rewrite required**: 20 test files must change from structural ShimCommand inspection to direct `CommandDef` and `run()` invocation. Behavioral coverage is preserved; structural inspection is largely replaced by type-safety.
- **Help renderer coupling**: `help-renderer.ts` requires the `CommandMeta` adapter extension before migrated commands can appear correctly in `cleo --help`. This is the first implementation task and a gate for all subsequent waves.
- **`optsWithGlobals()` gap**: 3 files (`doctor.ts`, `self-update.ts`, `upgrade.ts`) currently call `command.optsWithGlobals()`. After migration, these MUST read global flag state from the format/field context modules set in `index.ts` startup (`getFormatContext()`, `getFieldContext()`). The startup block already sets these contexts; the commands need to import and read them rather than calling `optsWithGlobals()`.
- **Variadic positional gap**: Citty's `PositionalArgDef` has no variadic field. Any command accepting variadic positionals MUST receive the value as a space-joined string and split inside `run()`, or restructure to accept repeated `--flag` invocations.

### Neutral

- The dispatch layer (`dispatchFromCli`, `dispatchRaw`, `handleRawError`) is unchanged. All migration work is in the CLI layer only.
- Global flag resolution in `index.ts` startup is unchanged — the `process.argv` parse and `setFormatContext`/`setFieldContext` calls remain.
- `buildOperationHelp()` remains useful for generating `meta.description` strings. Only `applyParamDefsToCommand()` requires a citty-native replacement (`buildCittyArgsFromParamDefs`).

---

## Implementation Order (Recommended)

| Wave | Scope | Gate |
|------|-------|------|
| 0 | `help-renderer.ts` — add `CommandMeta` adapter; update `buildAliasMap` and `renderGroupedHelp` to accept `CommandMeta[]`; update `index.ts` to produce merged `CommandMeta[]` | Required before any command migration |
| 0 | `help-generator.ts` — add `buildCittyArgsFromParamDefs(params: ParamDef[]): ArgsDef` | Required before migrating `show.ts`, `add.ts` |
| 1 | 29 Tier 1 simple commands (single action, direct dispatch) | Lowest risk; validates the pattern |
| 2 | 49 Tier 2 commands without aliases or `isDefault` | Multi-subcommand groups, no special shim features |
| 3 | 15 Tier 2 commands with aliases or `isDefault` | Duplicate-key pattern and parent `run()` fallback |
| 4 | 9 Tier 3 complex commands (`agent`, `session`, `memory-brain`, `orchestrate`, `nexus`, `skills`, `research`, `lifecycle`, `admin`) | Highest option density and `optsWithGlobals` usage |
| 5 | `help-renderer.ts` — remove `ShimCommand` import; rewrite to walk `subCommands` tree directly | Once all commands are native |
| 6 | Delete `commander-shim.ts`, `shimToCitty()`, and `rootShim` from `index.ts` | Final cleanup |

Each wave MUST pass `pnpm biome check --write .`, `pnpm run build`, and `pnpm run test` with zero new failures before the wave is marked complete.

---

## References

- T488 research report: `.cleo/agent-outputs/T488-shim-removal-research.md`
- Reference implementation: `packages/cleo/src/cli/commands/code.ts`
- Current bridge: `packages/cleo/src/cli/index.ts` (lines 248–345, `shimToCitty`)
- Help renderer: `packages/cleo/src/cli/help-renderer.ts`
- Help generator: `packages/cleo/src/cli/help-generator.ts`
- Shim implementation: `packages/cleo/src/cli/commander-shim.ts`
- Citty version: `^0.2.1` (resolved `citty@0.2.1`)

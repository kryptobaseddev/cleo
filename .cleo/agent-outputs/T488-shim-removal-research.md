# T488 — Commander-Shim Removal Research

**Date**: 2026-04-10
**Task**: T488 — R: Shim removal research — analyze citty patterns, code.ts reference, migration path
**Parent**: T487
**Status**: Research complete

---

## 1. Native Citty Reference: `code.ts`

### Pattern Overview

`packages/cleo/src/cli/commands/code.ts` is the single command file that uses native citty rather than the commander-shim. It exports a `codeCommand` object (not a `register*` function), which is wired directly into `index.ts` via `subCommands['code'] = codeCommand`.

### Exact Import Pattern

```typescript
import { defineCommand } from 'citty';

export const codeCommand = defineCommand({
  meta: { name: 'code', description: 'Code analysis via tree-sitter AST' },
  subCommands: {
    outline: defineCommand({ ... }),
    search: defineCommand({ ... }),
    unfold: defineCommand({ ... }),
  },
});
```

### Structural Differences vs. Shim-Based Commands

| Dimension | Native citty (`code.ts`) | Shim-based (all others) |
|-----------|--------------------------|--------------------------|
| Registration | Exports `const codeCommand` | Exports `registerXxxCommand(program: Command)` |
| Import in index.ts | Direct: `subCommands['code'] = codeCommand` | Via `shimToCitty(shim)` bridge |
| Option/arg declaration | `args:` object with typed `ArgDef` entries | `.option()` / `.requiredOption()` / `.argument()` chains |
| Subcommand declaration | `subCommands:` object literal | `.command('name')` chaining on parent shim |
| Run handler signature | `async run({ args }) { ... }` | `async (positional1, positional2, opts) => { ... }` |
| Enum support | `type: 'enum', options: [...]` | Embedded in description text via `enumHint` |
| Global flag access | Must read `process.argv` or set field context externally | `command.optsWithGlobals()` / `command.opts()` via shim |
| Help text | citty built-in renderer from `meta.description` | `buildOperationHelp()` multi-section string injected into `.description()` |
| Aliases | `subCommands['alias'] = sameRef` | `.alias('name')` method |

### What `code.ts` Does NOT Have

- No `requiredOption` equivalent needed (citty supports `required: true` on any ArgDef)
- No `parseFn` custom parser (all args treated as strings; manual `parseInt` inside `run`)
- No access to global flags (`--json`, `--human`, `--quiet`) through the command context — these are resolved externally in `index.ts` startup block
- No `isDefault` subcommand fallback

---

## 2. Citty API Analysis

**Version**: `^0.2.1` (resolved to `citty@0.2.1`)

### Full Public API Surface

From `citty/dist/index.d.mts`:

```typescript
// Core function — the only import code.ts uses
function defineCommand<T extends ArgsDef>(def: CommandDef<T>): CommandDef<T>

// Execution
function runMain<T>(cmd: CommandDef<T>, opts?: RunMainOptions): Promise<void>
function runCommand<T>(cmd: CommandDef<T>, opts: RunCommandOptions): Promise<{result: unknown}>

// Help
function showUsage<T>(cmd: CommandDef<T>, parent?: CommandDef<T>): Promise<void>
function renderUsage<T>(cmd: CommandDef<T>, parent?: CommandDef<T>): Promise<string>

// Arg parsing
function parseArgs<T>(rawArgs: string[], argsDef: ArgsDef): ParsedArgs<T>
```

### Supported Arg Types

| Type | ArgDef | Notes |
|------|--------|-------|
| `boolean` | `BooleanArgDef` | Supports `negativeDescription`, `alias`, `default` |
| `string` | `StringArgDef` | Supports `alias`, `default`, `required` |
| `enum` | `EnumArgDef` | Uses `options: string[]` NOT `enum:` field — important difference from shim ParamDef |
| `positional` | `PositionalArgDef` | No `alias` or `options` support |

### Feature Gap Matrix

| Shim Feature | Citty Native Equivalent | Notes |
|---|---|---|
| `.command('name [arg]')` subcommand registration | `subCommands: { name: defineCommand({...}) }` | Full support — citty-native pattern |
| `.requiredOption()` | `args: { name: { type: 'string', required: true } }` | Supported, different syntax |
| `.option('-s, --status <value>')` | `args: { status: { type: 'string', alias: 's' } }` | Supported — citty uses `alias` field |
| `.alias('shortname')` on a subcommand | `subCommands['alias'] = subCommands['primary']` | Supported by duplicate key in subCommands |
| `parseFn: parseInt` custom parse | Manual `parseInt(args.count)` inside `run()` | Not supported natively — must be inline |
| `._isDefault` default subcommand | Not supported | **BLOCKER**: citty has no `isDefault` concept; must manually invoke default in parent `run()` |
| `optsWithGlobals()` for global flags | Not supported | **BLOCKER**: no parent chain access; global flags must be read from `process.argv` or passed via context |
| `.description(text)` multi-line help | `meta.description` (single string, citty renders as-is) | `buildOperationHelp()` multi-line text works in citty via `meta.description` but citty may truncate |
| Variadic positional `[...args]` | `PositionalArgDef` has no variadic field | **GAP**: citty's `PositionalArgDef` omits `alias` and `options` but no variadic support confirmed |
| `command.opts()` return of parsed flags | `context.args` in `run()` | Different — args are typed, not a late-bound opts map |
| `.allowUnknownOption()` | Not needed — citty passes unknown args via `rawArgs._` | No-op in shim already |

### Citty Subcommand Support

Citty natively supports `subCommands` as a nested `Record<string, CommandDef>`. The `shimToCitty()` bridge in `index.ts` already translates `shim._subcommands` into this structure. Aliases are duplicated as separate keys pointing to the same converted `CommandDef`. **Sub-of-sub nesting is supported** — citty recurses through `subCommands` at any depth.

---

## 3. The `shimToCitty()` Bridge

Located in `packages/cleo/src/cli/index.ts` (lines 250–347). This is the translation layer that wraps every shim command for citty execution.

### What the Bridge Does

1. **Maps positional args**: `shim._args[]` → `cittyArgs[name] = { type: 'positional', required }`. Loses variadic information.
2. **Maps options**: `shim._options[]` → `cittyArgs[longName] = { type: string|boolean, required, alias: shortName, default }`. Preserves `parseFn` via inline application.
3. **Recursively converts subcommands**: `shim._subcommands[]` → `subCommands` object. Alias subcommands are added as duplicate keys.
4. **Builds a run function** that:
   - Detects if a subcommand was invoked via `rawArgs` inspection to avoid double-firing
   - Calls `shim._action(...positionalValues, opts, shim)` with the shim instance as third arg
   - Falls back to `defaultSub._action()` if `_isDefault` is set
   - Falls back to `showUsage(context.cmd)` if no action and no default sub

### Critical Bridge Limitation: The `shim` Instance

The bridge passes `shim` (the `ShimCommand` instance) as the third argument to `.action()`. Several commands call `command.optsWithGlobals()` inside their action handler (doctor.ts, self-update.ts, upgrade.ts). This works because `ShimCommand.optsWithGlobals()` re-parses `process.argv` each call — it is a live read, not a Commander parent-chain walk.

### Bridge Limitation: rawArgs Subcommand Detection

The bridge uses `context.rawArgs.some((a) => subCommandNames.has(a))` to avoid double-firing the parent `run()`. This is fragile: it matches on argument name presence anywhere in `rawArgs`, which could misfire if a flag value happens to equal a subcommand name.

---

## 4. Help System Dependency on ShimCommand

### `help-renderer.ts`

Receives `ShimCommand[]` (the `rootShim._subcommands` array) to:
- Build the alias map: reads `shim._aliases[]` for each command
- Build description map: reads `shim._description` for each command (parses multi-line `buildOperationHelp` output)
- Render the grouped help: iterates `COMMAND_GROUPS` to produce the `cleo --help` output

**Native citty commands are hard-coded** in `NATIVE_COMMAND_DESCS`: `version` and `code`. Any new native command must be manually added to this map.

**Coupling point**: `renderGroupedHelp()` and `buildAliasMap()` both take `ShimCommand[]` as input. To remove the shim, these functions must be replaced with an equivalent abstraction that walks the citty `subCommands` tree.

### `help-generator.ts`

`buildOperationHelp()` and `applyParamDefsToCommand()` both take a `ShimCommand` as target. Their purpose is to generate multi-section help text and register options onto the shim. After migration, `buildOperationHelp()` can remain unchanged (it generates a string), but `applyParamDefsToCommand()` must be replaced with a function that builds a citty `ArgsDef` object.

### Per-Command Help

Sub-command help (`cleo add --help`) currently flows through `shimToCitty()`: the `meta.description` of the generated citty `CommandDef` is `shim._description`, which may be a multi-line string from `buildOperationHelp()`. Citty renders `meta.description` verbatim — this works but produces inconsistent formatting compared to citty's native help for `codeCommand` subcommands.

---

## 5. Command Classification

**Total command files**: 106 (excluding `__tests__/`)

### Tier 0 — Native / Stub (4 files)

These files have zero `.action()` calls and are excluded from migration scope:

| File | Nature |
|------|--------|
| `code.ts` | Already native citty — the reference implementation |
| `agent-profile-status.ts` | Utility module (helper functions, no CLI registration) |
| `agents.ts` | Deprecated no-op stub (kept for import compatibility) |
| `dynamic.ts` | Future auto-generation stub, currently no-op |

### Tier 1 — Simple (29 files)

Single `.action()` call, ≤3 options, ≤1 `.command()` call. Direct `dispatchFromCli` delegation. Straightforward citty migration:

```
add-batch, analyze, backup-inspect, blockers, cancel, checkpoint, commands,
complete, current, delete, detect, detect-drift, exists, find, generate-changelog,
grade, list, map, next, ops, plan, promote, refresh-memory, reparent, roadmap,
show, start, stop, validate
```

Migration pattern for these: replace `program.command('name').option(...).action(fn)` with:
```typescript
export const nameCommand = defineCommand({
  meta: { name: 'name', description: '...' },
  args: { /* options */ },
  async run({ args }) { await dispatchFromCli(..., { ...args }); }
});
```

### Tier 2 — Medium (64 files)

Multiple subcommands OR >3 options, <10 total actions. The bulk of the migration:

```
adapter, add, adr, archive, archive-stats, backfill, backup, brain, briefing,
bug, cant, chain, check, claim, complexity, compliance, config, consensus,
context, contribution, dash, decomposition, deps, docs, doctor, env,
export, export-tasks, history, implementation, import, import-tasks, init,
inject, issue, labels, log, migrate-claude-mem, observe, otel, phase, phases,
provider, reason, relates, release, remote, reorder, restore, safestop,
schema, self-update, sequence, snapshot, specification, stats, sticky, sync,
testing, token, update, upgrade, verify, web
```

**Notable complexity drivers in medium tier**:
- `check.ts`: 34 options across 7 subcommands
- `token.ts`: 31 options across 7 subcommands
- `update.ts`: 20 options (single action but heavy flag set)
- `issue.ts`: 15 options across 5 subcommands
- `compliance.ts`: 10 options across 9 subcommands

### Tier 3 — Complex (9 files)

10+ actions, deeply nested subcommand trees, dynamic routing, or file I/O:

| File | Actions | Options | Subcommands | Special Features |
|------|---------|---------|-------------|-----------------|
| `agent.ts` | 25 | 46 | 26 | `requiredOption`, file I/O, multi-step async logic |
| `orchestrate.ts` | 24 | 20 | 26 | Dynamic dispatch, streaming |
| `nexus.ts` | 22 | 19 | 25 | Cross-project operations |
| `session.ts` | 14 | 33 | 15 | `requiredOption`, `alias` on sub, `isDefault` candidate |
| `skills.ts` | 15 | 10 | 15 | File I/O, tar/zip operations |
| `memory-brain.ts` | 16 | 54 | 17 | `requiredOption`, type-conditional routing, highest option count |
| `admin.ts` | 13 | 11 | 15 | `requiredOption`, `isDefault` |
| `research.ts` | 10 | 16 | 11 | `requiredOption`, MANIFEST file I/O |
| `lifecycle.ts` | 10 | 9 | 12 | `requiredOption`, multi-step pipeline |

---

## 6. Shim-Specific Features Inventory

### Feature 1: `.requiredOption()`

**Usage**: 15 command files use `requiredOption`.

**Citty equivalent**: `args: { name: { type: 'string', required: true } }` — fully supported. The difference is purely syntactic.

**Migration complexity**: Low. The shim's `required: true` in `ShimOption` is already correctly translated by `shimToCitty()`.

### Feature 2: `.alias()` on Subcommands

**Usage**: 8 files register aliases on subcommands (`backup.ts`, `complete.ts`, `delete.ts`, `list.ts`, `nexus.ts`, `phase.ts`, `session.ts`, `sticky.ts`).

**Citty equivalent**: Duplicate keys in the `subCommands` object pointing to the same `CommandDef` reference. This is how `shimToCitty()` handles it today.

**Migration complexity**: Low. Already works in the shim bridge; just needs explicit duplication in native citty.

### Feature 3: `_isDefault` — Default Subcommand Fallback

**Usage**: 5 files use `isDefault` (`admin.ts`, `context.ts`, `env.ts`, `labels.ts`, `phases.ts`).

**Citty native**: **No equivalent**. Citty has no `isDefault` concept. The bridge handles this by checking `shim._subcommands.find(s => s._isDefault)` inside the generated `run()`.

**Migration complexity**: Medium. Each file needs an explicit `run()` on the parent `defineCommand` that manually invokes the default subcommand's handler, checking `rawArgs` for the absence of any subcommand name.

### Feature 4: `optsWithGlobals()` / `opts()` — Global Flag Access

**Usage**: 3 files call `command.optsWithGlobals()` or `command.opts()` inside `.action()` (`doctor.ts`, `self-update.ts`, `upgrade.ts`).

**Citty native**: **No equivalent**. Citty's `run({ args })` only contains args declared in the command's own `args:` object. Global flags (`--json`, `--human`, `--quiet`, `--field`, `--fields`, `--mvi`) are not available through `context.args`.

**Current workaround in shim**: `ShimCommand.optsWithGlobals()` re-parses `process.argv` directly. After migration, the same `process.argv` parse can be called from inside the native citty `run()` body, or the format/field context can be read from the already-set module-level context (set in `index.ts` startup).

**Migration complexity**: Low–Medium. The pattern `resolveFieldContext(process.argv)` already exists; commands just need to import and call it, or read from the set context objects.

### Feature 5: `parseCommandName()` — Positional Arg Extraction from Command Name String

**Usage**: Implicit — every `program.command('show <taskId>')` call uses this via the `ShimCommand` constructor.

**Citty native**: Positional args are declared explicitly in `args: { name: { type: 'positional', required: true } }`. This is actually cleaner than encoding them in the name string.

**Migration complexity**: Low. Already demonstrated in `code.ts`.

### Feature 6: `parseFn` — Custom Value Parsers

**Usage**: 21 command files use `parseFloat`, `parseInt`, or custom parse functions on options.

**Citty native**: **No native equivalent**. Citty's `StringArgDef` returns raw strings. Custom parsing must be done inline inside `run()`.

**Migration complexity**: Low. All current parsers are simple `parseInt(val, 10)` or `parseFloat(val)` calls that move easily into `run()`.

### Feature 7: `_subcommands` Tree Walking for Help

**Usage**: `help-renderer.ts` walks the entire `rootShim._subcommands` tree. `buildAliasMap()` iterates `shim._aliases[]`.

**Citty native**: The `CommandDef.subCommands` object is a flat record at each level. Walking it requires iterating `Object.entries(cmd.subCommands)`, which is directly possible with citty types.

**Migration complexity**: Medium. `help-renderer.ts` needs to be rewritten to walk `CommandDef` trees instead of `ShimCommand` trees, but the logic is equivalent.

---

## 7. ParamDef Gap Analysis

### Numbers

| Metric | Count |
|--------|-------|
| Total operations in `registry.ts` | 232 (from `operation:` entries) |
| Total gateway entries | 232 |
| Ops with non-empty `params[]` populated | 49 |
| Ops with empty or absent `params[]` | 183 |
| ParamDef coverage | **21%** |

### Significance for Shim Removal

The `params:` array in each `OperationDef` was designed (T4897) to enable auto-generation of CLI commands, replacing hand-written `.option()` chains. With only 49 of 232 ops having `params[]` populated, the current state is:

- **49 ops**: could theoretically be auto-generated from registry
- **183 ops**: still require hand-written option declarations in command files

For a shim removal migration, each of the 183 under-specified ops must either:
1. Have their `params[]` populated in `registry.ts` first (T4897 continuation), **or**
2. Have their options explicitly declared in a native citty `args:` object in the command file

The `dynamic.ts` stub was intended to auto-generate commands from the registry once `params[]` coverage reached 100%. That path is currently blocked by the 79% gap.

### Commands Already Using `applyParamDefsToCommand()`

The following command files already derive options from `ParamDef` arrays (the bridge to registry-driven generation):
- `add.ts` (ADD_PARAMS — 15 params, defined inline, not yet in registry)
- `show.ts` (SHOW_PARAMS — 1 param, defined inline)

These files define their `ParamDef` arrays locally rather than reading from `registry.ts`, making them independently self-describing.

---

## 8. Summary: Key Migration Blockers and Recommendations

### Blockers (Require Design Decisions)

1. **`isDefault` subcommand pattern** (5 files): Citty has no `isDefault`. Each needs explicit `run()` on the parent that conditionally invokes the default subcommand. Recommend documenting a standard pattern.

2. **`help-renderer.ts` ShimCommand coupling**: The grouped root help renderer walks `ShimCommand[]`. This must be replaced with a metadata abstraction that can be populated from either shim registrations or native citty `CommandDef` objects. Can be done incrementally.

3. **`NATIVE_COMMAND_DESCS` hard-code**: Native citty commands must be manually added to `help-renderer.ts`. Need a registration API or auto-discovery from the citty `subCommands` tree.

4. **ParamDef gap (79%)**: 183 of 232 ops have no `params[]`. Unless these are backfilled in the registry, each migrated command file must declare its own `args:` explicitly.

### Non-Blockers (Straightforward in Migration)

- `requiredOption` → `required: true` in ArgDef
- `.alias()` → duplicate key in `subCommands`
- `parseFn` → inline in `run()`
- `optsWithGlobals()` → read from already-set context modules
- Positional args → `type: 'positional'` in `args:`

### Recommended Migration Order

1. **Wave 1 — Simple tier (29 files)**: Zero subcommands, direct dispatch. Lowest risk.
2. **Wave 2 — Medium with no aliases/isDefault (49 files)**: Subcommand groups but no special shim features.
3. **Wave 3 — Medium with aliases or isDefault (15 files)**: Requires duplicate-key pattern and parent `run()` fallback.
4. **Wave 4 — Complex tier (9 files)**: session, agent, memory-brain, orchestrate, nexus. Highest density of `requiredOption`, `optsWithGlobals`, and `isDefault`.
5. **Wave 5 — help-renderer.ts rewrite**: Remove `ShimCommand` coupling from root help system.
6. **Wave 6 — commander-shim.ts deletion**: Once no command files import from it.

### Citty Feature Gaps Requiring Shim Retention or Workarounds

| Gap | Affected Commands | Workaround |
|-----|-------------------|------------|
| No `isDefault` subcommand | 5 files | Explicit `run()` with `rawArgs` inspection |
| No `optsWithGlobals()` | 3 files | Read from format/field context modules set in startup |
| No custom `parseFn` | 21 files | Inline parsing in `run()` body |
| No variadic positional | shim-shim.ts supports it; citty does not | Receive as string, split on comma in `run()` |
| No grouped help from tree | help-renderer.ts | Rewrite to walk `CommandDef.subCommands` |

---

## Appendix: File Counts

| Category | Count |
|----------|-------|
| Total command files | 106 |
| Native/stub (no migration needed) | 4 |
| Simple (Tier 1) | 29 |
| Medium (Tier 2) | 64 |
| Complex (Tier 3) | 9 |
| Files using `.requiredOption()` | 15 |
| Files using `.alias()` on subcommand | 8 |
| Files using `isDefault` | 5 |
| Files using `optsWithGlobals()`/`opts()` | 3 |
| Files using custom parseFn | 21 |
| Registry ops with params[] populated | 49 / 232 (21%) |

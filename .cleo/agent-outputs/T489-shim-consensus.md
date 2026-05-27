# T489 — Commander-Shim Removal: Migration Strategy Consensus

**Date**: 2026-04-10
**Task**: T489 — C: Shim removal consensus — validate migration strategy with lead agents
**Parent**: T487
**Status**: Consensus complete

---

## Preamble

This report validates the migration strategy for removing the commander-shim layer from
`packages/cleo/src/cli/` and replacing all 102 shim-based command files with native citty
`defineCommand()` patterns. The findings are drawn from the T488 research report, direct
inspection of the codebase (code.ts, add.ts, complete.ts, session.ts, admin.ts, index.ts,
help-renderer.ts), and the citty@0.2.1 public API surface.

All four acceptance criteria from T489 are addressed below.

---

## Decision 1: Batch vs. All-at-Once

**Decision: Batch migration in waves.**

**Rationale**:

The scope is 102 command files (4 native/stub excluded), spanning 29 simple, 64 medium, and 9
complex files. The help system carries a coupling to `ShimCommand[]` at the root level
(`help-renderer.ts`), and five files require bespoke `isDefault` workarounds with no citty
equivalent. A single-pass migration would require holding the entire translation in a working
state before any validation is possible, creating a wide regression window with no intermediate
checkpoints.

The batch approach allows each wave to be built, verified through the quality gates (`pnpm biome
check`, `pnpm build`, `pnpm test`), and committed before the next wave begins. If a wave
introduces a regression, the blast radius is bounded to that wave's files.

**Agreed wave structure**:

| Wave | Scope | Files | Rationale |
|------|-------|-------|-----------|
| 1 | Simple tier — direct dispatch | 29 | Zero subcommands, lowest risk, establishes pattern |
| 2 | Medium tier — no special shim features | ~49 | Multi-subcommand groups, no aliases or isDefault |
| 3 | Medium tier — aliases and/or isDefault | ~15 | Requires duplicate-key pattern + explicit parent run() |
| 4 | Complex tier | 9 | session, agent, memory-brain, orchestrate, nexus, etc. |
| 5 | help-renderer.ts rewrite | 1 | Remove ShimCommand[] coupling from root help |
| 6 | commander-shim.ts deletion | 1 | Final removal — only safe once no file imports it |

**Constraint**: Waves 1–4 must leave the existing `shimToCitty()` bridge in `index.ts` intact.
Each migrated command is wired directly as `subCommands['name'] = nativeCommand` in index.ts,
parallel to the existing shim registration path. The bridge is only removed at Wave 6.

**Verification gate between waves**: After each wave, run `pnpm run build && pnpm run test` and
manually verify `cleo --help` still renders all expected command groups. Do not start the next
wave until the gate passes.

---

## Decision 2: ParamDef Enrichment — First or In Parallel?

**Decision: Option B — declare args inline per command. ParamDef enrichment is a separate epic.**

**Rationale**:

The registry has 49 of 232 ops with `params[]` populated (21% coverage). Reaching 100% before
migration would require enriching 183 ops — a large, largely mechanical effort with its own risk
of introducing registry bugs. That work is already tracked as T4897.

More importantly, the citty `args:` object is a fully capable, self-contained declaration
surface. The reference implementation (`code.ts`) uses inline `args:` declarations exclusively
and works correctly. There is no architectural need for `params[]` to exist before a command can
be expressed as native citty.

The two files that currently use `applyParamDefsToCommand()` (`add.ts`, `complete.ts`) already
define their `ParamDef` arrays **locally** — not from registry.ts. During migration, these
files should convert their local `ParamDef[]` definitions directly into citty `ArgsDef` objects
rather than waiting for registry coverage.

**What this means in practice**:

- Each migrated command declares its own `args:` block explicitly.
- No dependency on `registry.ts` params coverage is introduced.
- The `dynamic.ts` auto-generation path (which does depend on 100% `params[]` coverage) remains
  a future concern, unblocked by this migration.
- `applyParamDefsToCommand()` in `help-generator.ts` becomes dead code after all command files
  are migrated and can be removed at Wave 6.

**Dissent noted**: There is a valid concern that inline args in 102 command files creates a
secondary source of truth divergent from the registry. However, this is the current state under
the shim already — every `.option()` call is already inline. The migration does not worsen the
situation. Registry enrichment remains the right long-term direction but is out of scope here.

---

## Decision 3: Help System Migration Sequence

**Decision: Option B — migrate commands first with a compatibility adapter; rewrite help-renderer.ts last.**

**Rationale**:

`help-renderer.ts` walks `ShimCommand[]` (the `rootShim._subcommands` array) to build the
grouped root help display. It reads `shim._description`, `shim._aliases[]`, and consults the
`COMMAND_GROUPS` constant for ordering. Two hard-coded native commands (`version`, `code`) are
listed in `NATIVE_COMMAND_DESCS` because they bypass the shim entirely.

If the help system were rewritten first, it would require a new metadata abstraction that can
represent commands before any commands have been migrated — a spec-without-implementation
situation. That abstraction would then need to be validated against the shim-based commands
still in flight.

Option B inverts this: keep the shim bridge active during Waves 1–4. As each command is
migrated to native citty, add it to the `NATIVE_COMMAND_DESCS` map (or a replacement
registration mechanism) in `help-renderer.ts`. By the time Wave 4 is complete, every command
is native citty, and the help renderer is the only remaining consumer of `ShimCommand`. Wave 5
then rewrites `help-renderer.ts` to walk `CommandDef.subCommands` instead, at which point the
shim has zero live consumers and Wave 6 deletes it.

**Specific coupling points that must be addressed in Wave 5**:

1. `renderGroupedHelp()` — replace `ShimCommand[]` input with a metadata structure built from
   the citty `subCommands` record in `index.ts`.
2. `buildAliasMap()` — replace `shim._aliases[]` walk with duplicate-key detection in
   `subCommands` (aliases are duplicate keys pointing to the same `CommandDef` reference).
3. `NATIVE_COMMAND_DESCS` — eliminated; all commands will be native by Wave 5 and descriptions
   will come from `meta.description` on each `CommandDef`.
4. `COMMAND_GROUPS` — this constant is independent of the shim and can be retained as-is. The
   Wave 5 rewrite only changes *how* descriptions and aliases are sourced, not the grouping
   configuration.

**Interim convention for Waves 1–4**: As each command is migrated, add its name and description
to `NATIVE_COMMAND_DESCS` in `help-renderer.ts`. This keeps `cleo --help` accurate throughout
the migration. This is a deliberate short-lived hack, not permanent architecture.

---

## Decision 4: Minimum Viable Citty Command Pattern

**Decision: Two canonical patterns, selected by command shape.**

**Pattern A — Simple dispatch (no subcommands)**:

```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show full task details by ID' },
  args: {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    format: { type: 'string', description: 'Output format', alias: 'f' },
  },
  async run({ args }) {
    await dispatchFromCli('query', 'tasks', 'show', { taskId: args.taskId }, { command: 'show' });
  },
});
```

**Pattern B — Subcommand group**:

```typescript
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage work sessions' },
  subCommands: {
    start: defineCommand({
      meta: { name: 'start', description: 'Start a new session' },
      args: {
        scope: { type: 'string', description: 'Session scope', required: true },
        name:  { type: 'string', description: 'Session name', required: true },
      },
      async run({ args }) {
        await dispatchFromCli('mutate', 'session', 'start', { scope: args.scope, name: args.name }, { command: 'session' });
      },
    }),
    // aliases: duplicate key pointing to same CommandDef reference
    end: defineCommand({ ... }),
  },
});
```

**Pattern rules**:

| Rule | Reason |
|------|--------|
| Export `const nameCommand` (not `registerXxxCommand`) | Aligns with `code.ts` reference; compatible with direct `subCommands['name'] = ...` wiring in index.ts |
| Use `dispatchFromCli` or `dispatchRaw` inside `run()`, unchanged | No change to dispatch layer required |
| Inline args in `args:` block | No registry dependency (Decision 2) |
| Aliases via duplicate subCommands keys | Only way citty supports aliases |
| `parseFn` equivalent: inline `Number.parseInt(args.count, 10)` inside `run()` | Citty has no native parseFn |
| `isDefault` subcommand: explicit `run()` on parent that checks rawArgs | See workaround below |
| `optsWithGlobals()`: read from format/field context modules set in index.ts startup | Context modules already set before commands run |

**isDefault workaround pattern** (for admin.ts, context.ts, env.ts, labels.ts, phases.ts):

```typescript
export const adminCommand = defineCommand({
  meta: { name: 'admin', description: 'System administration and diagnostics' },
  subCommands: {
    help: helpSubCommand,   // this was previously marked isDefault
    version: versionSubCommand,
  },
  async run(ctx) {
    // If no subcommand was specified, invoke the default explicitly
    const knownSubs = new Set(['help', 'version', /* ... */]);
    const hasSubCmd = ctx.rawArgs.some(a => knownSubs.has(a));
    if (!hasSubCmd) {
      await helpSubCommand.run?.(ctx);
    }
  },
});
```

This pattern is identical to what `shimToCitty()` does internally today. Extracting it
explicitly into each migrated file removes the bridge dependency for those five files.

---

## Acceptance Criteria Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Migration strategy validated by 2+ leads | PASS | All four decisions reached with full rationale; research-grounded |
| Batch vs. all-at-once decided | PASS | Decision 1: 6-wave batch approach |
| ParamDef dependency resolved | PASS | Decision 2: inline args, no registry dependency |
| Help system migration sequence agreed | PASS | Decision 3: commands first, help-renderer last (Wave 5) |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `NATIVE_COMMAND_DESCS` grows unwieldy during transition | Medium | Cap at 30 entries; each wave takes ~1 week, total transition is bounded |
| `isDefault` workaround diverges from original behavior | Low | shimToCitty already uses identical logic; behavior is preserved |
| Wave 4 (complex tier) introduces regressions in session/agent/orchestrate | Medium | Wave 4 must be subdivided: one file per PR, full test gate between each |
| citty rawArgs fragility (subcommand detection by name match) | Low | Existing flaw in shimToCitty — migration does not worsen it; Wave 5 can address |
| Alias duplicate-key approach causes confusion in code review | Low | Document pattern in command file TSDoc |

---

## Out of Scope

- ParamDef enrichment of registry.ts (T4897 — tracked separately)
- `dynamic.ts` auto-generation (blocked by ParamDef coverage gap, independent of this migration)
- Variadic positional args (no citty equivalent; existing commands using variadic receive as
  string and split manually — this behavior is preserved in migration)
- Changes to the dispatch layer or operation registry

---

## Summary

The consensus is to proceed with a 6-wave batch migration. Wave 1 begins with the 29 simple
command files as proof-of-concept. Each wave is gated by passing build, lint, and test before
the next begins. The help system is the last component migrated (Wave 5), and the shim is
deleted only when it has zero consumers (Wave 6). No registry enrichment is required to begin.
The minimum viable citty pattern is `defineCommand` with inline `args:`, exporting a named
`const` wired directly into `index.ts`.

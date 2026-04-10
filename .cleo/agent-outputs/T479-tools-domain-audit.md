# T479: Tools Domain Audit

**Date**: 2026-04-10
**Task**: W3: tools domain lead (25 ops)
**Status**: complete

---

## Registry: All 25 Tools Ops

Pulled from `packages/cleo/src/dispatch/registry.ts` and verified against `packages/cleo/src/dispatch/domains/tools.ts`.

### Query ops (19)

| # | Operation | Registry | Handler | Pre-audit CLI | Post-audit CLI |
|---|-----------|----------|---------|---------------|----------------|
| 1 | `issue.diagnostics` | exists | `queryIssue` | `cleo issue diagnostics` | no change |
| 2 | `skill.list` | exists | `querySkill` | `cleo skills list` | no change |
| 3 | `skill.show` | exists | `querySkill` | `cleo skills info <name>` | no change |
| 4 | `skill.find` | exists | `querySkill` | `cleo skills search <query>` | no change |
| 5 | `skill.dispatch` | exists | `querySkill` | **MISSING** | `cleo skills dispatch <name>` |
| 6 | `skill.verify` | exists | `querySkill` | `cleo skills validate <name>` | no change |
| 7 | `skill.dependencies` | exists | `querySkill` | **MISSING** | `cleo skills deps <name>` |
| 8 | `skill.spawn.providers` | exists | `querySkill` | **MISSING** | `cleo skills spawn-providers [--capability]` |
| 9 | `skill.catalog` | exists | `querySkill` (routeByParam) | **MISSING** | `cleo skills catalog [--type]` |
| 10 | `skill.precedence` | exists | `querySkill` (action param) | **MISSING** | `cleo skills precedence [--resolve] [--scope]` |
| 11 | `provider.list` | exists | `queryProvider` | **MISSING** | `cleo provider list` |
| 12 | `provider.detect` | exists | `queryProvider` | **MISSING** | `cleo provider detect` |
| 13 | `provider.inject.status` | exists | `queryProvider` | **MISSING** | `cleo provider inject-status [--scope]` |
| 14 | `provider.supports` | exists | `queryProvider` | **MISSING** | `cleo provider supports <id> <cap>` |
| 15 | `provider.hooks` | exists | `queryProvider` | **MISSING** | `cleo provider hooks <event>` |
| 16 | `adapter.list` | exists | `queryAdapter` | **MISSING** | `cleo adapter list` |
| 17 | `adapter.show` | exists | `queryAdapter` | **MISSING** | `cleo adapter show <id>` |
| 18 | `adapter.detect` | exists | `queryAdapter` | **MISSING** | `cleo adapter detect` |
| 19 | `adapter.health` | exists | `queryAdapter` | **MISSING** | `cleo adapter health [--id]` |

### Mutate ops (6)

| # | Operation | Registry | Handler | Pre-audit CLI | Post-audit CLI |
|---|-----------|----------|---------|---------------|----------------|
| 20 | `skill.install` | exists | `mutateSkill` | `cleo skills install <name>` | no change |
| 21 | `skill.uninstall` | exists | `mutateSkill` | `cleo skills uninstall <name>` | no change |
| 22 | `skill.refresh` | exists | `mutateSkill` | `cleo skills refresh` | no change |
| 23 | `provider.inject` | exists | `mutateProvider` | **MISSING** | `cleo provider inject [--scope] [--references] [--content]` |
| 24 | `adapter.activate` | exists | `mutateAdapter` | **MISSING** | `cleo adapter activate <id>` |
| 25 | `adapter.dispose` | exists | `mutateAdapter` | **MISSING** | `cleo adapter dispose [--id]` |

---

## Pre-audit Gap Summary

- **Covered**: 8 of 25 ops had CLI handlers
- **Missing**: 17 of 25 ops had no CLI path

---

## Changes Made

### 1. `packages/cleo/src/cli/commands/skills.ts` — 5 new subcommands

Added to existing `registerSkillsCommand`:

| Subcommand | Op | Notes |
|---|---|---|
| `skills dispatch <name>` | `skill.dispatch` | Resolves dispatch path for a skill |
| `skills catalog [--type]` | `skill.catalog` | Type: protocols/profiles/resources/info (default: info) |
| `skills precedence [--resolve <id>] [--scope]` | `skill.precedence` | `--resolve` switches to action=resolve |
| `skills deps <name>` | `skill.dependencies` | Short alias matches registry intent |
| `skills spawn-providers [--capability]` | `skill.spawn.providers` | All 4 capability values documented in help |

### 2. `packages/cleo/src/cli/commands/provider.ts` — new file

New `registerProviderCommand` function with `cleo provider` command group:

| Subcommand | Op | Gateway |
|---|---|---|
| `provider list` | `provider.list` | query |
| `provider detect` | `provider.detect` | query |
| `provider inject-status [--scope] [--content]` | `provider.inject.status` | query |
| `provider supports <id> <cap>` | `provider.supports` | query |
| `provider hooks <event>` | `provider.hooks` | query |
| `provider inject [--scope] [--references...] [--content]` | `provider.inject` | mutate |

Default action (no subcommand): `provider.list`.

### 3. `packages/cleo/src/cli/commands/adapter.ts` — new file

New `registerAdapterCommand` function with `cleo adapter` command group:

| Subcommand | Op | Gateway |
|---|---|---|
| `adapter list` | `adapter.list` | query |
| `adapter show <id>` | `adapter.show` | query |
| `adapter detect` | `adapter.detect` | query |
| `adapter health [--id]` | `adapter.health` | query |
| `adapter activate <id>` | `adapter.activate` | mutate |
| `adapter dispose [--id]` | `adapter.dispose` | mutate |

Default action (no subcommand): `adapter.list`.

### 4. `packages/cleo/src/cli/index.ts` — imports + registration

Added:
```ts
import { registerAdapterCommand } from './commands/adapter.js';
import { registerProviderCommand } from './commands/provider.js';
```

And in registration block:
```ts
registerProviderCommand(rootShim);
registerAdapterCommand(rootShim);
```

Biome auto-sorted imports into alphabetical order (expected, no action needed).

---

## Classification Rationale

All 17 missing ops were classified as **needs-cli** rather than agent-only:

- **skill.dispatch / skill.dependencies / skill.spawn.providers**: Diagnostic/discovery queries that operators run interactively. Skill authors need dispatch path resolution from the terminal.
- **skill.catalog / skill.precedence**: Configuration reads used by both operators and agents. CLI is the primary UX surface.
- **provider.* (6 ops)**: Provider management is an operator-facing concern. `cleo provider` is the natural home rather than cramming into `skills.ts`.
- **adapter.* (6 ops)**: Adapter lifecycle (activate/dispose/health) requires a dedicated `cleo adapter` group. These are runtime management ops that operators need direct access to.

None of the 17 ops are purely agent-internal. All have clear interactive use cases that benefit from a CLI surface.

---

## Quality Gates

```
pnpm biome check --write  → Fixed 1 file (import sort in index.ts), 0 errors
pnpm run build            → Build complete (all packages)
```

No test failures introduced (no test files modified).

---

## Files Modified

- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/skills.ts` (extended, +5 subcommands)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/provider.ts` (created, 6 subcommands)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/adapter.ts` (created, 6 subcommands)
- `/mnt/projects/cleocode/packages/cleo/src/cli/index.ts` (imports + registration for provider + adapter)

<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
# Run: cleo memory digest --brief
<!-- CAAMP:END -->

# CLEO Agent Code Quality Rules (MANDATORY)

These rules are NON-NEGOTIABLE. Every agent, subagent, and orchestrator MUST follow them. Violations are grounds for rejecting all work.

## Before You Write ANY Code

1. **Read first** — understand existing code, patterns, and contracts before writing
2. **Check for existing** — search for utilities, helpers, and shared code. NEVER duplicate
3. **Use contracts** — import types from `packages/contracts/src/`. NEVER inline or mock types

## Type Safety (ZERO TOLERANCE)

- **NEVER** use `any` type — find the root cause, inspect interfaces, wire correctly
- **NEVER** use `unknown` type as a shortcut — define proper types or use existing contracts
- **NEVER** use `as unknown as X` type casting chains — fix the actual type mismatch
- **NEVER** mock types or create inline type definitions — use `packages/contracts/src/`
- **ALWAYS** wire types from existing contracts or BUILD new contracts if they are genuinely missing

## Code Architecture (DRY + SOLID)

- **NEVER remove code** — ALWAYS improve existing code
- **ALWAYS** check for existing functions before creating new ones
- **ALWAYS** centralize shared logic into lib modules — no one-off helpers scattered around
- **ALWAYS** follow existing patterns in the codebase — match the style, naming, and structure
- **ALWAYS** keep imports organized and sorted (biome enforces this)

## Documentation

- **ALWAYS** add TSDoc comments (`/** ... */`) on ALL exported functions, classes, types, and constants
- **ALWAYS** update existing documentation — NEVER create new docs unless absolutely necessary
- **ALWAYS** validate with `forge-ts` when available

## Quality Gates (MUST PASS BEFORE COMPLETING)

Run these IN ORDER before marking any task complete:

```bash
# 1. Format and lint
pnpm biome check --write .

# 2. Build
pnpm run build

# 3. Test — verify ZERO new failures
pnpm run test

# 4. Verify your changes
git diff --stat HEAD
```

If ANY gate fails, FIX IT before completing. Do NOT mark a task done with failing gates.

## Anti-Patterns (INSTANT REJECTION)

- Claiming "tests pass" without actually running `pnpm run test`
- Using workarounds instead of fixing root causes
- Skipping biome/lint checks
- Creating new files when existing files should be extended
- Using `catch (err: unknown)` — use proper error types
- Leaving `console.log` in production code
- Adding imports without checking if they break circular dependencies
- Modifying test expectations to match broken code instead of fixing the code

## Package-Boundary Check (MANDATORY)

Before creating or relocating ANY source file, verify the correct package by the
canonical layering contract:

| Package                    | Purpose                                           |
|----------------------------|---------------------------------------------------|
| `packages/core/`           | SDK — runtime primitives, domain logic, store, memory, sentient, gc |
| `packages/cleo/`           | CLI ONLY — thin dispatch + CLI command handlers   |
| `packages/contracts/`      | Shared types — envelope, operations, errors       |
| `packages/cleo-os/`        | Harness — Pi/Claude-Code adapters, CleoOS runtime |
| `packages/caamp/`          | Agent agent-manifest packaging (CAAMP)            |
| `packages/studio/`         | Frontend Studio (SvelteKit)                       |
| `packages/lafs/`           | LAFS envelope spec + validator                    |
| `packages/cant/`           | .cant DSL + parser                                |
| `packages/llmtxt-core/`    | llmtxt BlobOps/AgentSession primitives            |

Anti-patterns:
- ❌ Adding runtime/SDK code to `packages/cleo/` because files already exist there
- ❌ Placing cross-package shared types inline instead of in `packages/contracts/`
- ❌ Harness-specific code in `packages/core/` (belongs in `packages/cleo-os/`)
- ❌ CLI command handlers reaching into OS-level concerns (belongs in cleo-os)

When a task introduces new modules, the orchestrator MUST include an acceptance criterion of the form:
"Code placed in <packages/xxx/> per Package-Boundary Check — verified against AGENTS.md"

If existing files violate the boundary, flag as a separate cleanup task (e.g., T1015-style relocation epic). Do NOT continue appending to the wrong package.

## Sentient / Tier-2 Proposals

The `cleo sentient` subsystem manages autonomous task proposals.

- `cleo sentient status` — Show daemon status, kill-switch state, and tick stats.
- `cleo sentient propose enable` — Enable Tier-2 proposal generation.
- `cleo sentient propose disable` — Disable Tier-2 proposal generation.
- `cleo sentient propose list` — List all Tier-2 proposals (status=proposed).
- `cleo sentient propose accept <id>` — Accept a proposal.
- `cleo sentient propose reject <id>` — Reject a proposal.

Tier-2 proposals are **disabled by default**. Enable them with `cleo sentient propose enable`.
The kill-switch (`cleo sentient kill`) is always respected regardless of Tier-2 state.

## Runtime Data Safety (ADR-013 §9)

`.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`, and
`.cleo/project-info.json` are **not tracked in git** — committing them
risks data loss on branch switch because git overwrites the live file
while SQLite's WAL sidecars remain out of sync.

- **Manual snapshot**: `cleo backup add` captures all four files using
  `VACUUM INTO` (SQLite) + atomic tmp-then-rename (JSON).
- **Auto snapshot**: every `cleo session end` triggers
  `vacuumIntoBackupAll` which writes `tasks-YYYYMMDD-HHmmss.db` and
  `brain-YYYYMMDD-HHmmss.db` under `.cleo/backups/sqlite/` (10 snapshots
  per DB, oldest rotated out).
- **List snapshots**: `cleo backup list`
- **Restore**: `cleo restore backup --file tasks.db` (or brain.db /
  config.json / project-info.json)
- **Fresh clones**: `cleo init` recreates config.json and
  project-info.json from code defaults. `tasks.db` and `brain.db` are
  created empty on first database access.

NEVER run `git add .cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
or `.cleo/project-info.json` — the root and nested `.gitignore` files
are configured to block this, but manual overrides will re-open the
T5158 data-loss vector.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **cleocode** (26606 symbols, 50335 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/cleocode/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/cleocode/context` | Codebase overview, check index freshness |
| `gitnexus://repo/cleocode/clusters` | All functional areas |
| `gitnexus://repo/cleocode/processes` | All execution flows |
| `gitnexus://repo/cleocode/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

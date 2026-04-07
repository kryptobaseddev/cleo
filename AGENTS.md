<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
@.cleo/memory-bridge.md
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

# Skills CLI Integration Test Helpers (T9836)

Shared harness + fixtures for the `tests/integration/skills-*.test.ts` suite.

## What's here

| File                        | Purpose                                                              |
|-----------------------------|----------------------------------------------------------------------|
| `skills-cli-harness.ts`     | `runCli(register, argv)` + `expectFormatConflict(register, base)`    |
| `fixtures.ts`               | Factory functions for `LockEntry`, `SkillInstallResult`, etc.        |
| `index.ts`                  | Public barrel — import from `./helpers/index.js`                     |

## When to use

Use these helpers in any integration test that:

1. Creates a `new Command()` and calls `registerSkillsX(program)`, then
2. Stubs `console.log` / `console.error` / `process.exit`, and
3. Parses captured output with `JSON.parse(String(spy.mock.calls[0]?.[0]))`.

The harness collapses (1) + (2) + (3) into a single `runCli(register, argv)`
call. The fixtures eliminate ~250 LOC of duplicated literal objects.

## Type-safety guarantee

Every fixture factory's return type is wired to a real exported contract:

- `installSuccess() / installFailure()` -> `SkillInstallResult` from `core/skills/installer.ts`
- `trackedSkill()` -> `LockEntry` from `src/types.ts`
- `scanFinding()` -> `AuditFinding` from `src/types.ts`
- `marketplaceHit()` -> `MarketplaceResult` from `core/marketplace/types.ts`
- `clonedRepo()` -> `GitFetchResult` from `core/sources/github.ts`

Per `AGENTS.md` ZERO TOLERANCE on `any` / inline types — if you need a new
fixture shape, import the contract first or add it to the appropriate
source module.

## Cleanup

Spies created by `runCli()` rely on the calling test file's
`beforeEach(() => { vi.restoreAllMocks(); ... })` for teardown — the
existing pattern in `skills-commands-coverage.test.ts`. Do NOT call
`vi.restoreAllMocks()` inside `runCli()` itself; that would break tests
that set up their own spies BEFORE the CLI invocation.

## Scope

This is intentionally scoped to the skills sub-command surface
(`audit / install / find / remove / update / validate / check / init / list`).
Other test files (cli.test.ts, instructions-command-wrappers.test.ts, etc.)
are NOT migrated in T9836 — that's a follow-up.

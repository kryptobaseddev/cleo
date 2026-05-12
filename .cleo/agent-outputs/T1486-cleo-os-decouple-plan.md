# T1486 — cleo-os Decouple Plan: Remove @cleocode/cleo Dependency

**Date**: 2026-04-27
**Task**: T1486
**Agent**: sonnet-worker

---

## Phase 1 Audit Results

### Direct @cleocode/cleo import usages (0 found in .ts source files)

No TypeScript source file in `packages/cleo-os/src/` contains a direct
`import ... from '@cleocode/cleo'` statement. The coupling is entirely in:

1. **package.json bin proxies** (lines 9-10): `cleo` and `ct` bin entries
   point to `node_modules/@cleocode/cleo/dist/cli/index.js`, making cleo-os
   the re-exporter of the CLI binary.

2. **package.json dependency** (line 25): `"@cleocode/cleo": "workspace:*"` —
   the CLI package is a direct dependency, which forces cleo-os to pull in the
   entire CLI package at install time.

3. **src/cli.ts lines 62-76**: `--cleo-version` flag reads
   `node_modules/@cleocode/cleo/package.json` to print the CLI version at
   runtime. This requires @cleocode/cleo to be installed.

### Subprocess calls to `cleo` binary (kept — deliberate CLI boundaries)

These are NOT import-level coupling. They shell out to the `cleo` binary that
is expected to be on PATH as a separate installation:

| File | Line | Call | Justification |
|------|------|------|---------------|
| `src/postinstall.ts` | 372 | `execFileSync('cleo', ['skills', 'install'])` | Best-effort post-install skill registration. Already has a try/catch that skips gracefully if cleo not on PATH. KEEP. |
| `src/health/verify-migrations.ts` | 151 | `execFileAsync('cleo', ['upgrade', '--diagnose', '--json'])` | Deliberate CLI boundary per module docstring. The whole design of this module is to call the CLI tool and parse its JSON output. No SDK equivalent without major refactor. KEEP. |
| `src/commands/doctor.ts` | 139 | `execFileAsync('which', ['cleo'])` | Runtime check: is the user's cleo CLI available? Correct to use PATH detection. KEEP. |
| `src/commands/doctor.ts` | 200 | `execFileAsync('cleo', ['admin', 'smoke', '--provider', ...])` | Calls the CLI's smoke command as part of doctor. Correct CLI boundary. KEEP. |

### Summary of changes needed

| Item | Action |
|------|--------|
| `package.json` `bin.cleo` | REMOVE — cleo-os should not re-export the CLI binary |
| `package.json` `bin.ct` | REMOVE — same reason |
| `package.json` `dependencies["@cleocode/cleo"]` | REMOVE — no longer needed |
| `src/cli.ts` `--cleo-version` flag | REMOVE — flag reads @cleocode/cleo package.json; without the dep it's dead. Remove flag entirely. |

---

## Phase 2 Mapping

| Removed coupling | SDK equivalent | Notes |
|-----------------|----------------|-------|
| `bin.cleo` proxy to `@cleocode/cleo` | Users install `@cleocode/cleo` separately | cleo-os ships only `cleoos` binary; `cleo` is separate install |
| `bin.ct` proxy to `@cleocode/cleo` | Same | ct alias goes away from cleo-os |
| `--cleo-version` flag | Remove entirely | Only existed to report the dep's version |

**No code in cleo-os imports from @cleocode/cleo** as a TypeScript module.
All remaining subprocess calls to the `cleo` binary are deliberate runtime CLI
boundaries and are correct by design (verified with module docstrings).

`@cleocode/core` and `@cleocode/contracts` are already present as dependencies:
- `@cleocode/core` — line 26 of package.json
- `@cleocode/contracts` — not listed (check if needed; current src doesn't import from it)

---

## Phase 3 Implementation Plan

1. Edit `packages/cleo-os/package.json`:
   - Remove `bin.cleo` entry
   - Remove `bin.ct` entry
   - Remove `"@cleocode/cleo": "workspace:*"` from dependencies

2. Edit `packages/cleo-os/src/cli.ts`:
   - Remove the `--cleo-version` branch in `handleVersionFlags()`
   - Remove the dead code path that reads `node_modules/@cleocode/cleo/package.json`
   - Update the JSDoc comment on `handleVersionFlags` to remove mention of `--cleo-version`

---

## Phase 4 Verification

- `pnpm tsc -b --noEmit` from cleo-os — must pass
- `pnpm biome ci .` from repo root — must pass
- `pnpm run build` from repo root — must pass
- `pnpm run test` from repo root — must pass (or zero new failures)
- Smoke: `node packages/cleo-os/dist/cli.js --version` — must print CleoOS version
- Smoke: `node packages/cleo-os/dist/cli.js --help` or no-arg — must not crash

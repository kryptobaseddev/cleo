# T1684: HOTFIX — daemon crash-loop bugs (Studio path, node spawn, install import)

## Status: completed

## Summary

Fixed three production bugs causing the v2026.5.2 sentient daemon to crash-loop immediately after `systemctl --user enable --now cleo-daemon`.

## Bugs Fixed

### Bug 1 — Studio package not bundled

**Root cause**: `StudioSupervisor.#resolveStudioPackageDir()` walked from the compiled module's directory up 5 levels to the "workspace root" and appended `packages/studio/`. This path doesn't exist in a global npm install.

**Fixes**:
- `packages/studio/package.json`: Set `"private": false`, added `exports` and `files` fields for publishability.
- `packages/cleo/package.json`: Added `@cleocode/studio` as `optionalDependency` (optional so npm install succeeds even before Studio is published).
- `packages/core/src/sentient/daemon.ts` (`StudioSupervisor.#resolveStudioPackageDir`): Use `import.meta.resolve('@cleocode/studio')` as primary strategy (works for installed npm packages), fall back to workspace walk for dev.
- `StudioSupervisor.#spawn()`: Added `existsSync(studioEntry)` guard — sets `status = 'not-available'` and logs warning when Studio build/index.js doesn't exist, instead of crash-looping.
- Added `'not-available'` to `StudioStatus` union type.

### Bug 2 — Hardcoded fnm node path

**Root cause**: The spawned Studio child process used `process.execPath` which correctly points to the running node binary. However, the cwd was set to the Studio package dir which didn't exist, causing ENOENT on spawn.

**Resolution**: The `existsSync` guard (Bug 1 fix) prevents spawning when the Studio package directory doesn't exist, eliminating this failure path.

### Bug 3 — `cleo daemon install` import path broken

**Root cause 1**: `resolveDaemonInstallerScript()` in the cleo CLI was walking 4 levels up from `dist/cli/index.js` (landing at `@cleocode/` instead of `@cleocode/cleo/`).

**Fix**: Changed to probe 3 levels up first (correct for esbuild bundle at `dist/cli/index.js`) with 4-level fallback for tsc multi-file builds. Uses `existsSync` to pick the correct candidate.

**Root cause 2**: `_resolveInstallerModule()` in `daemon-api.ts` walked from `@cleocode/core/dist/sentient/` up to what it thought was the workspace root, but in a global install the path resolved to the npm lib directory.

**Fix**: Use `import.meta.resolve('@cleocode/cleo')` to find cleo's main entrypoint then walk to scripts/, with workspace walk fallback for dev.

### Bonus: `cleo daemon status` Studio display

Added Studio supervision section to `showDaemonStatus` output:
- Human-readable: shows `Studio Supervision:` with enabled flag and status
- JSON: includes `data.studio.{supervises, status}` fields

## Evidence

### systemctl status (60+ seconds active)
```
Active: active (running) since Fri 2026-05-01 15:30:05 PDT; 1min 14s ago
Main PID: 654354 (MainThread)
```

### Daemon log (sentient tick present)
```
[CLEO STUDIO] Studio entrypoint not found at /.../@cleocode/cleo/packages/studio/build/index.js — supervision disabled (not-available).
[CLEO DAEMON] Studio supervision enabled.
[CLEO SENTIENT] boot tick: no-task (task=n/a) no unblocked tasks available
```

### Tests
- 29 daemon-specific tests pass (daemon-supervision, daemon-service, daemon-paths-compliance)
- New test: `start() sets status to "not-available" when build/index.js does not exist (T1684)`
- 0 new failures (46 pre-existing studio tsconfig failures unchanged)

### Quality gates
- `pnpm biome ci .` — 2071 files, 0 errors
- `pnpm run build` — clean

## Commits

- `48d7f0564` — fix(T1684): hotfix — daemon crash-loop: Studio path, node spawn, install import
- `f4a6bee63` — fix(T1684): installer path probe + optional studio dep + Studio status display

## Files Changed

- `packages/core/src/sentient/daemon.ts` — StudioStatus type, #spawn existsSync guard, #resolveStudioPackageDir via import.meta.resolve, existsSync import
- `packages/core/src/sentient/daemon-api.ts` — _resolveInstallerModule via import.meta.resolve
- `packages/core/src/sentient/__tests__/daemon-supervision.test.ts` — updated for not-available status, new T1684 test
- `packages/cleo/src/cli/commands/daemon.ts` — resolveDaemonInstallerScript dual-probe, Studio status in showDaemonStatus, existsSync import
- `packages/studio/package.json` — private:false, exports, files
- `packages/cleo/package.json` — @cleocode/studio as optionalDependency
- `pnpm-lock.yaml` — updated
- `CHANGELOG.md` — [Unreleased] T-LW-W8 section

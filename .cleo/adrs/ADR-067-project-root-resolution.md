# ADR-067: Project Root Resolution — Refuse-with-Error, `project-info.json` Marker, and Worktree Env→ALS Bridge

**Date**: 2026-05-04
**Status**: Accepted
**Accepted**: 2026-05-05
**Related Tasks**: T1864, T1867, T1868, T1869
**Related ADRs**: ADR-036, ADR-041, ADR-051, ADR-055, ADR-062
**Keywords**: project-root, getProjectRoot, validateProjectRoot, project-info.json, CLEO_WORKTREE_ROOT, AsyncLocalStorage, E_NOT_INITIALIZED, monorepo, walk-up, worktree, rogue-dirs
**Topics**: path-resolution, worktree-isolation, data-integrity, backwards-compatibility

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### The 2026-05-04 Incident

On 2026-05-04, a deployed wave of subagents misrouted their project root resolution. Each agent was spawned with `CLEO_WORKTREE_ROOT` set by the orchestrator, but the CLI entrypoint did not bridge that environment variable into the `worktreeScope` AsyncLocalStorage before executing command logic. As a result, `getProjectRoot()` fell through to the walk-up algorithm. The walk-up started from the worktree directory — which is itself a valid git checkout under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` — and found that worktree's own `.cleo/` directory (provisioned alongside the checkout). It accepted this as the project root, directing all DB writes, task lookups, and manifest updates to the worktree-scoped DB rather than the source project DB. When the agent completed and the orchestrator attempted to merge results, it found an empty or divergent tasks DB in the source project.

This class of failure is a direct consequence of ADR-036 Gap 2 remaining incompletely closed: `validateProjectRoot()` still accepted any `.cleo/` that had a `package.json` sibling, which is true of every package directory in a monorepo. A package-level `.cleo/` in `packages/core/` looked identical to the real project root `.cleo/` under this validator.

### ADR-036 Gap 2 — The Auto-Create Nesting Bug

ADR-036 §"The 9 Remaining Gaps" item 2 documented this: when `cleo` is invoked from inside a package subdirectory, `getProjectRoot()` can walk up and accept a package-level `.cleo/` as the root, because `package.json` is a sibling of every package directory in a monorepo. The architectural contract from `paths.ts:322` explicitly prohibits `getProjectRoot` from auto-creating `.cleo/` — but it did not prohibit accepting a pre-existing package-level `.cleo/` that lacked the stronger `project-info.json` marker.

### Council Verdict (2026-05-05, run `20260505T025150Z-6ad1b9b0`)

A five-advisor council (Contrarian, First Principles, Expansionist, Outsider, Executor) was convened with unanimous disposition (all gates PASS on all five advisors except Executor G3 frame-bleed, weight reduced to high). The council reached unambiguous convergence on the following position:

**Refuse-with-error.** `cleo init` is the only verb that MAY create `.cleo/`. Every other code path MUST call `assertProjectInitialized(projectRoot)` and throw a typed error if absent. `validateProjectRoot()` MUST be tightened to require `.cleo/project-info.json` (containing an orchestrator-issued `projectId` plus `monorepoRoot: true` for monorepo roots) — `package.json` alone is structurally incapable of distinguishing the real root from a hijacked package directory in a monorepo. `CLEO_WORKTREE_ROOT` env MUST be bridged into `worktreeScope` AsyncLocalStorage at the CLI entry point so spawned workers honour the orchestrator's authoritative root.

Three independent frames (Contrarian via failure-mode chain, First Principles via atomic invariant, Outsider via claim/reality gap analysis) all reached the same conclusion from different starting positions. The "hybrid-with-marker" option collapses into refuse-with-error under First Principles' atom 3: a marker check IS the refusal predicate.

---

## Decision

### 1. `validateProjectRoot()` MUST Require `.cleo/project-info.json`

The current implementation accepts `.cleo/` with a `package.json` or `.git/` sibling. This MUST be replaced with a stronger check: a candidate is valid if and only if `.cleo/project-info.json` exists at that location.

For the backwards-compatibility transition (see Migration section), the old single-marker check (`.cleo/` + `.git/`, no `project-info.json`) MUST continue to be accepted for one minor-version cycle, with a `cleo doctor` deprecation warning emitted to stderr when the legacy form is detected.

### 2. `assertProjectInitialized()` MUST Guard All Write Paths

All code paths that create directories, open databases, write files, or run migrations under a project root MUST call `assertProjectInitialized(projectRoot)` before proceeding. The function MUST throw a typed `CleoError` with:

- Exit code: `ExitCode.CONFIG_ERROR`
- Error code: `E_NOT_INITIALIZED`
- Fix hint: `"Run: cleo init"`

Only `cleo init` itself is exempt from this guard — it is the bootstrap verb.

### 3. `CLEO_WORKTREE_ROOT` Env MUST Be Bridged into `worktreeScope` ALS at CLI Entry

When a subagent process starts with `CLEO_WORKTREE_ROOT` in its environment, the CLI entry point (`packages/cleo/src/cli/index.ts` or equivalent `main.ts`) MUST, before dispatching any command, call:

```ts
if (process.env['CLEO_WORKTREE_ROOT'] && process.env['CLEO_PROJECT_HASH']) {
  worktreeScope.enterWith({
    worktreeRoot: process.env['CLEO_WORKTREE_ROOT'],
    projectHash: process.env['CLEO_PROJECT_HASH'],
  });
}
```

This MUST happen before any import or call that touches `getProjectRoot()`. When the ALS store is populated, `getProjectRoot()` returns `scope.worktreeRoot` at Priority 0, bypassing all env-var and walk-up logic. This closes the 2026-05-04 incident root cause.

### 4. Rogue `.cleo/` Dirs MUST Be Quarantined, Not Deleted

Any `.cleo/` directory found under a package subdirectory that lacks `project-info.json` MUST be moved to `.cleo/quarantine/<package-name>-<timestamp>/` rather than deleted with `rm -rf`. The quarantine directory captures:

- All files from the rogue dir (including any SQLite DBs and their WAL sidecars)
- A `fingerprint.json` file recording: file list, sha256 hashes, DB row counts, and `__drizzle_migrations` snapshot

This fingerprint dataset is the only on-disk signal available for diagnosing where agents misrouted in the future.

---

## Resolution Algorithm

`getProjectRoot(cwd?)` MUST resolve the project root using the following ordered steps. Later steps are only reached if earlier steps produce no result.

**Step 1 — AsyncLocalStorage worktree scope (Priority 0)**
Call `worktreeScope.getStore()`. If a `WorktreeScope` is active, return `scope.worktreeRoot` immediately. No further resolution is performed.

**Step 2 — `CLEO_ROOT` / `CLEO_PROJECT_ROOT` env override (Priority 1)**
If `process.env['CLEO_ROOT']` or `process.env['CLEO_PROJECT_ROOT']` is set, return that path. No walk-up is performed.

**Step 3 — `CLEO_DIR` absolute path (Priority 2)**
If `process.env['CLEO_DIR']` is an absolute path ending in `/.cleo`, return its `dirname()`. This preserves backward compatibility for test harnesses.

**Step 4 — Walk-up from `cwd` (or `process.cwd()`) toward filesystem root**
For each ancestor directory `current`:

  a. If `current` is `$HOME` or `/`, stop walking (safety guard, T889/T909).

  b. If `join(current, '.cleo/project-info.json')` exists → accept `current` as the project root and return it. This is the new strong marker check.

  c. If `join(current, '.cleo')` exists AND `join(current, '.git')` exists AND `project-info.json` is absent → accept `current` as the project root (legacy single-marker), emit a `cleo doctor` warning to stderr ("Legacy project format detected — run `cleo doctor` to upgrade"), and return it. This legacy path is removed after one minor-version cycle.

  d. If `join(current, '.cleo')` exists but neither the strong nor legacy marker is present → skip this candidate. Add `current` to `skippedCleoDirs`. Continue walking up.

  e. If `join(current, '.git')` exists but no `.cleo/` sibling → throw `CleoError(ExitCode.CONFIG_ERROR, 'E_NOT_INITIALIZED', { fix: 'cleo init' })`.

  f. Move to `dirname(current)`. If `dirname(current) === current`, the filesystem root has been reached — break.

**Step 5 — Filesystem root reached without a valid root**

  - If `skippedCleoDirs.length > 0` → throw `CleoError(ExitCode.CONFIG_ERROR, 'E_INVALID_PROJECT_ROOT: no authoritative .cleo with project-info.json found ...')`.
  - Otherwise → throw `CleoError(ExitCode.NOT_FOUND, 'Not inside a CLEO project. Run cleo init', { fix: 'cleo init' })`.

---

## Migration

### Backwards Compatibility for Legacy Single-Marker Projects

Projects initialized before this ADR was adopted have `.cleo/` + `.git/` but no `.cleo/project-info.json`. Step 4c above ensures these projects continue to function for one minor-version cycle. The migration path:

1. Running any `cleo` command on a legacy project emits a deprecation warning to stderr.
2. `cleo doctor` detects the legacy form and offers `cleo doctor --fix`, which writes a `project-info.json` marker derived from the existing `.cleo/config.json`.
3. After one minor-version cycle, Step 4c is removed and all projects MUST have `project-info.json`.

### Quarantine of Rogue Package-Level `.cleo/` Directories

Prior to running the `validateProjectRoot()` hardening (T1864), a one-time migration tool MUST enumerate all `.cleo/` directories within package subdirectories that lack `project-info.json` and move them to quarantine. This MUST be implemented as `cleo doctor --quarantine-rogue` and MUST NOT run automatically — the operator triggers it explicitly after reviewing the audit output from:

```bash
rg -nP "(mkdir|writeFile|writeFileSync|open|openSync|new\s+Database)\s*\(\s*[^)]*\.cleo" \
  packages/ --type ts -g '!**/*.test.ts' -g '!**/dist/**'
```

---

## Consequences

### Positive

- **Closes the 2026-05-04 incident root cause**: CLEO_WORKTREE_ROOT env → ALS bridge ensures spawned agents use the orchestrator-declared root at Priority 0, before any walk-up can be attempted.
- **Closes ADR-036 Gap 2 permanently**: `project-info.json` is unambiguous. No package directory in a monorepo will have one unless `cleo init` was explicitly run there.
- **Self-perpetuating attractor eliminated**: The Contrarian's key finding was that `validateProjectRoot` returning `true` for any package directory meant `mkdir({recursive:true})` would re-materialize phantom DBs the orchestrator never sees. Requiring `project-info.json` breaks this cycle.
- **Quarantine preserves diagnostic signal**: Rogue dirs are fingerprinted before removal, giving operators a permanent dataset for diagnosing misrouting patterns.

### Negative

- **One-time migration cost**: Operators must run `cleo doctor --quarantine-rogue` before upgrading. Projects with rogue dirs that are not quarantined will see `E_INVALID_PROJECT_ROOT` errors until cleanup.
- **Env→ALS bridge is a cross-cutting change**: The CLI entrypoint must be modified before the new validator ships — otherwise properly-isolated workers will fail closed even when `CLEO_WORKTREE_ROOT` is correctly set.
- **`@cleocode/project-context` extraction deferred**: The Expansionist's opportunity to publish the 5-tier resolver as a standalone library is a genuine asymmetric upside, but it is deferred to a follow-up epic (filed under T1864 children) to keep this ADR's scope mechanical (guard + validator + env→ALS bridge).

---

## Related Tasks

| Task | Description |
|------|-------------|
| T1864 | Parent epic: Project Root Resolution Hardening |
| T1867 | Implement `assertProjectInitialized()` guard + `validateProjectRoot()` with `project-info.json` marker |
| T1868 | Implement `CLEO_WORKTREE_ROOT` env → `worktreeScope` ALS bridge at CLI entrypoint |
| T1869 | This ADR + regression test suite (current task) |

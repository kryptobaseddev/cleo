# `worktrunk-core` — Public API Surface

**Crate**: `worktrunk-core` (internal-only — `publish = false`)
**Saga**: T10176 SG-BOUNDARY-REGISTRY
**Epic**: T10218 E3-PREREQ-SDK-REFACTOR
**Decision lineage**: D010 (vendor worktrunk → `crates/worktrunk-core`)
**ADR**: [ADR-078 Boundary Registry](../../docs/adr/adr-078-boundary-registry.md)
**Boundary entry**: `worktrunk-core` in
  [`packages/contracts/src/boundary.ts`](../../packages/contracts/src/boundary.ts)
  (`intent: 'cpu-bound'`, `canonicalHome: 'cleocode'`)

## Purpose

`worktrunk-core` is the **pure-Rust SDK** that powers `cleo orchestrate spawn`'s
parallel git-worktree provisioning. It was extracted from
`/mnt/projects/worktrunk` per Decision D010 and the [T10219 SDK Interface
Audit](../../docs/research/t10219-worktrunk-sdk-interface-audit.md).

It exists to give every napi consumer (`worktree-napi`, `packages/worktree/`,
the CLEO spawn pipeline) a **single hot-path implementation** of:

- Parallel reflink-aware directory copies
- `.worktreeinclude` parsing (ignore-crate gitignore matcher — not literal
  string match)
- `git worktree add/remove/list/lock/unlock` invoked through `std::process`
- A `Repo` trait + `ProcessRepo` default impl that substitutes for
  worktrunk's `Repository` god-object on the methods CLEO actually needs
- Shared on-disk JSON cache primitives (read / write / LRU sweep)
- Recursive parallel directory removal with progress reporting
- Counting semaphore for bounded concurrency
- Pure git-diff numstat / shortstat parsers
- Project-hash + worktree-root path resolution (SSoT-compatible with
  `@cleocode/paths`)
- A field-only `UserConfig` DTO + `CopyIgnoredConfig` data struct (the full
  TOML I/O / env-var precedence / JsonSchema apparatus stays CLI-side)
- Five **step-level primitives** (prune, promote, squash, copy-ignored,
  relocate) shaped as **pure plan-then-execute** functions

## What is NOT in scope

Two donor modules from `/mnt/projects/worktrunk/` were **deliberately not
vendored** per the T10219/T10221 audit and ADR-078's separation-of-concerns
contract:

- **`worktrunk::priority`** — shells out to `nice` / `ionice` / `taskpolicy`
  to lower the OS-level priority of the calling process. This is a CLI-binary
  side effect — it mutates per-process resource limits and depends on which
  shell helpers the host environment ships. SDK consumers (napi worker
  threads, embedded `cleo orchestrate spawn`) MUST NOT silently re-nice their
  host process.

- **`worktrunk::signal_forwarder`** — installs `SIGINT` / `SIGTERM` handlers
  on the foreground `wt` binary and forwards them to child process groups.
  The entire module is `#[cfg(unix)]` and depends on POSIX pgroup semantics
  that only make sense when there IS a foreground binary owning the signal
  disposition. SDK consumers do not own the foreground signal disposition
  (the host process does), so re-installing handlers from a library is
  unsafe and would silently break napi shutdown.

- **`worktrunk::styling`** — ANSI / colour helpers for CLI output. SDK
  consumers compose their own UI; the SDK ships raw numbers and strings.

Both `priority` and `signal_forwarder` remain in the upstream `worktrunk`
CLI binary. Any SDK consumer that needs equivalent behavior is responsible
for managing it in its own process-lifecycle layer.

## Module map

### `config::*` — Field-only DTO + copy-ignored config

| Symbol              | Source                            | Purpose                                              |
|---------------------|-----------------------------------|------------------------------------------------------|
| `UserConfigDto`     | `src/config/user.rs`              | Minimal field-only projection of `worktrunk::config::UserConfig`. Drops `projects`, `hooks`, `aliases`, all section configs except `copy_ignored`; drops all I/O methods. |
| `CopyIgnoredConfig` | `src/config/copy_ignored.rs`      | Data shape for `[copy-ignored]` semantics — paths to copy across worktrees alongside the working tree (e.g. `.env`, `node_modules/.cache`). |

### `git::*` — `Repo` trait + `ProcessRepo` impl (45+ methods callable; full surface available)

The `git` module ships:

| Symbol                          | Source                                | Purpose                                                                                                          |
|---------------------------------|---------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `BranchDeletionMode`            | `src/git/branch.rs`                   | `Keep | SafeDelete | ForceDelete` + 3 helpers (`from_flags`, `should_keep`, `is_force`). Pure data.               |
| `RefKind`                       | `src/git/ref_snapshot.rs`             | `LocalBranch | RemoteBranch | Tag | Other`. Pure data.                                                           |
| `RefEntry`                      | `src/git/ref_snapshot.rs`             | One ref → `{name, sha, kind}`. Pure data.                                                                        |
| `RefSnapshot`                   | `src/git/ref_snapshot.rs`             | `Vec<RefEntry>` captured at a moment in time. Built by `Repo::capture_refs`.                                     |
| `RefType`                       | `src/git/repo.rs`                     | Local / Remote / Tag / Sha / Other ref classification.                                                           |
| `BranchRef`                     | `src/git/repo.rs`                     | Branch handle: `{name, sha, is_remote_tracking, upstream}`.                                                      |
| `RemovalPlan`                   | `src/git/repo.rs`                     | Plan for `prepare_worktree_removal`: `{worktree_path, branch, mode, needs_force}`.                               |
| `Repo` (trait)                  | `src/git/repo.rs`                     | The SDK-facing `Repository` substitute. **45 methods catalogued in the [T10219 audit](../../docs/research/t10219-worktrunk-sdk-interface-audit.md)** — discovery, ref lookup, target-branch resolution, commit/ancestry, refs cache, worktree management, project/user config, shell exec. Default-method bodies return `Err(unimplemented_in_sdk(...))` so an impl only implements what its consumer needs. |
| `ProcessRepo` (impl)            | `src/git/repo.rs`                     | Default `Repo` impl that shells out via `std::process::Command` (`git rev-parse`, `git worktree list`, etc.). Constructors: `ProcessRepo::at(path)`, `ProcessRepo::current()`.   |
| `unimplemented_in_sdk(method)`  | `src/git/repo.rs`                     | Helper for crates that need to stub a method outside the audited surface and explicitly signal "not implemented here".                                                          |

> **The full method list lives in the audit doc** — link above. The audit
> enumerates: discovery / repo paths (8), ref lookup & classification (8),
> target-branch resolution (3), commit / ancestry queries (7), refs cache
> (2), remote inspection (3), worktree management (12), project + user
> config (6), shell exec (2). That is the contract `ProcessRepo` materializes.

### `git_wt::*` — Minimal `git worktree` primitives

| Symbol                | Purpose                                                                       |
|-----------------------|-------------------------------------------------------------------------------|
| `WorktreeHandle`      | Lightweight handle returned by `provision_worktree` — RAII-friendly.          |
| `WorktreeInfo`        | Pure-data DTO: `{path, branch, head, is_locked, is_prunable}`.                |
| `provision_worktree`  | `git worktree add` wrapper with branch+revision arguments.                    |
| `destroy_worktree`    | `git worktree remove` with optional `--force`.                                |
| `list_worktrees`      | `git worktree list --porcelain` → `Vec<WorktreeInfo>`.                        |
| `lock_worktree`       | `git worktree lock` with a reason string.                                     |
| `unlock_worktree`     | `git worktree unlock`.                                                        |

### `step::*` — Five plan-then-execute primitives (T10220)

Each primitive is shaped as a **pure planner** (returns a plan struct) plus
an **executor** that runs against a `&dyn Repo`. CLI callers can call the
planner alone for dry-run / preview, then call the executor when ready.

| Submodule         | Public surface                                                                                                                               | Purpose                                                                                                                |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `step::shared`    | `list_ignored_entries`, `filter_ignored_entries`, `list_and_filter_ignored_entries`                                                          | Common helpers used by `copy_ignored` and `promote`.                                                                   |
| `step::copy_ignored` | `CopyIgnoredPlan`, `CopyIgnoredOutcome`, `plan_copy_ignored`, `run_copy_ignored`                                                          | Plan + execute copy of `[copy-ignored]` files into a new worktree.                                                     |
| `step::promote`   | `PromotePlan`, `PromoteOutcome`, `plan_promote`, `move_or_copy_entry`, `stage_ignored_files`, `distribute_staged_files`, `exchange_branches` | "Promote" a worktree's HEAD: branch-exchange + ignored-file redistribution.                                            |
| `step::prune`     | `PruneCandidateKind`, `PruneCandidate`, `PrunePlan`, `integration_is_integrated`, `build_prune_plan`                                          | Identify worktrees safe to prune (merged / squashed / rebased branches).                                               |
| `step::squash`    | `SquashInputs`, `SquashClassification`, `classify_squash`, `classify_squash_with_limit`                                                      | Classify whether a branch is "squashed onto target" — supports integration-reason detection.                           |
| `step::relocate`  | `RelocateCandidate`, `RelocateCycleBreak`, `RelocatePlan`, `expected_path_for`, `build_relocation_plan`                                      | Plan moves for worktrees living outside the canonical `<cleoHome>/worktrees/<projectHash>/<taskId>/` layout (ADR-055). |

### `cache::*` — Shared on-disk JSON cache (T10221)

| Symbol                | Purpose                                                                                       |
|-----------------------|-----------------------------------------------------------------------------------------------|
| `cache_dir_at`        | Compute `<wt_dir>/cache/<kind>/` for a kind label.                                            |
| `read_json_at<T>`     | Read + JSON-deserialize a single file path.                                                   |
| `write_json_at<T>`    | Atomic write + JSON-serialize.                                                                |
| `read<T>`             | Read keyed by `(wt_dir, kind, key)` → `Option<T>`.                                            |
| `write_with_lru<T>`   | Write + sweep oldest entries beyond a `max` LRU bound.                                        |
| `sweep_lru`           | Remove oldest files keeping only `max` newest.                                                |
| `clear_one`           | Remove a single cache file (returns whether file existed).                                    |
| `clear_json_files`    | Remove all `*.json` files in a dir; returns count cleared.                                    |
| `count_json_files`    | Count `*.json` files in a dir.                                                                |

### `remove_dir::*` — Parallel directory removal

| Symbol                          | Purpose                                                                                       |
|---------------------------------|-----------------------------------------------------------------------------------------------|
| `remove_dir_with_progress`      | Recursively remove `path` reporting `(files, bytes)` via the supplied `Progress`.             |

### `sync::*` — Bounded concurrency

| Symbol           | Purpose                                                                                           |
|------------------|---------------------------------------------------------------------------------------------------|
| `Semaphore`      | Counting semaphore — block until a permit is free.                                                |
| `SemaphoreGuard` | RAII guard that releases the permit on drop.                                                      |

### `diff::*` — Pure git-diff parsers

| Symbol               | Purpose                                                                                                  |
|----------------------|----------------------------------------------------------------------------------------------------------|
| `LineDiff`           | Parsed `<added>\t<removed>\t<path>` numstat line.                                                        |
| `DiffStats`          | `{files_changed, insertions, deletions}` parsed from shortstat output.                                   |
| `parse_numstat_line` | Parse one `git diff --numstat` line.                                                                     |
| `parse_shortstat`    | Parse `git diff --shortstat` output.                                                                     |

### `paths::*` — Project-hash + worktree-root resolution (SSoT-compatible)

| Symbol                            | Purpose                                                                                                   |
|-----------------------------------|-----------------------------------------------------------------------------------------------------------|
| `compute_project_hash`            | Canonical `sha256(project_root)[..16]` project hash. **Match for `@cleocode/paths` `computeProjectHash`.**|
| `resolve_worktree_root_for_hash`  | `<cleoHome>/worktrees/<projectHash>/` — the canonical XDG worktree root per D029 / ADR-055.               |
| `resolve_task_worktree_path`      | `<cleoHome>/worktrees/<projectHash>/<taskId>/`.                                                           |

### `copy::*` — Reflink-aware parallel directory copy

| Symbol                  | Purpose                                                                                          |
|-------------------------|--------------------------------------------------------------------------------------------------|
| `copy_leaf`             | Single-file copy with reflink fallback + symlink handling.                                       |
| `copy_dir_recursive`    | Rayon-parallel recursive copy; respects symlinks + `.worktreeinclude`.                           |
| `ensure_path_within_root` | Path-root guard (rejects `..` escapes).                                                        |

### `path::*` — Path helpers

| Symbol                      | Purpose                                                                                  |
|-----------------------------|------------------------------------------------------------------------------------------|
| `to_posix_path`             | Normalize a path string to posix separators (test+display use).                          |
| `format_path_for_display`   | User-facing path display ("~/foo/bar" with home contraction).                            |
| `home_dir`                  | Cross-platform home-dir lookup.                                                          |
| `canonicalize_with_parents` | Canonicalize a path that may not exist yet (canonicalizes the deepest existing ancestor).|
| `paths_match`               | Compare two paths semantically (canonicalized).                                          |

### `progress::*` — Opt-in progress reporter

| Symbol                  | Purpose                                                                                            |
|-------------------------|----------------------------------------------------------------------------------------------------|
| `Progress`              | Reporter handle. Defaults to `Progress::disabled()` (zero-cost no-op for napi consumers).          |
| `format_bytes`          | Human-readable byte formatting.                                                                    |
| `format_stats_paren`    | "(N files, M bytes)" formatting.                                                                   |
| `format_count`          | Comma-separated count formatting.                                                                  |

### `worktreeinclude::*` — Parser for `.worktreeinclude`

| Symbol                   | Purpose                                                                                              |
|--------------------------|------------------------------------------------------------------------------------------------------|
| `IncludePattern`         | One parsed pattern with its `ignore::gitignore` matcher.                                             |
| `read_include_patterns`  | Parse the `.worktreeinclude` file at the repo root.                                                  |
| `apply_include_matcher`  | Apply parsed patterns against a candidate path.                                                      |

## Usage

The canonical consumer is `worktree-napi`, which wraps `worktrunk-core` for
Node.js callers. A pure-Rust consumer looks like:

```rust
use std::path::Path;
use worktrunk_core::git::{ProcessRepo, Repo};
use worktrunk_core::progress::Progress;
use worktrunk_core::copy::copy_dir_recursive;
use worktrunk_core::paths::resolve_task_worktree_path;

// 1. Instantiate ProcessRepo for the current cwd.
let repo = ProcessRepo::current()?;
let repo_root = repo.root()?;

// 2. Resolve the canonical worktree path.
let worktree_path = resolve_task_worktree_path(
    /* cleo_home */ "/home/user/.local/share/cleo",
    /* project_hash */ "1e3146b7352ba279",
    /* task_id */ "T10223",
);

// 3. (Worktrunk-CLI/napi will call provision_worktree; here we copy.)
let progress = Progress::disabled();
let (files, bytes) = copy_dir_recursive(
    &repo_root,
    &worktree_path,
    /* matcher */ None,
    /* respect_symlinks */ false,
    &progress,
)?;
println!("Copied {files} files ({bytes} bytes)");
```

## Parity guarantee (T10222)

A 61-test parity suite verifies that every primitive listed above has
byte-equivalent behavior to the upstream `worktrunk` implementation. The
parity tests span 9 primitives:

- `cache` (read / write / sweep / clear)
- `step::shared` (ignored-entry listing)
- `step::copy_ignored` (plan + run)
- `step::promote` (planner + branch exchange)
- `step::prune` (candidate detection)
- `step::squash` (classification)
- `step::relocate` (plan generation)
- `diff` (numstat + shortstat)
- `paths` (hash + path resolution)

See `crates/worktrunk-core/tests/` for the parity test bodies.

## Boundary registry contract

This crate is the **reference implementation** of the boundary-registry
pattern defined in ADR-078. Its registry entry in
`packages/contracts/src/boundary.ts` declares:

```ts
{
  module: 'worktrunk-core',
  intent: 'cpu-bound',
  rustCore: 'crates/worktrunk-core',
  tsWrapper: 'packages/worktree',
  canonicalHome: 'cleocode',
  perfBudget: {
    latency_p50_ms: 5,
    latency_p99_ms: 50,
  },
  safetyBudget: {
    panic_unwind: 'forbidden',
    root_escape: 'forbidden',
  },
  amendments: ['adr-077-worktreeinclude', 'adr-078-boundary-registry'],
  rationale: 'Refactored SoC per ADR-078 amendment 2026-05-23. ...',
}
```

The CI gates `scripts/lint-boundary-registry.mjs` and
`scripts/lint-dual-implementation.mjs` enforce this contract — see ADR-078
for details.

## See also

- [ADR-078 — Boundary Registry as SSoT](../../docs/adr/adr-078-boundary-registry.md)
  (amendment dated 2026-05-23 records this refactor)
- [T10219 — SDK Interface Audit](../../docs/research/t10219-worktrunk-sdk-interface-audit.md)
- Saga T10176 SG-BOUNDARY-REGISTRY (epic + child tracker)
- Decision D010 — vendor worktrunk → `crates/worktrunk-core`
- `packages/worktree` — TS wrapper consuming this crate via `worktree-napi`
- `crates/worktree-napi` — napi binding shim

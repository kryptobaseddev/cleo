# T10219 — worktrunk SDK Interface Audit

**Status**: research / scope-clarification
**Saga**: T10176 SG-BOUNDARY-REGISTRY
**Epic**: T10218 E3-PREREQ-SDK-REFACTOR
**Task**: T10219 (re-scoped 2026-05-23)
**Author**: claude-opus-4-7 worker
**Decisions referenced**: D010 (vendor worktrunk), ADR-078 (boundary registry)

## Executive Summary

This audit catalogues every cross-module symbol that the consumers
(`worktrunk/src/commands/step/*.rs` and `worktrunk/src/commands/worktree/*.rs`)
import from `worktrunk::git::*`, `worktrunk::config::*`, and adjacent
crate-internal modules.

**Finding A — operations on data-DTOs are tractable.**
`BranchDeletionMode` (enum, 30 LOC), `WorktreeInfo` (struct, already vendored
in `git_wt.rs`), and a field-minimal `UserConfig` DTO (1 field actually read:
`copy_ignored`) can be vendored as pure data with no upstream pulls.

**Finding B — `Repository` is NOT a worktree wrapper. It is the entire
worktrunk runtime substrate.** Consumers call **45+ distinct methods** on it,
spanning git plumbing (`ref_exists`, `is_ancestor`, `count_commits`,
`commit_subjects`, `detect_ref_type`), worktree management
(`list_worktrees`, `worktree_at`, `prepare_target_worktree`,
`prepare_worktree_removal`), config integration
(`user_config`, `load_project_config`, `project_config_at_ref`,
`project_identifier`), shell exec
(`run_command`, `run_command_delayed_stream`), and high-level workflows
(`prepare_target_worktree`, `set_switch_previous`,
`warn_if_auto_staging_untracked`).

**Finding C — `RefSnapshot` is a derived cache, not a free-standing DTO.**
It is built via `repo.capture_refs()` and consumed only through
`repo.integration_reason(&snapshot, ...)` in `step/prune.rs`. Substituting
`RefSnapshot` requires substituting the methods that build and consume it,
not just the struct shape.

**Finding D — step/* and worktree/* consumers also import deeper
crate-private machinery beyond `git/`/`config/`.** They depend on:
- `crate::command_approval::*` (orchestration / HITL gating)
- `crate::commit::*` (CommitGenerator, CommitOptions, HookGate, StageMode)
- `crate::command_executor::FailureStrategy`
- `crate::hooks::{HookAnnouncer, execute_hook}`
- `crate::hook_plan::{ApprovedHookPlan, HookPlanBuilder}`
- `crate::repository_ext::RepositoryCliExt` (CLI-targeted extension trait)
- `crate::template_vars::TemplateVars`
- `crate::context::CommandEnv`
- `crate::styling::*`
- `crate::shell_exec::Cmd`
- `crate::output::handle_remove_output`

This is the **same boundary problem ADR-078 was filed for**: step/* is not
SDK-shaped today. It is the CLI layer with bits of orchestration leaking
into a "command handler".

**Recommendation**: T10219 scope is bounded. Deliverables A–D below are
achievable and unblock T10220/T10221 by establishing the small data-DTO
SDK surface. Implementing a full `git2`-backed `Repository` substitute is
beyond a single PR — it is a multi-task workstream that should be filed as
follow-up children of T10218 once T10219 ships.

---

## 1. Vendor candidates (data-only DTOs — implementable in this task)

### 1.1 `BranchDeletionMode`
- **Source**: `/mnt/projects/worktrunk/src/git/remove.rs:189` (30 LOC inc. impl)
- **Semantic**: 3-variant enum (`Keep | SafeDelete | ForceDelete`) + 3
  helpers (`from_flags`, `should_keep`, `is_force`).
- **Consumers** (file:line — semantic intent):
  - `step/prune.rs:191` — passes `SafeDelete` to a removal helper.
  - `worktree/types.rs:7` (import), `:162,:185,:358,:398,:426,:456` —
    embedded in WorktreeOp variants; used as field of removal commands.
  - `worktree/finish.rs:27` (import), `:126,:144,:156` — passed to
    `check_not_default_branch` + removal helpers.
- **Vendor strategy**: pure copy. No dependencies. Land in
  `worktrunk-core/src/git/branch.rs`.

### 1.2 `UserConfig` (field-only DTO)
- **Source**: `/mnt/projects/worktrunk/src/config/user/mod.rs:287` (62 LOC for
  the struct definition alone, ignoring impl).
- **Actual fields used by step/* + worktree/***:
  - `user_config.copy_ignored` — accessed in `step/copy_ignored.rs:95`,
    `step/shared.rs` (via lookup).
  - All other field accesses go through methods like
    `config.commit_generation(...)`, `config.worktree_path_for_project(...)`,
    `config.merged_with(...)` — these are NOT field reads but business-logic
    methods.
- **Semantic intent**: SDK-shaped consumers only need a "give me the
  `CopyIgnoredConfig` for project X" surface. The full `UserConfig`
  load/merge/persist apparatus is CLI-shaped (TOML I/O, env-var precedence,
  JsonSchema generation) and does NOT belong in the SDK.
- **Vendor strategy**: Vendor a minimal field-only DTO PLUS a
  `CopyIgnoredConfig` data struct in `worktrunk-core/src/config/`. Drop
  `projects`, `hooks`, `aliases`, all section configs except
  `CopyIgnoredConfig`, and ALL methods (`load`, `merge`, `merged_with`,
  etc.). Provide a `from_copy_ignored(cfg: CopyIgnoredConfig)` constructor
  so consumers can build one programmatically.

### 1.3 `WorktreeInfo`
- **Source**: ALREADY vendored at
  `crates/worktrunk-core/src/git_wt.rs:38` (12 LOC).
- **Worktrunk fields** (from `git/repository/worktrees.rs` — actual fields
  used by consumers): need to verify which extra fields step/worktree code
  reads beyond the current `{path, branch, head, is_locked, is_prunable}`.
- **Method usage on `wt: WorktreeInfo`** (from grep of consumers):
  - `wt.branch()`, `wt.dir_name()`, `wt.git_dir()`, `wt.has_staged_changes()`,
    `wt.is_prunable()`, `wt.root()`, `wt.run_command(...)`,
    `wt.temp_index()`, `wt.create_safety_backup(...)`.
- **Verdict**: the in-crate `WorktreeInfo` is a heavyweight object with
  behaviour methods (`run_command`, `create_safety_backup`, `temp_index`),
  not a DTO. Our `git_wt::WorktreeInfo` is the pure-data variant; the
  behaviour belongs on a `Repo` substitute (see §2).
- **Vendor strategy**: keep `git_wt::WorktreeInfo` as the data DTO. Add any
  missing fields surfaced by future T10220 work (e.g. `is_main`,
  `is_bare`, `has_safety_backup_dir`) once exact field shape required is
  re-audited inside T10220.

---

## 2. Substitute candidates (heavyweight types — require behaviour)

### 2.1 `Repository`
- **Source**: `/mnt/projects/worktrunk/src/git/repository/mod.rs:483` (1704
  LOC + 9 submodules totaling ~7300 LOC).
- **Methods called by step/* + worktree/* (45+ distinct):**

  | Method | Semantic intent (1 line) | git2 / process strategy |
  |---|---|---|
  | `Repository::at(path)` | Open repo at a path | git2: `Repository::open` |
  | `Repository::current()` | Open repo at cwd | git2: `discover` from cwd |
  | `discovery_path()` | Path used to discover | track at construction |
  | `repo_path()` | `.git/` location | git2: `path()` |
  | `root()` / `root_path()` | Worktree root | git2: `workdir()` |
  | `home_path()` | Common git dir | git2: `commondir()` |
  | `git_common_dir()` | Same | git2: `commondir()` |
  | `is_bare()` | bare repo flag | git2: `is_bare()` |
  | `ref_exists(name)` | Branch/tag exists | git2: `find_reference` |
  | `detect_ref_type(name)` | local/remote/tag | git2: `find_reference` + match kind |
  | `branch(name)` | Resolve branch handle | git2: `find_branch` |
  | `all_branches()` | List local + remote branches | git2: `branches(All)` |
  | `is_remote_tracking_branch(name)` | branch is remote-tracking | git2: kind check |
  | `strip_remote_prefix(name)` | strip `origin/` | pure string op |
  | `default_branch()` | repo's default branch | process: `symbolic-ref refs/remotes/origin/HEAD` |
  | `resolve_target_branch(...)` | Resolve user target | combined branch + remote lookup |
  | `require_target_branch(...)` | Same as above but bail on miss | wrapper around resolve |
  | `require_target_ref(...)` | Generic ref resolution | git2: `revparse_single` |
  | `count_commits(spec)` | `git rev-list --count` | process: `rev-list --count` |
  | `is_ancestor(a, b)` | merge-base check | git2: `graph_descendant_of` |
  | `is_rebased_onto(...)` | branch is rebased onto target | git2: ancestry walk |
  | `commit_subjects(rev_range, limit)` | `git log --format=%s` | process: `git log` |
  | `short_sha(sha)` | `git rev-parse --short` | git2: `Oid::find_prefix` |
  | `diff_stats_summary(a, b)` | `git diff --shortstat` | process: `git diff --shortstat` |
  | `capture_refs()` | snapshot all refs | process: `for-each-ref` |
  | `integration_reason(snapshot, name, target)` | Why is branch "integrated"? | derived from snapshot + ancestry |
  | `last_fetch_epoch(remote)` | mtime of FETCH_HEAD | std::fs |
  | `find_remote_by_url(url)` | remote name for url | git2: iterate remotes |
  | `remote_url(name)` | `remote get-url` | process or git2 |
  | `run_command(cmd, args)` | invoke command in repo dir | std::process::Command |
  | `run_command_delayed_stream(...)` | stream output with delay | tokio task or thread |
  | `set_config(k, v)` | `git config <k> <v>` | git2: `Config::set_str` |
  | `config_value(k)` | `git config --get <k>` | git2: `Config::get_string` |
  | `list_worktrees()` | already implemented in `git_wt::list_worktrees` | DONE |
  | `current_worktree()` | which wt are we in | match cwd against list |
  | `primary_worktree()` | main worktree | first entry in list |
  | `worktree_at(path)` | lookup by path | filter list |
  | `worktree_at_path(path)` | same | filter list |
  | `worktree_for_branch(name)` | lookup by branch | filter list |
  | `resolve_worktree(arg)` | by name OR path OR branch | combined filter |
  | `resolve_worktree_name(arg)` | extract name from any input | string parsing |
  | `worktree_state(...)` | classify wt as fresh/dirty/staged | combine status + porcelain |
  | `prepare_target_worktree(...)` | provision-or-reuse helper | high-level orchestration |
  | `prepare_worktree_removal(...)` | pre-flight checks for remove | high-level orchestration |
  | `load_project_config()` | read `.worktrunkrc` etc. | TOML reader |
  | `project_config_at_ref(ref)` | same but at a git ref | `git show <ref>:.worktrunkrc` |
  | `project_identifier()` | repo identity hash for config lookup | derived from origin remote or path |
  | `user_config()` | return UserConfig handle | TOML reader from XDG |
  | `set_switch_previous(...)` | track "last branch switched to" | git2: `Config::set_str` |
  | `warn_if_auto_staging_untracked(...)` | UI side-effect — not SDK | EXCLUDED — orchestration |
  | `extract_failed_command()` | extract a command from an error | error helper |
  | `find_remote_by_url(url)` | listed above | listed above |
  | `wt_dir(name)` | resolve wt name to path | high-level |

- **Verdict**: A faithful substitute requires implementing roughly 35
  pure-git operations + a small "project config / user config reader"
  layer + the worktree-resolution helpers already partially present in
  `git_wt.rs`. This is a non-trivial workstream (~1500–2500 LOC of
  substitute code + tests), beyond the single-task budget of T10219.

- **Recommended T10219 deliverable**: Define a `worktrunk_core::git::Repo`
  TRAIT with the audited method signatures, and ship a minimal default
  impl covering only the methods needed for steady-state CLEO consumers
  (worktree provisioning + path resolution, already in `git_wt.rs`).
  All OTHER methods get a `Repo` trait method that returns
  `anyhow::Result<T>` and an `unimplemented!()` body OR a clearly-named
  `RepoStub` impl with `Err(anyhow!("not yet implemented in
  worktrunk-core SDK — see T10220/T10221 follow-up"))`. This gives
  T10220/T10221 a typed contract to fill in incrementally without
  another scope-blocker.

### 2.2 `RefSnapshot`
- **Source**: `/mnt/projects/worktrunk/src/git/repository/ref_snapshot.rs:51`
  (1383 LOC total — but the struct itself is small; the LOC is largely
  cache-building logic + tests).
- **Consumers**:
  - `step/prune.rs:144` — borrowed as `&'a RefSnapshot`.
  - `step/prune.rs:503` — built by `repo.capture_refs()`.
  - `step/prune.rs:589-615` — passed via Arc to rayon workers.
- **Public methods called on `&RefSnapshot`** in step/prune.rs: only
  passed to `repo.integration_reason(&snapshot, ...)` — there are NO
  direct method calls on the snapshot in step/* (all access is via
  `Repository::integration_reason(snapshot, ...)`).
- **Substitute strategy**: define `RefSnapshot` as a typed wrapper
  around the data shape it carries (list of `(ref_name, oid, kind)`
  records). Implementation lives behind the `Repo::capture_refs` trait
  method. T10219 ships the struct shape + the trait method signature;
  the implementation is part of `Repo` substitute, which is deferred.

### 2.3 `CopyIgnoredConfig`
- **Source**: `/mnt/projects/worktrunk/src/config/sections/...` (separate
  file under sections/).
- **Methods used**: `merged_with(&other)` only — and even that is called
  via `UserConfig` not on the `CopyIgnoredConfig` directly.
- **Vendor strategy**: copy the data struct (likely 30–80 LOC) + the
  `merged_with` impl. Pure logic, no upstream deps expected (must verify
  during implementation).

---

## 3. Other consumer dependencies (NOT in scope for T10219)

step/* and worktree/* also import these symbols. They are listed here for
completeness — to set realistic expectations for T10220/T10221 — but are
NOT being vendored or substituted in T10219.

| Symbol | File:line | Why deferred |
|---|---|---|
| `crate::command_approval::{approve_or_skip, resolve_template_for_preview}` | step/copy_ignored.rs:12 | HITL gate orchestration — CLI-shaped |
| `crate::commit::{CommitGenerator, CommitOutcome, HookGate, StageMode, CommitOptions}` | step/commit.rs, step/squash.rs | commit-generation engine — orchestration |
| `crate::command_executor::FailureStrategy` | step/commit.rs | execution policy enum — orchestration |
| `crate::hooks::{self, HookAnnouncer, execute_hook}` | step/*, worktree/finish.rs | hook plumbing — orchestration |
| `crate::hook_plan::{ApprovedHookPlan, HookPlanBuilder}` | step/squash.rs | hook approval plan — orchestration |
| `crate::repository_ext::{RemoveTarget, RepositoryCliExt}` | step/*, worktree/* | CLI-targeted extension trait |
| `crate::template_vars::TemplateVars` | step/squash.rs | template engine state — orchestration |
| `crate::context::CommandEnv` | step/copy_ignored.rs | CLI command env — orchestration |
| `crate::styling::*` | all | CLI rendering — NOT SDK |
| `crate::shell_exec::Cmd` | step/* | shell exec wrapper — substitute with std::process |
| `crate::output::handle_remove_output` | step/prune.rs | CLI output renderer — NOT SDK |
| `crate::HookType` | step/commit.rs, etc | enum — vendor as DTO (small) |

---

## 4. Recommended T10219 final scope (implementation phase)

Given the audit, the in-scope deliverables for T10219 are:

1. **`worktrunk_core::git::branch::BranchDeletionMode`** — pure-copy enum +
   3 helper methods. Smoke test.
2. **`worktrunk_core::config::user::UserConfigDto`** — minimal field-only DTO
   exposing `copy_ignored: CopyIgnoredConfig`. Smoke test.
3. **`worktrunk_core::config::copy_ignored::CopyIgnoredConfig`** — vendor
   the data struct + `merged_with`. Smoke test.
4. **`worktrunk_core::git::HookType`** — small enum vendor (size to verify).
5. **`worktrunk_core::git::Repo` trait** — declare the 45+ method
   signatures with `anyhow::Result<T>` returns. Provide a default impl
   `worktrunk_core::git::ProcessRepo` that backs the worktree-management
   subset using `std::process::Command` (matches `git_wt.rs` pattern). All
   other methods return `Err(anyhow!("worktrunk-core: <method> not yet
   implemented — tracked in follow-up to T10218"))`. Smoke tests cover the
   implemented subset.
6. **`worktrunk_core::git::RefSnapshot`** — declare the struct shape used
   in step/prune.rs. The `Repo::capture_refs` trait method returns
   `Err(...)` for now.

This delivers a **typed SDK contract** that T10220 (step extraction) and
T10221 (lifecycle extraction) can program against. Each call site they
need to migrate has a corresponding `Repo` trait method in
`worktrunk-core`. Where the trait method returns `unimplemented`-style
errors, T10220/T10221 either fill in the implementation as part of their
PR scope OR file a tightly-scoped child of T10218 to do so.

This is the **substitute-trait pattern** the orchestrator's directive
described: vendor pure-data types; substitute heavy types via a trait
with a partial default impl.

---

## 5. Operation count summary

| Bucket | Count |
|---|---|
| Pure-data DTOs to vendor (BranchDeletionMode, UserConfigDto, CopyIgnoredConfig, HookType, WorktreeInfo already done) | 5 |
| Repository methods on the SDK trait | 45 |
| Repository methods with reference `ProcessRepo` impl in this PR | 6 (worktree mgmt — already in git_wt.rs) |
| Repository methods stubbed with `unimplemented_in_sdk!()` error | 39 |
| RefSnapshot fields declared | 1 struct (shape only, no captures impl) |

## 6. References

- ADR-078 (boundary registry — published as research/note attachment on T10176)
- Memory: O-mphq6fsb-0 (prior T10219 worker halt evidence)
- Memory: O-mphpo2pp-0 (T10201 parallel diagnostic from consumer side)
- Decision D010 (vendor worktrunk Rust source per saga T10176)

## 7. Verification methodology

This audit was produced by:
1. `grep -h "^use " step/*.rs worktree/*.rs` — full import surface.
2. `grep -oE "\b(repo|repository)\.[a-z_]+\("` — method call surface on
   Repository instances.
3. `grep -oE "(wt|info)\.[a-z_]+\("` — method call surface on WorktreeInfo.
4. `grep -n "user_config\." | grep -oE "user_config\.[a-z_]+"` — field-only
   access on UserConfig.
5. Cross-referenced against `/mnt/projects/worktrunk/src/git/repository/mod.rs`,
   `/mnt/projects/worktrunk/src/git/remove.rs`, and
   `/mnt/projects/worktrunk/src/config/user/mod.rs`.

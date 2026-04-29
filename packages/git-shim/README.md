# @cleocode/git-shim

Harness-agnostic `git` PATH override that fences agent (worker | lead |
subagent) git invocations. Provides two layers of enforcement:

1. **T1118 denylist** — branch-mutation operations
   (`checkout`, `switch`, `branch -D`, `worktree add`, `reset --hard`,
   `rebase`, `push --force`, etc.).
2. **T1591 boundary fence** — contextual rules tied to the
   worktree-by-default model (ADR-055) + worktree-merge integration
   (ADR-062):
   - **(a)** `git add` MUST stage paths inside the active worktree.
   - **(b)** `git commit -m "<msg>"` MUST embed a CLEO task ID
     (`T<NUM>`).
   - **(c)** `git merge` MUST be invoked by `completeAgentWorktreeViaMerge`
     (signalled via `CLEO_ORCHESTRATE_MERGE=1`).
   - **(d)** `git cherry-pick <ref>` MUST NOT take a `task/T<NUM>` source
     (cherry-pick from worktree branches is the deprecated integration
     path superseded by ADR-062).

Every block and every bypass is recorded in
`<XDG_DATA_HOME ?? ~/.local/share>/cleo/audit/git-shim.jsonl`.

## Installation

The shim ships as the `git` bin entry of this package. The orchestrator
materialises a `git` symlink inside `<projectRoot>/.cleo/bin/` (or any
shim directory) via `installShimSymlink(...)` and prepends that
directory to the spawned agent's `PATH`.

## Activation gate

The shim only enforces when the agent role is restricted:

```bash
CLEO_AGENT_ROLE=worker  # or lead, subagent
```

Orchestrators (the absence of `CLEO_AGENT_ROLE` or
`CLEO_AGENT_ROLE=orchestrator`) bypass the shim entirely — this keeps
orchestration code paths fast and unencumbered.

## Environment contract

| Variable | Set by | Purpose |
|---|---|---|
| `CLEO_AGENT_ROLE` | orchestrator (spawn) | Activates the fence for restricted roles. |
| `CLEO_WORKTREE_ROOT` | orchestrator (spawn) | Explicit worktree path; auto-detected from cwd otherwise. |
| `CLEO_TASK_ID` | orchestrator (spawn) | Active task ID; auto-derived from worktree path otherwise. |
| `CLEO_ORCHESTRATE_MERGE` | `completeAgentWorktreeViaMerge` (T1587) | Single-purpose grant — allows `git merge`. See below. |
| `CLEO_ALLOW_BRANCH_OPS` | operator (manual) | Single-shot bypass for the legacy denylist. Audited. |
| `CLEO_ALLOW_GIT` | operator (emergency) | Universal bypass for any T1591 boundary block. Audited. |
| `CLEO_AUDIT_LOG_PATH` | tests | Override audit log location. |
| `CLEO_REAL_GIT_PATH` | tests | Skip PATH walk; use this binary as real git. |
| `CLEO_SHIM_MARKER` | installer (optional) | Path-fragment that identifies the shim dir. Default: `.cleo/bin/git-shim`. |

## `CLEO_ORCHESTRATE_MERGE=1` contract (T1587 / ADR-062 integration)

`packages/core/src/spawn/branch-lock.ts::completeAgentWorktreeViaMerge`
is the **only** sanctioned entry point for `git merge` on a CLEO task
branch. It MUST set `CLEO_ORCHESTRATE_MERGE=1` in the env passed to the
spawned `git merge --no-ff` process. The shim's boundary (c) refuses any
other `git merge` invocation from a restricted role.

Concretely (see `branch-lock.ts:830`):

```ts
execFileSync('git', ['merge', '--no-ff', branch, '-m', subject], {
  cwd: gitRoot,
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CLEO_ORCHESTRATE_MERGE: '1' },
});
```

If you discover a code path that needs to invoke `git merge` from
restricted-role context **other than** `completeAgentWorktreeViaMerge`,
file a follow-up task — do NOT silently set `CLEO_ORCHESTRATE_MERGE=1`
elsewhere. The narrow scope of this env var is what makes the boundary
auditable.

`--abort`, `--continue`, and `--quit` flag invocations are exempt —
they do not perform a merge.

## Bypass workflow

For a legitimate emergency (e.g. operator hotfix, incident triage):

```bash
# One-off bypass; audit entry written to git-shim.jsonl.
CLEO_ALLOW_GIT=1 git <subcommand> ...
```

The bypass is logged with full context (subcommand, args, cwd, role,
task_id, worktree_path). Reviewers can list bypasses via:

```bash
jq 'select(.outcome | startswith("bypassed"))' \
  ~/.local/share/cleo/audit/git-shim.jsonl
```

## Audit record schema

```ts
interface AuditRecord {
  ts: string;                          // ISO 8601
  outcome: 'blocked' | 'bypassed-allow-git' | 'bypassed-orchestrate-merge';
  boundary: 'a' | 'b' | 'c' | 'd' | 'denylist';
  code: string;                        // E_GIT_OP_BLOCKED | E_GIT_BOUNDARY_*
  subcommand: string;
  args: string[];
  cwd: string;
  worktree_path: string | null;
  task_id: string | null;
  role: string | null;
  context: Record<string, string>;
}
```

The schema is project-agnostic: the audit log under
`~/.local/share/cleo/audit/` is shared across every CLEO-managed
project on the host.

## Defense-in-depth pipeline

The git-binary fence (this package) is one layer in a multi-checkpoint
pipeline:

| Layer | Package | Catches |
|---|---|---|
| Git binary | `@cleocode/git-shim` (this) | Direct git invocations from agents |
| Commit-msg hook | `@cleocode/core` (T1588) | Editor-flow commits (no inline `-m`) |
| Drift watchdog | `@cleocode/core` (T1594) | Files modified outside worktree |
| Pre-push reconcile | `@cleocode/core` (T1595) | Branch state drift before push |
| Sync linter | CI (T1598) | Review-time policy mismatches |

Both T1588 (hook) and T1591 (shim, boundary b) enforce the
commit-subject T-ID rule. This is intentional defense in depth: a
developer who disables the local hook still trips the shim.

## References

- ADR-055 — worktree-by-default agent isolation
- ADR-062 — worktree integration via `git merge --no-ff` (not cherry-pick)
- T1118 — original branch-lock engine (denylist)
- T1587 — `completeAgentWorktreeViaMerge` (sets `CLEO_ORCHESTRATE_MERGE=1`)
- T1591 — this fence (boundary a/b/c/d)

# T1588 — Worker 9 Report (Foundation-Worker-9, Wave B)

Mission: Ship project-agnostic pre-commit + pre-push T-ID enforcement so EVERY commit references at least one task ID. Closes lie-pattern source #1.

## T1410 verification — PARTIALLY shipped

`cleo show T1410` reports `status=pending stage=research verified=false`. Predecessor commit `ee0e55592` ("feat(T1410): commit-msg lint requiring T-IDs in release commits") DID land artifacts but they FAIL the project-agnostic acceptance:

| Artifact | Status | Why insufficient |
|---|---|---|
| `scripts/hooks/commit-msg-release-lint.mjs` | shipped | Only fires on `chore(release):`/`feat(release):` subjects. Lets every other commit pass without a T-ID. |
| `package.json` simple-git-hooks wiring | shipped | Cleocode-specific (uses pnpm). Won't run in Rust/Python/bare-repo projects. |
| `scripts/__tests__/commit-msg-release-lint.test.mjs` (7 cases) | shipped | All 7 cases test the release-only path. |
| Pre-push T-ID gate | NOT shipped | `core/templates/git-hooks/pre-push` enforces CalVer on tag pushes only. |
| `.git/hooks/commit-msg` (legacy) | shipped (bash) | Requires `.cleo/tasks.db` for task-existence check — fails on non-cleo-init'd projects. |

**Verdict**: T1410's release-only narrow scope DID NOT close the lie-pattern hole. T1588 generalizes it to every commit on every project, project-agnostic.

## Hook templates

- `/mnt/projects/cleocode/packages/cleo/templates/hooks/commit-msg` — POSIX `/bin/sh`, sentinel `# CLEO_MANAGED_HOOK v1`, requires `T<digits>` anywhere in subject, bypasses `Merge / Revert / fixup! / squash! / amend!`. No node/pnpm dep.
- `/mnt/projects/cleocode/packages/cleo/templates/hooks/pre-push` — POSIX `/bin/sh`, walks every commit in pushed range, enforces same regex. Includes T1595 sentinel block:
  ```sh
  # T1595:reconcile-extension-point
  # Pre-push reconcile gate hooks here (see T1595 worker)
  # T1595:reconcile-extension-point-end
  ```
  T1595 worker can inline `reconcile_gate()` between those markers without parsing.
- Legacy `/mnt/projects/cleocode/packages/core/templates/git-hooks/{commit-msg,pre-push}` overwritten with the same POSIX bodies so existing `ensureGitHooks()` callsite (init/upgrade/system-health) gets the project-agnostic behaviour transparently.

## Installer

`packages/core/src/git/hooks-install.ts` — exported via both `@cleocode/core` (root) and `@cleocode/core/internal`:

```ts
export async function installCleoHooks(
  projectRoot: string,
  opts?: InstallCleoHooksOptions,
): Promise<InstallCleoHooksResult>;

export interface InstallCleoHooksOptions {
  templatesDir?: string;  // override (tests pass repo path)
  force?: boolean;        // overwrite non-CLEO hooks
  dryRun?: boolean;
}
```

Honours `git config core.hooksPath` (Husky/lefthook compat). Worktree-aware (`.git` file with `gitdir:` pointer). Sentinel-based ownership: only files whose first 5 lines contain `# CLEO_MANAGED_HOOK v1` are overwritten without `force`.

## Wiring

`cleo init` and `cleo upgrade` both call `ensureGitHooks(projectRoot, { force })` (already shipped), which now installs the T1588 POSIX templates from `core/templates/git-hooks/`. No new wiring required — the upgrade replaces existing managed hooks via content-comparison. Per-task spec, the `installCleoHooks` SDK is exposed for any consumer who wants the sentinel-tracked path independently.

## Override path

- `git commit --no-verify` / `git push --no-verify` (standard git, audited only via T1591 git shim — hooks themselves cannot observe the flag).
- Documented inline in both hook scripts.

## Tests

61/61 passed across `src/git/__tests__/hooks-install.test.ts` (29) + `src/__tests__/hooks.test.ts` (13) + `src/__tests__/init-e2e.test.ts` (19). Coverage:

- Fresh `git init` → both hooks installed, mode 0o755, sentinel present.
- Idempotent re-install (sentinel detected → overwrite same content).
- Non-CLEO hook present → skip without `force:true`.
- `force:true` → overwrite preserved hook with sentinel version.
- Project-agnostic: works in repo with only README.md (no package.json), runs with `/bin/sh` directly.
- Non-git directory → `installCleoHooks` rejects with `not inside a git repository`.
- Subject regex: 7 accept cases (`T1588: foo`, `feat(T1588): add hooks`, `fix: T1588 typo`, `T1`, `T123456789`, `chore — T1588 — done`, bare `T1588`); 6 reject cases (`fix bug`, `feat: add new feature`, `chore: bump deps`, `WIP`, `TIP: ...`, `task1234: ...`).
- Bypass paths: 6 merge/revert/fixup/squash/amend variants pass.
- Empty subject rejected; comment-line subjects honored.
- `isCleoManagedHook` detects sentinel in head, false on missing/non-managed files.

## Sentinel for T1595

Pre-push hook contains:
```
# T1595:reconcile-extension-point
# Pre-push reconcile gate hooks here (see T1595 worker)
# Reserved range below — DO NOT remove these markers; T1595 extends here.
# T1595:reconcile-extension-point-end
```
T1595 worker inlines `reconcile_gate()` from `pre-push.t1595-extension.sh` between those exact lines.

## Files touched

- `packages/cleo/templates/hooks/commit-msg` (new, 2027B)
- `packages/cleo/templates/hooks/pre-push` (new, 2370B)
- `packages/core/src/git/hooks-install.ts` (new, ~9KB)
- `packages/core/src/git/__tests__/hooks-install.test.ts` (new, ~9KB, 29 tests)
- `packages/core/src/index.ts` (export `installCleoHooks` + types)
- `packages/core/src/internal.ts` (re-export for cleo CLI consumers)
- `packages/core/templates/git-hooks/commit-msg` (overwritten with POSIX/sentinel)
- `packages/core/templates/git-hooks/pre-push` (overwritten with POSIX/sentinel)

## Coordination notes

- T1591 (git shim): hooks emit override hint pointing at shim audit.
- T1595: extension sentinel is in place; worker can extend without parsing.
- T1594, T1598: independent — no conflict.

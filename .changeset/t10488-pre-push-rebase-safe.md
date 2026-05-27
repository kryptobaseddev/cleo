---
id: t10488-pre-push-rebase-safe
tasks: [T10488]
kind: fix
summary: pre-push hook scan range now excludes commits already on any remote ref — rebased branches with upstream release commits no longer reject
---

The unified pre-push hook (`packages/core/templates/git-hooks/pre-push`, T1588) enforces a T-ID on every commit in the push range. The existing-branch range was `$remote_sha..$local_sha` which, after a rebase onto a newer `origin/main`, includes the rebased-on upstream commits — so legitimate release-ship / chore(changelog) / ci: nudge commits (which by design lack T-IDs because they are release-pipeline plumbing) caused the hook to reject the push. Operators worked around this with `--no-verify`, which also defeats the T1595 reconcile gate stacked on the same hook.

Fix (Option A — narrow scan range): both new-branch and existing-branch pushes now use `$local_sha --not --remotes`, which means "commits reachable from local_sha that are not reachable from any remote ref". After `git rebase origin/main`, the rebased-on commits are by definition on `origin/main`, so they are excluded from the T-ID scan. Local feature commits not yet pushed remain in scope.

Caught during Saga T9862 Wave 4 where 5 rebases needed owner-authorized `--no-verify` overrides in a row. Project-agnostic POSIX shell — no behaviour change for non-rebased pushes.

Regression coverage: `packages/core/src/__tests__/pre-push-task-id.test.ts` — 7 scenarios including the explicit rebase-onto-release-commits reproduction (failing before this fix, green after).

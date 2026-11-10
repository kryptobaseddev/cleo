---
id: terminal-worktree-reaper
tasks: [T14438]
kind: fix
summary: "Worktree reaper: release terminal-task locks and reclaim proven-safe worktrees with TTL and size limits, retaining branches"
---

Extend the existing hygiene census with machine-wide apply, external worktree
coverage, dry-run selection, TTL and a retained-size budget. Completion and
cancellation release locks and remove only worktrees the disposal engine proves
safe, retaining branches and reporting everything kept. The scheduled census
applies to the current project; ignored build output needs an explicit flag.
Manual census calls remain report-only unless `--apply` is passed. Automatic
removal requires terminal task state and independent worker, lease and process
inactivity proof; unknown ownership or a failed probe always keeps the checkout.

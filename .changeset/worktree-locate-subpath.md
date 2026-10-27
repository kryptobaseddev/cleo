---
id: worktree-locate-subpath
tasks: [T10866]
kind: refactor
summary: "Core's worktree list reads the registry through a light @cleocode/worktree/worktree-locate.js subpath"
---

`@cleocode/worktree` gains a package `exports` map: `.` as before (now with a
`default` condition, so `require.resolve` keeps working), a narrow
`./worktree-locate.js` subpath, and pass-throughs for `./native/*`, `./dist/*`
and `./package.json`, so existing paths keep resolving. Core's
`enumerateWorktrees` no longer parses `git worktree list --porcelain` itself: it
calls the new throwing `readWorktreePorcelain` from that subpath, which keeps
the package barrel off the CLI's sync evidence path. `LocatedWorktree` marks a
bare repository entry with `bare: true`. `worktree/list.ts` leaves the
raw-git-worktree lint allowlist; the doctor orphan scan is the only remaining
forensic bypass (spec MUST-30).

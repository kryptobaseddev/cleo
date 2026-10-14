---
id: t13577-init-commit-pre-push
tasks: [T13577]
kind: fix
summary: "CLEO's commit-msg and pre-push hooks accept the empty 'initial: cleo init' commit, so a fresh project's first push succeeds"
---

`cleo init` makes an empty commit, `initial: cleo init`, so HEAD resolves, but CLEO's own pre-push hook refused it as missing a task ID. A fresh project's first push therefore failed; the v2026.10.10-canary.1 soak hit this on `push HEAD:refs/heads/allowed`. The commit-msg and pre-push allowlists now accept that exact subject, which opens no general bypass: a longer or different subject still needs a task ID. The 10.9 hook template hashes join `legacy-hashes.json`, so `cleo upgrade` refreshes installed copies. The packed hooks preflight (`scripts/release-hooks-soak.mjs --packed-preflight`) now runs `cleo init` as the canary soak does, so it would have caught this.

---
id: spawn-include-deps
tasks: [T14045]
kind: feat
summary: "orchestrate spawn --include-deps starts the task branch from a merge of its dependencies' branches"
---

`cleo orchestrate spawn <id> --include-deps` builds the base for a task whose
dependencies have not landed yet. Each dependency's `task/<id>` branch is merged
`--no-ff` onto the base (HEAD, or `--base <ref>`) in a temporary integration
worktree under the canonical worktree root; the primary checkout never moves
and no commit is cherry-picked or rewritten. The resulting commit is handed to
the `--base` path, so the resolved-sha guard and lifecycle audit apply. The base
ref, its sha and every dependency sha are recorded in
`.cleo/audit/worktree-integration.jsonl`. A dependency with no branch
(`E_INCLUDE_DEPS_MISSING`) or one that does not merge cleanly
(`E_INCLUDE_DEPS_DIVERGED`) refuses the spawn before anything is claimed or
provisioned.

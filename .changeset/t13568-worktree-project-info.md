---
id: t13568-worktree-project-info
tasks: [T13568]
kind: fix
summary: "Typed gates run in a git worktree CLEO did not provision; cleo worktree adopt seeds and verifies its project-info.json"
---

A worktree created outside CLEO has no `.cleo/project-info.json`, so typed gates failed before running with ENOENT from `captureProjectScope`. When a worktree has none, the project-info readers now fall back to the primary checkout's file. They find it from files alone: the worktree's `.git` gitlink and its gitdir's `commondir`, with a subdirectory CLEO root mapped to the same path. The worktree stays the identity's root and the hash root, and nothing is written into it. `cleo worktree adopt` now copies the adopting project's `project-info.json` into the worktree, as `createWorktree` does, and checks the projectId. A worktree whose file names another project is refused with `E_WORKTREE_IDENTITY_MISMATCH`. The adopt result reports `projectInfo: seeded | present | skipped`.

---
id: t12190-evidence-cache-identity-ssot
tasks: [T12190]
kind: fix
summary: Evidence-cache key, read guard and write guard all derive from one identity field list (gh#1419)
---

A tool-evidence cache entry is now keyed on the tree the tool actually ran in.

`computeCacheKey` hashed `{canonical, cmd, args, head, dirtyFingerprint}` and no
working directory, while the cache DIRECTORY is shared by every worktree of a
project on purpose. Two clean worktrees at the same HEAD share a
`dirtyFingerprint` — the empty-input hash — so they collided by construction and
a run in worktree A was served to worktree B. T12112 had already threaded
`executionRoot` through execution for this exact hazard; it never reached the key.

The structural half, which is why this is a design pass rather than a fourth
patch: `TOOL_RUN_IDENTITY_FIELDS` is now the single source of truth for what the
key hashes, what `readCacheEntry` requires, and what the persist guard requires.
Those three were previously maintained by hand, and the read and write guards
were separate transcriptions of one rule with nothing asserting they agreed.
`schemaVersion` bumps 1 -> 2, retiring every pre-`executionRoot` entry on one
comparison — the mechanism gh#1380 and gh#1404 each rebuilt as a bespoke
null-check while that counter sat unused.

Behaviour change worth stating: N worktrees now run a tool N times rather than
sharing one result. That reuse was unsound — `biome lint .` walks
untracked-not-ignored files, `node_modules` differ per worktree, and the
originating worktree may be deleted, which makes the evidence unfalsifiable
rather than merely stale.

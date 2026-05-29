---
id: t11294-docs-list-full-sha-sweep-o1
tasks: [T11294, T11292]
kind: fix
summary: docs list --json emits full sha256; Manual Write Sweep is O(1) cleo spawns (was O(docs), 1963 docs × 7-10s → never finished)
---

Root-causes the PR #812 merge blocker T11294. `cleo docs list --json` truncated the content hash to 8 chars in the machine envelope (a display hack that leaked into data); `scripts/sweep-manual-doc-writes.mjs` therefore spawned `cleo docs fetch <sha>` once per doc to recover the full hash — 1963 docs × 7-10s cold start = 229-327 min, exceeding the job's 5-min timeout, then killed by workflow concurrency cancel. Fix: emit the full 64-hex sha256 in the list JSON (truncation belongs in human render only) and replace the per-file fetch with an in-memory full-sha map built from the single `docs list` call. Real run: 1963 files classified in 14.2s, one spawn.

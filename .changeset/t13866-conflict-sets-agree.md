---
id: t13866-conflict-sets-agree
tasks: [T13866]
kind: fix
summary: sync conflict lists agree on both devices after a rebase under an unframed writer, and memory-read bookkeeping is no conflict
---

Two devices could list different conflicts after syncing. A write from a foreign connection (unframed, such as the citation bump a `memory find` or `memory fetch` makes) has no capture position. When a pull rebased it under a concurrent foreign edit, the replay deferred its conflicts to its echo. The echo then took the fast path and applied in place over its own replayed value, so the origin never recorded the conflict its receivers did. An unframed transaction a rebase has replayed now declines the fast path, and its echo is decided at its stream position, the same way on every device. The citation count and last-use time a memory read writes on brain observations, decisions, patterns and learnings now merge by LWW without recording a conflict. A divergent edit of any other column still records one.

---
id: t10108-find-parent-filter
tasks: [T10108]
kind: fix
summary: cleo find --parent applies the parent filter (closes T10108 — empty-string query no longer bypasses all filters)
---

Closes the T10108 bug where `cleo find "" --parent T9758` returned the full unfiltered task set instead of just the children of T9758. Two compounding defects:

1. The CLI `find` command had no `--parent` flag — the value was silently dropped before dispatch.
2. The empty-string `""` query short-circuited to fuzzy mode, where `fuzzyScore('', '<any title>')` returned 80 (every string contains the empty string), so every row "matched" regardless of any filter that had been set.

This change wires `--parent` end-to-end through CLI → dispatch → core → accessor, normalises empty / whitespace-only queries to `undefined` so filter-only mode kicks in, and routes Saga parents through `task_relations.type='groups'` member IDs (ADR-073 §1) — same dual-path resolution `cleo list --parent` uses.

8 new unit tests in `packages/core/src/tasks/__tests__/find-parent-filter.test.ts` lock in the behaviour: direct-children filtering, AND composition with status / label, filter-only mode, empty-string and whitespace-only regression cases, and Saga-aware routing.

---
id: graph-sync-discover-honesty
tasks: [T12135]
kind: fix
summary: graph sync and discover describe the operations they actually perform (gh#1218)
---

Two `cleo graph` subcommands documented themselves as operations they do not
perform, and the reporter's conclusion — "NEXUS indexing never populates" —
followed reasonably from believing them.

**`graph sync`** was described as "Re-analyze and sync the project graph with
the codebase". It performs no analysis: `nexusSyncAll` refreshes each
registered project's taskCount, labels and lastSync in the project registry
and touches no source file. On a 360-file repo it returned
`{"success": true, "synced": 1}` — one metadata row — which reads as "one
thing indexed", while `graph status` stayed `indexed: false` with zero nodes.
A success envelope describing work that did not happen. The description now
says what it does and points at `cleo nexus analyze`, and the command emits a
warning so `synced: N` is not read as files indexed.

**`graph discover`** was described as "Discover the codebase structure (file
tree + symbol counts)" — a command that would take no arguments. It actually
dispatches a task→code query and requires a positional `taskQuery`, so running
it as documented produced `Missing required positional argument: TASKQUERY`
for an argument the help text never mentioned. The reporter concluded the
router had bound the wrong operation; the router was correct and the
description was not.

Python is supported by the analyzer (`py`/`pyi` are in the tree-sitter
extension map), so the reporter's Python repo was never the obstacle.

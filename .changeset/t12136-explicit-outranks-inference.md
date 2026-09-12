---
id: t12136-explicit-outranks-inference
tasks: [T12136]
kind: fix
summary: cleo add no longer inherits a parent from finished work, and an inference that fires is named in the output and in the error instead of being announced only to humans
---

Closes GH #1232 (primary defect), #1238.

`cleo add` with no `--parent` silently acquired one from session state and then failed on a rule about the **inherited** value:

```
$ cleo add --type task --kind bug --severity P1 --title "..." --acceptance "..."
E_CLEO_DEPTH_EXCEEDED
Cannot add a child to T138: the hierarchy depth cap (3) would be exceeded.
Tasks at depth 2 cannot have children. Use --parent T124 (the parent epic) instead.
```

The caller never named T138. It was a stale `current` pointer left by a session that had ended days earlier and was being inherited by unrelated sessions. As #1238 put it: *"the message describes the checker's state, not the world the caller is in."* And the suggested remedy — the only actionable-looking line — pointed at the parent epic of a task the caller never intended to be under at all, so following it verbatim files the bug in an unrelated epic.

## The live condition, not a synthetic one

The session that wrote this fix had exactly the defect in it. `cleo current` returned **`T12100` — status `done`**, set 2026-08-19, in a session started 2026-08-01. Any `cleo add --type task` without `--parent` would have been filed under a task finished weeks earlier.

## Two things were wrong, and there were two inference sites

**1. The inference had no viability check.** A `current` pointer outlives the work it points at. A candidate whose status is `done`/`cancelled`/`archived` is now declined rather than silently adopted — inheriting a parent from completed work is never what the caller meant.

**2. The inference was invisible to exactly the population it hurt.** It *was* announced — through `humanInfo`, which begins `if (!humanEnabled()) return;` and is silent unless `format === 'human' && !quiet`. So under `--json` or a pipe, agents never saw it, while the error that *did* reach them never mentioned it. The notice now travels on both channels: the human line, plus a `parentInference` record in the envelope and in the `EngineResult`.

And there are **two** session-derived inference sites, not one:

| Site | Infers from | Who hits it |
|---|---|---|
| `infer-add-params.ts` (CLI) | the session's `current` task pointer | `cleo add` |
| `resolveParentFromSession` (core) | the session's `scope.epicId` | SDK / dispatch / MCP — **non-CLI callers** |

Both were silent and both swallowed their lookup failure. Fixing only the CLI would have left the programmatic path in precisely the state the issues describe, so both are fixed.

## The error now describes the world, not the checker

`E_CLEO_DEPTH_EXCEEDED` leads with the provenance when — and **only** when — the parent was inherited:

> **You did not pass --parent: T138 was inherited from the active session pointer (cleo current).** Cannot add a child to T138: the hierarchy depth cap (3) would be exceeded… Use --parent T124 (the parent epic) instead. Or pass --parent <id> explicitly to override the session pointer, or --parent none to suppress inference.

`parentSource` defaults to `'explicit'`, and a test pins the dangerous inverse: a caller that genuinely passed `--parent` must **never** be told its parent was inferred. Telling it so would be a new false statement, not a fix.

## A failed lookup is no longer indistinguishable from no-current-task

Both inference sites wrapped their session lookup in `catch {}` with a "non-fatal" comment, so a broken session produced the same silent outcome as a clean one with nothing to infer. Each now reports which happened.

## Also fixed

The root-containment error's `fix` hint was `cleo add "Task title" --parent T### --acceptance "..."` — the **positional-title** form, contradicting the `--title` form used throughout CLEO-INJECTION.md (#1232's third ask). A fix hint that disagrees with the injected protocol makes a reader doubt both. Now `cleo add --type task --parent T### --title "..." --acceptance "..."`.

## Not in this change

#1232 bundles four further doc/CLI contradictions, each a separate surface: the pipe-vs-JSON-array acceptance inconsistency between `cleo saga create` and `cleo add-batch` (reproduced independently while writing this saga's tasks), `cleo docs add --field` returning `E_UNKNOWN_FLAG` against a protocol that documents `--field` as general, the undiscoverable 65,536-character doc cap, and `E_INTERNAL_AC_LOCKED` presenting a deliberate guard as an internal error. They are filed separately rather than folded in.

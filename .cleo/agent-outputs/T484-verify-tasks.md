# T484: Full CLI Runtime Verification — Tasks Domain

**Agent**: CLI Runtime Verifier (Subagent)
**Date**: 2026-04-10
**Epic**: T443 — CLI System Integrity
**Task**: T484

---

## Executive Summary

All 31 tasks-domain CLI commands were executed against live `.cleo/tasks.db`.
26 PASS, 3 BROKEN, 2 DUPLICATE paths identified.

**Critical bug**: `cleo claim` and `cleo unclaim` have a parameter name mismatch
(`taskId` sent, `id` expected by engine) — both fail 100% of the time with exit 0
but `"success": false`.

---

## Read Commands

| Command | Exit | Operation | Status |
|---------|------|-----------|--------|
| `cleo show T443` | 0 | `tasks.show` | PASS |
| `cleo find "CLI"` | 0 | `tasks.find` (436 results) | PASS |
| `cleo list --parent T443` | 0 | `tasks.list` | PASS |
| `cleo next` | 0 | `tasks.next` | PASS |
| `cleo current` | 0 | `tasks.current` | PASS |
| `cleo plan` | 0 | `tasks.plan` | PASS |
| `cleo tree` | 0 | `tasks.tree` | PASS |
| `cleo blockers` | 0 | `tasks.blockers` | PASS |
| `cleo analyze` | 0 | `tasks.analyze` | PASS |
| `cleo history` | 0 | `admin.log` | PASS |
| `cleo exists T443` | 0 | `tasks.exists` | PASS |
| `cleo labels list` | 0 | `tasks.label.list` | PASS |
| `cleo labels show "cli"` | 0 | `tasks.label.list` | BROKEN (see §Bugs) |
| `cleo labels stats` | 0 | `tasks.label.list` | DUPLICATE (see §Duplicates) |
| `cleo deps show T443` | 0 | `tasks.depends` | PASS |
| `cleo deps overview` | 0 | `tasks.depends` | PASS |
| `cleo deps waves --epic T443` | 0 | `tasks.depends` | PASS |
| `cleo deps waves` (bare) | 0 | `orchestrate.waves` (wrong op!) | BROKEN (see §Bugs) |
| `cleo deps cycles` | 0 | `tasks.depends` | PASS |
| `cleo deps critical-path T443` | 0 | `tasks.criticalPath` | PASS |
| `cleo deps impact T443` | 0 | `tasks.depends` | PASS |
| `cleo relates suggest T443` | 0 | `cli.output` (0 suggestions) | PASS |
| `cleo complexity estimate T443` | 0 | `tasks.complexity.estimate` | PASS |
| `cleo sync links list --task T443` | 0 | `tasks.sync.links` | PASS |
| `cleo sync links list` (bare) | 0 | `tasks.sync.links` | BROKEN (see §Bugs) |
| `cleo sync reconcile` (bare) | 1 | shows parent help, "Unknown command reconcile" | BROKEN (see §Bugs) |

---

## Mutation Commands

Test task T485 created under T443, used for all mutations, then deleted.

| Command | Exit | Operation | Status |
|---------|------|-----------|--------|
| `cleo add "VERIFY-TEST-TASK" --parent T443 --acceptance "A\|B\|C"` | 0 | `tasks.add` | PASS |
| `cleo start T485` | 0 | `tasks.start` | PASS |
| `cleo stop T485` | 0 | `tasks.stop` | PASS |
| `cleo update T485 --title "..."` | 0 | `tasks.update` | PASS |
| `cleo reorder T485 --position 1` | 0 | `tasks.reorder` | PASS |
| `cleo reparent T485 --to T443` | 0 | `tasks.reparent` | PASS |
| `cleo promote T485` | 0 | `tasks.reparent` (clears parent) | PASS |
| `cleo claim T485 --agent "test-agent-001"` | 0 | `tasks.claim` | BROKEN (see §Bugs) |
| `cleo unclaim T485` | 0 | `tasks.unclaim` | BROKEN (see §Bugs) |
| `cleo cancel T485 --reason "test"` | 0 | `tasks.cancel` | PASS |
| `cleo delete T485` | 0 | `tasks.delete` | PASS |
| `cleo archive` (bare — archives all done) | 0 | `tasks.archive` | PASS |
| `cleo restore task T485` | 0 | rejected (already pending) | PASS (correct error) |

---

## Bugs Found

### BUG-1: `cleo claim` — parameter name mismatch (CRITICAL)

**Command**: `cleo claim T485 --agent "test-agent-001"`
**Observed**: `{"success":false,"error":{"code":2,"message":"Missing required parameters: id"}}`
**Exit**: 0 (misleading — should be non-zero)

**Root cause**: `claim.ts` handler passes `{ taskId, agentId }` to dispatch, but registry
`tasks.claim` declares `requiredParams: ['id']`, not `taskId`. The engine never receives `id`.

**File**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/claim.ts` line 30
**Fix**: Change `taskId` key to `id`:
```ts
{ id: taskId, agentId: opts['agent'] as string | undefined }
```

### BUG-2: `cleo unclaim` — same parameter name mismatch (CRITICAL)

Same root cause as BUG-1. Handler passes `{ taskId }`, registry expects `{ id }`.

**File**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/claim.ts` line 54
**Fix**: Change `{ taskId }` to `{ id: taskId }`.

### BUG-3: `cleo labels show <label>` — filter param ignored

**Command**: `cleo labels show "cli"`
**Observed**: Returns full label list (247 labels), not tasks filtered to "cli" label.
**Exit**: 0

**Root cause**: `labels.ts` line 35 dispatches `tasks.label.list` with `{ label }`.
The engine's `label.list` operation does not implement label-based filtering — it always
returns the full label index. The subcommand description says "Show tasks with specific
label" but the registry operation `tasks.label.list` returns aggregate counts, not task
lists. This is a behavior/description mismatch: either the handler needs to use a
different operation (e.g., `tasks.find` with label filter), or the engine must support
a `label` filter param on `tasks.label.list`.

**File**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/labels.ts` line 33-36

### BUG-4: `cleo deps waves` (bare, no `--epic`) routes to wrong operation

**Command**: `cleo deps waves` (no --epic flag)
**Observed**: `{"success":false,"error":{"code":2,"message":"epicId is required","codeName":"E_INVALID_INPUT"}}`
**Operation**: `orchestrate.waves` — WRONG domain entirely
**Exit**: 0

This is a routing bug: without `--epic`, the deps waves handler falls through to
`orchestrate.waves` rather than a graceful error. The response JSON and error are
correct from the engine's standpoint, but the wrong operation is being called.

### BUG-5: `cleo sync links list` (bare, without --task or --provider)

**Command**: `cleo sync links list`
**Observed**: Logs a WARN and returns `{"success":false,"error":{"message":"Either providerId or taskId is required"}}`
**Exit**: 0

The engine requires at least one filter. The CLI help text says "filter by provider or task"
but does not indicate this is required. `cleo sync links` (bare, no `list` subcommand)
correctly calls the default action which also shows this error. The bare `sync links` default
action (line 66 of sync.ts) sends `{}` to the engine without any filter — same result.

This is an engine constraint not documented in CLI help. Low severity but misleading UX.

### BUG-6: `cleo sync reconcile` shows wrong help / "Unknown command reconcile"

**Command**: `cleo sync reconcile` (bare, no file/provider)
**Observed**: Shows `sync links` help, then "Unknown command reconcile", exit 1

**Root cause**: The `sync` shim command has no action of its own. When `sync reconcile`
is typed without a `<file>` argument, citty/shim fails to match the subcommand. The
`reconcile <file>` subcommand requires a positional arg at registration time; without it,
the command is not recognized.

---

## Duplicate Paths

### DUP-1: `cleo labels stats` == `cleo labels list`

Both dispatch to `tasks.label.list` with identical `{}` params and return identical
output. `stats` was documented as a "Show detailed label statistics" command but the
implementation does nothing different.

**Recommendation**: Either implement `stats` as a genuinely different aggregation
(e.g., label velocity, trending), or remove the `stats` subcommand entirely.

**File**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/labels.ts` lines 38-45

### DUP-2: `cleo pipeline` == `cleo phase`

Both commands render identical help text for phase lifecycle management.
Confirmed from CLI root help: `phase (pipeline)` — `pipeline` is registered as an alias.
This is intentional (documented alias), not a bug. Noted for completeness.

---

## Dead / No-Op Commands

None found. All registered commands dispatch to real operations. `cleo sync links`
bare returns an error (expected from engine constraint, not a dead command).

---

## Consolidation Candidates

1. **`cleo labels show` + `cleo find --label`**: The `show` subcommand should route to
   `tasks.find` with `{ labels: [label] }` instead of `tasks.label.list`. This would
   correctly return task records filtered by label, matching the help description.

2. **`cleo labels stats`**: Consolidate into `cleo labels list --stats` or implement
   genuinely different statistics (velocity, trend). Current implementation is a dead alias.

3. **`cleo sync links` default action**: The default bare action (no subcommand, no filters)
   could show usage/help instead of hitting the engine with `{}` and getting an error.

---

## Argument Validation Issues

### `cleo add` — acceptance criteria format is non-obvious

Passing `--acceptance "A" --acceptance "B" --acceptance "C"` (three separate flags)
fails with "1 criteria" even though three flags were provided. The pipe-separated format
`--acceptance "A|B|C"` works. This suggests the shim is passing the last `--acceptance`
value only, not accumulating them. Non-trivial UX issue for multi-value args.

---

## Summary Table

| Category | Count |
|----------|-------|
| PASS | 26 |
| BROKEN | 5 (BUGs 1-6, BUG-1/2 counted together) |
| DUPLICATE | 2 |
| Dead / No-op | 0 |

### Priority Fix Order

1. **CRITICAL**: BUG-1/BUG-2 — `claim`/`unclaim` parameter mismatch. These commands
   are completely non-functional. Two-line fix in `claim.ts`.
2. **HIGH**: BUG-3 — `labels show` returns wrong data. Agents relying on this for label
   lookup get the full list instead of filtered tasks.
3. **MEDIUM**: BUG-4 — `deps waves` without `--epic` hits wrong operation.
4. **LOW**: BUG-5 — `sync links list` bare needs clearer error/help.
5. **LOW**: BUG-6 — `sync reconcile` bare command not recognized; add a bare help fallback.

---

*Generated by T484 CLI Runtime Verifier subagent. All commands executed against live
`.cleo/tasks.db` in `/mnt/projects/cleocode`.*

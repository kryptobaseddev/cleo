# T484 Pipeline Domain CLI Verification Report

**Date**: 2026-04-10
**CLEO version**: v2026.4.25
**Scope**: All pipeline-domain CLI commands (lifecycle, phase/phases/pipeline, release, research, chain)

---

## Summary Table

| Command | Exit | Status | Notes |
|---------|------|--------|-------|
| `cleo lifecycle status` | 1 | FAIL | `status` is not a valid subcommand |
| `cleo lifecycle validate` | 1 | FAIL | `validate` is not a valid subcommand |
| `cleo lifecycle history --help` | 0 | OK | Valid, shows correct usage |
| `cleo lifecycle record --help` | 0 | FALSE OK | `record` is not a valid subcommand; falls through to help with exit 0 |
| `cleo lifecycle skip --help` | 0 | OK | Valid |
| `cleo lifecycle reset --help` | 0 | OK | Valid |
| `cleo lifecycle guidance --help` | 0 | OK | Valid |
| `cleo lifecycle gate-record --help` | 0 | OK | Valid |
| `cleo phase list` | 0 | OK | Routes to `pipeline.phase.list` |
| `cleo phase show --help` | 0 | OK | Valid |
| `cleo phases list` | 0 | OK | Routes to `pipeline.phase.list` (same as `cleo phase list`) |
| `cleo phases stats` | 0 | SUSPECT | Routes to `pipeline.phase.list`, not a distinct stats operation |
| `cleo release list` | 0 | OK | Returns data with two releases |
| `cleo release show --help` | 0 | OK | Valid |
| `cleo release ship --help` | 0 | OK | Valid |
| `cleo release rollback --help` | 0 | OK | Valid |
| `cleo release cancel --help` | 0 | OK | Valid |
| `cleo release channel` | 0 | OK | Returns channel info |
| `cleo research list` | 0 | OK | Returns empty manifest |
| `cleo research stats` | 0 | OK | Returns zero stats |
| `cleo research find "test"` | 1 | FAIL | `find` is not a valid subcommand for research |
| `cleo research add --help` | 0 | OK | Valid |
| `cleo chain list` | 1 | FAIL | `chain` is not a registered top-level command |
| `cleo chain show --help` | 1 | FAIL | `chain` is not a registered top-level command |
| `cleo chain add --help` | 1 | FAIL | `chain` is not a registered top-level command |
| `cleo chain instantiate --help` | 1 | FAIL | `chain` is not a registered top-level command |
| `cleo chain advance --help` | 1 | FAIL | `chain` is not a registered top-level command |

---

## Failures

### 1. `cleo lifecycle status` — NONEXISTENT SUBCOMMAND (exit 1)

`lifecycle` valid subcommands: `show`, `start`, `complete`, `skip`, `gate`, `guidance`, `history`, `reset`, `gate-record`.

`status` does not exist. Likely intended alias for `show`. **Callers using `lifecycle status` get exit 1 and no data.**

### 2. `cleo lifecycle validate` — NONEXISTENT SUBCOMMAND (exit 1)

`validate` is not a subcommand of `lifecycle`. **Callers get exit 1.**

### 3. `cleo lifecycle record` — SILENT FALSE-OK (exit 0)

`record` is not a valid subcommand. However, the CLI falls through to showing the help screen and exits with **0**, not 1. This is a silent failure — callers that check only exit code will incorrectly believe the call succeeded. The valid equivalent is `lifecycle gate-record`.

### 4. `cleo research find` — NONEXISTENT SUBCOMMAND (exit 1)

`research` valid subcommands: `add`, `show`, `list`, `pending`, `link`, `update`, `stats`, `links`, `archive`, `manifest`.

`find` is not registered. Callers attempting `cleo research find "query"` get exit 1. The correct approach is `cleo research list` with a filter, or `cleo find` for tasks.

### 5. `cleo chain *` — COMMAND DOES NOT EXIST (exit 1)

`chain` is not a registered top-level command. All five variants (`list`, `show`, `add`, `instantiate`, `advance`) return "Unknown command chain" with exit 1. This entire command group is absent from the CLI.

---

## Duplicates and Overlaps

### `cleo phase` vs `cleo pipeline` — CONFIRMED ALIAS

`cleo pipeline` is a registered alias for `cleo phase`. The help output is byte-for-byte identical (confirmed via `diff`). Both route to `pipeline.phase.*` operations. The alias is intentional and declared in the main help as `phase (pipeline)`. No behavioral divergence.

**Verdict**: benign alias, not a bug. Documentation should make this explicit.

### `cleo phase list` vs `cleo phases list` — FUNCTIONALLY IDENTICAL

Both commands return the same JSON, the same `meta.operation` (`pipeline.phase.list`), and the same data shape. The routing is identical.

However, `cleo phase` and `cleo phases` are **separate top-level commands** with different subcommand sets:

| Command | Subcommands |
|---------|-------------|
| `cleo phase` | `show`, `list`, `set`, `start`, `complete`, `advance`, `rename`, `delete` |
| `cleo phases` | `list`, `show`, `stats` |

`cleo phases` appears to be a **read-only view layer** over the same data (progress bars, statistics). However, `cleo phases stats` routes to `pipeline.phase.list` rather than a distinct stats operation — this is suspect. Either `phases stats` is unimplemented (delegating to list as a fallback) or it is a routing bug.

### `cleo lifecycle` vs `cleo pipeline/phase` — DIFFERENT DOMAINS, NO OVERLAP

These are distinct:

- `cleo lifecycle` — RCASD-IVTR+C stage tracking **per epic** (research, consensus, spec, decomposition, implementation, validation, testing, release, contribution). Epic-scoped, tracks who did what stage.
- `cleo phase` / `cleo pipeline` — Project-level **development phases** (e.g., "Alpha", "Beta"). Project-scoped milestones with task assignment.

No behavioral overlap. The word "pipeline" appearing in `meta.operation` strings for `phase` commands (`pipeline.phase.*`) is an internal namespace convention, not a surface-level alias relationship.

---

## Findings by Category

### Missing / Ghost Commands (documented or expected but absent)

| Command | Disposition |
|---------|-------------|
| `cleo chain *` | Entirely absent — not registered as a command |
| `cleo lifecycle status` | Not a subcommand; nearest equivalent is `lifecycle show` |
| `cleo lifecycle validate` | Not a subcommand; no equivalent found |
| `cleo lifecycle record` | Not a subcommand; nearest equivalent is `lifecycle gate-record` |
| `cleo research find` | Not a subcommand; use `cleo research list` instead |

### Exit Code Anomalies

| Command | Expected | Actual | Risk |
|---------|----------|--------|------|
| `cleo lifecycle record --help` | 1 (unknown command) | 0 (help shown) | Callers may misread as success |

### Suspect Routing

| Command | Routed To | Expected |
|---------|-----------|----------|
| `cleo phases stats` | `pipeline.phase.list` | `pipeline.phase.stats` or distinct stats endpoint |

---

## Recommended Corrections

1. **Add `lifecycle status` as alias for `lifecycle show`** or document that `show` is the correct verb.
2. **Fix `lifecycle record` exit code** — unknown subcommands should return exit 1, not 0, to avoid false-success masking.
3. **Clarify `lifecycle record` vs `lifecycle gate-record`** — if `record` was an old name, remove it; if it should exist, implement it.
4. **Add `lifecycle validate` or remove references to it** from any docs/skills that reference it.
5. **Implement `cleo chain` or remove references** — the command group is entirely absent. If planned, track it as a future feature; if abandoned, scrub documentation.
6. **Add `cleo research find`** — the top-level `cleo find` is for tasks; there is no equivalent fuzzy-search for research entries. Either add it to `research` or document that `cleo research list` is the fallback.
7. **Fix `cleo phases stats` routing** — it currently delegates to `pipeline.phase.list`. Either implement a distinct stats operation or remove `phases stats` and point users to `cleo stats`.
8. **Document `phase (pipeline)` alias explicitly** in the phases reference — the alias is correct but underdocumented, causing confusion about whether `pipeline` and `phase` are the same.

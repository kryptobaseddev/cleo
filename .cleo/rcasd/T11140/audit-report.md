# T11140: CLI Flag Shape Consistency Audit — `cleo docs` Subcommands

**Date:** 2026-05-27  
**Task:** T11140 (T10516-M1)  
**Scope:** All 26 `cleo docs` subcommands  
**Axes:** `--json` parity, `--output` parity, `--strict` parity, `--help` completeness

---

## Executive Summary

| Axis | Coverage | Gap |
|---|---|---|
| `--json` | 14/26 (54%) | 12 commands lack `--json` in help |
| `--output` | 5/26 (19%) | 21 commands lack `--output` — **critical gap** |
| `--strict` | 3/26 (12%) | Only add, update, sync; missing from supersede/remove/publish/import |
| `--help` quality | Mixed | 14 commands have minimal arg documentation; 16 lack examples |

**Root cause:** The `docsOutputArgs` shared constant (providing both `--json` and `--output`) is only spread into 4 subcommands (list, fetch, remove, rank). All other subcommands either define `--json` alone without `--output` (export, find, search, merge, rank, versions, publish, status, import) or define neither (supersede, generate, graph, publish-pr, sync, gap-check, schema, list-types, serve, open, stop, viewer-status).

---

## Full Audit Matrix

### Tier 1 — Fully Consistent (both flags + help quality)

| Subcommand | --json | --output | --strict | OutputSec | Examples | ArgsDocs |
|---|---|---|---|---|---|---|
| add | ✅ | ✅ | ✅ | no | no | yes |
| update | ✅ | ✅ | ✅ | ✅ | ✅ | yes |
| list | ✅ | ✅ | ❌ | ✅ | no | yes |
| fetch | ✅ | ✅ | ❌ | ✅ | no | yes |
| remove | ✅ | ✅ | ❌ | ✅ | no | yes |

### Tier 2 — Has --json but missing --output

| Subcommand | --json | --output | --strict | Issue |
|---|---|---|---|---|
| export | ✅ | ❌ | ❌ | Defined in code as `json: {type:'boolean'}` but no `--output` |
| find | ✅ | ❌ | ❌ | Same pattern — json only |
| search | ✅ | ❌ | ❌ | Same pattern — json only |
| merge | ✅ | ❌ | ❌ | Same pattern — json only |
| rank | ✅ | ❌ | ❌ | Has spread `...docsOutputArgs` but --output not showing in help |
| versions | ✅ | ❌ | ❌ | json only |
| publish | ✅ | ❌ | ❌ | json only |
| status | ✅ | ❌ | ❌ | json only, minimal help (228 chars) |
| import | ✅ | ❌ | ❌ | json in help but not in code args |

### Tier 3 — Missing both --json and --output

| Subcommand | --json | --output | --strict | Notes |
|---|---|---|---|---|
| supersede | ❌ | ❌ | ❌ | Only `--reason` flag; 505-char help |
| generate | ❌ | ❌ | ❌ | Only `--for`, `--attach`; 555-char help |
| graph | ❌ | ❌ | ❌ | Only `--root`, `--depth`, `--format`; 685-char help |
| publish-pr | ❌ | ❌ | ❌ | [DEPRECATED] — should still support output flags |
| sync | ❌ | ❌ | ✅ | Has `--strict` but no output flags! |
| gap-check | ❌ | ❌ | ❌ | Only `--epic`, `--task`; 182-char stub help |
| schema | ❌ | ❌ | ❌ | Only `--include-counts`; 445-char help |
| list-types | ❌ | ❌ | ❌ | Only `--counts`; 310-char help |
| serve | ❌ | ❌ | ❌ | Only port/server flags; 518-char help |
| open | ❌ | ❌ | ❌ | No args at all; 469-char help |
| stop | ❌ | ❌ | ❌ | Only `--timeout`; 178-char help |
| viewer-status | ❌ | ❌ | ❌ | No args at all; **91-char stub** (just USAGE line) |

---

## --strict Coverage

Only 3 commands define `--strict`:

| Subcommand | Code | Help | Notes |
|---|---|---|---|
| add | ✅ | ✅ | Enforces body-schema requiredSections |
| update | ✅ | ✅ | Fails body-schema diagnostics instead of warning |
| sync | ✅ | ✅ | T4551 gap-check context |

**Missing from mutating commands that should have it:**
- `supersede` — mutates lifecycle_status, links rows
- `remove` — purges blob files when refCount=0
- `publish` — writes to git-tracked file paths
- `publish-pr` — opens/updates GitHub PRs
- `import` — imports .md files into SSoT
- `merge` — merges doc content

---

## --help Quality Assessment

### Critical gaps

| Issue | Affected Commands | Count |
|---|---|---|
| No examples | add, list, fetch, remove, supersede, generate, export, find, search, merge, graph, rank, versions, publish, gap-check, schema, list-types, serve, stop, viewer-status | **20** |
| No "Output flags" section | supersede, generate, export, find, search, merge, graph, rank, versions, publish, publish-pr, sync, status, gap-check, import, schema, list-types, serve, open, stop, viewer-status | **21** |
| Minimal arg docs (< 1000 chars) | supersede, generate, graph, rank, versions, publish, status, gap-check, schema, list-types, serve, stop, viewer-status | **13** |
| No arg documentation at all | viewer-status | **1** |

### Exemplary help (gold standard)
- **add** (4915 chars): Positional + named args, validation behaviors, examples
- **update** (4270 chars): Full arg docs, output flags section, examples, renderer note
- **list** (2314 chars): Output flags section, scope filters documented

---

## Recommendations

### P0 — Add --output to all JSON-emitting commands
Every command that produces output should support `--output envelope|id|table|count|silent`. Use `...docsOutputArgs` spread consistently across all 26 subcommands. This is a one-line change per subcommand that immediately gives both `--json` and `--output`.

### P1 — Standardize output flags section in --help
Add the shared `docsOutputFlagHelp` string to the help text of all subcommands. Current pattern in add/update shows the right approach.

### P2 — Add --strict to all mutating commands
Extend `--strict` to: supersede, remove, publish, publish-pr, import, merge. Standardize semantics: when `--strict` is set, schema/validation failures become hard errors instead of warnings.

### P3 — Improve help quality for stub commands
For viewer-subcommands (serve/open/stop/viewer-status), utility commands (schema/list-types), and legacy commands (gap-check, sync): add structured arg docs, output flags, and at least one example.

### P4 — viewer-status needs any documentation at all
At 91 characters, `cleo docs viewer-status --help` outputs only a USAGE line with no args or description. This is a stub that needs completion.

---

## Code-Level Discrepancies

Commands where code defines flags not shown in help:

| Command | Code has | Help shows | Gap |
|---|---|---|---|
| rank | json + spread(docsOutputArgs) | json only | --output code-defined but not in help |
| import | No json/output in code | YES for json | Help claims --json but code doesn't define it |

`import` command: help text says "Output flags: --json and --output envelope|id|table|count|silent are accepted consistently" but the actual `args` block does not include json or output properties — these are likely injected by the cliOutput renderer rather than citty arg parsing.

---

## Verification

```bash
# Re-run audit to verify
for sub in add update list fetch remove supersede generate export find search merge graph rank versions publish publish-pr sync status gap-check import schema list-types serve open stop viewer-status; do
  echo "=== $sub ==="
  cleo docs "$sub" --help 2>&1 | grep -c '\-\-json\|\-\-output\|\-\-strict'
done
```

# T11178: Flag Shape Audit — Doc CLI Commands

**Date**: 2026-05-27
**Auditor**: Hermes Prime (kanban-worker)
**Scope**: All 26 `cleo docs` subcommands
**Dimensions**: `--json`, `--output`, `--strict` parity and help completeness

---

## Summary

| Tier | Count | Commands |
|------|-------|----------|
| Full parity (--json + --output) | 4 | add, update, list, fetch, remove |
| Partial (--json only) | 9 | export, find, import, merge, publish, rank, search, status, versions |
| Missing both | 12 | gap-check, generate, graph, list-types, open, publish-pr, schema, serve, stop, supersede, viewer-status |
| Has --strict | 3 | add, update, sync |
| Missing --strict where applicable | many | Several data-mutating commands lack --strict |

## Detailed Per-Command Analysis

### Tier 1: Full Parity ✓

| Command | --json | --output | --strict | Notes |
|---------|--------|----------|----------|-------|
| add | ✓ | ✓ | ✓ | Gold standard. Help complete with validation behaviors section. |
| update | ✓ | ✓ | ✓ | Help includes examples section. Well-structured. |
| list | ✓ | ✓ | ✗ | Clean. Has "Output flags" line in help prose. |
| fetch | ✓ | ✓ | ✗ | Clean. Has "Output flags" line in help prose. |
| remove | ✓ | ✓ | ✗ | Clean. Has "Output flags" line in help prose. |

### Tier 2: Has --json, Missing --output

| Command | --json | --output | --strict | Issue |
|---------|--------|----------|----------|-------|
| export | ✓ | ✗ | ✗ | --json toggle but no --output mode. Has --out for file path (not output mode). |
| find | ✓ | ✗ | ✗ | --json present as "Emit LAFS JSON envelope (default for non-TTY)" |
| import | ✓ | ✗ | ✗ | Has --json and --dry-run. No --output mode. |
| merge | ✓ | ✗ | ✗ | --json present. No --output mode. Also has --out for file path. |
| publish | ✓ | ✗ | ✗ | --json present. Has --for and --to instead. |
| rank | ✓ | ✗ | ✗ | --json present. No --output. |
| search | ✓ | ✗ | ✗ | --json present. Also has --owner/--type/--limit. |
| status | ✓ | ✗ | ✗ | --json present. Exit code 0/2 for in-sync/drift. |
| versions | ✓ | ✗ | ✗ | --json present. Also has --name filter. |

### Tier 3: Missing Both --json and --output

| Command | Issue | Severity | Notes |
|---------|-------|----------|-------|
| gap-check | No --json, no --output | MEDIUM | Validator; JSON output useful for CI integration |
| generate | No --json, no --output | HIGH | Produces llms.txt; should support JSON envelope for programmatic consumption |
| graph | No --json, no --output | HIGH | Produces provenance graph; DOT/JSON output but no envelope control |
| list-types | No --json, no --output | MEDIUM | Read-only listing; JSON would benefit automation |
| open | No --json, no --output | LOW | Browser-launch command; operational side-effect |
| publish-pr | No --json, no --output | HIGH | Creates PRs; needs JSON output for CI/automation |
| schema | No --json, no --output | HIGH | Emits registry data; "Emit the canonical doc-kind taxonomy registry as a LAFS envelope" — yet no --json flag documented in help |
| serve | No --json, no --output | LOW | Server lifecycle; operational |
| stop | No --json, no --output | LOW | Server lifecycle; operational |
| supersede | No --json, no --output | HIGH | Mutates attachment state; needs JSON for programmatic use |
| sync | No --json, no --output | HIGH | Bidirectional sync; already has --strict but no JSON output for CI |
| viewer-status | No --json, no --output | MEDIUM | Reports viewer state; JSON useful for monitoring |

### --strict Coverage

| Command | Has --strict? | Should have? | Notes |
|---------|---------------|--------------|-------|
| add | ✓ | ✓ | Schema enforcement on doc body |
| update | ✓ | ✓ | Body-schema diagnostics enforcement |
| sync | ✓ | ✓ | Legacy mode: exit-with-error on drift |
| remove | ✗ | LOW | Simple unlink operation |
| supersede | ✗ | MEDIUM | State mutation; could enforce lifecycle rules strictly |
| publish | ✗ | LOW | Atomic file write; well-defined success/failure |
| publish-pr | ✗ | LOW | PR-based; GitHub controls strictness |
| import | ✗ | MEDIUM | Could enforce type auto-classification strictly |
| gap-check | ✗ | LOW | Already validates |

### Help Completeness Issues

| Issue | Commands Affected |
|-------|-------------------|
| No description of command purpose | gap-check (minimal) |
| No examples section | Most commands except add, update |
| No exit code documentation | Most commands except status |
| Validation behavior section | Only add has this |
| Non-standard help format | publish-pr (flat list vs structured) |

## Recommendations

### High Priority (data-producing commands)

1. **add --output to**: export, find, import, merge, publish, rank, search, status, versions
2. **add --json + --output to**: generate, graph, list-types, publish-pr, schema, supersede, sync
3. **Consider --json for operational commands**: open, serve, stop, viewer-status (lower priority but consistency)

### Medium Priority

4. **add --strict where appropriate**: supersede, import
5. **Standardize help format**: Add examples section, exit codes, and validation behaviors consistently
6. **Add --json to**: gap-check (CI integration value)

### Low Priority

7. **Operational commands** (serve, open, stop, viewer-status): --json is optional but would complete consistency

## Consistency Model

The canonical flag set for a `cleo docs` subcommand should be:

```
--json       Emit LAFS JSON envelope (global output flag)
--output     Output mode: envelope|id|table|count|silent (global output flag)
--strict     Enforce strict validation where applicable (command-specific)
```

Only `add`, `update`, and `list`/`fetch`/`remove` achieve this standard. 21 of 26 commands (81%) have at least one flag gap.

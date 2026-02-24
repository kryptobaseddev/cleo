# CLEO Bash CLI Deprecation Plan

**Task**: T4472
**Epic**: T4454
**Date**: 2026-02-14
**Status**: complete

---

## Summary

This document defines the deprecation timeline for the CLEO Bash CLI in favor of the TypeScript CLI (V2). The transition follows a phased approach with a 60-day parallel run period, feature flags for gradual rollout, and documented rollback procedures.

---

## Timeline

### Phase 1: Parallel Run (Day 0 - Day 60)

**Both CLIs available simultaneously.**

| Milestone | Action |
|-----------|--------|
| Day 0 | V2 TypeScript CLI released as `cleo` (default) |
| Day 0 | Bash CLI available as `cleo-v1` (alias) |
| Day 0 | Feature flag `CLEO_USE_V1=1` routes `cleo` back to Bash |
| Day 14 | First stability checkpoint - review error reports |
| Day 30 | Second stability checkpoint - collect migration feedback |
| Day 45 | Deprecation warning added to `cleo-v1` on every invocation |
| Day 60 | Parallel run ends |

### Phase 2: Maintenance Mode (Day 61 - Day 120)

**Bash CLI receives critical fixes only.**

| Milestone | Action |
|-----------|--------|
| Day 61 | `cleo-v1` enters maintenance mode |
| Day 61 | `CLEO_USE_V1` flag still works but logs a warning |
| Day 90 | Final maintenance release for Bash CLI |
| Day 120 | Maintenance period ends |

### Phase 3: End of Life (Day 121+)

**Bash CLI no longer supported.**

| Milestone | Action |
|-----------|--------|
| Day 121 | `cleo-v1` alias removed from installation |
| Day 121 | `CLEO_USE_V1` flag no longer recognized |
| Day 121 | Bash CLI scripts remain in repository `archive/` directory |
| Day 180 | Archived scripts removed from main branch |

---

## Feature Flags

### CLEO_USE_V1

Routes all `cleo` invocations to the Bash CLI during the parallel run period.

```bash
# Use Bash CLI temporarily
export CLEO_USE_V1=1
cleo add "Task"  # Routes to Bash CLI

# Use TypeScript CLI (default)
unset CLEO_USE_V1
cleo add "Task"  # Routes to TypeScript CLI
```

**Scope**: Per-session (environment variable).

**Availability**: Phase 1 and Phase 2 only. Removed in Phase 3.

### CLEO_V2_STRICT

Enables strict LAFS validation on all V2 output during the parallel run.

```bash
export CLEO_V2_STRICT=1  # Validate every response against LAFS schema
```

**Use case**: CI pipelines and automated testing during migration.

---

## Rollback Procedures

### Per-Command Rollback

If a specific V2 command fails, invoke the Bash CLI directly:

```bash
# Direct invocation of Bash CLI script
bash /path/to/cleo/scripts/add.sh "Task title" --description "..."
```

### Full Rollback

If V2 has critical issues, revert the entire installation:

```bash
# Option 1: Feature flag (recommended during parallel run)
export CLEO_USE_V1=1

# Option 2: Reinstall Bash CLI as default
./install.sh --use-bash

# Option 3: Point ct alias to Bash
alias ct='/path/to/cleo/scripts/cleo.sh'
```

### Data Rollback

V2 uses the same data files (`.cleo/todo.json`, etc.) as the Bash CLI. If V2 corrupts data:

```bash
# Restore from operational backup
ct restore --latest

# Or restore from a specific backup
ls .cleo/backups/operational/
cp .cleo/backups/operational/todo.json.3 .cleo/todo.json
```

Both CLIs read/write the same data format. No data conversion is needed for rollback.

---

## Migration Checklist

### For Users

- [ ] Verify Node.js 20+ is installed
- [ ] Run `ct migrate` to ensure data files are at latest schema version
- [ ] Test critical workflows: add, complete, list, session start/end
- [ ] Update any scripts that parse CLI output to use LAFS envelope format
- [ ] Update any CI pipelines that depend on exit codes or output format

### For Script Maintainers

- [ ] Replace `._meta.command` references with LAFS `success`/`data` structure
- [ ] Replace `$schema` field checks (no longer present)
- [ ] Update error handling: `error.exitCode` becomes `error.code`
- [ ] Update error handling: `error.code` (string) becomes `error.name`
- [ ] Test with `CLEO_V2_STRICT=1` to validate LAFS compliance

### For CI/CD Pipelines

- [ ] Update pipeline scripts for new output format
- [ ] Add `CLEO_V2_STRICT=1` to catch output regressions
- [ ] Verify exit codes still match expected values (exit code numbers are unchanged)
- [ ] Run validation: `ct --validate` in CI

---

## What Is NOT Changing

- **Data format**: `.cleo/todo.json` and other data files remain the same
- **Exit codes**: Numeric exit codes are preserved (0, 1-22, 60-67, 100+)
- **Command names**: All commands keep the same names and flags
- **CLI alias**: `ct` continues to work
- **Schema files**: `schemas/*.schema.json` are unchanged
- **Task hierarchy**: Epic > Task > Subtask model is preserved
- **Session protocol**: Same session lifecycle with scopes and focus

---

## Support Channels

During the parallel run period:

- **Bug reports**: `ct issue bug --title "V2: ..." --body "..."`
- **Migration help**: `docs/guides/v2-migration-guide.md`
- **API reference**: `docs/api/v2-api-reference.md`

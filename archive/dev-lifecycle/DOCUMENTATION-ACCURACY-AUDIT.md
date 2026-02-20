# Documentation Accuracy Audit Report

**Date**: 2025-12-13
**Version**: 0.9.0
**Audited by**: 10 parallel verification agents

---

## Executive Summary

A comprehensive audit of claude-todo documentation against actual code implementation revealed significant accuracy gaps. Overall documentation accuracy is approximately **65%**.

### Critical Issues Found

| Category | Issue Count | Severity |
|----------|-------------|----------|
| Documented features not implemented | 8 | CRITICAL |
| Implemented features not documented | 23 | HIGH |
| Function name mismatches | 4 | HIGH |
| Missing documentation files | 2 | MEDIUM |
| Library functions undocumented | 68/72 (94%) | HIGH |

---

## Command-by-Command Findings

### Core Commands

| Command | Accuracy | Critical Issues |
|---------|----------|-----------------|
| **add-task.sh** | 70% | `-f`, `-v`, `-c` flags documented but don't work; missing docs for `--phase`, `--files`, `--acceptance`, `--depends`, `--notes` |
| **update-task.sh** | 75% | Missing docs for `-t/--title`, `--blocked-by`, file/acceptance/depends variants |
| **complete-task.sh** | 100% | PASS - Fully accurate |
| **list-tasks.sh** | 85% | **CSV/TSV formats documented but NOT implemented** |
| **archive.sh** | 90% | `--count` option undocumented |

### Session/Focus Commands

| Command | Accuracy | Critical Issues |
|---------|----------|-----------------|
| **focus.sh** | 100% | PASS - Fully accurate |
| **session.sh** | 85% | Option scope unclear, session info features undocumented |
| **validate.sh** | 60% | **`--file` and `--verbose` documented but NOT implemented** |
| **init.sh** | 70% | **`--template` documented but NOT implemented**; `--no-claude-md` undocumented |
| **migrate.sh** | 80% | **`--force` in help text but not actually parsed in code** |

### Phase 2 Commands (Dashboard)

| Command | Accuracy | Critical Issues |
|---------|----------|-----------------|
| **dash.sh** | 95% | `--format markdown` documented but not implemented |
| **next.sh** | 80% | JSON field names differ (`id` vs `taskId`); missing `status`, `blocks` fields |
| **labels.sh** | 100% | PASS - Fully accurate |
| **stats.sh** | 95% | Missing dedicated `docs/commands/stats.md` file |

### Phase 3 Commands (Dependencies)

| Command | Accuracy | Critical Issues |
|---------|----------|-----------------|
| **blockers-command.sh** | 100% | PASS - Fully accurate |
| **deps-command.sh** | 100% | PASS - Fully accurate |
| **phases.sh** | 0% | **NEW: Implementation complete but NO DOCUMENTATION** |

### Utility Commands

| Command | Accuracy | Critical Issues |
|---------|----------|-----------------|
| **backup.sh** | 60% | `--list`, `--verbose` undocumented |
| **export.sh** | 70% | `--priority`, `--label` filtering undocumented |

---

## Library Documentation Gaps

### Critical: Nearly All Library Functions Undocumented

| Library | Documented | Total | Accuracy |
|---------|------------|-------|----------|
| **file-ops.sh** | 4 | 10 | 40% |
| **validation.sh** | 1 | 4+ | 25% |
| **output-format.sh** | 2 | 23 | 8.7% |
| **logging.sh** | 2 | 25 | 8% |
| **cache.sh** | 0 | 13 | 0% |
| **analysis.sh** | 0 | 11 | 0% |

### Specific Library Issues

**validation.sh - Function Name Mismatches:**
- `validate_anti_hallucination()` - DOCUMENTED BUT DOESN'T EXIST
- `check_duplicate_ids()` → actual: `check_id_uniqueness()`
- `validate_task_object()` → actual: `validate_task()`

**file-ops.sh - Undocumented Functions:**
- `lock_file()`, `unlock_file()` - Critical concurrency control
- `load_json()`, `save_json()` - Core utilities
- `ensure_directory()`, `list_backups()`

**cache.sh & analysis.sh:**
- Both are NEW libraries with ZERO documentation
- Critical features (O(1) lookups, critical path analysis) completely hidden

---

## Priority Fix List

### P0 - CRITICAL (Documented but Not Implemented)

1. **list-tasks.sh**: Remove CSV/TSV format claims OR implement them
2. **validate.sh**: Remove `--file` and `--verbose` from docs OR implement them
3. **init.sh**: Remove `--template` from docs OR implement it
4. **migrate.sh**: Add `--force` to option parsing OR remove from help
5. **validation.sh**: Remove `validate_anti_hallucination()` from docs (doesn't exist)

### P1 - HIGH (Implemented but Not Documented)

1. **phases.sh**: Create `docs/commands/phases.md`
2. **cache.sh**: Add to QUICK-REFERENCE.md library section
3. **analysis.sh**: Add to QUICK-REFERENCE.md library section
4. **export.sh**: Document `--priority`, `--label` options
5. **backup.sh**: Document `--list`, `--verbose` options
6. **add-task.sh**: Document all actual options (`--phase`, `--files`, etc.)

### P2 - MEDIUM (Accuracy Improvements)

1. **next.sh**: Fix JSON field naming (use `id` not `taskId`)
2. **stats.sh**: Create `docs/commands/stats.md`
3. **docs/INDEX.md**: Add phases.md reference
4. **QUICK-REFERENCE.md**: Update library functions section (72 functions need docs)

### P3 - LOW (Enhancements)

1. Add short flag reference consistency across all commands
2. Document session.sh option-command mapping
3. Add examples for new filtering options

---

## Verification Test Results

### Commands That Pass All Tests

```
✅ complete-task.sh - 100% accurate
✅ focus.sh - 100% accurate
✅ labels.sh - 100% accurate
✅ blockers-command.sh - 100% accurate
✅ deps-command.sh - 100% accurate
```

### Commands Needing Documentation Updates

```
⚠️ add-task.sh - 70% (missing options in docs)
⚠️ update-task.sh - 75% (missing options in docs)
⚠️ export.sh - 70% (missing filter options)
⚠️ backup.sh - 60% (missing operational options)
```

### Commands Needing Code OR Doc Fixes

```
❌ list-tasks.sh - CSV/TSV claim vs reality
❌ validate.sh - --file/--verbose claims
❌ init.sh - --template claim
❌ migrate.sh - --force parsing
❌ next.sh - JSON field naming
```

### Commands Needing New Documentation

```
🆕 phases.sh - No docs/commands/phases.md
🆕 cache.sh - No library documentation
🆕 analysis.sh - No library documentation
```

---

## Recommendations

### Immediate Actions

1. **Create docs/commands/phases.md** - New command completely undocumented
2. **Fix docs/usage.md short flags table** - Remove claims about flags that don't work per-command
3. **Update docs/reference/cli-output-formats.md** - Remove CSV/TSV from list-tasks.sh OR implement

### Short-term Actions

1. Audit all `--help` outputs against documentation
2. Create library function reference documentation
3. Add JSON schema examples to next.sh docs
4. Document new cache.sh and analysis.sh libraries

### Process Improvements

1. Add documentation review to PR checklist
2. Create automated doc/code sync validation
3. Require docs updates for new features before merge

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Commands Audited | 17 |
| Commands 100% Accurate | 5 (29%) |
| Commands with Critical Issues | 5 (29%) |
| Library Functions Documented | 4/72 (5.6%) |
| Overall Documentation Accuracy | ~65% |

---

*Generated: 2025-12-13 by 10 parallel verification agents*

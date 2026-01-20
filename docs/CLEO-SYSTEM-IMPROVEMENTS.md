# CLEO System Improvements Analysis

**Version**: 1.0.0
**Status**: INTERNAL
**Created**: 2026-01-20
**Purpose**: Identify gaps, inconsistencies, and enhancement opportunities

---

## Overview

This document catalogs areas requiring attention across the CLEO + Orchestrator Protocol system. Items are organized by category with severity ratings.

**Severity Levels**:
- **P0**: Breaking/Critical - System doesn't work as documented
- **P1**: Major Gap - Missing critical functionality
- **P2**: Enhancement - Would improve system significantly
- **P3**: Polish - Nice-to-have refinements

---

## 1. Documentation Gaps

### 1.1 Library Files Status (VALIDATED 2026-01-20)

| Item | Status | Severity | Notes |
|------|--------|----------|-------|
| `lib/token-inject.sh` | ✓ EXISTS | P2 | Needs integration test coverage |
| `lib/skill-dispatch.sh` | ✓ EXISTS | P2 | Needs integration test coverage |
| `lib/skill-validate.sh` | ✓ EXISTS | P2 | Needs integration test coverage |
| `lib/orchestrator-spawn.sh` | ✓ EXISTS | P2 | Needs integration test coverage |
| `lib/subagent-inject.sh` | ✓ EXISTS | P2 | Needs integration test coverage |

**Note**: All orchestrator libraries exist. Priority is now integration testing, not creation.

### 1.2 Documentation Drift

| Document | Issue | Severity |
|----------|-------|----------|
| INDEX.md | References non-existent files (PHASE-3-FEATURES.md, TASK-COMPLETION-PHILOSOPHY.md) | P2 |
| Multiple orchestrator docs | Overlapping content between VISION, PROTOCOL, SPEC | P3 |
| Skill READMEs | Inconsistent format across skills | P3 |

### 1.3 Missing Documentation

| Topic | Severity | Notes |
|-------|----------|-------|
| Token injection tutorial | P2 | How to create prompts with tokens |
| Skill creation guide (complete) | P2 | ct-skill-creator exists but could be more comprehensive |
| Manifest recovery procedures | P2 | What to do when MANIFEST.jsonl is corrupted |
| Multi-session debugging guide | P3 | Troubleshooting session conflicts |

---

## 2. Implementation Gaps

### 2.1 Token Injection System (lib/token-inject.sh EXISTS)

| Issue | Description | Severity |
|-------|-------------|----------|
| ~~Verification of lib/token-inject.sh~~ | ✓ File exists with 8 exported functions | ~~P1~~ DONE |
| placeholders.json completeness | Verify all documented tokens are defined | P2 |
| Token validation on spawn | May not validate required tokens before spawn | P2 |
| Error handling for missing tokens | Unclear behavior when tokens undefined | P2 |

**Recommended Actions**:
1. ~~Audit `lib/token-inject.sh` for documented functions~~ ✓ EXISTS
2. Create comprehensive test suite for token injection
3. Add validation step to spawning workflow

### 2.2 Skill Dispatch System (lib/skill-dispatch.sh EXISTS)

| Issue | Description | Severity |
|-------|-------------|----------|
| ~~Verification of lib/skill-dispatch.sh~~ | ✓ File exists with three-tier dispatch | ~~P1~~ DONE |
| Dispatch trigger consistency | Some skills may have inconsistent trigger definitions | P2 |
| Fallback handling | Need to verify ct-task-executor fallback works | P2 |
| Debug mode documentation | SKILL_DISPATCH_DEBUG env var undocumented | P3 |

**Recommended Actions**:
1. ~~Audit `lib/skill-dispatch.sh` against documented functions~~ ✓ EXISTS
2. Create dispatch decision tests
3. Document debug mode in skill development guide

### 2.3 Context Monitoring

| Issue | Description | Severity |
|-------|-------------|----------|
| Context state file per session | Unclear if `.context-state-{sessionId}.json` implemented | P2 |
| Alert suppression logic | May not correctly suppress repeat alerts | P3 |
| Stale data handling | Exit code 54 handling unclear | P3 |

**Recommended Actions**:
1. Verify context state isolation per session
2. Add integration tests for alert suppression
3. Document stale data recovery procedures

---

## 3. Protocol Inconsistencies

### 3.1 Subagent Return Messages

| Issue | Description | Severity |
|-------|-------------|----------|
| Inconsistent return message text | Some skills say "Research complete", others "Task complete" | P2 |
| Partial/blocked return messages | Different from complete message but not standardized | P2 |
| Protocol enforcement | No runtime validation of return message compliance | P3 |

**Recommended Standard**:
```
Complete:  "Research complete. See MANIFEST.jsonl for summary."
Partial:   "Research partial. See MANIFEST.jsonl for details."
Blocked:   "Research blocked. See MANIFEST.jsonl for blocker details."
```

### 3.2 Manifest Entry Format

| Issue | Description | Severity |
|-------|-------------|----------|
| `linked_tasks` vs `needs_followup` confusion | Similar purposes, unclear when to use which | P2 |
| Status enum inconsistency | Some docs show "archived", others don't | P3 |
| timestamp vs date fields | Both documented but not clear when to use which | P3 |

**Recommended Actions**:
1. Create canonical manifest schema JSON file
2. Add manifest validation to CLI
3. Document field purposes clearly

### 3.3 ORC vs CTX Constraints

| Issue | Description | Severity |
|-------|-------------|----------|
| Overlap between ORC-003 and CTX-001 | Both about not reading full files | P3 |
| CTX rules not in ORCHESTRATOR-PROTOCOL-SPEC.md | Documented separately | P3 |
| Enforcement mechanisms unclear | How are these rules actually enforced? | P2 |

**Recommended Actions**:
1. Consolidate constraint documentation
2. Add enforcement section to spec
3. Consider automated constraint checking

---

## 4. CLI Gaps

### 4.1 Missing Commands (Documented but Unclear Implementation)

| Command | Status | Severity |
|---------|--------|----------|
| `cleo orchestrator spawn` | Documented, implementation status unclear | P1 |
| `cleo orchestrator start` | Documented, implementation status unclear | P1 |
| `cleo orchestrator validate` | Documented, implementation status unclear | P1 |
| `cleo orchestrator next` | Documented, implementation status unclear | P2 |
| `cleo orchestrator analyze` | Documented, implementation status unclear | P2 |

**Recommended Actions**:
1. Audit `scripts/orchestrator.sh` for all documented subcommands
2. Add missing subcommands if not present
3. Create integration tests for orchestrator commands

### 4.2 Research Command Completeness

| Subcommand | Status | Notes |
|------------|--------|-------|
| `cleo research init` | Likely implemented | Documented |
| `cleo research list` | Likely implemented | Documented |
| `cleo research show` | Likely implemented | Documented |
| `cleo research pending` | Unclear | Documented but needs verification |
| `cleo research get` | Unclear | Documented but needs verification |
| `cleo research inject` | Unclear | Documented but needs verification |

### 4.3 Session Command Edge Cases

| Issue | Description | Severity |
|-------|-------------|----------|
| `session start` without `--focus` or `--auto-focus` | Error E_FOCUS_REQUIRED, but behavior unclear | P2 |
| `session close` with incomplete tasks | Should fail with E_SESSION_CLOSE_BLOCKED | P2 |
| `session resume --last` with multiple active | Which session is "last"? | P3 |

---

## 5. Schema Gaps

### 5.1 Missing/Undefined Schemas

| Schema | Status | Severity |
|--------|--------|----------|
| `schemas/manifest.schema.json` | Not found | P1 |
| `schemas/skills-manifest.schema.json` | May exist (in git status) | P2 |
| Skill SKILL.md frontmatter schema | Not formally defined | P3 |

**Recommended Actions**:
1. Create `schemas/manifest.schema.json` with all fields
2. Create JSON Schema for skill manifest
3. Add validation to `cleo research` commands

### 5.2 Schema Inconsistencies

| Issue | Description | Severity |
|-------|-------------|----------|
| Verification gates naming | Schema uses `implemented`, docs sometimes say `implementation_complete` | P2 |
| Phase enum values | Inconsistent across schemas and docs | P2 |
| Session scope types | 6 types documented, schema may differ | P2 |

---

## 6. Testing Gaps

### 6.1 Missing Test Coverage

| Area | Coverage | Severity |
|------|----------|----------|
| Token injection library | Unknown | P1 |
| Skill dispatch logic | Unknown | P1 |
| Manifest operations (lib/research-manifest.sh) | Unknown | P2 |
| Multi-session conflict detection | Unknown | P2 |
| Context alert threshold crossing | Unknown | P3 |
| Verification gate auto-completion | Unknown | P2 |

### 6.2 Integration Test Gaps

| Scenario | Status | Severity |
|----------|--------|----------|
| Full orchestrator spawn workflow | Unclear | P1 |
| Session startup protocol | Unclear | P2 |
| Epic auto-complete with verification | Unclear | P2 |
| Manifest corruption recovery | Missing | P2 |

---

## 7. Architectural Improvements

### 7.1 Token Injection Enhancements

| Enhancement | Benefit | Severity |
|-------------|---------|----------|
| Token validation before spawn | Prevent runtime errors | P2 |
| Token preview mode | Debug prompt before spawning | P3 |
| Token inheritance from parent skill | Reduce duplication | P3 |

### 7.2 Skill System Enhancements

| Enhancement | Benefit | Severity |
|-------------|---------|----------|
| Skill versioning with compatibility | Handle skill upgrades | P2 |
| Skill composition (skill inherits skill) | Reduce duplication | P3 |
| Skill dependency declaration | Explicit shared resource requirements | P3 |

### 7.3 Manifest Enhancements

| Enhancement | Benefit | Severity |
|-------------|---------|----------|
| Manifest rotation/archival | Prevent unbounded growth | P2 |
| Manifest validation on append | Catch malformed entries | P2 |
| Manifest indexing for O(1) lookup | Performance for large manifests | P3 |
| Manifest compaction | Remove obsolete entries | P3 |

### 7.4 Session Enhancements

| Enhancement | Benefit | Severity |
|-------------|---------|----------|
| Session templates | Quick-start common patterns | P3 |
| Session timeout auto-suspend | Prevent stale active sessions | P3 |
| Session handoff notes | Better cross-agent continuity | P2 |

---

## 8. Cross-Cutting Concerns

### 8.1 Error Handling

| Issue | Description | Severity |
|-------|-------------|----------|
| Consistent error JSON format | Not all commands use same structure | P2 |
| Error recovery guidance | `error.fix` not always present | P2 |
| Exit code documentation | Some codes undocumented | P2 |

### 8.2 Logging and Audit

| Issue | Description | Severity |
|-------|-------------|----------|
| Subagent spawn logging | Not captured in todo-log.json | P2 |
| Context threshold crossings | Not logged | P3 |
| Manifest append logging | Not captured | P3 |

### 8.3 Configuration

| Issue | Description | Severity |
|-------|-------------|----------|
| Orchestrator-specific config section | Missing from config.schema.json | P2 |
| Skill dispatch config | Not configurable (priority order, fallback) | P3 |
| Token defaults config | Hardcoded, not configurable | P3 |

---

## 9. Priority Action Items

### Immediate (P0/P1) - VALIDATED 2026-01-20

1. ~~**Audit lib/token-inject.sh**~~ ✓ EXISTS (8 functions exported)
2. ~~**Audit lib/skill-dispatch.sh**~~ ✓ EXISTS (three-tier dispatch)
3. ~~**Audit scripts/orchestrator.sh**~~ ✓ EXISTS (10+ subcommands)
4. ~~**Create schemas/manifest.schema.json**~~ ✓ EXISTS as `schemas/research-manifest.schema.json` (T1672)
5. ~~**Create token injection tests**~~ ✓ 51 unit tests (T1826)

### Short-term (P2)

6. Standardize subagent return messages across all skills
7. ~~Create orchestrator spawn integration tests~~ ✓ 33 tests (T1829)
8. ~~Document manifest field semantics~~ ✓ Defined in schemas/research-manifest.schema.json
9. Add manifest validation to research commands
10. ~~Consolidate ORC/CTX constraint documentation~~ ✓ In ORCHESTRATOR-PROTOCOL-SPEC.md Part 2.1

### Medium-term (P3)

11. Create skill development tutorial
12. Add manifest rotation/archival
13. Implement skill versioning
14. Add session timeout auto-suspend
15. Create debugging guides for common issues

---

## 10. Verification Checklist

Use this checklist when implementing fixes:

### Library Verification (VALIDATED 2026-01-20)
- [x] lib/token-inject.sh exists and exports documented functions
- [x] lib/skill-dispatch.sh exists and exports documented functions
- [x] lib/skill-validate.sh exists and exports documented functions
- [x] lib/research-manifest.sh exports 16 documented functions
- [x] lib/context-alert.sh implements threshold crossing logic
- [x] lib/orchestrator-spawn.sh exists (consolidates spawn workflow)
- [x] lib/subagent-inject.sh exists (protocol injection)

### Schema Verification (VALIDATED 2026-01-20)
- [x] schemas/research-manifest.schema.json created with all fields (T1672)
- [x] schemas/skills-manifest.schema.json validated (v1.1.0)
- [ ] Verification gates naming consistent across schema and docs

### CLI Verification (VALIDATED 2026-01-20)
- [x] `cleo orchestrator spawn` implemented
- [x] `cleo orchestrator start` implemented
- [x] `cleo orchestrator validate` implemented
- [x] `cleo research pending` implemented
- [x] `cleo research inject` implemented

### Documentation Verification
- [ ] INDEX.md broken links fixed
- [ ] Subagent return message standardized across docs
- [ ] ORC/CTX constraints consolidated in spec

### Test Verification (VALIDATED 2026-01-20)
- [x] Token injection unit tests exist (51 tests in tests/unit/token-inject.bats)
- [x] Skill dispatch unit tests exist (52 tests in tests/unit/skill-dispatch.bats)
- [x] Orchestrator spawn integration tests exist (33 tests in tests/integration/orchestrator-spawn.bats)
- [ ] Session conflict detection tests exist

---

*This document should be reviewed after each major system update to track progress on improvements.*

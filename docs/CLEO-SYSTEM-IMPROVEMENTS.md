# CLEO System Improvements Analysis

**Version**: 1.1.0
**Status**: INTERNAL
**Created**: 2026-01-20
**Updated**: 2026-01-20 (T1835 Epic Completion)
**Purpose**: Identify gaps, inconsistencies, and enhancement opportunities

---

## Overview

This document catalogs areas requiring attention across the CLEO + Orchestrator Protocol system. Items are organized by category with severity ratings.

**Severity Levels**:
- **P0**: Breaking/Critical - System doesn't work as documented
- **P1**: Major Gap - Missing critical functionality
- **P2**: Enhancement - Would improve system significantly
- **P3**: Polish - Nice-to-have refinements

**User Decisions Applied (2026-01-20)**:
- Token validation: STRICT with guidance (fail + suggest correct values)
- Session auto-archive: YES (30 days inactivity)
- Session improvements: NEW EPIC (not T998 subtasks)

---

## 1. Documentation Gaps

### 1.1 Library Files Status (VALIDATED 2026-01-20)

| Item | Status | Severity | Notes |
|------|--------|----------|-------|
| `lib/token-inject.sh` | ✓ EXISTS | P2 | Unit tests exist (51 tests) |
| `lib/skill-dispatch.sh` | ✓ EXISTS | P2 | Unit tests exist (52 tests) |
| `lib/skill-validate.sh` | ✓ EXISTS | P2 | Needs integration test coverage |
| `lib/orchestrator-spawn.sh` | ✓ EXISTS | P2 | Integration tests exist (33 tests) |
| `lib/subagent-inject.sh` | ✓ EXISTS | P2 | Needs integration test coverage |

**Note**: All orchestrator libraries exist with significant test coverage.

### 1.2 Documentation Drift

| Document | Issue | Severity |
|----------|-------|----------|
| INDEX.md | References non-existent files (PHASE-3-FEATURES.md, TASK-COMPLETION-PHILOSOPHY.md) | P2 |
| Multiple orchestrator docs | Overlapping content between VISION, PROTOCOL, SPEC | P3 |
| Skill READMEs | Inconsistent format across skills | P3 |

### 1.3 Missing Documentation

| Topic | Severity | Notes |
|-------|----------|-------|
| Manifest recovery procedures | P2 | What to do when MANIFEST.jsonl is corrupted |
| Multi-session debugging guide | P3 | Troubleshooting session conflicts |

**[DONE v0.55.0]** Token injection tutorial - Now documented in skills SKILL.md
**[DONE v0.55.0]** Skill creation guide - Now documented with automation examples

---

## 2. Implementation Gaps

### 2.1 Token Injection System (lib/token-inject.sh EXISTS)

**[DONE v0.55.0 - T1835 Epic]**:
- ✓ `ti_populate_skill_specific_tokens()` implemented for skill-specific tokens (T1836)
- ✓ `validate_token_value()` implemented for enum/path/array/required validation (T1837)
- ✓ 8 hardcoded cleo commands tokenized (T1841)
- ✓ 51 unit tests added (T1826)

**Remaining Items**:

| Issue | Description | Severity |
|-------|-------------|----------|
| Token preview mode | Debug prompt before spawning | P3 |
| Token inheritance from parent skill | Reduce duplication | P3 |

### 2.2 Skill Dispatch System (lib/skill-dispatch.sh EXISTS)

**[DONE v0.55.0 - T1835 Epic]**:
- ✓ File exists with three-tier dispatch
- ✓ 52 unit tests added (T1827)

**Remaining Items**:

| Issue | Description | Severity |
|-------|-------------|----------|
| Dispatch trigger consistency | Some skills may have inconsistent trigger definitions | P2 |
| Debug mode documentation | SKILL_DISPATCH_DEBUG env var undocumented | P3 |

### 2.3 Context Monitoring

| Issue | Description | Severity |
|-------|-------------|----------|
| Context state file per session | Unclear if `.context-state-{sessionId}.json` implemented | P2 |
| Alert suppression logic | May not correctly suppress repeat alerts | P3 |
| Stale data handling | Exit code 54 handling unclear | P3 |

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
Complete:  "Task complete. See MANIFEST.jsonl for summary."
Partial:   "Task partial. See MANIFEST.jsonl for details."
Blocked:   "Task blocked. See MANIFEST.jsonl for blocker details."
```

### 3.2 Manifest Entry Format

| Issue | Description | Severity |
|-------|-------------|----------|
| `linked_tasks` vs `needs_followup` confusion | Similar purposes, unclear when to use which | P2 |
| Status enum inconsistency | Some docs show "archived", others don't | P3 |
| timestamp vs date fields | Both documented but not clear when to use which | P3 |

---

## 4. CLI Gaps

### 4.1 Orchestrator Commands (VALIDATED 2026-01-20)

**[DONE v0.55.0]**:
- ✓ `cleo orchestrator spawn` implemented
- ✓ `cleo orchestrator start` implemented
- ✓ `cleo orchestrator validate` implemented
- ✓ Integration tests exist (33 tests)

**Remaining Items**:

| Command | Status | Severity |
|---------|--------|----------|
| `cleo orchestrator next` | Documented, implementation status unclear | P2 |
| `cleo orchestrator analyze` | Documented, implementation status unclear | P2 |

### 4.2 Research Command Completeness

**[DONE v0.53.0]**:
- ✓ `cleo research init` implemented
- ✓ `cleo research list` implemented
- ✓ `cleo research show` implemented
- ✓ `cleo research inject` implemented

**Remaining Items**:

| Subcommand | Status | Notes |
|------------|--------|-------|
| `cleo research pending` | Unclear | Documented but needs verification |
| `cleo research get` | Unclear | Documented but needs verification |

### 4.3 Session Command Edge Cases

| Issue | Description | Severity |
|-------|-------------|----------|
| `session start` without `--focus` or `--auto-focus` | Error E_FOCUS_REQUIRED, but behavior unclear | P2 |
| `session close` with incomplete tasks | Should fail with E_SESSION_CLOSE_BLOCKED | P2 |
| `session resume --last` with multiple active | Which session is "last"? | P3 |

---

## 5. Schema Gaps

### 5.1 Schema Status (VALIDATED 2026-01-20)

**[DONE]**:
- ✓ `schemas/research-manifest.schema.json` exists (T1672)
- ✓ `schemas/skills-manifest.schema.json` validated (v1.1.0)

**Remaining Items**:

| Schema | Status | Severity |
|--------|--------|----------|
| Skill SKILL.md frontmatter schema | Not formally defined | P3 |

### 5.2 Schema Inconsistencies

| Issue | Description | Severity |
|-------|-------------|----------|
| Verification gates naming | Schema uses `implemented`, docs sometimes say `implementation_complete` | P2 |
| Phase enum values | Inconsistent across schemas and docs | P2 |
| Session scope types | 6 types documented, schema may differ | P2 |

---

## 6. Testing Gaps

### 6.1 Test Coverage (UPDATED 2026-01-20)

**[DONE v0.55.0 - T1835 Epic]**:
- ✓ Token injection library: 51 unit tests (T1826)
- ✓ Skill dispatch logic: 52 unit tests (T1827)
- ✓ Orchestrator spawn: 33 integration tests (T1829)

**Remaining Items**:

| Area | Coverage | Severity |
|------|----------|----------|
| Manifest operations (lib/research-manifest.sh) | Unknown | P2 |
| Multi-session conflict detection | Unknown | P2 |
| Context alert threshold crossing | Unknown | P3 |
| Verification gate auto-completion | Unknown | P2 |

### 6.2 Integration Test Gaps

| Scenario | Status | Severity |
|----------|--------|----------|
| Session startup protocol | Unclear | P2 |
| Epic auto-complete with verification | Unclear | P2 |
| Manifest corruption recovery | Missing | P2 |

---

## 7. Architectural Improvements

### 7.1 Token Injection Enhancements

**[DONE v0.55.0 - T1835 Epic]**:
- ✓ Skill-specific token population (T1836)
- ✓ Token validation (enum/path/array/required) (T1837)

**Remaining Items**:

| Enhancement | Benefit | Severity |
|-------------|---------|----------|
| Token preview mode | Debug prompt before spawning | P3 |
| Token inheritance from parent skill | Reduce duplication | P3 |

### 7.2 Skill System Enhancements

**[DONE v0.55.0 - T1835 Epic]**:
- ✓ Automation function documentation in SKILL.md (T1839)
- ✓ Skill loading explanation in SKILL.md (T1840)

**Remaining Items**:

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

### 7.4 Session Enhancements (**NEW EPIC CANDIDATE**)

> **User Decision**: Session improvements warrant a separate epic (not T998 subtasks).

| Enhancement | Benefit | Severity | Epic Priority |
|-------------|---------|----------|---------------|
| Auto-archive ended sessions | Prevent session accumulation (127 sessions) | **P1** | Epic Core |
| Orphaned context file cleanup | Cascade delete on session close (63 orphaned) | **P1** | Epic Core |
| Multi-terminal session binding | Support concurrent terminal usage | P2 | Epic Scope |
| Session health check | Detect stale/corrupted sessions | P2 | Epic Scope |
| Session handoff notes | Better cross-agent continuity | P2 | Epic Scope |
| Session templates | Quick-start common patterns | P3 | Backlog |
| Session timeout auto-suspend | Prevent stale active sessions | P3 | Backlog |

**Recommended New Epic**: "Session System Improvements"
- **Auto-archive policy**: 30 days inactivity (per user decision)
- **Cascade cleanup**: Context files deleted on session close
- **Multi-terminal**: Hybrid binding (env var → PPID → singleton fallback)

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

**[ALL DONE - T1835 Epic]**:
1. ~~**Audit lib/token-inject.sh**~~ ✓ EXISTS (8 functions exported)
2. ~~**Audit lib/skill-dispatch.sh**~~ ✓ EXISTS (three-tier dispatch)
3. ~~**Audit scripts/orchestrator.sh**~~ ✓ EXISTS (10+ subcommands)
4. ~~**Create schemas/manifest.schema.json**~~ ✓ EXISTS as `schemas/research-manifest.schema.json` (T1672)
5. ~~**Create token injection tests**~~ ✓ 51 unit tests (T1826)
6. ~~**Implement skill-specific token population**~~ ✓ T1836
7. ~~**Implement token validation**~~ ✓ T1837
8. ~~**Document orchestrator_spawn_for_task()**~~ ✓ T1838

### P1 (Next Priority)

9. **[NEW EPIC]** Session auto-archive policy (30 days - user decision)
10. **[NEW EPIC]** Cascade delete orphaned context files (63 orphaned)
11. Implement STRICT token validation with suggestions (user decision)

### Short-term (P2)

12. Standardize subagent return messages across all skills
13. ~~Create orchestrator spawn integration tests~~ ✓ 33 tests (T1829)
14. ~~Document manifest field semantics~~ ✓ Defined in schemas/research-manifest.schema.json
15. Add manifest validation to research commands
16. ~~Consolidate ORC/CTX constraint documentation~~ ✓ In ORCHESTRATOR-PROTOCOL-SPEC.md Part 2.1
17. **[NEW EPIC]** Multi-terminal session binding
18. **[NEW EPIC]** Session health check command

### Medium-term (P3)

19. Create skill development tutorial (partially done with SKILL.md updates)
20. Add manifest rotation/archival
21. Implement skill versioning
22. Add session timeout auto-suspend
23. Create debugging guides for common issues
24. Token preview mode (debug prompt before spawning)
25. Token inheritance from parent skill

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

### Documentation Verification (UPDATED 2026-01-20)
- [ ] INDEX.md broken links fixed
- [ ] Subagent return message standardized across docs
- [x] ORC/CTX constraints consolidated in spec
- [x] `orchestrator_spawn_for_task()` documented (T1838)
- [x] Automation functions documented in SKILL.md (T1839)
- [x] Skill loading explanation in SKILL.md (T1840)

### Test Verification (VALIDATED 2026-01-20)
- [x] Token injection unit tests exist (51 tests in tests/unit/token-inject.bats)
- [x] Skill dispatch unit tests exist (52 tests in tests/unit/skill-dispatch.bats)
- [x] Orchestrator spawn integration tests exist (33 tests in tests/integration/orchestrator-spawn.bats)
- [ ] Session conflict detection tests exist

### T1835 Epic Verification (COMPLETED 2026-01-20)
- [x] T1836: Skill-specific token population implemented
- [x] T1837: Token validation (enum/path/array/required) implemented
- [x] T1838: `orchestrator_spawn_for_task()` documented
- [x] T1839: Automation function examples added to SKILL.md
- [x] T1840: Skill loading explanation added to SKILL.md
- [x] T1841: 8 hardcoded cleo commands tokenized
- [x] T1842: This document updated

---

## 11. New Gaps from 2026-01-20 Analysis

### Session System Gaps (P1-P2)

Discovered during comprehensive review:

| Gap | Severity | Description |
|-----|----------|-------------|
| 127 sessions accumulated | P2 | No auto-archive for ended sessions |
| 63 orphaned context files | P2 | Session delete doesn't cascade to context files |
| Single-terminal binding | P2 | `.current-session` is singleton, can't support multi-terminal |
| No session health check | P3 | Can't detect stale/corrupted sessions |

**Recommended Architecture**: Hybrid session binding
1. Check `CLEO_SESSION_ID` env var (explicit override)
2. Check `.cleo/.session-{PPID}` (terminal-specific)
3. Fallback to `.cleo/.current-session` (legacy)

### User Decisions (Resolved 2026-01-20)

**Q1: Token Enforcement Policy** ✓ DECIDED
- **Decision**: STRICT with guidance - fail on invalid tokens but provide suggestions for correct values
- Implementation: Token validation fails fast, but error message includes valid options

**Q2: Session Auto-Archive Policy** ✓ DECIDED
- **Decision**: YES - archive sessions after 30 days inactivity
- Implementation: Background job or session list command checks age

**Q3: Session Epic Alignment** ✓ DECIDED
- **Decision**: Create SEPARATE epic for session work (not T998 subtasks)
- Rationale: Session improvements are substantial enough for dedicated epic tracking

---

*This document should be reviewed after each major system update to track progress on improvements.*
*Last updated: 2026-01-20 (T1843 Priority Adjustment)*
*Previous: T1835 Token Injection Infrastructure Epic completion*

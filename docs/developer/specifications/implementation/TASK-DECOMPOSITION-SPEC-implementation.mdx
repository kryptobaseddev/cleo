# TASK-DECOMPOSITION-SPEC Implementation Report

**Spec Version**: 1.0.0
**Report Created**: 2025-12-19
**Report Updated**: 2025-12-23
**Target Release**: v0.22.0+
**Master Epic**: T753

---

## Executive Summary

The TASK-DECOMPOSITION-SPEC defines a 4-phase LLM-agent-first decomposition system for transforming high-level user requests into atomic, executable tasks with validated DAG dependencies.

**Status**: ACTIVE (tasks created, ready for implementation)

---

## CRITICAL: Subagent Work Protocol

**ALL subagents working on Phase tasks and subtasks MUST:**

1. **Update task notes regularly** with progress details
2. **Document completions** immediately when finishing work
3. **Record blockers** with clear descriptions of issues
4. **Note deviations** from spec with rationale
5. **Update notes BEFORE ending session** for handoff

**Required Note Update Pattern:**
```bash
ct update <task-id> --notes "Session <date>: <what was done>"
ct update <task-id> --notes "BLOCKER: <issue description>"
ct update <task-id> --notes "COMPLETE: <summary of deliverables>"
ct update <task-id> --notes "DEVIATION: <what changed> - Reason: <why>"
```

---

## Task Hierarchy

### Master Epic

| Task ID | Title | Type | Status |
|---------|-------|------|--------|
| **T753** | EPIC: Task Decomposition System Implementation | epic | pending |

### Phase Tasks (Direct Children of T753)

| Task ID | Phase | Title | Priority | Size | Dependencies |
|---------|-------|-------|----------|------|--------------|
| T754 | Phase 1 | Core Infrastructure - Decomposition Libraries | critical | medium | - |
| T760 | Phase 2 | Decomposition Pipeline - Core Functions | critical | large | T754 |
| T766 | Phase 3 | Challenge System - Adversarial Validation | high | medium | T760 |
| T771 | Phase 4 | Dependency Detection - Algorithm Implementation | high | medium | T760 |
| T777 | Phase 5 | HITL Integration - Human-in-the-Loop Gates | high | small | T760 |
| T781 | Phase 6 | Schema Extensions - v2.4.0 Fields | medium | medium | - |
| T788 | Phase 7 | Testing - Unit, Integration, Challenge Tests | high | medium | T754, T760, T766, T771 |
| T793 | Phase 8 | Documentation - User Guides & References | medium | small | T758 |

---

## Implementation Tasks

### Phase 1: Core Infrastructure (T754)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-001 | T755 | Create `lib/decomposition.sh` library | critical | medium | - | Part 10 |
| TD-002 | T756 | Create `lib/llm-invoke.sh` library | critical | medium | - | Part 18 |
| TD-003 | T757 | Create `lib/computed-fields.sh` library | high | small | - | Part 23 |
| TD-004 | T758 | Create `scripts/decompose.sh` command | critical | large | T755, T756 | Part 9 |
| TD-005 | T759 | Add exit codes to `lib/exit-codes.sh` | high | small | - | Part 9.3 |

### Phase 2: Decomposition Pipeline (T760)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-010 | T761 | Implement `analyze_scope()` function | critical | medium | T755 | Part 5 |
| TD-011 | T762 | Implement `decompose_goals()` function | critical | large | T755, T756 | Part 6 |
| TD-012 | T763 | Implement `build_dependency_graph()` function | critical | medium | T755 | Part 7 |
| TD-013 | T764 | Implement `specify_tasks()` function | critical | medium | T755 | Part 8 |
| TD-014 | T765 | Implement atomicity scoring | high | medium | T762 | Part 4 |

### Phase 3: Challenge System (T766)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-020 | T767 | Implement `challenge_decomposition()` function | high | medium | T756 | Part 11.2 |
| TD-021 | T768 | Implement rubber-stamp detection | high | small | T767 | Part 21.3 |
| TD-022 | T769 | Implement challenge quality scoring | medium | small | T767 | Part 21.2 |
| TD-023 | T770 | Implement challenge-revision loop | high | medium | T767 | Part 22.3 |

### Phase 4: Dependency Detection (T771)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-030 | T772 | Implement explicit dependency detection | critical | small | T763 | Part 19.1 |
| TD-031 | T773 | Implement data flow dependency detection | high | medium | T763 | Part 19.1 |
| TD-032 | T774 | Implement file conflict detection | high | small | T763 | Part 19.1 |
| TD-033 | T775 | Implement semantic dependency detection | medium | medium | T763 | Part 19.1 |
| TD-034 | T776 | Implement transitive closure optimization | medium | medium | T772, T773, T774, T775 | Part 19.3 |

### Phase 5: HITL Integration (T777)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-040 | T778 | Implement HITL gate output format | high | small | T761 | Part 12 |
| TD-041 | T779 | Integrate HITL with AskUserQuestion pattern | high | medium | T778 | Part 12 |
| TD-042 | T780 | Add `--hitl-response` flag to decompose | medium | small | T779 | Part 9.2 |

### Phase 6: Schema Extensions (T781)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-050 | T782 | Add `decompositionId` field to schema | medium | small | - | Part 23.1 |
| TD-051 | T783 | Add `atomicityScore` field to schema | medium | small | - | Part 23.1 |
| TD-052 | T784 | Add `acceptance` array field to schema | medium | small | - | Part 23.1 |
| TD-053 | T785 | Implement computed `children` field | medium | small | T757 | Part 23.2 |
| TD-054 | T786 | Implement computed `blockedBy` field | medium | small | T757 | Part 23.2 |
| TD-055 | T787 | Create schema migration v2.3.0 → v2.4.0 | medium | medium | T782, T783, T784 | Part 23.4 |

### Phase 7: Testing (T788)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-060 | T789 | Add unit tests for decomposition | high | medium | T761, T762, T763, T764 | Part 13.1 |
| TD-061 | T790 | Add integration tests for decompose command | high | medium | T758 | Part 13.2 |
| TD-062 | T791 | Add challenge system tests | medium | small | T767, T768, T769, T770 | Part 13.3 |
| TD-063 | T792 | Add performance benchmarks | low | small | T758 | Part 14 |

### Phase 8: Documentation (T793)

| Spec ID | Task ID | Task | Priority | Size | Dependencies | Spec Part |
|---------|---------|------|----------|------|--------------|-----------|
| TD-070 | T794 | Add decompose to QUICK-REFERENCE.md | medium | small | T758 | - |
| TD-071 | T795 | Add decompose to TODO_Task_Management.md | medium | small | T758 | - |
| TD-072 | T796 | Create decomposition user guide | low | medium | T758 | - |

---

## Task ID Quick Reference

| Spec ID | Task ID | Spec ID | Task ID | Spec ID | Task ID |
|---------|---------|---------|---------|---------|---------|
| TD-001 | T755 | TD-020 | T767 | TD-050 | T782 |
| TD-002 | T756 | TD-021 | T768 | TD-051 | T783 |
| TD-003 | T757 | TD-022 | T769 | TD-052 | T784 |
| TD-004 | T758 | TD-023 | T770 | TD-053 | T785 |
| TD-005 | T759 | TD-030 | T772 | TD-054 | T786 |
| TD-010 | T761 | TD-031 | T773 | TD-055 | T787 |
| TD-011 | T762 | TD-032 | T774 | TD-060 | T789 |
| TD-012 | T763 | TD-033 | T775 | TD-061 | T790 |
| TD-013 | T764 | TD-034 | T776 | TD-062 | T791 |
| TD-014 | T765 | TD-040 | T778 | TD-063 | T792 |
| - | - | TD-041 | T779 | TD-070 | T794 |
| - | - | TD-042 | T780 | TD-071 | T795 |
| - | - | - | - | TD-072 | T796 |

---

## Schema Changes Required

### New Fields (v2.4.0)

```json
{
  "decompositionId": "string (pattern: DEC-YYYYMMDD-NNN)",
  "atomicityScore": "integer (0-100)",
  "acceptance": "array of strings"
}
```

### Computed Fields (not stored)

```
children, ancestors, depth, dependents, blockedBy
```

---

## New Exit Codes Required

| Code | Constant | Usage |
|------|----------|-------|
| 30 | `EXIT_HITL_REQUIRED` | Decomposition blocked by ambiguity |
| 31 | `EXIT_CHALLENGE_REJECTED` | Challenge agent rejected decomposition |

---

## New Error Codes Required

| Code | Exit | Description |
|------|------|-------------|
| `E_DECOMPOSE_EMPTY_INPUT` | 2 | No request provided |
| `E_DECOMPOSE_AMBIGUOUS` | 30 | Request has unresolved ambiguities |
| `E_DECOMPOSE_CYCLE` | 14 | Generated DAG has cycles |
| `E_DECOMPOSE_REJECTED` | 31 | Challenge agent rejected |
| `E_DECOMPOSE_DEPTH` | 11 | Exceeded depth limit |
| `E_DECOMPOSE_SIBLINGS` | 12 | Exceeded sibling limit |

---

## Dependencies on Other Specs

| Spec | Required Version | Purpose |
|------|------------------|---------|
| HIERARCHY-ENHANCEMENT-SPEC | v1.0.0+ | type, parentId, size, depth/sibling limits |
| LLM-AGENT-FIRST-SPEC | v1.0.0+ | JSON output, exit codes, error handling |
| CONSENSUS-FRAMEWORK-SPEC | v2.0.0+ | Challenge protocol, evidence standards |
| LLM-TASK-ID-SYSTEM-DESIGN-SPEC | v1.0.0+ | Task ID format |

---

## Implementation Notes

### LLM Invocation Strategy

Per Part 18, the system uses tiered model selection:
- **Haiku**: Scope analysis, DAG construction, task specification
- **Sonnet**: Goal decomposition (complex), all challenge phases

### Challenge System Design

Per Part 21, challenge outputs must:
- Produce minimum 2 findings
- Reference specific tasks/edges
- Include actionable suggestions
- Pass rubber-stamp detection

### Retry Behavior

Per Part 22:
- Max 3 retries per phase
- Max 10 total retries
- Exponential backoff (1s base, 30s max)
- Circuit breaker after 5 consecutive failures

---

## Open Questions

1. **LLM API Integration**: Which provider/SDK to use for Haiku/Sonnet calls?
2. **Prompt Storage**: Where to store prompt templates (lib/prompts/, templates/)?
3. **Caching**: Should decomposition results be cached for similar requests?
4. **Parallel Execution**: How to integrate with existing parallel task runners?

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LLM API rate limits | Medium | High | Implement backoff, queue system |
| Hallucinated dependencies | High | Medium | Anti-hallucination validation (Part 19.4) |
| Challenge rubber-stamping | Medium | Medium | Rubber-stamp detection (Part 21.3) |
| Schema migration issues | Low | High | Backward compatibility requirements |

---

## Session Workflow for Subagents

When starting a session for a phase:

```bash
# 1. Start session and set focus
cleo session start
cleo focus set <phase-task-id>

# 2. Review the phase task and subtasks
cleo show <phase-task-id>
cleo list --parent <phase-task-id>

# 3. Work on subtasks, updating notes as you go
cleo focus set <subtask-id>
cleo update <subtask-id> --notes "Starting work on..."

# 4. Complete subtasks when done
cleo complete <subtask-id>
cleo update <subtask-id> --notes "COMPLETE: <deliverables>"

# 5. End session with summary
cleo focus note "Session summary: ..."
cleo session end
```

---

## Changelog

### 2025-12-23 - Task Creation
- Created Master Epic T753 with 8 phase tasks
- Created 38 subtasks (T755-T796) across all phases
- Added task ID mapping from spec IDs (TD-XXX) to actual IDs (TXXX)
- Added subagent work protocol and session workflow
- Updated status from DRAFT to ACTIVE

### 2025-12-19 - Initial Report
- Created implementation report tracking 38 tasks across 8 phases
- Identified schema changes, exit codes, error codes required
- Documented dependencies on other specs
- Listed open questions and risks

---

*End of Implementation Report*

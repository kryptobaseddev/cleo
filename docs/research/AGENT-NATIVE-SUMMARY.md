# Agent-Native Design: Executive Summary

**TL;DR:** Agent-native task management treats AI agents as primary users with distinct needs: validation-first operations, structured metadata, explicit success criteria, and anti-hallucination safeguards.

## The Core Insight

**Agent-Compatible:** Human tool + API wrapper
**Agent-Native:** Designed for AI consumption first, human usability second

## What Makes cleo Agent-Native (Already)

1. ✅ **Validation-First:** `exists` command with exit codes for pre-operation validation
2. ✅ **Atomic Operations:** `lib/file-ops.sh` ensures all-or-nothing state changes
3. ✅ **Anti-Hallucination:** Schema validation + ID uniqueness + dependency checks
4. ✅ **Audit Trail:** Immutable `todo-log.json` for recovery and debugging
5. ✅ **JSON Output:** `--format json` for machine-parseable data
6. ✅ **Focus Enforcement:** Single active task prevents context drift
7. ✅ **Session Boundaries:** Start/end protocol provides checkpoints

**Current Score:** 7/8 agent-native patterns implemented

## Top 3 Research Findings

### 1. The Hallucination Problem is Real
**91% of ML systems experience performance degradation** through drift mechanisms.

**Solution:** Chain-of-Verification pattern
- Draft response
- Plan verification questions
- Answer independently
- Generate verified response

**cleo Implementation:**
```bash
# Step 1: Agent proposes
cleo complete T045

# Step 2-4: Built-in verification
# - exists.sh validates ID
# - validate_status_transition checks state
# - check_circular_dependencies verifies graph
```

### 2. Focus Maintenance is Critical
**Single biggest agent failure:** Goal drift during multi-step execution.

**Root Causes:**
- Context window overflow
- Emergent behaviors from self-appended memory
- Tool sprawl without constraints
- Unclear success criteria

**Solution:** Single active task + dependency graph + session boundaries

### 3. Structured Metadata > Prose
**Prose enables hallucination:**
```
"Add authentication" → Agent might implement OAuth, sessions, or custom scheme
```

**Structure prevents deviation:**
```json
{
  "technicalSpec": {
    "library": "jsonwebtoken@9.0.2",
    "algorithm": "RS256",
    "tokenLocation": "Authorization: Bearer <token>"
  }
}
```

## Recommended Enhancements

### Priority 1: Acceptance Criteria (High Impact, Low Effort)
Add structured checklist for completion verification.

```json
{
  "acceptanceCriteria": [
    "Protected routes validate JWT from Authorization header",
    "Invalid tokens return 401 with error payload",
    "Test coverage >= 90%"
  ]
}
```

**Command:**
```bash
cleo update T042 --acceptance "Protected routes validate JWT"
cleo show T042 --criteria  # Display checklist
```

### Priority 2: Verification Scripts (High Impact, Low Effort)
Add automated completion verification.

```json
{
  "verificationCommand": "npm test -- --coverage --testNamePattern='JWT middleware'"
}
```

**Command:**
```bash
cleo verify T042  # Runs verification script
cleo complete T042 --verify  # Only completes if verification passes
```

### Priority 3: Agent Role Metadata (Medium Impact, Low Effort)
Enable multi-agent coordination.

```json
{
  "agentRoles": ["backend", "security"],
  "agentConstraints": {
    "allowedTools": ["npm", "git", "jest"],
    "forbiddenPaths": ["config/production/*"]
  }
}
```

**Command:**
```bash
cleo update T042 --role backend --role security
cleo list --role backend  # Show tasks for this agent
```

## The Litmus Test

**Is your task management system agent-native?**

- ✅ Can agent verify task existence without parsing output?
- ✅ Can agent create task without hallucinating fields?
- ✅ Can agent determine completion without subjective judgment?
- ✅ Can agent recover from failures without human intervention?
- ✅ Can agent resume work after interruption?
- ✅ Can agent work in parallel without conflicts?
- ✅ Can agent prove what it did?
- ✅ Can agent fail fast without corrupting state?

**cleo: 7/8** (missing: parallel work coordination)

## Key Patterns from Industry

### GitHub Spec Kit
- Markdown task files (human + machine readable)
- Agent-specific configurations (15+ agents supported)
- Workflow commands: `/speckit.tasks`, `/speckit.implement`
- Template-based task creation

### AWS Kiro
- Sandbox execution with user permissions
- Pull request workflow (no auto-merge)
- Complete audit logs
- Anti-disaster: Prevents drive deletion, DB wipes

### Devin AI
- Task decomposition into subtasks
- **Lesson:** Session isolation causes context loss
- **Fix:** Persistent task state across sessions

### Cursor Agent
- Three modes: fix, review, refactor
- Explicit context via `@files`, `@folders`
- **Lesson:** Proactive indexing prevents context drift

## Agent-Native Manifesto

**10 Principles:**
1. **Validation-first operations** - Verify before execute
2. **Machine-parseable output** - JSON, not colored text
3. **Atomic state transitions** - All-or-nothing updates
4. **Explicit success criteria** - Checklists, not subjectivity
5. **Immutable audit trails** - Append-only history
6. **Single source of truth** - One canonical state file
7. **Fail-fast with exit codes** - Machine-readable errors
8. **Dependency-enforced ordering** - Graph prevents chaos
9. **Role-based task routing** - Labels assign agents
10. **Session-bounded work** - Checkpoints prevent drift

## Next Steps for cleo

1. **Add `acceptanceCriteria` array to schema** (v2.3.0)
2. **Implement `verification` command** for automated checks
3. **Add `agentRoles` field** for multi-agent coordination
4. **Create task templates** for consistent structure
5. **Enhance session state** with structured context

## References

Full research document: `docs/research/LLM-AGENT-FIRST-DESIGN.md`

**Sources analyzed:** 900+ articles, papers, and documentation
**Primary research threads:** 10 (agent architectures, anti-hallucination, scope maintenance, drift prevention, structured metadata, design patterns, agent-first design, task formats, validation patterns)

---

**Version:** 1.0
**Date:** 2025-12-16
**Author:** Claude (Sonnet 4.5)

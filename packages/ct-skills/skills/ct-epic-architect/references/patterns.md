# Epic Patterns Reference

Detailed patterns for specialized epic types.

---

## Research Epic Pattern

When the work type is classified as research:

### Research Wave Structure

| Wave | Task Type | Purpose |
|------|-----------|---------|
| Wave 0 | Scope Definition | Define research questions, boundaries, success criteria |
| Wave 1+ | Investigation (parallel) | Multiple parallel investigation tasks for sources/aspects |
| Final Wave | Synthesis | Aggregate findings, create recommendations, link to future work |

### Research Epic Types

| Type | When | Structure |
|------|------|-----------|
| Exploratory | Investigating unknowns | Questions -> Literature + Alternatives + Feasibility -> Synthesis -> Recommendations |
| Decision | Comparing options | Criteria -> Option A + B + C (parallel) -> Matrix -> Recommendation |
| Codebase Analysis | Understanding existing code | Architecture -> Dependencies + Data Flows -> Pain Points -> Improvements |

### Research-Specific Commands

```bash
# Initialize research outputs directory
{{TASK_RESEARCH_INIT_CMD}}

# Create research epic with research-specific labels
{{TASK_ADD_CMD}} "Research: {{TOPIC}}" \
  --type epic \
  --size medium \
  --labels "research,{{TYPE}},{{DOMAIN}}" \
  --phase core \
  --description "Research questions: ..." \
  --acceptance "Findings documented in research outputs; Recommendations actionable"

# Query prior research before starting
{{TASK_RESEARCH_LIST_CMD}} --status complete --topic {{DOMAIN}}
{{TASK_RESEARCH_SHOW_CMD}} {{ID}}              # Key findings only
{{TASK_RESEARCH_PENDING_CMD}}                  # Incomplete work

# Link research to task after completion
{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}
```

### Research Task Atomicity

Each research task SHOULD address exactly ONE research question:
- **Good**: "What authentication options exist for SvelteKit?"
- **Bad**: "Research authentication and authorization"

### Research Output Integration

- Subagents write findings to `{{OUTPUT_DIR}}/`
- Subagents append entry to `{{MANIFEST_PATH}}` with `linked_tasks: ["{{TASK_ID}}"]`
- Orchestrator reads only manifest summaries (key_findings) for context efficiency
- Use `{{TASK_RESEARCH_INJECT_CMD}}` to get subagent protocol block

### Synthesis vs Investigation Tasks

| Type | Parallel? | Dependencies | Output |
|------|-----------|--------------|--------|
| Investigation | Yes | Scope definition only | Raw findings |
| Synthesis | No | All investigation tasks | Conclusions, recommendations |

---

## Bug Epic Pattern

When work is classified as bug fix:

### Bug Severity to Priority Mapping

| Severity | Priority | Indicators |
|----------|----------|------------|
| Critical | critical | Data loss, security, system down |
| High | high | Core feature broken, workaround difficult |
| Medium | medium | Feature degraded, workaround exists |
| Low | low | Cosmetic, edge case |

### Bug Wave Structure

| Wave | Task Type | Purpose |
|------|-----------|---------|
| Wave 0 | Investigation | Root cause analysis |
| Wave 1 | Fix | Implement solution |
| Wave 2 | Regression Test | Verify fix, add test coverage |

### Bug-Specific Labels

```bash
{{TASK_ADD_CMD}} "Fix: {{BUG_DESCRIPTION}}" \
  --type epic \
  --labels "bug,severity:{{LEVEL}},{{DOMAIN}}" \
  --priority {{MAPPED_PRIORITY}}
```

---

## Brownfield Epic Pattern

When working in existing codebases (refactoring, modernization, migrations):

### Brownfield vs Greenfield Classification

| Indicator | Greenfield | Brownfield |
|-----------|------------|------------|
| Code exists | No | Yes |
| Tests exist | No | May exist |
| Users exist | No | Yes (production impact) |
| Rollback needed | No | Yes (critical) |
| Dependencies | None | Many (existing systems) |

### Brownfield Wave 0: Impact Analysis (MANDATORY)

**Every brownfield epic MUST start with impact analysis:**

```bash
# T1: Impact analysis task (Wave 0)
{{TASK_ADD_CMD}} "Analyze impact and dependencies" \
  --type task \
  --size medium \
  --priority critical \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "brownfield,analysis,wave-0" \
  --description "Document all files, functions, and integration points affected. Create dependency graph. Identify external systems." \
  --acceptance "Dependency map documented" \
  --acceptance "All integration points identified" \
  --acceptance "Risk areas flagged"
```

### Brownfield Wave 0: Regression Baseline (MANDATORY)

**Create tests BEFORE any modifications:**

```bash
# T2: Regression baseline task (Wave 0)
{{TASK_ADD_CMD}} "Create regression test baseline" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "brownfield,testing,wave-0,regression-risk" \
  --description "Write tests for ALL current behaviors BEFORE changes. These verify no regressions during work." \
  --acceptance "Current behavior fully tested" \
  --acceptance "Edge cases covered" \
  --acceptance "Tests pass against current code"
```

### Brownfield Safety Patterns

| Pattern | Purpose | Implementation |
|---------|---------|----------------|
| **Strangler Fig** | Gradual replacement | New code parallel to legacy, shift traffic gradually |
| **Feature Flags** | Rollback capability | Gate new behavior, instant rollback |
| **Dual-Write** | Data migration safety | Write to both old/new, verify consistency |
| **Shadow Mode** | Risk-free testing | New code runs but doesn't affect users |

### Brownfield-Specific Labels

```bash
--labels "brownfield,refactor,regression-risk"
--labels "brownfield,migration,rollback-checkpoint"
--labels "brownfield,cleanup,tech-debt"
```

### Rollback Checkpoints

Every brownfield epic MUST document rollback at each wave:

```bash
# Rollback documentation task (parallel with implementation)
{{TASK_ADD_CMD}} "Document Wave N rollback procedure" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --labels "brownfield,rollback" \
  --description "Document and test rollback procedure for this wave. Must be tested in staging." \
  --acceptance "Rollback procedure documented" \
  --acceptance "Tested in staging environment"
```

### Brownfield Verification Gates

After brownfield task completion:

```bash
# Regression tests still pass
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate testsPassed

# Cleanup/tech debt addressed
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate cleanupDone

# Security review for auth/data changes
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate securityPassed
```

### Brownfield Anti-Patterns

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| **Big-bang cutover** | High risk, no rollback | Gradual migration with feature flags |
| **No regression tests** | Can't verify no breakage | Baseline tests before any changes |
| **Undocumented rollback** | Stuck if issues arise | Document rollback at each phase |
| **Modifying and testing together** | Tests may pass broken code | Tests first, then modifications |

**See [refactor-epic-example.md](refactor-epic-example.md) for complete brownfield refactoring example.**

---

## Refactor Epic Pattern

For code modernization, architectural improvements, and tech debt reduction:

### Refactor Wave Structure

| Wave | Task Type | Purpose |
|------|-----------|---------|
| Wave 0 | Impact Analysis + Regression Baseline | Understand scope, create safety net |
| Wave 1 | New Implementation (parallel) | Build new code alongside legacy |
| Wave 2 | Adapter/Integration | Create bridge between old and new |
| Wave 3 | Gradual Migration | Shift traffic/users incrementally |
| Wave 4 | Validation + Cleanup | Verify migration, remove legacy |

### Refactor Safety Rules

1. **Never modify existing code in Wave 0** - Analysis only
2. **New code is ADDITIVE in Wave 1** - Don't touch legacy yet
3. **Feature flags control all behavior changes** - Instant rollback
4. **Test rollback at every phase** - Before production deployment
5. **Remove legacy code LAST** - Only after validation complete

### Refactor-Specific Commands

```bash
# Create refactor epic with lifecycle tracking
{{TASK_ADD_CMD}} "EPIC: Refactor {{COMPONENT}}" \
  --type epic \
  --size large \
  --priority high \
  --epic-lifecycle planning \
  --labels "refactor,brownfield,{{DOMAIN}}" \
  --description "Modernize {{COMPONENT}}. Strangler fig pattern with feature flags." \
  --acceptance "New implementation complete" \
  --acceptance "All users migrated" \
  --acceptance "Legacy code removed" \
  --acceptance "Rollback tested at each phase"
```

**See [refactor-epic-example.md](refactor-epic-example.md) for complete example.**

---

## Task Naming Conventions

### Pattern: "{Verb} {Object} {Qualifier}"

**Good:**
- "Create user authentication schema"
- "Implement JWT validation middleware"
- "Write integration tests for auth flow"
- "Add error handling to API endpoints"

**Bad:**
- "Auth stuff"
- "Part 1"
- "Fix things"
- "TODO"

### Numbered Sequences

For clearly sequential work:
- "1. Define data model"
- "2. Create API endpoints"
- "3. Build UI components"
- "4. Add integration tests"

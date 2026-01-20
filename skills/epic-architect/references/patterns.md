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

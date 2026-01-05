# CLEO Documentation Standard Operating Procedure

**Version**: 1.0.0
**Status**: Active
**Applies to**: All CLEO documentation intended for LLM agents

## Purpose

Define documentation standards for LLM agent instruction that balance:
- **GOLDEN framework** principles (Goal/Output/Limits/Data/Evaluation)
- **RFC 2119** requirement levels (MUST/SHOULD/MAY)
- **Agent SOPs** (critical safety instructions)

## Core Principles

### 1. GOLDEN Framework Structure

Every instruction section SHOULD follow GOLDEN framework:

- **Goal**: What to accomplish
- **Output**: Expected result format
- **Limits**: Constraints and boundaries
- **Data**: Input/context required
- **Evaluation**: Success criteria

### 2. RFC 2119 Requirement Levels

Use RFC 2119 keywords for **precise requirement levels**:

| Keyword | Meaning | Usage |
|---------|---------|-------|
| **MUST** | Absolute requirement | Critical safety, data integrity |
| **MUST NOT** | Absolute prohibition | Dangerous operations, data corruption |
| **SHOULD** | Strong recommendation | Best practices, optimization |
| **SHOULD NOT** | Strong discouragement | Inefficient patterns |
| **MAY** | Optional | Feature availability |

**Example (Correct)**:
```markdown
## Data Integrity

**MUST** use `cleo` commands for all state modifications.
**MUST NOT** edit `.cleo/*.json` files directly.
**SHOULD** use `find` for task discovery (99% less context than `list`).
```

### 3. Positive Prescriptive Language

**DO**: Show the right way
```markdown
✅ Use `ct find` for task discovery
✅ Start sessions before work with `ct session start`
```

**DON'T**: Create anti-pattern catalogs
```markdown
❌ Don't use list when find would work
❌ Never forget to start sessions
❌ Avoid editing JSON files
```

### 4. Strong Language Usage

**When to use uppercase/strong language**:

| Use Case | Pattern | Example |
|----------|---------|---------|
| Critical safety | **MUST NOT** | **MUST NOT** ignore exit codes |
| Data integrity | **MUST** | **MUST** use CLI for all operations |
| Absolute requirement | **NEVER** | **NEVER** edit JSON directly |
| Required workflow | **ALWAYS** | **ALWAYS** check exit codes |

**When NOT to use**:
- Emphasis on preferences: ~~"ALWAYS prefer find"~~ → "Use `find` for discovery"
- Redundant statements: ~~"NEVER EVER"~~ → **MUST NOT**
- Multiple negatives: ~~"Don't never avoid"~~ → **MUST** do X

## Documentation Patterns

### Pattern 1: Critical Requirements (Agent SOPs)

**Structure**: RFC 2119 + Rationale + Enforcement

```markdown
### Critical: Error Handling

**MUST** check exit codes after EVERY command.

**Rationale**: Failed commands mean tasks were NOT created/updated.

**Enforcement**:
1. Exit code `0` = success
2. Exit codes `1-22` = error
3. Execute `error.fix` command for resolution
```

**Why this works**:
- RFC 2119 keyword (**MUST**) = precise requirement level
- Rationale explains WHY (not just what)
- Enforcement shows HOW to comply

### Pattern 2: Best Practices (GOLDEN Framework)

**Structure**: Goal + Prescriptive guidance

```markdown
### Best Practices

**Goal**: Minimize context usage and maximize efficiency

**Patterns**:
- Use `find` for task discovery (99% less context than `list`)
- Use `--status`, `--label`, `--phase` (native filters, faster than jq)
- Use `ct commands -r critical` for command discovery

**Output**: JSON by default (piped output auto-detected)
```

**Why this works**:
- Starts with goal/purpose
- Shows what TO do (not what NOT to do)
- Explains benefits (context efficiency, speed)

### Pattern 3: Workflow Instructions

**Structure**: Ordered steps with state awareness

```markdown
### Session Protocol

**START Phase** (State Awareness):
```bash
ct session list              # Check existing sessions
ct dash                      # Project overview
ct session resume <id>       # Resume existing
```

**WORK Phase** (Operations):
```bash
ct focus show                # Current focus
ct next                      # Task suggestion
ct complete <id>             # Complete task
```

**END Phase** (Cleanup):
```bash
ct archive                   # Clean up done tasks
ct session end               # End session
```
```

**Why this works**:
- Clear phases with purpose labels
- Paste-able command examples
- State-aware progression

## Anti-Patterns to Avoid

### ❌ Anti-Pattern 1: Negative Repetition

**Bad**:
```markdown
- Don't edit JSON files
- Never modify .cleo/*.json directly
- Avoid manual file edits
- NEVER EVER touch JSON files
```

**Good**:
```markdown
**MUST** use `cleo` commands for all state modifications.
```

### ❌ Anti-Pattern 2: Verbose Explanations

**Bad**:
```markdown
When you want to discover tasks, you should avoid using the list command
because it includes all fields including potentially large notes arrays which
consume a lot of context, and instead you should prefer the find command...
```

**Good**:
```markdown
Use `find` for task discovery (99% less context than `list`)
```

### ❌ Anti-Pattern 3: Multiple Weak Alternatives

**Bad**:
```markdown
You could use find, or maybe list with filters, or perhaps grep the output...
```

**Good**:
```markdown
Use `find` for task discovery:
- `ct find "query"` - fuzzy search
- `ct find "T1234" --exact` - exact match
```

## Evaluation Checklist

Before finalizing documentation, verify:

- [ ] Uses RFC 2119 keywords for requirement levels
- [ ] Strong language (**MUST**, **NEVER**) only for critical requirements
- [ ] Prescriptive (show what TO do) over proscriptive (what NOT to do)
- [ ] No semantic repetition (say it once, say it right)
- [ ] Paste-able examples with expected output
- [ ] Clear hierarchy (essential → advanced)
- [ ] GOLDEN framework applied where appropriate

## References

- **T1458**: LLM Agent Documentation Research (CLEO epic T1384)
- **RFC 2119**: Key words for use in RFCs to Indicate Requirement Levels
- **GOLDEN Framework**: Lakera/Elements.cloud prompt engineering research (2025)
- **Context Efficiency**: LLM-AGENT-FIRST-SPEC.md (CLEO)

---

**Status**: This SOP is **active** and applies to all CLEO documentation updates.

**Maintenance**: Update this SOP when new research findings emerge (link to T1458).

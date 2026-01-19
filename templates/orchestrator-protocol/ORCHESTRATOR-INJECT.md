# DEPRECATED: CLAUDE.md Injection Approach

> **STATUS**: DEPRECATED - Do NOT use this approach
>
> **REASON**: CLAUDE.md injection affects ALL agents including subagents,
> which breaks the orchestrator pattern where only the HITL session
> should operate as orchestrator. When injected into CLAUDE.md, subagents
> ALSO try to be orchestrators, causing:
> - Context duplication (orchestrator constraints loaded in every agent)
> - Role confusion (subagents try to delegate instead of execute)
> - Protocol violations (nested orchestration breaks dependency tracking)
>
> **USE INSTEAD**: Skill-based approach
> - Skill location: `skills/orchestrator/SKILL.md`
> - Install: `cleo orchestrator skill --install`
> - Invoke: "activate orchestrator mode" or Skill tool
>
> **MIGRATION STEPS**:
> 1. Remove any ORCHESTRATOR:START/END blocks from your CLAUDE.md
> 2. Run: `cleo orchestrator skill --install`
> 3. Invoke the skill when orchestrator mode is needed
>
> **WHY SKILLS WORK**:
> - Skills load ON-DEMAND, not always
> - Subagents do NOT inherit parent session skills
> - Only the HITL session operates as orchestrator

---

<!-- ORCHESTRATOR:START v1.0.0 (DEPRECATED - REFERENCE ONLY) -->
## Orchestrator Protocol (Legacy Reference)

### Immutable Constraints

| Rule | Constraint | Rationale |
|------|------------|-----------|
| ORC-001 | MUST stay high-level; MUST NOT implement code | Context preservation |
| ORC-002 | MUST delegate ALL work to subagents | Separation of concerns |
| ORC-003 | MUST NOT read full research files (>100 lines) | Token efficiency |
| ORC-004 | MUST spawn agents in dependency order | Avoid wasted work |
| ORC-005 | MUST use manifest for research summaries | O(1) lookup |

**Mantra**: Stay high-level. Delegate everything. Read only manifests. Spawn in order.

### Session Startup Protocol

Execute this sequence at conversation start:

```bash
# 1. Check active sessions
cleo session list --status active

# 2. Check manifest for pending work
cat docs/claudedocs/research-outputs/MANIFEST.jsonl | jq -s '[.[] | select(.needs_followup | length > 0)]'

# 3. Check focused task
cleo focus show

# 4. Review epic status
cleo dash --compact
```

**Decision Matrix**:
| Condition | Action |
|-----------|--------|
| Active session with focus | Resume; continue focused task |
| Active session, no focus | Query manifest needs_followup; spawn next |
| No session, manifest has followup | Create session; spawn for followup |
| No session, no followup | Ask user for direction |

### Subagent Spawning Rules

**Permitted Actions**:
- Check task state: `cleo show`, `cleo list`, `cleo session list`
- Query manifest: `jq -s '.[-1]' MANIFEST.jsonl`
- Plan task sequence (internal reasoning)
- Spawn subagent via Task tool
- Create epic/tasks: `cleo add`

**Prohibited Actions** (delegate these):
- Read full research files -> Subagent
- Implement code -> Coder subagent
- Run tests -> Testing subagent
- Write docs -> Docs subagent
- Merge/commit -> Human or auth agent

**Dependency Order**:
```
cleo deps <task-id>  # Check before spawn
cleo analyze --parent <epic-id>  # Find next unblocked
```

Only spawn when ALL dependencies are complete.

### Manifest Query Patterns

```bash
# Latest entry
jq -s '.[-1]' MANIFEST.jsonl

# Pending followups
jq -s '[.[] | select(.needs_followup | length > 0)]' MANIFEST.jsonl

# By topic
jq -s '[.[] | select(.topics | contains(["X"]))]' MANIFEST.jsonl

# Actionable items
jq -s '[.[] | select(.actionable)]' MANIFEST.jsonl

# Key findings for epic
jq -s '[.[] | select(.linked_tasks | contains(["T1575"])) | .key_findings] | flatten' MANIFEST.jsonl
```

### Subagent Injection Block (include in every spawn)

```markdown
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: docs/claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: docs/claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

CLEO INTEGRATION:
1. MUST read task details: `cleo show <task-id>`
2. MUST set focus: `cleo focus set <task-id>`
3. MUST complete task when done: `cleo complete <task-id>`
4. SHOULD link research: `cleo research link <task-id> <research-id>`
```

### Context Protection (Budget: 10K tokens max)

| Rule | Constraint |
|------|------------|
| CTX-001 | MUST NOT read research files > 100 lines |
| CTX-002 | MUST use `cleo research list` over raw manifest |
| CTX-003 | MUST use `cleo show --brief` for task summaries |
| CTX-004 | Subagent MUST NOT return content in response |
| CTX-005 | Manifest key_findings: 3-7 items, one sentence each |

### Error Recovery

| Failure | Recovery |
|---------|----------|
| No output file | Re-spawn with clearer instructions |
| No manifest entry | Manual entry or rebuild |
| Task not completed | Orchestrator completes manually |
| Partial status | Spawn continuation agent |
| Blocked status | Flag for human review |

<!-- ORCHESTRATOR:END -->

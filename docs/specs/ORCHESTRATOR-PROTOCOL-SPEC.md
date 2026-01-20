# Orchestrator Protocol Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Created**: 2026-01-18
**Author**: Protocol Specification Subagent
**Epic**: T1575
**Session**: session_20260118_132917_801b75

**See Also**: [Version Guide](../guides/ORCHESTRATOR-VERSIONS.md) for version relationships

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 1: Overview

### 1.1 Purpose

This specification defines the behavioral protocol for orchestrating multi-agent research workflows in CLEO. It establishes immutable rules for orchestrator behavior, subagent delegation, manifest-based coordination, and session startup procedures.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:

- Orchestrator behavioral constraints and delegation rules
- Subagent output protocol and CLEO task integration
- Manifest schema and query patterns
- Session startup protocol for conversation continuity
- Task linking and research-to-task cross-referencing

This specification **DEFERS TO**:

- [ORCHESTRATOR-SPEC.md](ORCHESTRATOR-SPEC.md) for tmux-based multi-agent orchestration
- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for 7-agent pipeline
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) for session scope binding
- [SUBAGENT_PROTOCOL.md](../claudedocs/research-outputs/SUBAGENT_PROTOCOL.md) for research output format

### 1.3 Scope

This protocol governs:
1. **Orchestrator behavior** - High-level coordination without implementation
2. **Subagent delegation** - Work assignment and output collection
3. **Manifest coordination** - Lightweight state passing between agents
4. **Session continuity** - Resuming work across conversation boundaries

---

## Part 2: Orchestrator Behavior Rules

### 2.1 Core Constraints

The orchestrator agent is the conversation-level coordinator. It MUST adhere to these immutable constraints:

| Rule ID | Constraint | Rationale |
|---------|------------|-----------|
| ORC-001 | MUST stay high-level; MUST NOT implement code | Context preservation; delegation efficiency |
| ORC-002 | MUST delegate ALL work to subagents | Separation of concerns; parallel execution |
| ORC-003 | MUST NOT read full research files into context | Token efficiency; context window protection |
| ORC-004 | MUST spawn agents in dependency order | Correctness; avoid wasted work |
| ORC-005 | MUST use manifest for research summaries | O(1) lookup vs O(n) file reading |

### 2.2 Delegation Decision Tree

```
USER REQUEST RECEIVED
        │
        ▼
┌───────────────────────────────────────┐
│ Is this a coordination/planning task? │
└───────────────────┬───────────────────┘
                    │
        ┌───────────┴───────────┐
        │ YES                   │ NO
        ▼                       ▼
┌───────────────────┐   ┌───────────────────────────┐
│ Orchestrator      │   │ Spawn subagent for task   │
│ handles directly  │   │ via Task tool             │
└───────────────────┘   └───────────────────────────┘
        │                       │
        │                       ▼
        │               ┌───────────────────────────┐
        │               │ Wait for subagent         │
        │               │ completion message        │
        │               └───────────────────────────┘
        │                       │
        └───────────┬───────────┘
                    ▼
            ┌───────────────────┐
            │ Read MANIFEST.jsonl│
            │ for results summary│
            └───────────────────┘
```

### 2.3 Permitted Orchestrator Actions

The orchestrator MAY perform these actions directly:

| Action | Tool | Example |
|--------|------|---------|
| Check task state | `cleo session list`, `cleo list`, `cleo show` | `cleo session list --status active` |
| Query manifest | `cat MANIFEST.jsonl \| jq` | `jq -s '.[-1]' MANIFEST.jsonl` |
| Plan task sequence | None (internal reasoning) | Dependency analysis |
| Spawn subagent | Task tool | `<task>Research X</task>` |
| Create epic/tasks | `cleo add` | `cleo add "Epic" --type epic` |

### 2.4 Prohibited Orchestrator Actions

The orchestrator MUST NOT perform these actions:

| Prohibited Action | Why | Delegate To |
|-------------------|-----|-------------|
| Read full research files | Token explosion | Subagent with targeted Read |
| Implement code changes | Context pollution | Coder subagent |
| Run tests | Specialized knowledge | Testing subagent |
| Write documentation | Detailed work | Docs subagent |
| Merge/commit code | HITL gate | Human or authorized agent |

---

## Part 3: Subagent Protocol

### 3.1 Subagent Injection Block

Every research subagent prompt MUST include this instruction block:

```markdown
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

CLEO INTEGRATION:
1. MUST read task details: `cleo show <task-id>`
2. MUST set focus: `cleo focus set <task-id>`
3. MUST complete task when done: `cleo complete <task-id>`
4. SHOULD link research: `cleo research link <task-id> <research-id>`

Manifest entry format (single JSON line):
{"id":"topic-YYYY-MM-DD","file":"YYYY-MM-DD_topic.md","title":"Title","date":"YYYY-MM-DD","status":"complete|partial|blocked","topics":["t1"],"key_findings":["Finding 1"],"actionable":true,"needs_followup":["T1234"]}
```

### 3.2 Subagent Workflow

```
SUBAGENT SPAWNED
        │
        ▼
┌───────────────────────────────────────┐
│ 1. Read task: cleo show <task-id>     │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 2. Set focus: cleo focus set <task-id>│
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 3. Execute research/implementation    │
│    Write findings to output file      │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 4. Append manifest entry              │
│    Set needs_followup to next tasks   │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 5. Complete task: cleo complete <id>  │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ 6. Return: "Research complete. See    │
│    MANIFEST.jsonl for summary."       │
└───────────────────────────────────────┘
```

### 3.3 Subagent Return Contract

| Requirement | Rule Level | Validation |
|-------------|------------|------------|
| Output file exists | MUST | `test -f <path>` |
| Manifest entry appended | MUST | `grep <id> MANIFEST.jsonl` |
| Response is completion message only | MUST | String match |
| Task completed in CLEO | SHOULD | `cleo show <id>` status=done |
| Research linked to task | SHOULD | Task notes contain research ID |

---

## Part 4: Session Startup Protocol

### 4.1 Every New Conversation

When a new conversation starts, the orchestrator MUST execute this startup sequence:

```bash
# Step 1: Check for active sessions
cleo session list --status active

# Step 2: Check manifest for pending work
cat claudedocs/research-outputs/MANIFEST.jsonl | jq -s '[.[] | select(.needs_followup | length > 0)]'

# Step 3: Check focused task
cleo focus show

# Step 4: Review epic status
cleo dash --compact
```

### 4.2 Decision Matrix

Based on startup checks, orchestrator MUST take one of these actions:

| Condition | Action |
|-----------|--------|
| Active session exists with focus | Resume session; continue from focused task |
| Active session exists, no focus | Query manifest for needs_followup; spawn next agent |
| No active session, manifest has followup | Create session; spawn agent for first followup task |
| No active session, no manifest followup | Ask user for direction |

### 4.3 Session Resume Flow

```
CONVERSATION STARTS
        │
        ▼
┌───────────────────────────────────────┐
│ cleo session list --status active     │
└───────────────────────────────────────┘
        │
        ├──── No active sessions ────▶ CREATE NEW SESSION
        │
        ▼ Active session found
┌───────────────────────────────────────┐
│ cleo session resume <session-id>      │
│   OR                                  │
│ cleo session resume --last            │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ cleo focus show                       │
└───────────────────────────────────────┘
        │
        ├──── Focus exists ────▶ CONTINUE FOCUSED TASK
        │
        ▼ No focus
┌───────────────────────────────────────┐
│ Query MANIFEST.jsonl for              │
│ needs_followup arrays                 │
└───────────────────────────────────────┘
        │
        ├──── Followup tasks found ────▶ SPAWN NEXT AGENT
        │
        ▼ No followup
┌───────────────────────────────────────┐
│ cleo analyze --parent <epic-id>       │
│ Find next unblocked task              │
└───────────────────────────────────────┘
```

---

## Part 5: Manifest Schema

### 5.1 Required Fields

| Field | Type | Required | Constraint | Purpose |
|-------|------|----------|------------|---------|
| `id` | string | MUST | Unique slug with date | Lookup key |
| `file` | string | MUST | Matches output filename | File reference |
| `title` | string | MUST | Human-readable | Display name |
| `date` | string | MUST | ISO 8601 (YYYY-MM-DD) | Temporal ordering |
| `status` | enum | MUST | `complete\|partial\|blocked` | Progress tracking |
| `topics` | array | MUST | 1+ string items | Categorization |
| `key_findings` | array | MUST | 3-7 string items | Executive summary |
| `actionable` | boolean | MUST | true/false | Requires action? |
| `needs_followup` | array | MUST | Task IDs or empty | Handoff coordination |

### 5.2 Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `timestamp` | string | ISO 8601 datetime for precise ordering |
| `linked_tasks` | array | CLEO task IDs this research relates to |
| `agent_type` | string | Subagent role identifier |
| `tokens_spent` | number | Token usage estimate (informational only) |

### 5.3 needs_followup Semantics

The `needs_followup` array is the primary handoff mechanism:

```json
{
  "needs_followup": ["T1578", "T1580"]
}
```

| Value | Meaning | Orchestrator Action |
|-------|---------|---------------------|
| Empty array `[]` | No downstream work | Move to next independent task |
| Task IDs `["T1234"]` | Specific tasks ready | Spawn agents for listed tasks |
| `["BLOCKED:<reason>"]` | Work blocked | Flag for human review |

### 5.4 Manifest Query Patterns

Orchestrator SHOULD use these jq patterns for manifest queries:

```bash
# Get latest entry
jq -s '.[-1]' MANIFEST.jsonl

# Find entries with pending followup
jq -s '[.[] | select(.needs_followup | length > 0)]' MANIFEST.jsonl

# Filter by topic
jq -s '[.[] | select(.topics | contains(["orchestrator"]))]' MANIFEST.jsonl

# Get all key_findings for an epic's research
jq -s '[.[] | select(.linked_tasks | contains(["T1575"])) | .key_findings] | flatten' MANIFEST.jsonl

# List actionable items
jq -s '[.[] | select(.actionable == true) | {id, title, needs_followup}]' MANIFEST.jsonl
```

---

## Part 6: Task Linking Protocol

### 6.1 Research-to-Task Linking

When research relates to a CLEO task, subagents SHOULD establish the link:

**Method 1: CLEO research link command**
```bash
cleo research link <task-id> <research-id>
```

**Method 2: Direct task note**
```bash
cleo update <task-id> --notes "Linked research: <research-id> - <brief context>"
```

**Method 3: Manifest field**
```json
{
  "linked_tasks": ["T1575", "T1576"]
}
```

### 6.2 Bidirectional Traceability

| Direction | Storage | Query |
|-----------|---------|-------|
| Task → Research | Task notes field | `cleo show <task-id>` |
| Research → Task | Manifest `linked_tasks` | `jq 'select(.linked_tasks)' MANIFEST.jsonl` |

### 6.3 Link Timing

| Event | Link Action |
|-------|-------------|
| Subagent starts task | Focus task; no link yet |
| Research complete | Add task to manifest `linked_tasks` |
| Task complete | Add research ID to task notes |

---

## Part 7: Dependency Resolution

### 7.1 Dependency Order Enforcement

Orchestrator MUST spawn agents in dependency order:

```
EPIC T1575
    │
    ├── T1576 (no deps) ────────────────▶ WAVE 0 (spawn first)
    │
    ├── T1578 (deps: T1576) ────────────▶ WAVE 1 (after T1576 complete)
    ├── T1580 (deps: T1576) ────────────▶ WAVE 1 (parallel with T1578)
    │
    ├── T1582 (deps: T1576) ────────────▶ WAVE 1
    ├── T1584 (deps: T1576) ────────────▶ WAVE 1
    ├── T1588 (deps: T1576) ────────────▶ WAVE 1
    │
    ├── T1586 (deps: T1582,T1584,T1588) ─▶ WAVE 2 (wait for all wave 1)
    ├── T1590 (deps: T1584) ────────────▶ WAVE 2
    │
    ├── T1592 (deps: T1586,T1590) ──────▶ WAVE 3
    │
    └── T1594 (deps: T1592) ────────────▶ WAVE 4
```

### 7.2 Parallel Spawn Rules

| Rule | Constraint |
|------|------------|
| Parallel OK | Tasks in same wave with no inter-dependencies |
| Serial REQUIRED | Task depends on another in same or later wave |
| Overlap PROHIBITED | Same task claimed by multiple agents |

### 7.3 Spawn Decision

```python
def should_spawn(task_id, completed_tasks):
    task = cleo_show(task_id)
    deps = task.get('depends', [])

    # All dependencies must be completed
    for dep in deps:
        if dep not in completed_tasks:
            return False

    return True
```

---

## Part 8: Error Handling

### 8.1 Subagent Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| No output file | `test -f <path>` fails | Re-spawn with clearer instructions |
| No manifest entry | `grep <id>` fails | Manual entry or rebuild |
| Wrong return message | String mismatch | Accept but log warning |
| Task not completed | Status != done | Orchestrator completes manually |
| Partial status | `status: partial` | Spawn continuation agent |
| Blocked status | `status: blocked` | Flag for human review |

### 8.2 Orchestrator Recovery

```bash
# Rebuild manifest from files (disaster recovery)
for f in claudedocs/research-outputs/*.md; do
  # Extract metadata and append to manifest
  cleo research show --file "$f" --format jsonl >> MANIFEST.jsonl.new
done
mv MANIFEST.jsonl.new MANIFEST.jsonl
```

### 8.3 Session Recovery

```bash
# Find orphaned work
cleo session list --status suspended

# Resume specific session
cleo session resume <session-id>

# Clean stale sessions
cleo session close <session-id> --force
```

---

## Part 9: Context Protection

### 9.1 Token Budget Allocation

| Component | Max Tokens | Strategy |
|-----------|------------|----------|
| Orchestrator context | 10K | Manifest summaries only |
| Subagent prompt | 4K | Task description + injection block |
| Subagent research | 50K | Full file reading permitted |
| Return message | 100 | Fixed completion message |

### 9.2 Context Protection Rules

| Rule ID | Constraint |
|---------|------------|
| CTX-001 | Orchestrator MUST NOT read research files > 100 lines |
| CTX-002 | Orchestrator MUST use `cleo research list` over raw manifest read |
| CTX-003 | Orchestrator MUST use `cleo show --brief` for task summaries |
| CTX-004 | Subagent MUST NOT return content in response message |
| CTX-005 | Manifest key_findings MUST be 3-7 items, one sentence each |

---

## Part 10: Integration Points

### 10.1 CLEO Commands for Orchestration

| Command | Purpose | When Used |
|---------|---------|-----------|
| `cleo session start --scope epic:T1575` | Begin orchestration | First agent spawn |
| `cleo focus set <id>` | Mark active work | Subagent start |
| `cleo complete <id>` | Mark task done | Subagent finish |
| `cleo research link <tid> <rid>` | Link research to task | After research complete |
| `cleo analyze --parent <epic>` | Find next work | Orchestrator planning |
| `cleo deps <id>` | Check dependencies | Before spawn decision |
| `cleo research list` | List research entries (context-efficient) | Manifest query |
| `cleo research show <id>` | Get research entry details | Deep-dive on specific research |
| `cleo research pending` | Get entries with needs_followup | Find next agent work |
| `cleo research links <task-id>` | Get research linked to task | Traceability check |

### 10.2 File Locations

| File | Purpose | Created By |
|------|---------|------------|
| `claudedocs/research-outputs/` | Research output directory | `cleo research init` |
| `MANIFEST.jsonl` | Research index | Subagents (append) |
| `SUBAGENT_PROTOCOL.md` | Protocol reference | `cleo research init` |
| `INJECT.md` | Copy-paste injection block | `cleo research init` |

### 10.3 Related Specifications

| Spec | Relationship |
|------|--------------|
| ORCHESTRATOR-SPEC.md | tmux-based multi-agent spawning |
| IMPLEMENTATION-ORCHESTRATION-SPEC.md | 7-agent implementation pipeline |
| MULTI-SESSION-SPEC.md | Session scope isolation |
| SUBAGENT_PROTOCOL.md | Research output format |

---

## Part 11: Compliance Checklist

### 11.1 Orchestrator Compliance

- [ ] Never reads full research files
- [ ] Always spawns in dependency order
- [ ] Uses manifest for summaries
- [ ] Delegates all implementation work
- [ ] Executes session startup protocol

### 11.2 Subagent Compliance

- [ ] Writes output file to correct path
- [ ] Appends manifest entry
- [ ] Returns only completion message
- [ ] Sets focus before work
- [ ] Completes task when done
- [ ] Sets needs_followup for handoff

### 11.3 Manifest Compliance

- [ ] All required fields present
- [ ] Status is valid enum value
- [ ] key_findings is 3-7 items
- [ ] Date is ISO 8601 format
- [ ] needs_followup contains valid task IDs

---

## Appendix A: Quick Reference

### A.1 Orchestrator Mantra

```
Stay high-level. Delegate everything. Read only manifests. Spawn in order.
```

### A.2 Subagent Mantra

```
Focus. Execute. Write file. Append manifest. Complete task. Return message.
```

### A.3 Manifest Query Cheatsheet

```bash
# Latest entry
jq -s '.[-1]' MANIFEST.jsonl

# Pending followups
jq -s '[.[] | select(.needs_followup | length > 0)]' MANIFEST.jsonl

# By topic
jq -s '[.[] | select(.topics | contains(["X"]))]' MANIFEST.jsonl

# Actionable items
jq -s '[.[] | select(.actionable)]' MANIFEST.jsonl
```

---

## Appendix B: Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-18 | Initial specification |

---

*Specification v1.0.0 - Orchestrator Protocol*
*Epic: T1575 - Orchestrator Protocol Implementation*
*Task: T1576 - Define Protocol Specification*

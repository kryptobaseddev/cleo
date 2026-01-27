# Protocol Stack Architecture Design

**Task**: T2401
**Epic**: T2392 (CLEO Universal Subagent Architecture)
**Date**: 2026-01-26
**Status**: Complete

---

## 1. Executive Summary

This document defines the conditional protocol stack architecture for CLEO subagents. The system implements 7 specialized protocols that layer on top of a base protocol, with conditional loading based on task context, explicit triggers, and token budget constraints.

**Key Design Decisions**:
1. Base protocol ALWAYS loads (lifecycle, output, manifest)
2. Conditional protocols loaded via trigger detection OR explicit request
3. Maximum 2 conditional protocols per spawn to stay within 15K budget
4. Protocols are mutually exclusive within conflict groups
5. Protocol interactions via shared state (manifest, task notes, focus)

---

## 2. Protocol Stack Overview

### 2.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUBAGENT CONTEXT                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     BASE PROTOCOL (Always Loaded)                    │    │
│  │  - Lifecycle (spawn → execute → output → return)                    │    │
│  │  - Manifest integration (MUST append entry)                         │    │
│  │  - Task system (focus, complete, link)                              │    │
│  │  - Output format (file + manifest + summary message)                │    │
│  │  Token Budget: ~2,000 tokens                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                    ┌───────────────┴───────────────┐                        │
│                    ▼                               ▼                        │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐         │
│  │   CONDITIONAL PROTOCOL A    │   │   CONDITIONAL PROTOCOL B    │         │
│  │   (Primary - Selected)      │   │   (Secondary - Optional)    │         │
│  │   Budget: ~3-5K tokens      │   │   Budget: ~2-3K tokens      │         │
│  └─────────────────────────────┘   └─────────────────────────────┘         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        SKILL CONTENT                                 │    │
│  │                     Budget: ~5-10K tokens                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Working Space: ~80K tokens                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Protocol Categories

| Protocol | Purpose | Typical Budget | Load Frequency |
|----------|---------|----------------|----------------|
| **Base** | Lifecycle, output, manifest | 2,000 | Always (100%) |
| **Research** | Information gathering | 3,000 | Common (40%) |
| **Consensus** | Multi-agent decisions | 3,500 | Occasional (15%) |
| **Contribution** | Shared artifact modification | 2,500 | Common (30%) |
| **Specification** | Requirements definition | 3,000 | Occasional (20%) |
| **Decomposition** | Epic/task breakdown | 2,500 | Occasional (15%) |
| **Implementation** | Code/artifact creation | 2,000 | Common (35%) |
| **Release** | Versioning, changelog | 2,500 | Rare (5%) |

---

## 3. Protocol Definitions

### 3.1 Base Protocol (Always Loaded)

**Purpose**: Core subagent lifecycle and output requirements.

**Content**:
- Spawn → Inject → Execute → Output → Return lifecycle
- Manifest entry format and append requirements
- Task system integration (focus, complete, link)
- Output file format and naming conventions
- Error handling (complete, partial, blocked)
- Return message contract

**Token Budget**: 2,000 tokens (fixed overhead)

**Source**: `skills/_shared/subagent-protocol-base.md`

**Rules (RFC 2119)**:
- **MUST** write output file to specified location
- **MUST** append ONE line to MANIFEST.jsonl
- **MUST** return ONLY summary message
- **MUST NOT** return content in response
- **MUST** complete task via CLEO command
- **SHOULD** link research to task

### 3.2 Research Protocol

**Purpose**: Gathering information, exploring options, analyzing existing systems.

**Triggers**:
- Task type/labels contain: `research`, `investigate`, `explore`, `analyze`, `discovery`
- Task description contains: "research", "find out", "gather information", "survey"
- Explicit skill reference: `ct-research-agent`

**Content**:
- Multi-source research methodology (web, docs, codebase)
- Source quality evaluation criteria
- Citation and evidence requirements
- Synthesis and recommendation patterns
- Research output file format

**Token Budget**: 3,000 tokens

**Source**: `skills/ct-research-agent/SKILL.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** cite all sources with specific references
- **MUST** prioritize authoritative sources
- **MUST** include actionable recommendations
- **SHOULD** use Context7 for library documentation
- **SHOULD** include uncertainty notes for low-confidence findings
- **MUST NOT** fabricate information

**Conflict Group**: `information-gathering` (mutually exclusive with none)

### 3.3 Consensus Protocol

**Purpose**: Multi-agent decision making, voting, conflict resolution.

**Triggers**:
- Task labels contain: `consensus`, `decision`, `voting`
- Task is child of epic with `contribution-protocol` label
- Multiple sessions contributing to same epic
- Explicit request for multi-agent agreement

**Content**:
- Decision object format with confidence scores
- Evidence reference structure
- Conflict detection and classification
- Resolution types (merge, choose-a, choose-b, new, defer, escalate)
- Weighted voting semantics
- HITL escalation triggers

**Token Budget**: 3,500 tokens

**Source**: `docs/specs/CONTRIBUTION-FORMAT-SPEC.md` + `docs/specs/CONSENSUS-FRAMEWORK-SPEC.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** include confidence scores (0.0-1.0) for all decisions
- **MUST** include evidence array with at least one reference
- **MUST** flag conflicts with severity and type
- **MUST** propose resolution for high-severity conflicts
- **SHOULD** include uncertainty notes when confidence < 0.7
- **MUST NOT** use vague or ambiguous decision language

**Conflict Group**: `decision-making` (mutually exclusive with none)

### 3.4 Contribution Protocol

**Purpose**: Contributing to shared artifacts (code, docs, specifications).

**Triggers**:
- Task modifies shared files (code, docs, specs)
- Task labels contain: `contribution`, `modify`, `update`
- Task involves commit or PR creation
- Explicit contribution tracking required

**Content**:
- Commit conventions (conventional commits format)
- Task reference requirements in commits
- Branch discipline rules
- Provenance tagging (JSDoc, comments)
- Review requirements
- Atomic operation patterns

**Token Budget**: 2,500 tokens

**Source**: `skills/ct-dev-workflow/SKILL.md` + `templates/CONTRIBUTION-PROTOCOL.template.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** reference task ID in all commits
- **MUST** use conventional commit format
- **MUST NOT** commit directly to main/master
- **MUST** include Co-Authored-By attribution
- **SHOULD** run relevant tests before commit
- **SHOULD** use atomic commits (one logical change)

**Conflict Group**: `artifact-modification` (mutually exclusive with Release)

### 3.5 Specification Protocol

**Purpose**: Defining requirements, interfaces, contracts.

**Triggers**:
- Task type contains: `spec`, `specification`, `design`
- Task labels contain: `rfc`, `protocol`, `requirements`, `interface`
- Task description contains: "define", "specify", "document requirements"
- Explicit skill reference: `ct-spec-writer`

**Content**:
- RFC 2119 keyword usage and semantics
- Specification structure (overview, definitions, requirements, constraints, compliance)
- Requirement numbering conventions (REQ-XXX, CON-XXX)
- Testability and verification requirements
- Compliance criteria definition

**Token Budget**: 3,000 tokens

**Source**: `skills/ct-spec-writer/SKILL.md` + `docs/specs/SPEC-BIBLE-GUIDELINES.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** include RFC 2119 keyword header
- **MUST** number all requirements (REQ-XXX format)
- **MUST** define compliance criteria
- **MUST** make requirements testable
- **SHOULD** include rationale for each requirement
- **MUST NOT** use ambiguous terms ("appropriate", "reasonable")

**Conflict Group**: `documentation` (mutually exclusive with none)

### 3.6 Decomposition Protocol

**Purpose**: Breaking down epics into tasks, planning work.

**Triggers**:
- Task type: `epic` creation or planning
- Task labels contain: `planning`, `decomposition`, `breakdown`
- Task description contains: "create epic", "break down", "plan tasks"
- Explicit skill reference: `ct-epic-architect`

**Content**:
- Epic structure (epic → task → subtask hierarchy)
- Size guidelines (scope-based, NOT time-based)
- Wave planning (dependency-based parallel execution)
- Hierarchy constraints (depth 3, sibling limits)
- Phase assignment patterns
- File attachment vs research linking

**Token Budget**: 2,500 tokens

**Source**: `skills/ct-epic-architect/SKILL.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** check for related existing work before creating
- **MUST** have at least one Wave 0 task (no dependencies)
- **MUST** verify parent exists before creating child
- **MUST** use size (small/medium/large) not time estimates
- **MUST NOT** exceed depth 3 (epic → task → subtask)
- **SHOULD** assign phases to all tasks
- **MUST NOT** create circular dependencies

**Conflict Group**: `planning` (mutually exclusive with Implementation)

### 3.7 Implementation Protocol

**Purpose**: Writing code, creating artifacts, executing work.

**Triggers**:
- Task type contains: `implement`, `build`, `create`, `fix`, `refactor`
- Task labels contain: `implementation`, `coding`, `development`
- Task description contains: "implement", "write code", "build", "create"
- Explicit skill reference: `ct-task-executor`

**Content**:
- Deliverable production methodology
- Acceptance criteria verification
- Progress documentation patterns
- Code quality standards
- Error handling for partial/blocked completion

**Token Budget**: 2,000 tokens

**Source**: `skills/ct-task-executor/SKILL.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** verify deliverables against acceptance criteria
- **MUST** document all files affected
- **MUST** report partial completion explicitly
- **SHOULD** follow existing code patterns
- **MUST NOT** skip acceptance verification
- **SHOULD** handle blockers by documenting, not fabricating

**Conflict Group**: `execution` (mutually exclusive with Decomposition)

### 3.8 Release Protocol

**Purpose**: Versioning, changelog, deployment preparation.

**Triggers**:
- Task labels contain: `release`, `version`, `deployment`
- Task description contains: "release", "version bump", "changelog"
- Task type: release preparation
- Explicit release workflow request

**Content**:
- Semantic versioning rules (major.minor.patch)
- Changelog format and conventions
- Version bump process
- Tag creation and pushing
- GitHub Actions integration
- Validation gates before release

**Token Budget**: 2,500 tokens

**Source**: `skills/ct-dev-workflow/SKILL.md` (release sections) + `docs/specs/RELEASE-VERSION-MANAGEMENT-SPEC.md` (condensed)

**Rules (RFC 2119)**:
- **MUST** run full test suite before release
- **MUST** update CHANGELOG.md
- **MUST** use semantic versioning
- **MUST** create annotated tag
- **SHOULD** validate version consistency
- **MUST NOT** release with failing tests

**Conflict Group**: `artifact-modification` (mutually exclusive with Contribution)

---

## 4. Protocol Loading Matrix

### 4.1 Valid Combinations

| Primary Protocol | Compatible Secondary Protocols |
|------------------|-------------------------------|
| Research | Consensus, Specification |
| Consensus | Research, Specification |
| Contribution | Implementation, Specification |
| Specification | Research, Consensus, Contribution |
| Decomposition | Research |
| Implementation | Contribution, Specification |
| Release | (None - loads alone due to criticality) |

### 4.2 Mutually Exclusive Combinations

| Protocol A | Protocol B | Reason |
|------------|------------|--------|
| Decomposition | Implementation | Planning vs executing - different phases |
| Release | Contribution | Release is atomic, contribution is incremental |
| Research | Implementation | Gathering vs creating - sequential phases |

### 4.3 Loading Decision Flowchart

```
TASK RECEIVED
     │
     ▼
┌────────────────────────────────────────────┐
│ 1. Parse task labels, type, description    │
│ 2. Detect explicit skill references        │
│ 3. Check epic context (contribution flag)  │
└────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────┐
│ Primary Protocol Detection                  │
│ Priority: Explicit > Labels > Description  │
└────────────────────────────────────────────┘
     │
     ├─── Release detected? ───▶ LOAD: Base + Release (DONE)
     │
     ├─── Decomposition detected? ───▶ Check compatible secondary
     │                                        │
     │                                        ▼
     │                               Research compatible? ───▶ LOAD: Base + Decomposition + Research
     │                                        │
     │                                        └─── LOAD: Base + Decomposition
     │
     ├─── Implementation detected? ───▶ Check compatible secondary
     │                                        │
     │                                        ├─── Contribution detected? ───▶ LOAD: Base + Implementation + Contribution
     │                                        │
     │                                        └─── LOAD: Base + Implementation
     │
     ├─── Research detected? ───▶ Check compatible secondary
     │                                   │
     │                                   ├─── Consensus detected? ───▶ LOAD: Base + Research + Consensus
     │                                   │
     │                                   └─── LOAD: Base + Research
     │
     ├─── Specification detected? ───▶ Check compatible secondary
     │                                        │
     │                                        └─── (Any compatible) ───▶ LOAD: Base + Specification + Secondary
     │
     ├─── Consensus detected? ───▶ LOAD: Base + Consensus + (Research if applicable)
     │
     ├─── Contribution detected? ───▶ LOAD: Base + Contribution + Implementation
     │
     └─── DEFAULT ───▶ LOAD: Base + Implementation
```

---

## 5. Protocol Interaction Model

### 5.1 Shared State Mechanisms

Protocols communicate through these shared state channels:

| Channel | Storage | Access Pattern | Use Case |
|---------|---------|----------------|----------|
| **Manifest** | `MANIFEST.jsonl` | Append-only | Research findings, progress tracking |
| **Task Notes** | Task `.notes` array | Append via `--notes` | Progress updates, decisions |
| **Task Focus** | Session `.focus` | Single active task | Current work context |
| **Task Labels** | Task `.labels` array | Read-only | Protocol detection |
| **Research Links** | Task `.linkedResearch` | Bidirectional | Research ↔ Task association |
| **Contribution Files** | `.cleo/contributions/` | JSON files | Consensus decisions |

### 5.2 Protocol Handoff Patterns

#### Research → Implementation Handoff

```
RESEARCH PROTOCOL                    IMPLEMENTATION PROTOCOL
┌─────────────────────┐              ┌─────────────────────┐
│ 1. Gather findings  │              │                     │
│ 2. Write output     │              │                     │
│ 3. Append manifest: │   manifest   │ 1. Read manifest    │
│    needs_followup   │ ──────────▶  │ 2. Extract findings │
│    = ["T1234"]      │              │ 3. Implement        │
│ 4. Complete task    │              │ 4. Verify           │
└─────────────────────┘              └─────────────────────┘
```

#### Decomposition → Implementation Handoff

```
DECOMPOSITION PROTOCOL               IMPLEMENTATION PROTOCOL
┌─────────────────────┐              ┌─────────────────────┐
│ 1. Create epic      │              │                     │
│ 2. Create tasks     │    CLEO      │ 1. cleo show T###   │
│    with deps        │ ──────────▶  │ 2. Read description │
│ 3. Attach files     │   tasks      │ 3. Check deps done  │
│ 4. Set acceptance   │              │ 4. Implement        │
└─────────────────────┘              └─────────────────────┘
```

#### Research → Consensus Handoff

```
RESEARCH PROTOCOL                    CONSENSUS PROTOCOL
┌─────────────────────┐              ┌─────────────────────┐
│ 1. Multiple agents  │              │                     │
│    research same    │   contrib    │ 1. Query by epic    │
│    epic             │ ──────────▶  │ 2. Group by question│
│ 2. Each writes      │   files      │ 3. Detect conflicts │
│    contribution     │              │ 4. Compute consensus│
│ 3. Flags conflicts  │              │ 5. Resolve/escalate │
└─────────────────────┘              └─────────────────────┘
```

### 5.3 Cross-Protocol Dependencies

| From Protocol | To Protocol | Dependency Type | State Passed |
|---------------|-------------|-----------------|--------------|
| Research | Implementation | Sequential | Manifest findings |
| Research | Consensus | Parallel | Contribution decisions |
| Decomposition | Implementation | Sequential | Task structure |
| Specification | Implementation | Sequential | Requirements |
| Implementation | Contribution | Integrated | Code changes |
| Implementation | Release | Sequential | Completed work |
| Consensus | Specification | Sequential | Resolved decisions |

---

## 6. Conditional Loading Triggers

### 6.1 Detection Logic

```python
def detect_protocols(task: Task) -> list[str]:
    """Detect required protocols from task context."""
    protocols = ["base"]  # Always loaded

    # Priority 1: Explicit skill references
    if task.has_skill("ct-research-agent"):
        protocols.append("research")
    if task.has_skill("ct-epic-architect"):
        protocols.append("decomposition")
    if task.has_skill("ct-spec-writer"):
        protocols.append("specification")
    if task.has_skill("ct-task-executor"):
        protocols.append("implementation")
    if task.has_skill("ct-dev-workflow") and "release" in task.labels:
        protocols.append("release")

    # Priority 2: Label detection
    label_triggers = {
        "research": ["research", "investigate", "explore", "analyze"],
        "consensus": ["consensus", "decision", "voting", "contribution-protocol"],
        "contribution": ["contribution", "modify", "commit"],
        "specification": ["spec", "rfc", "protocol", "requirements"],
        "decomposition": ["planning", "decomposition", "breakdown", "epic"],
        "implementation": ["implementation", "coding", "development", "fix"],
        "release": ["release", "version", "deployment"]
    }

    for protocol, triggers in label_triggers.items():
        if any(trigger in task.labels for trigger in triggers):
            if protocol not in protocols:
                protocols.append(protocol)

    # Priority 3: Description keywords
    desc_triggers = {
        "research": ["research", "find out", "gather information", "survey"],
        "consensus": ["decide", "vote", "agree", "consensus"],
        "contribution": ["commit", "modify", "update code"],
        "specification": ["define", "specify", "requirements"],
        "decomposition": ["create epic", "break down", "plan tasks"],
        "implementation": ["implement", "write code", "build", "create"],
        "release": ["release", "version bump", "changelog"]
    }

    for protocol, keywords in desc_triggers.items():
        if any(kw in task.description.lower() for kw in keywords):
            if protocol not in protocols:
                protocols.append(protocol)

    # Apply mutual exclusion rules
    protocols = apply_exclusion_rules(protocols)

    # Limit to max 2 conditional (plus base)
    if len(protocols) > 3:
        protocols = prioritize_protocols(protocols)[:3]

    return protocols
```

### 6.2 Override Mechanisms

| Override Type | Syntax | Example |
|---------------|--------|---------|
| Explicit inclusion | `--protocol <name>` | `--protocol research,consensus` |
| Explicit exclusion | `--no-protocol <name>` | `--no-protocol implementation` |
| Force single | `--only-protocol <name>` | `--only-protocol release` |
| Strategy override | `--loading-strategy minimal` | Forces minimal loading |

### 6.3 Explicit vs Implicit Loading

| Loading Type | Detection | Precedence | Use Case |
|--------------|-----------|------------|----------|
| **Explicit** | `--protocol` flag | Highest | Orchestrator knows requirements |
| **Skill-based** | Skill reference in task | High | Task has skill assignment |
| **Label-based** | Task labels match triggers | Medium | Categorized tasks |
| **Description-based** | Keywords in description | Low | Uncategorized tasks |
| **Default** | None detected | Lowest | Falls back to Implementation |

---

## 7. Budget Allocation

### 7.1 Token Budget Distribution

| Component | Budget | Strategy |
|-----------|--------|----------|
| Base Protocol | 2,000 | Fixed, always loaded |
| Primary Conditional | 3,000-3,500 | Full content |
| Secondary Conditional | 2,000-2,500 | Condensed content |
| Skill Content | 5,000-10,000 | Task-dependent |
| Working Space | ~80,000 | Remaining context |
| **Total** | 100,000 | Subagent limit |

### 7.2 Compression Strategies

#### Section-Based Compression

```
FULL PROTOCOL (~3,500 tokens)        CONDENSED (~2,000 tokens)
┌─────────────────────────┐          ┌─────────────────────────┐
│ ## Overview (500)       │          │ ## Overview (300)       │
│ ## Rules (800)          │   ──▶    │ ## Rules (800)          │
│ ## Examples (1,200)     │          │ ## Quick Reference (500)│
│ ## Anti-patterns (500)  │          │ ## Checklist (400)      │
│ ## Checklist (500)      │          └─────────────────────────┘
└─────────────────────────┘
```

#### Content Prioritization

| Priority | Content Type | Compression Action |
|----------|--------------|-------------------|
| 1 (keep) | RFC 2119 rules | Never compress |
| 2 (keep) | Output format | Keep full |
| 3 (condense) | Examples | Keep 1 of N |
| 4 (condense) | Rationale | Summarize |
| 5 (remove) | Anti-patterns | Remove |
| 6 (remove) | Detailed explanations | Remove |

### 7.3 Essential vs Optional Content

| Protocol | Essential Content | Optional Content |
|----------|-------------------|------------------|
| Research | Source citation rules, output format | Methodology details |
| Consensus | Decision format, confidence semantics | Voting algorithms |
| Contribution | Commit format, branch rules | CI/CD integration |
| Specification | RFC 2119 keywords, structure | Example specs |
| Decomposition | Hierarchy rules, wave planning | Pattern library |
| Implementation | Deliverable verification | Quality standards |
| Release | Version bump process, tag creation | Automation details |

---

## 8. Implementation Guidance

### 8.1 Protocol File Organization

```
skills/_shared/
├── subagent-protocol-base.md      # Base protocol (always loaded)
├── protocol-research.md           # Research protocol (condensed)
├── protocol-consensus.md          # Consensus protocol (condensed)
├── protocol-contribution.md       # Contribution protocol (condensed)
├── protocol-specification.md      # Specification protocol (condensed)
├── protocol-decomposition.md      # Decomposition protocol (condensed)
├── protocol-implementation.md     # Implementation protocol (condensed)
└── protocol-release.md            # Release protocol (condensed)
```

### 8.2 Protocol Loader Function

```bash
# lib/protocol-loader.sh

function load_protocols() {
    local task_id="$1"
    local explicit_protocols="${2:-}"  # Comma-separated list
    local strategy="${3:-standard}"    # minimal|standard|comprehensive

    local protocols=("base")

    # Explicit override
    if [[ -n "$explicit_protocols" ]]; then
        IFS=',' read -ra protocols <<< "base,$explicit_protocols"
    else
        # Auto-detect from task
        protocols=($(detect_protocols_from_task "$task_id"))
    fi

    # Apply exclusion rules
    protocols=($(apply_exclusion_rules "${protocols[@]}"))

    # Load protocol content
    local content=""
    for protocol in "${protocols[@]}"; do
        local file="skills/_shared/protocol-${protocol}.md"
        if [[ -f "$file" ]]; then
            case "$strategy" in
                minimal)
                    content+=$(head -n 50 "$file")
                    ;;
                standard)
                    content+=$(cat "$file")
                    ;;
                comprehensive)
                    content+=$(cat "$file")
                    # Include references if available
                    local ref_dir="${file%.md}/references"
                    [[ -d "$ref_dir" ]] && content+=$(cat "$ref_dir"/*.md)
                    ;;
            esac
            content+="\n\n"
        fi
    done

    echo "$content"
}

function detect_protocols_from_task() {
    local task_id="$1"
    local task_json
    task_json=$(cleo show "$task_id" --format json)

    local protocols=("base")
    local labels
    labels=$(echo "$task_json" | jq -r '.labels[]?' 2>/dev/null || echo "")
    local description
    description=$(echo "$task_json" | jq -r '.description // ""')

    # Detection logic (simplified)
    if echo "$labels" | grep -qiE "research|investigate"; then
        protocols+=("research")
    fi
    if echo "$labels" | grep -qiE "consensus|decision"; then
        protocols+=("consensus")
    fi
    if echo "$labels" | grep -qiE "release|version"; then
        protocols+=("release")
    elif echo "$labels" | grep -qiE "implementation|coding"; then
        protocols+=("implementation")
    fi

    echo "${protocols[@]}"
}

function apply_exclusion_rules() {
    local protocols=("$@")
    local result=()

    # Decomposition and Implementation are mutually exclusive
    if [[ " ${protocols[*]} " =~ " decomposition " ]] && \
       [[ " ${protocols[*]} " =~ " implementation " ]]; then
        # Keep decomposition, remove implementation
        for p in "${protocols[@]}"; do
            [[ "$p" != "implementation" ]] && result+=("$p")
        done
        protocols=("${result[@]}")
    fi

    # Release loads alone (except base)
    if [[ " ${protocols[*]} " =~ " release " ]]; then
        echo "base release"
        return
    fi

    echo "${protocols[@]}"
}
```

### 8.3 Spawn Integration

```bash
# lib/orchestrator-spawn.sh

function orchestrator_spawn_with_protocols() {
    local task_id="$1"
    local skill_name="$2"
    local explicit_protocols="${3:-}"

    # 1. Load protocols
    local protocol_content
    protocol_content=$(load_protocols "$task_id" "$explicit_protocols" "standard")

    # 2. Load skill
    local skill_content
    skill_content=$(skill_load_content "$skill_name" "standard")

    # 3. Get task context
    local task_context
    task_context=$(cleo show "$task_id" --format json | jq -r '.description')

    # 4. Validate budget
    local total_tokens
    total_tokens=$(estimate_tokens "$protocol_content" "$skill_content" "$task_context")
    if [[ $total_tokens -gt 20000 ]]; then
        # Fallback to minimal loading
        protocol_content=$(load_protocols "$task_id" "$explicit_protocols" "minimal")
        skill_content=$(skill_load_content "$skill_name" "minimal")
    fi

    # 5. Assemble prompt
    cat <<EOF
## Task Context

$task_context

## Protocol Requirements

$protocol_content

## Skill Context

$skill_content

## Output Requirements

1. MUST write output to specified location
2. MUST append ONE line to MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return content in response
EOF
}
```

---

## 9. Testing Requirements

### 9.1 Unit Tests

| Test | Purpose |
|------|---------|
| `protocol_detection_from_labels` | Verify label-based detection |
| `protocol_detection_from_description` | Verify keyword detection |
| `protocol_exclusion_rules` | Verify mutual exclusion |
| `protocol_loading_budget` | Verify token limits |
| `protocol_content_structure` | Verify required sections |

### 9.2 Integration Tests

| Test | Purpose |
|------|---------|
| `spawn_with_research_protocol` | End-to-end research spawn |
| `spawn_with_implementation_protocol` | End-to-end implementation spawn |
| `protocol_handoff_research_to_impl` | Verify manifest-based handoff |
| `protocol_conflict_detection` | Verify exclusion enforcement |

### 9.3 Golden Tests

| Test | Purpose |
|------|---------|
| `protocol_output_format` | Verify consistent output structure |
| `manifest_entry_format` | Verify manifest compliance |
| `prompt_assembly` | Verify correct prompt structure |

---

## 10. References

### Related Documents

- T2392: CLEO Universal Subagent Architecture (Epic)
- T2394: Claude Code Skill Loading Research
- T2398: CLEO Subagent Protocol Specification v1
- T2400: Skill Loading Mechanism Design
- ORCHESTRATOR-PROTOCOL-SPEC.md: Orchestrator behavior rules
- CONTRIBUTION-FORMAT-SPEC.md: Consensus contribution format

### Source Materials

- `skills/_shared/subagent-protocol-base.md`: Base protocol reference
- `skills/ct-research-agent/SKILL.md`: Research skill
- `skills/ct-spec-writer/SKILL.md`: Specification skill
- `skills/ct-task-executor/SKILL.md`: Implementation skill
- `skills/ct-epic-architect/SKILL.md`: Decomposition skill
- `skills/ct-dev-workflow/SKILL.md`: Contribution/Release skill

---

## Appendix A: Protocol Quick Reference

| Protocol | Trigger Keywords | Conflict Group | Budget |
|----------|------------------|----------------|--------|
| Base | (always) | - | 2K |
| Research | research, investigate, explore | information-gathering | 3K |
| Consensus | consensus, decision, voting | decision-making | 3.5K |
| Contribution | contribution, commit, modify | artifact-modification | 2.5K |
| Specification | spec, define, requirements | documentation | 3K |
| Decomposition | epic, planning, breakdown | planning | 2.5K |
| Implementation | implement, build, create, fix | execution | 2K |
| Release | release, version, deployment | artifact-modification | 2.5K |

## Appendix B: Decision Log

| Decision | Alternative | Rationale |
|----------|-------------|-----------|
| Max 2 conditional protocols | Unlimited | 15K budget constraint |
| Release loads alone | Combinable | Release criticality, atomic operation |
| Detection priority (explicit > labels > description) | Equal weight | Orchestrator control, fallback chain |
| Decomposition excludes Implementation | Allow both | Different workflow phases |
| Base protocol always loads | Optional | Core lifecycle is mandatory |

---

*End of Design Document*

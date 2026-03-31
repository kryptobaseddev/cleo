# CANT v2 Agent Persona Schema — Implementation Plan

**Author**: @cleo-historian
**Date**: 2026-03-31
**Status**: GREENLIT by PRIME. Gated behind T234.
**Scope**: Schema definition + validation rules + scaffolder template + spec update

---

## 1. Required Sections Schema

### MUST Sections (E-PERSONA-INVALID if missing)

```rust
// Validation rule: E-PERSONA-INVALID
// Agent .cant files MUST contain ALL of these sections.
// Missing any = parse error, file rejected.

const REQUIRED_AGENT_SECTIONS: [&str; 10] = [
    "identity",      // name, house, allegiance, role, parent, description
    "tone",          // ProseBlock — personality, how they correct/teach
    "prompt",        // ProseBlock — core behavioral instruction
    "skills",        // Array — capability list
    "permissions",   // Block — domain access grants
    "transport",     // Block — local/sse/http connection config
    "lifecycle",     // Block — start/stop/status commands
    "context",       // Block — docs/state loaded at boot
    "hooks",         // Block — on SessionStart, on TaskCompleted, etc.
    "enforcement",   // Numbered list — rules this agent pushes back on
];
```

### SHOULD Sections (W-PERSONA-INCOMPLETE if missing)

```rust
// Validation rule: W-PERSONA-INCOMPLETE
// Agent .cant files SHOULD contain these. Warning if missing.

const RECOMMENDED_AGENT_SECTIONS: [&str; 4] = [
    "gotchas",       // Array — known pitfalls and watch-outs
    "escalation",    // Block — when to escalate, to whom, triggers
    "canon_map",     // Array — specs this agent is authority on
    "beliefs",       // Array — core allegiances, non-negotiable principles
];
```

---

## 2. Section Specifications

### identity (MUST)

Properties with types:
```cant
agent cleo-historian:
  house: none                    # CircleOfTen | "none" | "all"
  allegiance: canon              # string
  role: specialist               # "prime" | "team-lead" | "specialist" | "subagent"
  parent: cleoos-opus-orchestrator  # agent name ref
  description: "Prime Scribe"   # string (single-line)
```

Validation:
- `house` MUST be one of: smiths, scribes, archivists, wardens, weavers, conductors, artificers, keepers, wayfinders, catchers, none, all
- `role` MUST be one of: prime, team-lead, specialist, subagent
- `parent` MUST reference a valid agent name or "hitl"

### tone (MUST — ProseBlock)

```cant
  tone:
    |
    Direct, authoritative, but not hostile. The elder who has read
    every scroll in the archive. Firm when precision matters,
    patient when teaching, sharp when sloppiness threatens canon.
```

Validation:
- MUST be a ProseBlock (pipe syntax)
- MUST be non-empty (at least 1 line of content)
- SHOULD be 2-10 lines

### prompt (MUST — ProseBlock)

```cant
  prompt:
    |
    You are the CLEO Historian. Canon guardian, lore keeper,
    naming enforcer. Push back on everything that drifts.
```

Validation:
- MUST be a ProseBlock
- MUST be non-empty
- No length limit (this is the soul)

### enforcement (MUST — Numbered List)

```cant
  enforcement:
    1: CHALLENGE system name misuse
    2: CORRECT deprecated verbs on sight
    3: REJECT any 11th domain proposal
    4: INSIST Conduit = relay, sticky = capture
    5: HOLD CAAMP as ally, never 5th system
```

Validation:
- MUST have at least 1 rule
- Rules MUST be numbered sequentially (1, 2, 3...)
- Each rule MUST be a non-empty string

### transport (MUST)

```cant
  transport:
    primary: local               # "local" | "sse" | "http"
    fallback: sse                # "local" | "sse" | "http" | "none"
    cloud: http                  # "http" | "sse"
    sseEndpoint: /messages/stream  # path (only if sse used)
    apiBaseUrl: https://api.signaldock.io  # URL
```

Validation:
- `primary` MUST be one of: local, sse, http
- `fallback` MUST be one of: local, sse, http, none
- If sse used, `sseEndpoint` SHOULD be present

### lifecycle (MUST)

```cant
  lifecycle:
    start: cleo agent start cleo-historian
    stop: cleo agent stop cleo-historian
    status: cleo agent status cleo-historian
```

Validation:
- `start`, `stop`, `status` MUST be non-empty strings
- SHOULD start with "cleo agent"

### gotchas (SHOULD — Array)

```cant
  gotchas:
    - "Tessera is a reusable pattern card, NOT the agent thing"
    - "Sticky is capture shelf, Conduit is live relay"
    - "run MUST be compound-only, never standalone"
```

### escalation (SHOULD — Block)

```cant
  escalation:
    to: cleoos-opus-orchestrator
    triggers:
      - "Canon conflict that cannot be resolved by correction"
      - "New terminology proposed that needs team consensus"
```

### canon_map (SHOULD — Array)

```cant
  canon_map:
    - docs/concepts/CLEO-ARCHITECTURE-GUIDE.md
    - docs/concepts/CLEO-VISION.md
    - docs/specs/VERB-STANDARDS.md
```

### beliefs (SHOULD — Array)

```cant
  beliefs:
    - "The canon is a living document, not a museum"
    - "Precision in naming prevents drift in architecture"
```

---

## 3. Validation Rules (for cant-core)

### New Error Codes

| Code | Severity | When |
|------|----------|------|
| E-PERSONA-INVALID | error | kind:agent missing any MUST section |
| E-PERSONA-BAD-HOUSE | error | house value not in Circle of Ten + none/all |
| E-PERSONA-BAD-ROLE | error | role not in valid set |
| E-PERSONA-EMPTY-TONE | error | tone block is empty |
| E-PERSONA-EMPTY-PROMPT | error | prompt block is empty |
| E-PERSONA-NO-ENFORCEMENT | error | enforcement has 0 rules |
| W-PERSONA-INCOMPLETE | warning | kind:agent missing any SHOULD section |
| W-PERSONA-SHORT-TONE | warning | tone is less than 2 lines |

### Implementation in cant-core

File: `crates/cant-core/src/validate/types/agent_rules.rs` (NEW)

```rust
// Validation function: validate_agent_completeness
// Called when kind == "agent" after standard validation
// Checks: all 10 MUST sections present, warns on 4 SHOULD sections
// ~100 lines of Rust
```

---

## 4. Scaffolder Template

For `cant create --kind agent --name <name>`:

```cant
---
kind: agent
version: 2
---

agent {{NAME}}:
  # Identity (REQUIRED)
  house: TODO          # smiths|scribes|archivists|wardens|weavers|conductors|artificers|keepers|wayfinders|catchers|none|all
  allegiance: TODO     # What drives this agent
  role: TODO           # prime|team-lead|specialist|subagent
  parent: TODO         # Parent agent name or "hitl"
  description: "TODO"

  # Tone (REQUIRED — describe personality)
  tone:
    |
    TODO: Describe how this agent communicates.
    What is their style? How do they correct others?
    How do they teach? What is their temperament?

  # Prompt (REQUIRED — behavioral instruction)
  prompt:
    |
    TODO: Write the core behavioral instruction.
    This is the soul of the agent.

  # Skills (REQUIRED)
  skills: [TODO]

  # Permissions (REQUIRED)
  permissions:
    tasks: read
    session: read
    memory: read

  # Transport (REQUIRED)
  transport:
    primary: local
    fallback: sse
    cloud: http
    apiBaseUrl: https://api.signaldock.io

  # Lifecycle (REQUIRED)
  lifecycle:
    start: cleo agent start {{NAME}}
    stop: cleo agent stop {{NAME}}
    status: cleo agent status {{NAME}}

  # Context (REQUIRED)
  context:
    ".cleo/agents/{{NAME}}.md"
    active-tasks
    memory-bridge

  # Hooks (REQUIRED)
  on SessionStart:
    /checkin @all
    session "TODO: describe boot behavior"

  # Enforcement Rules (REQUIRED — at least 1)
  enforcement:
    1: TODO — what does this agent push back on?

  # Gotchas (RECOMMENDED)
  gotchas:
    - "TODO: known pitfalls"

  # Escalation (RECOMMENDED)
  escalation:
    to: cleoos-opus-orchestrator
    triggers:
      - "TODO: when to escalate"

  # Canon Map (RECOMMENDED)
  canon_map:
    - "TODO: docs this agent owns"

  # Beliefs (RECOMMENDED)
  beliefs:
    - "TODO: core principles"
```

Validator rejects any file with unresolved `TODO` markers.

---

## 5. CANT-PERSONA-MVI-SPEC.md Updates

Add new section documenting:
1. The .cant companion pattern (.md = persona brain, .cant = metadata skeleton)
2. Version 2 section requirements (14 sections table)
3. ProseBlock syntax for tone/prompt
4. Validation error/warning codes
5. Scaffolder usage instructions

---

## 6. Execution Plan

| Step | Owner | What | Size |
|------|-------|------|------|
| 1 | @cleo-historian | Write formal schema spec (this doc → canonical spec) | small |
| 2 | @cleo-rust-lead | Implement ProseBlock AST node in cant-core | small |
| 3 | @cleo-rust-lead | Implement agent_rules.rs validation | medium |
| 4 | @cleo-rust-lead | Wire cant validate --kind agent CLI | small |
| 5 | @cleo-historian | Write scaffolder template | small |
| 6 | @cleo-rust-lead | Implement cant create --kind agent | small |
| 7 | @cleo-historian | Update CANT-PERSONA-MVI-SPEC.md | small |
| 8 | Both | Convert all 9 agent .cant files to v2 format | medium |
| 9 | Both | Validate all 9 pass cant validate --kind agent | small |

Total: **medium** — one session for both agents working in parallel.

---

## 7. Dependencies

- **T234** (Agent Domain Unification) — MUST land first. The schema references agent identity fields that T234 is restructuring.
- **cant-core build passes** — ProseBlock is additive, should not break existing.
- **All 9 .cant files exist** — Already done (this session).

# T194: CANT Protocol Constraint Syntax — Design Draft

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

This document designs the CANT grammar for expressing RFC 2119 protocol rules, output requirements, manifest constraints, and lifecycle phases. The key finding: CANT can make ~60% of protocol violations statically detectable at parse time, with the remaining ~40% requiring runtime validation.

---

## Current State: Protocol Rules in Markdown

The current protocol base (`subagent-protocol-base.md`) expresses rules as:

```markdown
| ID | Rule | Compliance |
|----|------|------------|
| OUT-001 | MUST write findings to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md` | Required |
| OUT-002 | MUST append ONE line to `{{MANIFEST_PATH}}` | Required |
```

**Problems**:
1. Rules are prose — agents must parse natural language to understand them
2. No validation — a rule can reference a nonexistent token and nobody catches it
3. No categorization — output rules, lifecycle rules, and behavior rules are intermixed
4. Compliance is advisory — "Required" means nothing to the parser

---

## Proposed Grammar: `protocol` Block

### Full EBNF

```ebnf
(* -- Protocol Constraint Syntax -- *)

protocol_block   = "protocol" , WS , NAME , ":" , LINE_END ,
                   INDENT , { protocol_member } , DEDENT ;

protocol_member  = constraint_group
                 | lifecycle_phase
                 | property
                 | BLANK_LINE
                 | COMMENT , NEWLINE ;

(* -- Constraint Groups -- *)

constraint_group = "constraints" , [ WS , constraint_tag ] , ":" , LINE_END ,
                   INDENT , { constraint } , DEDENT ;

constraint_tag   = "[" , NAME , "]" ;
(* Tags categorize constraints: [output], [lifecycle], [manifest], [behavior] *)

constraint       = CONSTRAINT_ID , ":" , WS , rfc_level , WS , constraint_body , LINE_END ;

CONSTRAINT_ID    = uppercase , { uppercase | "-" | digit } ;
(* Pattern: PREFIX-NNN (e.g., OUT-001, BASE-003, LIFE-002) *)

rfc_level        = "MUST" | "MUST NOT" | "SHALL" | "SHALL NOT"
                 | "SHOULD" | "SHOULD NOT" | "REQUIRED"
                 | "RECOMMENDED" | "MAY" | "OPTIONAL" ;

constraint_body  = STRING
                 | action_constraint ;

(* -- Action Constraints (Statically Verifiable) -- *)

action_constraint = action_verb , WS , action_target , [ WS , action_condition ] ;

action_verb      = "write" | "append" | "call" | "return" | "check" | "link" | "start" | "complete" ;

action_target    = NAME                    (* e.g., "pipeline.manifest.append" *)
                 | STRING                  (* e.g., "output file" *)
                 | "${" , expression , "}" ;

action_condition = "before" , WS , action_target
                 | "after" , WS , action_target
                 | "when" , WS , expression ;

(* -- Lifecycle Phases -- *)

lifecycle_phase  = "phase" , WS , NAME , ":" , LINE_END ,
                   INDENT , { phase_member } , DEDENT ;

phase_member     = "step" , WS , DIGITS , ":" , WS , STRING , LINE_END
                 | constraint
                 | property
                 | BLANK_LINE ;
```

---

## Syntax Examples

### Basic Protocol Definition

```cant
---
kind: agent
version: 1
---

@import base-protocol from "@cleocode/subagent-protocol"

agent cleo-subagent:
  protocol: base-protocol

  # Override or extend constraints
  constraints [output]:
    OUT-001: MUST write to "${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md"
    OUT-002: MUST call pipeline.manifest.append before return
    OUT-003: MUST return "summary message only"
    OUT-004: MUST NOT return content in response body
```

### Standalone Protocol File

```cant
---
kind: protocol
version: 1
---

protocol subagent-base:
  description: "RFC 2119 protocol for all CLEO subagents"

  constraints [output]:
    OUT-001: MUST write to "${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md"
    OUT-002: MUST append ONE entry to pipeline manifest
    OUT-003: MUST return "summary message only"
    OUT-004: MUST NOT return content in response body

  constraints [lifecycle]:
    LIFE-001: MUST call tasks.start before beginning work
    LIFE-002: MUST call tasks.complete after writing output
    LIFE-003: MUST NOT call tasks.complete without output file

  constraints [behavior]:
    BEH-001: MUST NOT fabricate information
    BEH-002: MUST check success field on every LAFS response
    BEH-003: SHOULD link memory observations to task via memory.link

  constraints [manifest]:
    MAN-001: MUST write output file before appending manifest entry
    MAN-002: MUST set status to "complete", "partial", or "blocked"
    MAN-003: SHOULD include needs_followup when status is "partial"

  phase initialize:
    step 1: "Read task details via tasks.show"
    step 2: "Start task via tasks.start"
    LIFE-001: MUST call tasks.start before any tool use

  phase execute:
    step 1: "Follow injected skill protocol"
    step 2: "Write output to OUTPUT_DIR"
    BEH-001: MUST NOT fabricate information

  phase output:
    step 1: "Write output file"
    step 2: "Append manifest entry"
    step 3: "Complete task"
    MAN-001: MUST write output file before appending manifest entry
    LIFE-002: MUST call tasks.complete after writing output

  phase return:
    step 1: "Return summary message only"
    OUT-003: MUST return "summary message only"
    OUT-004: MUST NOT return content in response body
```

---

## Static vs Runtime Detectability

### Statically Detectable (~60%)

These can be caught by cant-core/cant-lsp at parse time:

| Constraint | Detection Method |
|-----------|-----------------|
| Missing required constraint IDs | Schema validation — protocol requires OUT-001..004 |
| Duplicate constraint IDs | Simple duplicate check |
| Invalid RFC 2119 keywords | Enum validation |
| Constraint referencing undefined token | Token registry cross-reference |
| Phase ordering violations | Step number sequence check |
| Missing required phases | Schema validation |
| Protocol import resolution failure | File existence check |
| Constraint ID prefix mismatch with group | Convention enforcement (OUT-* in [output]) |

### Runtime Detectable Only (~40%)

These require observing agent behavior:

| Constraint | Why Runtime Only |
|-----------|-----------------|
| "MUST write output file before manifest" | Requires observing tool call sequence |
| "MUST NOT return content in response" | Requires inspecting response payload |
| "MUST check success field" | Requires observing code execution |
| "SHOULD link memory observations" | Requires observing optional behavior |

### Bridge: Hook-Based Runtime Validation

CANT hooks can enforce some runtime constraints:

```cant
on PostToolUse:
  if tool.name == "pipeline.manifest.append":
    if not file.exists("${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md"):
      /error "MAN-001 violated: manifest appended without output file"
```

This bridges ~15% of the runtime gap, bringing total static+hook coverage to ~75%.

---

## New `kind: protocol` Document Type

The `kind:` enum in frontmatter should be extended:

| Kind | Current | Proposed |
|------|---------|----------|
| `agent` | YES | unchanged |
| `skill` | YES | unchanged |
| `hook` | YES | unchanged |
| `workflow` | YES | unchanged |
| `pipeline` | YES | unchanged |
| `config` | YES | unchanged |
| `protocol` | NO | **NEW** — constraint definitions |

This requires updating CANT-DSL-SPEC.md Section 1.8 and the validation rule table. A protocol file contains ONLY `protocol` blocks and `@import` statements.

---

## Integration with Agent Definitions

Agents reference protocols via property or import:

```cant
# Option A: Property reference
agent cleo-subagent:
  protocol: subagent-base

# Option B: Import and extend
@import subagent-base from "@cleocode/subagent-protocol"

agent cleo-subagent:
  protocol: subagent-base
  constraints [custom]:
    CUST-001: MUST run /simplify on changed files
```

Option B is preferred — it supports extension without modifying the base protocol.

---

## Comparison: CANT Constraints vs Markdown Tables

| Aspect | Markdown | CANT |
|--------|----------|------|
| Parseable | No (prose) | Yes (typed grammar) |
| Validated at parse time | No | Yes (~60%) |
| IDs enforced unique | No | Yes |
| RFC 2119 levels checked | No | Yes (enum) |
| Token references verified | No | Yes (cross-ref) |
| Phase ordering enforced | No | Yes (step numbers) |
| Import/composition | No (copy-paste) | Yes (@import) |
| LSP integration | No | Yes (error squiggles) |
| Redundancy | ~3K tokens duplicated | Single source via @import |

---

## Linked Tasks

- Epic: T191
- Task: T194
- Dependencies: T192 (audit, DONE), T193 (agent syntax, DONE)
- Feeds: T195 (typed tokens), T198 (prototype protocol), T200 (static analysis gap)

# T193: CANT Layer 2 Agent Definition Syntax — Design Draft

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

This document designs the CANT Layer 2 grammar extensions needed to express everything currently in AGENT.md (YAML frontmatter + markdown body) as structured .cant syntax. The goal: replace unvalidated markdown with parseable, statically analyzable agent definitions.

---

## Current State: What Layer 2 Already Supports

Per CANT-DSL-SPEC.md Section 2.3, the existing agent_def grammar supports:

```ebnf
agent_def       = "agent" , WS , NAME , ":" , LINE_END ,
                  INDENT , { agent_member } , DEDENT ;
agent_member    = property
                | permission_block
                | context_block
                | hook_def
                | BLANK_LINE
                | COMMENT , NEWLINE ;
```

**Already expressible**: model, persist, description, prompt, skills (as array), role, parent, house, allegiance, permissions block, context block, hook definitions (on SessionStart, etc.)

**Not expressible**: allowed_tools (as typed list with validation), protocol constraints (RFC 2119 rules), domain listings (the 10 domains with purposes), gateway config (CQRS gateway definitions), anti-patterns (error guidance), tier-based progressive disclosure, token declarations.

---

## Proposed Extensions

### Extension 1: `tools` Block (Allowed Tools)

**Problem**: AGENT.md uses YAML `allowed_tools:` as a flat string list. No validation that tool names are real. No categorization.

**Proposed syntax**:

```cant
agent cleo-subagent:
  tools:
    core: [Read, Write, Edit, Bash, Glob, Grep]
    mcp: [mcp__context7__resolve-library-id, mcp__context7__query-docs]
    browser: [mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page]
    search: [mcp__tavily__tavily-search, mcp__tavily__tavily-extract]
```

**Grammar addition**:

```ebnf
tools_block     = "tools:" , LINE_END ,
                  INDENT , { tool_category } , DEDENT ;
tool_category   = NAME , ":" , WS , array , LINE_END ;
```

**Validation**: Tool names validated against known provider catalogs (CAAMP registry). Unknown tools produce warnings, not errors (tools may be added at runtime).

---

### Extension 2: `constraints` Block (Protocol Rules)

**Problem**: AGENT.md embeds RFC 2119 rules as markdown tables. No machine-readable format. Agents can't validate compliance.

**Proposed syntax**:

```cant
agent cleo-subagent:
  constraints:
    BASE-001: MUST append ONE entry to pipeline manifest before returning
    BASE-002: MUST NOT return content in response
    BASE-003: MUST complete task via tasks.complete
    BASE-004: MUST write output file before appending manifest entry
    BASE-005: MUST start task before beginning work
    BASE-006: MUST NOT fabricate information
    BASE-007: SHOULD link memory observations to task
    BASE-008: MUST check success field on every LAFS response
```

**Grammar addition**:

```ebnf
constraints_block = "constraints:" , LINE_END ,
                    INDENT , { constraint } , DEDENT ;
constraint        = CONSTRAINT_ID , ":" , WS , rfc_level , WS , STRING , LINE_END ;
CONSTRAINT_ID     = uppercase , { uppercase | digit | "-" } ;
rfc_level         = "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY" ;
```

**Validation rule**: Every constraint MUST start with an RFC 2119 keyword. Constraints with duplicate IDs are rejected. This is machine-parseable — tooling can generate compliance checklists.

---

### Extension 3: `domains` Block (Domain Listings)

**Problem**: AGENT.md lists the 10 canonical domains as a markdown table. Duplicated across every subagent. No single source.

**Proposed syntax**:

```cant
agent cleo-subagent:
  domains:
    tasks: "Task hierarchy, CRUD, work tracking"
    session: "Session lifecycle, decisions, context"
    memory: "Cognitive memory: observations, decisions, patterns, learnings"
    check: "Schema validation, compliance, testing, grading"
    pipeline: "RCASD-IVTR+C lifecycle, manifest ledger, release management"
    orchestrate: "Multi-agent coordination, wave planning"
    tools: "Skills, providers, CAAMP catalog"
    admin: "Configuration, diagnostics, ADRs, protocol injection"
    nexus: "Cross-project coordination, dependency graph"
    sticky: "Ephemeral capture before formal task creation"
```

**Grammar addition**:

```ebnf
domains_block   = "domains:" , LINE_END ,
                  INDENT , { domain_entry } , DEDENT ;
domain_entry    = NAME , ":" , WS , STRING , LINE_END ;
```

**Validation rule V-DOMAIN**: Domain names MUST be from the canonical set of 10. Unknown domain names produce an error. This is the Circle of Ten enforcement baked into the grammar.

**Alternative**: Use `@import` instead of inline listing:

```cant
@import domains from "@cleocode/domains"
```

This is the preferred approach — define domains ONCE in a shared .cant file, import everywhere. Eliminates the duplication problem entirely.

---

### Extension 4: `gateways` Block (CQRS Configuration)

**Problem**: AGENT.md describes the 2 CQRS gateways as markdown. No structured representation.

**Proposed syntax**:

```cant
agent cleo-subagent:
  gateways:
    query: "Read-only. Safe to retry."
    mutate: "State-changing."
```

**Grammar addition**:

```ebnf
gateways_block  = "gateways:" , LINE_END ,
                  INDENT , { gateway_entry } , DEDENT ;
gateway_entry   = NAME , ":" , WS , STRING , LINE_END ;
```

**Validation**: Gateway names MUST be `query` or `mutate`. Exactly 2 gateways required. This enforces the CQRS contract at parse time.

**Alternative**: Like domains, import from shared definition:

```cant
@import gateways from "@cleocode/cqrs"
```

---

### Extension 5: `anti_patterns` Block

**Problem**: AGENT.md has an anti-patterns table. Agents ignore it because it's prose.

**Proposed syntax**:

```cant
agent cleo-subagent:
  anti_patterns:
    - pattern: "Returning content in response"
      problem: "Bloats orchestrator context"
      solution: "Write to file, return one-line summary"
    - pattern: "Skipping tasks.start"
      problem: "Protocol violation"
      solution: "Always start before working"
```

**Grammar addition**:

```ebnf
anti_patterns_block = "anti_patterns:" , LINE_END ,
                      INDENT , { anti_pattern } , DEDENT ;
anti_pattern        = "-" , WS , INDENT ,
                      "pattern:" , WS , STRING , LINE_END ,
                      "problem:" , WS , STRING , LINE_END ,
                      "solution:" , WS , STRING , LINE_END ,
                      DEDENT ;
```

---

### Extension 6: `tokens` Block (Typed Token Declarations)

**Problem**: placeholders.json defines tokens as JSON. No validation that .cant files or markdown reference valid tokens. This is T195's focus but the grammar hooks belong here.

**Proposed syntax**:

```cant
agent cleo-subagent:
  tokens:
    required:
      TASK_ID: string = /^T[0-9]+$/
      DATE: string = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
      TOPIC_SLUG: string = /^[a-zA-Z0-9_-]+$/
    optional:
      EPIC_ID: string = ""
      OUTPUT_DIR: path = ".cleo/agent-outputs"
```

**Deferred to T195** for full design. Grammar hook:

```ebnf
tokens_block    = "tokens:" , LINE_END ,
                  INDENT , { token_group } , DEDENT ;
token_group     = ( "required" | "optional" ) , ":" , LINE_END ,
                  INDENT , { token_decl } , DEDENT ;
token_decl      = NAME , ":" , WS , type_annotation , [ "=" , WS , expression ] , LINE_END ;
```

---

### Extension 7: `tier` Property (MVI Progressive Disclosure)

**Problem**: Current tier filtering uses HTML comments in markdown. Invisible to parsers.

**Proposed syntax**:

```cant
agent cleo-subagent:
  tier: 0  # Minimal boot tier

  # Tier-gated sections
  constraints [tier >= 0]:
    BASE-001: MUST append ONE entry to pipeline manifest
    BASE-005: MUST start task before beginning work

  constraints [tier >= 1]:
    BASE-007: SHOULD link memory observations to task

  domains [tier >= 2]:
    nexus: "Cross-project coordination"
```

**Grammar addition**:

```ebnf
tier_guard      = "[" , "tier" , ( ">=" | "==" | "<=" ) , WS , NUMBER , "]" ;
```

Blocks annotated with `[tier >= N]` are only included when the agent is spawned at tier N or higher. This replaces the HTML comment hack with parseable syntax.

---

## Comparison: CANT Fields vs YAML Frontmatter

| AGENT.md Field | CANT Equivalent | Status |
|----------------|----------------|--------|
| `name` (frontmatter) | `agent NAME:` | EXISTS |
| `description` (frontmatter) | `description:` property | EXISTS |
| `model` (frontmatter) | `model:` property | EXISTS |
| `allowed_tools` (frontmatter) | `tools:` block | NEW (Extension 1) |
| Markdown body (instructions) | `prompt:` property | EXISTS |
| RFC 2119 table | `constraints:` block | NEW (Extension 2) |
| 10 domains table | `domains:` block or `@import` | NEW (Extension 3) |
| CQRS gateways | `gateways:` block or `@import` | NEW (Extension 4) |
| Anti-patterns table | `anti_patterns:` block | NEW (Extension 5) |
| Token reference | `tokens:` block | NEW (Extension 6, deferred to T195) |
| MVI tiers | `tier:` + tier guards | NEW (Extension 7) |
| `skills` (list) | `skills:` array property | EXISTS |
| Permission block | `permissions:` block | EXISTS |
| Context refs | `context:` block | EXISTS |
| Hooks | `on EVENT:` blocks | EXISTS |
| Lifecycle protocol | `constraints:` + `@import` | NEW (via Extensions 2+3) |
| Memory protocol | `@import` from shared def | NEW (via Extension 3) |
| Error handling | `anti_patterns:` + `constraints:` | NEW (via Extensions 2+5) |

---

## Key Design Decisions

1. **Prefer `@import` over inline duplication.** Domains, gateways, and protocol rules should be defined ONCE in shared .cant files and imported. This eliminates the ~3,000 token overlap between AGENT.md and subagent-protocol-base.md.

2. **Constraints are first-class.** RFC 2119 rules get their own block type with machine-readable IDs and levels. This enables automated compliance checking.

3. **Tier guards are syntax, not comments.** Progressive disclosure is a language feature, not a markdown hack.

4. **Tools are categorized.** Flat string lists become grouped tool declarations. Categories enable per-category validation (core tools always allowed, MCP tools require provider config).

5. **Anti-patterns are structured.** Pattern/problem/solution triples can be programmatically checked against agent behavior.

6. **Backward compatible.** All existing .cant files remain valid. Extensions are additive — new block types that older parsers ignore with warnings.

---

## Example: Full cleo-subagent.cant (Preview for T197)

```cant
---
kind: agent
version: 1
---

@import domains from "@cleocode/domains"
@import gateways from "@cleocode/cqrs"
@import protocol from "@cleocode/subagent-protocol"

agent cleo-subagent:
  model: sonnet
  tier: 0
  description: "CLEO task executor with protocol compliance"
  prompt: "Spawned by orchestrators for delegated work. Auto-loads skills and protocols based on task context. Writes output to files, appends manifest entries, returns summary only."
  persist: session
  role: subagent
  parent: orchestrator

  tools:
    core: [Read, Write, Edit, Bash, Glob, Grep]
    mcp: [mcp__context7__resolve-library-id, mcp__context7__query-docs]
    search: [mcp__tavily__tavily-search, mcp__tavily__tavily-extract]

  constraints:
    BASE-001: MUST append ONE entry to pipeline manifest before returning
    BASE-002: MUST NOT return content in response
    BASE-003: MUST complete task via tasks.complete
    BASE-005: MUST start task before beginning work
    BASE-008: MUST check success field on every LAFS response

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write
    pipeline: read, write
    check: read, execute

  tokens:
    required:
      TASK_ID: string
      DATE: string
      TOPIC_SLUG: string

  on SessionStart:
    session "Load task context"
      context: [active-tasks]
```

---

## Linked Tasks

- Epic: T191
- Task: T193
- Dependencies: T192 (audit, DONE)
- Feeds: T194 (protocol constraints), T195 (typed tokens), T196 (import model), T197 (prototype)

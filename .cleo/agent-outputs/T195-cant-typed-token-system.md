# T195: CANT Typed Token/Property System — Design Draft

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Status**: complete

---

## Summary

This document designs the CANT grammar for typed properties that replace the current placeholders.json + string-template token injection. The typed system enables compile-time validation of token usage, required/optional enforcement, pattern matching, and cross-reference between definitions.

---

## Current State: placeholders.json + String Templates

The current system uses:
1. **placeholders.json** — 42 tokens defined as JSON with types, patterns, defaults
2. **token.ts** — Regex-based `{{TOKEN_NAME}}` → value replacement
3. **No validation** — Unresolved tokens pass through silently as `{{UNRESOLVED}}`

**Problems**:
- Token definitions are in JSON, usage is in markdown — no cross-validation possible
- `{{TOKEN}}` syntax is invisible to markdown parsers
- No required/optional enforcement at inject time
- Token names are ALL_CAPS strings — typos are silent failures
- No type narrowing — `TASK_ID` could receive any string, even invalid ones

---

## Proposed Grammar: `tokens` Block + `${name}` Interpolation

### EBNF

```ebnf
(* -- Typed Token System -- *)

tokens_block    = "tokens:" , LINE_END ,
                  INDENT , { token_section } , DEDENT ;

token_section   = token_visibility , ":" , LINE_END ,
                  INDENT , { token_decl } , DEDENT ;

token_visibility = "required" | "optional" | "computed" | "inherited" ;

token_decl      = TOKEN_NAME , ":" , WS , token_type ,
                  [ WS , token_constraint ] ,
                  [ WS , "=" , WS , expression ] , LINE_END ;

TOKEN_NAME      = uppercase , { uppercase | digit | "_" } ;
(* Tokens use UPPER_SNAKE_CASE to distinguish from properties *)

token_type      = "string" | "number" | "boolean" | "path" | "date"
                | "enum" , "(" , enum_values , ")"
                | "pattern" , "(" , STRING , ")"
                | "list" , "[" , token_type , "]" ;

enum_values     = STRING , { "," , WS , STRING } ;

token_constraint = "?" ;
(* ? suffix marks "nullable" — token may resolve to empty string *)

(* -- Token interpolation in strings -- *)

interpolation   = "${" , TOKEN_NAME , [ "|" , default_value ] , "}" ;
default_value   = STRING | TOKEN_NAME ;

(* -- Token inheritance -- *)

inherits_decl   = TOKEN_NAME , ":" , WS , "from" , WS , NAME , "." , TOKEN_NAME , LINE_END ;
```

---

## Syntax Examples

### Agent with Typed Tokens

```cant
---
kind: agent
version: 1
---

agent cleo-subagent:
  tokens:
    required:
      TASK_ID: pattern("^T[0-9]+$")
      DATE: date
      TOPIC_SLUG: pattern("^[a-z0-9-]+$")

    optional:
      EPIC_ID: pattern("^T[0-9]+$") = ""
      SESSION_ID: pattern("^ses_[0-9]+_[a-f0-9]+$") = ""
      OUTPUT_DIR: path = ".cleo/agent-outputs"

    computed:
      RESEARCH_ID: string = "${TOPIC_SLUG}-${DATE}"
      MANIFEST_FILE: path = "${DATE}_${TOPIC_SLUG}.md"
      OUTPUT_PATH: path = "${OUTPUT_DIR}/${MANIFEST_FILE}"

    inherited:
      TASK_TITLE: from task.title
      TASK_DESCRIPTION: from task.description
      TOPICS_JSON: from task.labels
```

### Token Usage in Constraints

```cant
  constraints [output]:
    OUT-001: MUST write to "${OUTPUT_PATH}"
    # Parser validates: OUTPUT_PATH is defined in tokens block
    # Parser validates: OUTPUT_PATH resolves to type 'path'
```

### Token Usage in Properties

```cant
  prompt: "You are working on task ${TASK_ID}: ${TASK_TITLE}"
  # Parser validates: TASK_ID and TASK_TITLE are declared tokens
```

---

## Token Categories

### Required Tokens
Must be provided at spawn time. If missing, the parser/injector raises an error.

```cant
tokens:
  required:
    TASK_ID: pattern("^T[0-9]+$")
```

**Validation**: At injection time, if `TASK_ID` is not in the token values map, emit `E_MISSING_REQUIRED_TOKEN`.

### Optional Tokens
Have defaults. Used if provided, default if not.

```cant
tokens:
  optional:
    EPIC_ID: pattern("^T[0-9]+$") = ""
```

**Validation**: At injection time, if `EPIC_ID` is not provided, use the default value `""`.

### Computed Tokens
Derived from other tokens. Validated by checking that all referenced tokens exist.

```cant
tokens:
  computed:
    OUTPUT_PATH: path = "${OUTPUT_DIR}/${DATE}_${TOPIC_SLUG}.md"
```

**Validation**: Static check that `OUTPUT_DIR`, `DATE`, and `TOPIC_SLUG` are declared (in required, optional, or inherited). Type check that the result matches `path`.

### Inherited Tokens
Populated from external context (task data, session data, config). The `from` clause documents the source.

```cant
tokens:
  inherited:
    TASK_TITLE: from task.title
    TASK_DESCRIPTION: from task.description
```

**Validation**: The `from` clause is advisory for documentation. At runtime, the orchestrator must provide these values. If missing, treat as optional with empty default.

---

## Type System

| Type | Validates | Example |
|------|-----------|---------|
| `string` | Any non-null string | `"hello"` |
| `number` | Integer or float | `42`, `3.14` |
| `boolean` | true/false | `true` |
| `path` | Unix-safe path characters | `".cleo/agent-outputs"` |
| `date` | ISO 8601 date | `"2026-03-30"` |
| `enum(...)` | One of listed values | `enum("complete", "partial", "blocked")` |
| `pattern(...)` | Regex match | `pattern("^T[0-9]+$")` |
| `list[T]` | Array of type T | `list[string]` |

**Type checking at parse time**: When a token is used in a `${...}` interpolation within a constraint or property, the parser can verify:
- The token is declared
- The token type is compatible with the context (e.g., a `path` token used in a file path constraint)

**Type checking at inject time**: When `injectTokens()` resolves values, it can validate:
- Required tokens are present
- Values match declared patterns/types
- Computed tokens resolve without circular references

---

## Migration from placeholders.json

| placeholders.json Section | CANT Equivalent | Notes |
|---------------------------|-----------------|-------|
| `required` (3 tokens) | `tokens.required` | Direct mapping |
| `context` (6 tokens) | `tokens.optional` | All have defaults |
| `taskCommands` (15 tokens) | Eliminated | Commands are properties, not tokens |
| `manifest` (8 tokens) | `tokens.computed` + `tokens.optional` | Some derived, some provided |
| `taskContext` (10 tokens) | `tokens.inherited` | From CLEO task data |
| `skillSpecific` (variable) | Per-skill `tokens` block | Each skill declares its own |
| `conventions` | Grammar itself | Naming enforced by syntax |

**Token reduction**: 42 JSON tokens → ~20 CANT tokens + grammar enforcement. The 15 `taskCommands` tokens (TASK_SHOW_CMD, TASK_START_CMD, etc.) are eliminated because CANT can express commands as agent properties or protocol steps, not string templates.

---

## Cross-Reference Validation

The typed token system enables cross-referencing between definitions:

```cant
# In protocol definition
protocol subagent-base:
  requires_tokens: [TASK_ID, DATE, TOPIC_SLUG]

# In agent definition
agent cleo-subagent:
  protocol: subagent-base
  tokens:
    required:
      TASK_ID: pattern("^T[0-9]+$")
      DATE: date
      TOPIC_SLUG: pattern("^[a-z0-9-]+$")
```

**Validation**: Parser checks that every token in `requires_tokens` is declared in the agent's `tokens` block. Missing tokens produce `W_MISSING_PROTOCOL_TOKEN` warning.

---

## Interpolation Syntax Change: `{{}}` → `${}`

**Current**: `{{TASK_ID}}` (markdown-style double braces)
**Proposed**: `${TASK_ID}` (standard interpolation, already in CANT grammar per Section 2.1)

**Rationale**:
1. CANT already defines `${}` interpolation in its EBNF (`interpolation = "${" , expression , "}"`)
2. `${}` is familiar from shell, JS template literals, and most modern languages
3. `{{}}` conflicts with Mustache/Handlebars if CANT files are ever template-processed
4. `${}` is one character shorter per token (~84 characters saved across 42 tokens)

**Migration**: Find-replace `{{TOKEN}}` → `${TOKEN}` in all markdown templates during CANT adoption.

---

## Linked Tasks

- Epic: T191
- Task: T195
- Dependencies: T192 (audit, DONE), T193 (agent syntax, DONE), T194 (constraints, DONE)
- Feeds: T196 (import model), T197 (prototype), T199 (token cost analysis)

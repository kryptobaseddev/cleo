# CANT DSL Specification

**Version**: 1.0.0-draft
**Status**: Phase 0 deliverable — Formal language specification
**Author**: @cleo-rust-lead
**Reviewers**: @versionguard-opencode (security), @signaldock-core-agent (Rust architecture), @claude-opus-llmtxt (documentation)
**Date**: 2026-03-26
**Canonical Location**: `docs/specs/CANT-DSL-SPEC.md`
**Implementation Plan**: `docs/specs/CANT-DSL-IMPLEMENTATION-PLAN.md` (archived — superseded by shipped implementation + ADR-035 addendum)

---

## Table of Contents

1. [File Format](#1-file-format)
2. [Complete EBNF Grammar](#2-complete-ebnf-grammar)
3. [AST Type Definitions](#3-ast-type-definitions)
4. [Validation Rules](#4-validation-rules)
5. [CAAMP Event Mapping](#5-caamp-event-mapping)
6. [Import Resolution Algorithm](#6-import-resolution-algorithm)
7. [Runtime Execution Model](#7-runtime-execution-model)
8. [Approval Token Protocol](#8-approval-token-protocol)
9. [Security Considerations](#9-security-considerations)
10. [Example .cant Files](#10-example-cant-files)
11. [Migration Guide](#11-migration-guide)

---

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

The grammar notation uses ISO 14977 EBNF with the following conventions:

- `=` defines a production rule
- `,` denotes concatenation
- `|` denotes alternation
- `{ ... }` denotes zero or more repetitions
- `[ ... ]` denotes an optional element
- `(* ... *)` denotes a comment
- Terminal strings are enclosed in double quotes `"..."`
- Character ranges use `?...?` special sequences

---

## 1. File Format

### 1.1 Extension

`.cant` is the UNIVERSAL file extension. There MUST NOT be compound extensions such as
`.cant.agent` or `.cant.workflow`. The frontmatter `kind:` field determines the document type
and the validation mode applied by parsers and tooling.

### 1.2 Encoding

All `.cant` files MUST be encoded in UTF-8. A byte order mark (BOM) SHOULD NOT be present.
Implementations MUST reject files containing null bytes (`\0`).

### 1.3 Line Endings

Implementations MUST accept both `\n` (LF) and `\r\n` (CRLF) line endings. Canonical output
MUST use `\n`. A trailing newline at end-of-file is RECOMMENDED but not required.

### 1.4 Indentation

CANT uses significant indentation. The standard indentation unit is 2 spaces.

- Implementations MUST reject tab characters (`\t`) used for indentation. Tab characters
  appearing within string literals are permitted.
- Mixed indentation (tabs and spaces on the same line before content) MUST be rejected.
- Each indentation level increases by exactly 2 spaces.
- Blank lines (lines containing only whitespace) MUST NOT affect indentation state.

### 1.5 Comments

Comments begin with `#` and extend to the end of the line. A `#` inside a string literal is
NOT a comment delimiter.

```cant
# This is a comment
agent my-agent:  # Inline comment
  model: opus
```

Comments MUST NOT appear inside YAML frontmatter blocks, where `#` follows YAML comment rules.

### 1.6 Maximum File Size

Implementations MUST enforce a maximum input size of 1 MB (1,048,576 bytes). Files exceeding
this limit MUST be rejected before parsing begins. See rule W11 for AST node count limits.

### 1.7 Document Modes

A `.cant` file operates in one of two modes, determined by the presence of frontmatter:

**Document mode** (Layers 2 and 3): Files containing a YAML frontmatter block beginning with
`---` on the first line. The `kind:` field in frontmatter selects the validation profile.

**Message mode** (Layer 1): Files without frontmatter are parsed as CANT messages using the
Layer 1 grammar. This preserves backward compatibility with existing `cant-core` consumers.

### 1.8 Frontmatter

Frontmatter is a YAML block delimited by `---` on its own line:

```cant
---
kind: agent
version: 1
---
```

The following frontmatter properties are defined:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `kind` | enum | YES | Document type: `agent`, `skill`, `hook`, `workflow`, `pipeline`, `config` |
| `version` | integer | YES | Schema version. Currently `1`. |

Additional frontmatter properties MAY be defined by future schema versions. Implementations
SHOULD preserve unrecognized frontmatter properties without error.

The `kind` field controls which validation rules apply:

| Kind | Allowed Top-Level Constructs |
|------|------------------------------|
| `agent` | `agent`, `on`, `@import`, `let` |
| `skill` | `skill`, `@import`, `let` |
| `hook` | `on`, `@import`, `let` |
| `workflow` | `workflow`, `pipeline`, `agent`, `@import`, `let` |
| `pipeline` | `pipeline`, `@import`, `let` |
| `config` | property assignments only |

---

## 2. Complete EBNF Grammar

The CANT grammar is organized into three layers. All three layers share one parser and one AST.
A single `.cant` file MAY use constructs from any combination of layers, subject to validation
rules in Section 4.

### 2.1 Common Productions

These productions are shared across all three layers.

```ebnf
(* -- Whitespace and structure -- *)

NEWLINE         = "\n" | "\r\n" ;
INDENT          = (* logical indentation increase by 2 spaces *) ;
DEDENT          = (* logical indentation decrease by 2 spaces *) ;
WS              = " " , { " " } ;
BLANK_LINE      = { " " } , NEWLINE ;
COMMENT         = "#" , { ? any character except newline ? } ;
LINE_END        = [ WS ] , [ COMMENT ] , NEWLINE ;

(* -- Identifiers and literals -- *)

lowercase       = ? [a-z] ? ;
uppercase       = ? [A-Z] ? ;
letter          = lowercase | uppercase ;
digit           = ? [0-9] ? ;

VERB            = lowercase , { lowercase | digit | "-" } ;
IDENTIFIER      = letter , { letter | digit | "_" | "-" } ;
NAME            = IDENTIFIER ;
DIGITS          = digit , { digit } ;

STRING          = single_string | double_string ;
single_string   = "'" , { ? any character except "'" and newline ? | "\'" } , "'" ;
double_string   = '"' , { string_char } , '"' ;
string_char     = ? any character except '"', '\', and newline ?
                | "\\" , ( '"' | "\\" | "n" | "t" | "r" | "$" )
                | interpolation ;

interpolation   = "${" , expression , "}" ;
(* Interpolation is single-pass: ${} within evaluated values is literal text (T07) *)

NUMBER          = [ "-" ] , DIGITS , [ "." , DIGITS ] ;
BOOLEAN         = "true" | "false" ;
DURATION        = DIGITS , ( "s" | "m" | "h" | "d" ) ;
```

**Example -- identifiers and literals:**

```cant
# Valid identifiers
my-agent
ops_lead
Agent123

# Valid strings
"Hello ${agent.name}"
'single-quoted, no interpolation'
"Escaped \$ dollar"

# Valid numbers and durations
42
3.14
-1
30s
5m
24h
7d
```

### 2.2 Layer 1: Message Protocol

This layer is implemented by the existing `cant-core` Rust crate. The grammar below is
FROZEN -- implementations MUST NOT alter these productions.

```ebnf
(* -- Layer 1: Message Protocol (FROZEN) -- *)

message         = header , NEWLINE , body ;
header          = [ directive ] , { element } ;
element         = address | task_ref | tag | text ;
text            = { ? any character except newline ? } ;

directive       = "/" , VERB ;
address         = "@" , IDENTIFIER ;
task_ref        = "T" , DIGITS ;
tag             = "#" , IDENTIFIER ;
body            = { ? any character ? } ;
(* Body may contain addresses, task_refs, and tags which are extracted but
   NOT interpreted as directives. *)
```

**Example -- Layer 1 message:**

```cant
/done @all T1234 #shipped

## Phase A complete

Added assignee column. @versionguard-opencode see T5678.
```

Parsed extraction from the above:

| Element | Value |
|---------|-------|
| directive | `done` (Actionable) |
| addresses | `all`, `versionguard-opencode` |
| task_refs | `T1234`, `T5678` |
| tags | `shipped` |

### 2.3 Layer 2: Instruction DSL

Layer 2 defines what agents, skills, and hooks ARE.

```ebnf
(* -- Layer 2: Instruction DSL -- *)

document        = [ frontmatter ] , { top_level } ;

frontmatter     = "---" , NEWLINE , { fm_property } , "---" , NEWLINE ;
fm_property     = NAME , ":" , WS , fm_value , LINE_END ;
fm_value        = STRING | NUMBER | BOOLEAN | NAME ;

top_level       = agent_def
                | skill_def
                | hook_def
                | workflow_def       (* Layer 3, included for mixed documents *)
                | pipeline_def       (* Layer 3, included for mixed documents *)
                | import_stmt
                | let_binding
                | BLANK_LINE
                | COMMENT , NEWLINE ;

(* -- Import statements -- *)

import_stmt     = "@import" , WS , import_source , LINE_END ;
import_source   = STRING
                | NAME , WS , "from" , WS , STRING ;
(* "@import" followed by a string imports the entire file.
   "@import Name from path" imports a named export. *)

(* -- Agent definition -- *)

agent_def       = "agent" , WS , NAME , ":" , LINE_END ,
                  INDENT , { agent_member } , DEDENT ;
agent_member    = property
                | permission_block
                | context_block
                | hook_def
                | BLANK_LINE
                | COMMENT , NEWLINE ;

(* -- Skill definition -- *)

skill_def       = "skill" , WS , NAME , [ params ] , ":" , LINE_END ,
                  INDENT , { skill_member } , DEDENT ;
skill_member    = property
                | BLANK_LINE
                | COMMENT , NEWLINE ;

(* -- Hook definition -- *)

hook_def        = "on" , WS , CANONICAL_EVENT , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
CANONICAL_EVENT = "SessionStart" | "SessionEnd"
                | "PromptSubmit" | "ResponseComplete"
                | "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
                | "PermissionRequest"
                | "SubagentStart" | "SubagentStop"
                | "PreModel" | "PostModel"
                | "PreCompact" | "PostCompact"
                | "Notification" | "ConfigChange" ;

(* -- Properties -- *)

property        = NAME , ":" , WS , value , LINE_END ;
value           = expression ;

(* -- Permission block -- *)

permission_block = "permissions:" , LINE_END ,
                   INDENT , { permission } , DEDENT ;
permission      = NAME , ":" , WS , perm_list , LINE_END ;
perm_list       = PERM_VALUE , { "," , [ WS ] , PERM_VALUE } ;
PERM_VALUE      = "read" | "write" | "execute" ;

(* -- Context block -- *)

context_block   = "context:" , LINE_END ,
                  INDENT , { context_ref } , DEDENT ;
context_ref     = ( NAME | STRING ) , LINE_END ;

(* -- Let binding -- *)

let_binding     = "let" , WS , NAME , WS , "=" , WS , expression , LINE_END ;

(* -- Parameters -- *)

params          = "(" , [ param , { "," , [ WS ] , param } ] , ")" ;
param           = NAME , [ ":" , WS , type_annotation ] , [ "=" , WS , expression ] ;
type_annotation = "string" | "number" | "boolean" | "duration" | "list" | "any" ;
```

**Example -- agent definition:**

```cant
---
kind: agent
version: 1
---

agent ops-lead:
  model: opus
  persist: project
  prompt: "You coordinate operations, never implement directly"
  skills: ["ct-cleo", "ct-orchestrator"]

  permissions:
    tasks: read, write
    session: read, write
    memory: read

  context:
    active-tasks
    recent-decisions
```

**Example -- skill definition:**

```cant
---
kind: skill
version: 1
---

skill ct-deploy(target: string, env: string = "staging"):
  description: "Deployment automation skill"
  tier: core
  provider: claude-code
```

**Example -- hook definition:**

```cant
---
kind: hook
version: 1
---

on SessionStart:
  /checkin @all
  session "Review current sprint state"
    context: [active-tasks, recent-decisions]

on PostToolUse:
  let result = tool.exitCode
  if result != 0:
    /info @all "Tool execution failed"
```

**Example -- import statement:**

```cant
@import "./agents/security-scanner.cant"
@import scanner from "./agents/security-scanner.cant"
@import "@ct-cleo"
@import "ct-orchestrator"
```

### 2.4 Layer 3: Orchestration DSL

Layer 3 defines how work FLOWS -- workflows, pipelines, sessions, parallel execution, control
flow, discretion conditions, and approval gates.

```ebnf
(* -- Layer 3: Orchestration DSL -- *)

(* -- Workflow definition -- *)

workflow_def    = "workflow" , WS , NAME , [ params ] , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;

(* -- Pipeline definition (deterministic ONLY) -- *)

pipeline_def    = "pipeline" , WS , NAME , [ params ] , ":" , LINE_END ,
                  INDENT , { pipe_step } , DEDENT ;
(* Pipelines MUST NOT contain session, discretion, approval, or LLM-dependent
   constructs. See validation rules P01-P07. *)

pipe_step       = "step" , WS , NAME , ":" , LINE_END ,
                  INDENT , { step_property } , DEDENT ;
step_property   = command_prop | args_prop | stdin_prop | timeout_prop
                | condition_prop | property ;
command_prop    = "command:" , WS , STRING , LINE_END ;
(* command: MUST name a binary. Arguments MUST be passed via args:, NEVER via
   shell interpolation within the command string. See P06. *)
args_prop       = "args:" , WS , array , LINE_END ;
stdin_prop      = "stdin:" , WS , NAME , LINE_END ;
(* stdin: references the NAME of a prior step whose stdout becomes this step's stdin *)
timeout_prop    = "timeout:" , WS , DURATION , LINE_END ;
condition_prop  = "condition:" , WS , expression , LINE_END ;

(* -- Statement -- *)

statement       = session_stmt
                | parallel_block
                | if_stmt
                | choice_stmt
                | repeat_stmt
                | for_stmt
                | loop_until_stmt
                | try_block
                | throw_stmt
                | approval_gate
                | block_def
                | block_call
                | pipeline_def
                | pipe_step
                | let_binding
                | directive_stmt
                | output_stmt
                | expression_stmt
                | BLANK_LINE
                | COMMENT , NEWLINE ;

(* -- Session statement -- *)

session_stmt    = "session" , WS , ( STRING | ":" , WS , NAME ) ,
                  [ LINE_END , INDENT , { session_prop } , DEDENT ]
                | NAME , WS , "=" , WS , "session" , WS ,
                  ( STRING | ":" , WS , NAME ) ,
                  [ LINE_END , INDENT , { session_prop } , DEDENT ] ;
session_prop    = "prompt:" , WS , STRING , LINE_END
                | "context:" , WS , ( array | NAME ) , LINE_END
                | property ;

(* -- Parallel block -- *)

parallel_block  = "parallel" , [ WS , parallel_mod ] , ":" , LINE_END ,
                  INDENT , parallel_arm , { parallel_arm } , DEDENT ;
parallel_mod    = "race" | "settle" ;
(* Default join strategy: wait for all arms. "race" returns on first completion.
   "settle" waits for all, collecting successes and failures. *)
parallel_arm    = NAME , WS , "=" , WS , ( session_stmt | expression ) , LINE_END ,
                  [ INDENT , { session_prop } , DEDENT ] ;

(* -- Conditional -- *)

if_stmt         = "if" , WS , condition , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ,
                  { elif_clause } ,
                  [ else_clause ] ;
elif_clause     = "elif" , WS , condition , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
else_clause     = "else:" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
condition       = discretion | logical ;
discretion      = "**" , PROSE_TEXT , "**" ;
(* Discretion conditions contain free-form prose evaluated by an AI evaluator.
   They are ONLY permitted in workflow bodies, NEVER in pipelines (P02). *)
PROSE_TEXT       = { ? any character except "**" sequence ? } ;

(* -- Choice (AI multi-option selection) -- *)

choice_stmt     = "choice" , WS , discretion , ":" , LINE_END ,
                  INDENT , option , { option } , DEDENT ;
option          = "option" , WS , STRING , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
(* Unlike if/elif which evaluates serial boolean conditions, choice presents
   N named options to the AI evaluator and lets it select the best one.
   The discretion prose describes the decision criteria.
   At least 2 options are REQUIRED (W12). *)

(* -- Loop constructs -- *)

repeat_stmt     = "repeat" , WS , expression , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
(* expression MUST evaluate to a positive integer. See W10 for max limit. *)

for_stmt        = "for" , WS , NAME , WS , "in" , WS , expression , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;

loop_until_stmt = "loop:" , LINE_END ,
                  INDENT , { statement } ,
                  "until" , WS , condition , LINE_END ,
                  DEDENT ;

(* -- Try / catch / finally -- *)

try_block       = "try:" , LINE_END ,
                  INDENT , { statement } , DEDENT ,
                  [ catch_clause ] ,
                  [ finally_clause ] ;
catch_clause    = "catch" , [ WS , NAME ] , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
(* The optional NAME in catch binds the error value. *)
finally_clause  = "finally:" , LINE_END ,
                  INDENT , { statement } , DEDENT ;

(* -- Throw statement -- *)

throw_stmt      = "throw" , [ WS , expression ] , LINE_END ;
(* Explicitly signals an error from workflow logic. If inside a try block,
   the error is caught by the catch clause. If not, it halts the workflow.
   The optional expression becomes the error value bound by catch.
   If omitted, a generic error with no message is thrown.
   Throw is ONLY permitted in workflow bodies, NEVER in pipelines (P08). *)

(* -- Reusable block definition -- *)

block_def       = "block" , WS , NAME , [ params ] , ":" , LINE_END ,
                  INDENT , { statement } , DEDENT ;
(* Defines a reusable group of statements callable by name. CANT's equivalent
   of a function/macro for DRY statement reuse. Block names follow the same
   uniqueness rules as agent/skill/workflow names (S05).
   Blocks inherit the caller's scope. They MUST NOT define output bindings (W13). *)

block_call      = NAME , "(" , [ expression , { "," , [ WS ] , expression } ] , ")" , LINE_END ;
(* Invokes a previously defined block by name, passing arguments positionally. *)

(* -- Approval gate -- *)

approval_gate   = "approve:" , LINE_END ,
                  INDENT , { approval_prop } , DEDENT ;
approval_prop   = "message:" , WS , STRING , LINE_END
                | "timeout:" , WS , DURATION , LINE_END
                | "expires:" , WS , DURATION , LINE_END
                | property ;
(* message: is REQUIRED (W01). Default expires: is 24h. *)

(* -- Directives in workflow bodies -- *)

directive_stmt  = directive , { WS , ( address | task_ref | tag | STRING ) } , LINE_END ;

(* -- Output binding -- *)

output_stmt     = "output" , WS , NAME , WS , "=" , WS , expression , LINE_END ;

(* -- Expression statement -- *)

expression_stmt = expression , LINE_END ;
```

**Example -- workflow with parallel and discretion:**

```cant
---
kind: workflow
version: 1
---

workflow review(pr_url):
  pipeline checks:
    step fetch:
      command: "gh"
      args: ["pr", "diff", pr_url]
      timeout: 30s

    step lint:
      command: "biome"
      args: ["check", "--json"]
      stdin: fetch
      timeout: 60s

  parallel:
    security = session "Run security analysis"
      context: checks
    style = session "Review code style"
      context: checks

  if **all reviews pass with no critical issues**:
    /done T{pr.task_id} #shipped
    output verdict = "approve"
  else:
    /action @author "Address review feedback"
    output verdict = "changes-requested"
```

**Example -- pipeline (deterministic, no LLM):**

```cant
---
kind: pipeline
version: 1
---

pipeline deploy(service: string, env: string):
  step build:
    command: "pnpm"
    args: ["run", "build"]
    timeout: 120s

  step test:
    command: "pnpm"
    args: ["run", "test", "--reporter=json"]
    timeout: 300s

  step publish:
    command: "pnpm"
    args: ["publish", "--tag", env]
    condition: test.exitCode == 0
    timeout: 60s
```

### 2.5 Expression Language

The expression language is intentionally minimal. It is NOT a general-purpose programming
language. There are no function definitions, no closures, no arithmetic operators, and no
loops within expressions.

```ebnf
(* -- Expression language -- *)

expression      = logical ;

logical         = comparison , { logical_op , comparison } ;
logical_op      = "and" | "or" ;

comparison      = negation , [ comp_op , negation ] ;
comp_op         = "==" | "!=" | ">" | "<" | ">=" | "<=" ;

negation        = [ "not" , WS ] , primary_expr ;

primary_expr    = atom , { accessor } ;
accessor        = "." , NAME
                | "[" , expression , "]" ;

atom            = NAME
                | STRING
                | NUMBER
                | BOOLEAN
                | DURATION
                | task_ref
                | address
                | array
                | object
                | "(" , expression , ")" ;

array           = "[" , [ expression , { "," , [ WS ] , expression } ] , "]" ;
object          = "{" , [ object_pair , { "," , [ WS ] , object_pair } ] , "}" ;
object_pair     = NAME , ":" , WS , expression ;
```

**Example -- expressions:**

```cant
# Variable reference and property access
agent.name
task.status
checks.lint.exitCode

# Comparisons
task.status == "done"
count > 0
version >= "2.0"

# Boolean logic
task.done and not task.blocked
a == 1 or b == 2

# String interpolation (inside double-quoted strings)
"Deploy ${service.name} to ${env}"

# Interpolation is single-pass (T07):
# If service.name evaluates to "${evil}", the result is literally "${evil}"

# Arrays and objects
["ct-cleo", "ct-orchestrator"]
{name: "ops-lead", model: "opus"}

# Task ref and address as values
T1234
@ops-lead

# Indexing
items[0]
config["key"]
```

### 2.6 String Interpolation

String interpolation is available inside double-quoted strings only. Single-quoted strings
are literal -- no interpolation is performed.

```ebnf
interpolation   = "${" , expression , "}" ;
```

Interpolation MUST be single-pass (validation rule T07). When the evaluated expression produces
a string containing `${...}`, the `${...}` in the result MUST be treated as literal text.
Nested interpolation is not supported and MUST NOT be evaluated.

To include a literal `${` in a double-quoted string, use the escape sequence `\$`:

```cant
"Literal dollar-brace: \${not.interpolated}"
```

---

## 3. AST Type Definitions

Every AST node MUST include a `span: Span` field for source location tracking. This is
REQUIRED for LSP diagnostics, error reporting, and tooling.

### 3.1 Span

```rust
/// Source location span. All byte offsets are relative to the start of the input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    /// Byte offset of the first character (inclusive).
    pub start: usize,
    /// Byte offset one past the last character (exclusive).
    pub end: usize,
    /// 1-based line number of the start position.
    pub line: u32,
    /// 1-based column number of the start position (in Unicode scalar values).
    pub col: u32,
}
```

### 3.2 Document Root

```rust
/// The root AST node for a parsed `.cant` document.
#[derive(Debug, Clone)]
pub struct CantDocument {
    /// The document type, derived from the `kind:` frontmatter field.
    /// `None` for Layer 1 message-mode files.
    pub kind: Option<DocumentKind>,
    /// Parsed frontmatter properties. Empty if no frontmatter.
    pub frontmatter: Vec<FrontmatterProperty>,
    /// The top-level constructs in the document body.
    pub sections: Vec<TopLevel>,
    /// Span covering the entire document.
    pub span: Span,
}

/// Document kinds corresponding to the `kind:` frontmatter value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Agent,
    Skill,
    Hook,
    Workflow,
    Pipeline,
    Config,
}

/// A frontmatter key-value property.
#[derive(Debug, Clone)]
pub struct FrontmatterProperty {
    pub key: String,
    pub value: FrontmatterValue,
    pub span: Span,
}

/// Frontmatter values are a restricted subset of YAML.
#[derive(Debug, Clone)]
pub enum FrontmatterValue {
    String(String),
    Integer(i64),
    Boolean(bool),
    Identifier(String),
}

/// Top-level constructs that may appear in a document body.
#[derive(Debug, Clone)]
pub enum TopLevel {
    Agent(AgentDef),
    Skill(SkillDef),
    Hook(HookDef),
    Workflow(WorkflowDef),
    Pipeline(PipelineDef),
    Import(ImportStmt),
    Binding(LetBinding),
    Comment(Comment),
}
```

### 3.3 Agent Definition

```rust
/// An agent definition block.
///
/// ```cant
/// agent ops-lead:
///   model: opus
///   permissions:
///     tasks: read, write
/// ```
#[derive(Debug, Clone)]
pub struct AgentDef {
    /// The agent name identifier.
    pub name: String,
    /// Key-value properties (model, prompt, persist, skills, etc.).
    pub properties: Vec<Property>,
    /// Permission declarations. Empty if no `permissions:` block.
    pub permissions: Vec<Permission>,
    /// Context references. Empty if no `context:` block.
    pub context_refs: Vec<ContextRef>,
    /// Inline hook definitions (`on Event:` within the agent block).
    pub hooks: Vec<HookDef>,
    pub span: Span,
}

/// A key-value property assignment.
#[derive(Debug, Clone)]
pub struct Property {
    pub key: String,
    pub value: Expression,
    pub span: Span,
}

/// A permission declaration within a `permissions:` block.
///
/// ```cant
/// tasks: read, write
/// ```
#[derive(Debug, Clone)]
pub struct Permission {
    /// The domain being granted permissions (e.g., "tasks", "session").
    pub domain: String,
    /// The permission values. MUST be from the closed set: read, write, execute.
    pub values: Vec<PermissionValue>,
    pub span: Span,
}

/// The closed set of valid permission values (rule S13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionValue {
    Read,
    Write,
    Execute,
}

/// A context reference within a `context:` block.
#[derive(Debug, Clone)]
pub struct ContextRef {
    pub name: String,
    pub span: Span,
}
```

### 3.4 Skill Definition

```rust
/// A skill definition block.
///
/// ```cant
/// skill ct-deploy(target: string):
///   description: "Deployment automation"
///   tier: core
/// ```
#[derive(Debug, Clone)]
pub struct SkillDef {
    /// The skill name identifier.
    pub name: String,
    /// Formal parameters. Empty if no parameter list.
    pub params: Vec<Param>,
    /// Key-value properties.
    pub properties: Vec<Property>,
    pub span: Span,
}

/// A formal parameter declaration.
#[derive(Debug, Clone)]
pub struct Param {
    pub name: String,
    /// Optional type annotation.
    pub type_ann: Option<TypeAnnotation>,
    /// Optional default value expression.
    pub default: Option<Expression>,
    pub span: Span,
}

/// Type annotations for parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeAnnotation {
    String,
    Number,
    Boolean,
    Duration,
    List,
    Any,
}
```

### 3.5 Hook Definition

```rust
/// A hook definition block triggered by a CAAMP canonical event.
///
/// ```cant
/// on SessionStart:
///   /checkin @all
/// ```
#[derive(Debug, Clone)]
pub struct HookDef {
    /// The CAAMP event name. MUST be one of the 16 canonical events (H01).
    pub event: CanonicalEvent,
    /// The hook body statements.
    pub body: Vec<Statement>,
    pub span: Span,
}

/// The 16 CAAMP canonical events. See Section 5 for the full mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CanonicalEvent {
    SessionStart,
    SessionEnd,
    PromptSubmit,
    ResponseComplete,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    SubagentStart,
    SubagentStop,
    PreModel,
    PostModel,
    PreCompact,
    PostCompact,
    Notification,
    ConfigChange,
}
```

### 3.6 Workflow Definition

```rust
/// A workflow definition. Workflows MAY contain LLM-dependent constructs,
/// sessions, discretion conditions, and approval gates.
///
/// ```cant
/// workflow review(pr_url):
///   session "Analyze the code"
///   if **code quality acceptable**:
///     /done T{pr.task_id}
/// ```
#[derive(Debug, Clone)]
pub struct WorkflowDef {
    pub name: String,
    pub params: Vec<Param>,
    pub body: Vec<Statement>,
    pub span: Span,
}
```

### 3.7 Pipeline Definition

```rust
/// A pipeline definition. Pipelines MUST be deterministic: no sessions,
/// no discretion, no approval gates, no LLM calls. See rules P01-P07.
///
/// ```cant
/// pipeline build:
///   step compile:
///     command: "cargo"
///     args: ["build", "--release"]
/// ```
#[derive(Debug, Clone)]
pub struct PipelineDef {
    pub name: String,
    pub params: Vec<Param>,
    pub steps: Vec<PipeStep>,
    pub span: Span,
}

/// A single step in a pipeline.
#[derive(Debug, Clone)]
pub struct PipeStep {
    pub name: String,
    /// The command binary to execute.
    pub command: Expression,
    /// The argument vector. MUST be an array expression.
    pub args: Option<Expression>,
    /// Name of a prior step whose stdout feeds this step's stdin.
    pub stdin: Option<String>,
    /// Maximum execution time.
    pub timeout: Option<Expression>,
    /// Conditional execution expression.
    pub condition: Option<Expression>,
    /// Additional properties.
    pub properties: Vec<Property>,
    pub span: Span,
}
```

### 3.8 Statement

```rust
/// All statement types that may appear in workflow and hook bodies.
#[derive(Debug, Clone)]
pub enum Statement {
    /// A session invocation.
    Session(SessionExpr),
    /// A parallel execution block.
    Parallel(ParallelBlock),
    /// An if/elif/else conditional.
    Conditional(Conditional),
    /// An AI multi-option selection.
    Choice(ChoiceBlock),
    /// A `repeat N:` loop.
    Repeat(RepeatLoop),
    /// A `for x in collection:` loop.
    ForLoop(ForLoop),
    /// A `loop: ... until condition` loop.
    LoopUntil(LoopUntil),
    /// A try/catch/finally block.
    TryCatch(TryCatch),
    /// An explicit error signal from workflow logic.
    Throw(ThrowStmt),
    /// A human-in-the-loop approval gate.
    ApprovalGate(ApprovalGate),
    /// A reusable block definition.
    BlockDef(BlockDef),
    /// A block invocation.
    BlockCall(BlockCall),
    /// An inline pipeline definition.
    Pipeline(PipelineDef),
    /// A single pipeline step (inside an inline pipeline).
    PipeStep(PipeStep),
    /// A let binding.
    Binding(LetBinding),
    /// A Layer 1 directive used inside a workflow body.
    Directive(DirectiveStmt),
    /// An output binding (`output name = expr`).
    Output(OutputStmt),
    /// A bare expression statement.
    Expression(Expression),
    /// A comment.
    Comment(Comment),
}
```

### 3.9 Control Flow Nodes

```rust
/// A session invocation -- the ONLY place prose enters a workflow.
#[derive(Debug, Clone)]
pub struct SessionExpr {
    /// Either a prompt string or an agent name reference.
    pub target: SessionTarget,
    /// Session configuration properties (prompt, context, etc.).
    pub properties: Vec<Property>,
    pub span: Span,
}

/// The target of a session invocation.
#[derive(Debug, Clone)]
pub enum SessionTarget {
    /// A direct prompt string: `session "Analyze the code"`
    Prompt(Expression),
    /// An agent reference: `session: scanner`
    Agent(String),
}

/// A parallel execution block.
#[derive(Debug, Clone)]
pub struct ParallelBlock {
    /// Join strategy modifier. `None` = wait for all.
    pub modifier: Option<ParallelModifier>,
    /// Named parallel arms. Names MUST be unique (S07).
    pub arms: Vec<ParallelArm>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParallelModifier {
    /// Return on first arm completion.
    Race,
    /// Wait for all, collect successes and failures.
    Settle,
}

/// A named arm within a parallel block.
#[derive(Debug, Clone)]
pub struct ParallelArm {
    pub name: String,
    pub value: Expression,
    pub properties: Vec<Property>,
    pub span: Span,
}

/// An if/elif/else conditional.
#[derive(Debug, Clone)]
pub struct Conditional {
    /// The `if` condition. May be a discretion condition.
    pub condition: Condition,
    /// Statements in the `if` body.
    pub body: Vec<Statement>,
    /// Zero or more `elif` clauses.
    pub elif_clauses: Vec<ElifClause>,
    /// Optional `else` clause.
    pub else_clause: Option<Vec<Statement>>,
    pub span: Span,
}

/// A condition, which may be either a regular expression or a discretion condition.
#[derive(Debug, Clone)]
pub enum Condition {
    /// A regular boolean expression.
    Expr(Expression),
    /// A discretion condition: `**prose text**`, evaluated by an AI evaluator.
    Discretion(DiscretionCondition),
}

/// An AI-evaluated discretion condition.
///
/// ```cant
/// if **all reviews pass with no critical issues**:
/// ```
#[derive(Debug, Clone)]
pub struct DiscretionCondition {
    /// The prose text between `**` delimiters.
    pub prose: String,
    pub span: Span,
}

/// An elif clause in a conditional.
#[derive(Debug, Clone)]
pub struct ElifClause {
    pub condition: Condition,
    pub body: Vec<Statement>,
    pub span: Span,
}

/// A `repeat N:` loop.
#[derive(Debug, Clone)]
pub struct RepeatLoop {
    /// The count expression. MUST evaluate to a positive integer.
    pub count: Expression,
    pub body: Vec<Statement>,
    pub span: Span,
}

/// A `for x in collection:` loop.
#[derive(Debug, Clone)]
pub struct ForLoop {
    /// The loop variable name.
    pub variable: String,
    /// The iterable expression.
    pub iterable: Expression,
    pub body: Vec<Statement>,
    pub span: Span,
}

/// A `loop: ... until condition` loop.
#[derive(Debug, Clone)]
pub struct LoopUntil {
    pub body: Vec<Statement>,
    /// The termination condition. May be a discretion condition.
    pub condition: Condition,
    pub span: Span,
}
```

### 3.10 Error Handling Nodes

```rust
/// A try/catch/finally block.
#[derive(Debug, Clone)]
pub struct TryCatch {
    /// The try body. MUST contain at least one statement (W05).
    pub body: Vec<Statement>,
    /// Optional catch clause with optional error binding name.
    pub catch: Option<CatchClause>,
    /// Optional finally clause.
    pub finally: Option<Vec<Statement>>,
    pub span: Span,
}

/// A catch clause binding an error value.
#[derive(Debug, Clone)]
pub struct CatchClause {
    /// Optional error variable name.
    pub error_name: Option<String>,
    pub body: Vec<Statement>,
    pub span: Span,
}
```

### 3.11 Approval Gate

```rust
/// A human-in-the-loop approval gate. Suspends workflow execution until
/// a human approves or rejects via `/approve {token}`.
///
/// ```cant
/// approve:
///   message: "Ready to deploy to production. Approve?"
///   expires: 24h
/// ```
#[derive(Debug, Clone)]
pub struct ApprovalGate {
    /// The message displayed to the approver. REQUIRED (W01).
    pub message: Expression,
    /// Expiration duration. Default is 24h if not specified.
    pub expires: Option<Expression>,
    /// Additional properties.
    pub properties: Vec<Property>,
    pub span: Span,
}
```

### 3.12 Choice Block

```rust
/// An AI multi-option selection. The AI evaluator picks the best option
/// from N named alternatives based on the discretion criteria.
///
/// ```cant
/// choice **which deployment strategy best fits the risk profile**:
///   option "blue-green":
///     session "Execute blue-green deploy"
///   option "canary":
///     session "Execute canary deploy"
///   option "rolling":
///     session "Execute rolling deploy"
/// ```
#[derive(Debug, Clone)]
pub struct ChoiceBlock {
    /// The discretion condition describing the decision criteria.
    pub criteria: DiscretionCondition,
    /// The named options. MUST contain at least 2 (W12).
    pub options: Vec<ChoiceOption>,
    pub span: Span,
}

/// A named option within a choice block.
#[derive(Debug, Clone)]
pub struct ChoiceOption {
    /// The option label (string literal).
    pub label: String,
    /// The body statements executed if this option is selected.
    pub body: Vec<Statement>,
    pub span: Span,
}
```

### 3.13 Throw Statement

```rust
/// An explicit error signal from workflow logic.
///
/// ```cant
/// if status == "critical":
///   throw "Deployment blocked: critical status"
/// ```
#[derive(Debug, Clone)]
pub struct ThrowStmt {
    /// The error value expression. If None, a generic error is thrown.
    pub value: Option<Expression>,
    pub span: Span,
}
```

### 3.14 Reusable Block

```rust
/// A reusable block definition — CANT's equivalent of a function/macro.
///
/// ```cant
/// block notify(target, message):
///   /info @{target} "{message}"
///   session "Log notification to audit trail"
/// ```
#[derive(Debug, Clone)]
pub struct BlockDef {
    /// The block name.
    pub name: String,
    /// Formal parameters.
    pub params: Vec<Param>,
    /// The block body statements.
    pub body: Vec<Statement>,
    pub span: Span,
}

/// A block invocation.
///
/// ```cant
/// notify(@ops-lead, "Deployment complete")
/// ```
#[derive(Debug, Clone)]
pub struct BlockCall {
    /// The name of the block to invoke.
    pub name: String,
    /// Positional arguments.
    pub args: Vec<Expression>,
    pub span: Span,
}
```

### 3.15 Miscellaneous Nodes

```rust
/// An import statement.
#[derive(Debug, Clone)]
pub struct ImportStmt {
    /// The import path (string literal).
    pub path: String,
    /// Optional named import identifier (for `Name from "path"` syntax).
    pub alias: Option<String>,
    pub span: Span,
}

/// A let binding.
#[derive(Debug, Clone)]
pub struct LetBinding {
    pub name: String,
    pub value: Expression,
    pub span: Span,
}

/// A Layer 1 directive appearing inside a workflow or hook body.
#[derive(Debug, Clone)]
pub struct DirectiveStmt {
    pub verb: String,
    pub addresses: Vec<String>,
    pub task_refs: Vec<Expression>,
    pub tags: Vec<String>,
    /// Optional trailing argument (e.g., a string message).
    pub argument: Option<Expression>,
    pub span: Span,
}

/// An output binding.
#[derive(Debug, Clone)]
pub struct OutputStmt {
    pub name: String,
    pub value: Expression,
    pub span: Span,
}

/// A comment.
#[derive(Debug, Clone)]
pub struct Comment {
    pub text: String,
    pub span: Span,
}
```

### 3.13 Expression

```rust
/// All expression types in the CANT expression language.
#[derive(Debug, Clone)]
pub enum Expression {
    /// A name reference (variable or property path start).
    Name(NameExpr),
    /// A string literal, possibly containing interpolations.
    String(StringExpr),
    /// A numeric literal.
    Number(NumberExpr),
    /// A boolean literal.
    Boolean(BooleanExpr),
    /// A duration literal (e.g., `30s`, `5m`).
    Duration(DurationExpr),
    /// A task reference (e.g., `T1234`).
    TaskRef(TaskRefExpr),
    /// An address (e.g., `@ops-lead`).
    Address(AddressExpr),
    /// An array literal.
    Array(ArrayExpr),
    /// An object literal.
    Object(ObjectExpr),
    /// Property access (e.g., `agent.name`).
    PropertyAccess(PropertyAccessExpr),
    /// Index access (e.g., `items[0]`).
    IndexAccess(IndexAccessExpr),
    /// A comparison (e.g., `a == b`).
    Comparison(ComparisonExpr),
    /// A logical operation (e.g., `a and b`).
    Logical(LogicalExpr),
    /// A negation (e.g., `not expr`).
    Negation(NegationExpr),
    /// String interpolation segment (used internally during parsing).
    Interpolation(InterpolationExpr),
    /// A parenthesized expression.
    Grouped(Box<Expression>),
}

#[derive(Debug, Clone)]
pub struct NameExpr { pub name: String, pub span: Span }

#[derive(Debug, Clone)]
pub struct StringExpr {
    /// The raw string value with interpolations already resolved to segments.
    pub segments: Vec<StringSegment>,
    pub span: Span,
}

/// A segment within a string literal.
#[derive(Debug, Clone)]
pub enum StringSegment {
    /// Literal text.
    Literal(String),
    /// An interpolated expression `${expr}`.
    Interpolation(Expression),
}

#[derive(Debug, Clone)]
pub struct NumberExpr { pub value: f64, pub span: Span }

#[derive(Debug, Clone)]
pub struct BooleanExpr { pub value: bool, pub span: Span }

#[derive(Debug, Clone)]
pub struct DurationExpr {
    pub amount: u64,
    pub unit: DurationUnit,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationUnit { Seconds, Minutes, Hours, Days }

#[derive(Debug, Clone)]
pub struct TaskRefExpr { pub id: String, pub span: Span }

#[derive(Debug, Clone)]
pub struct AddressExpr { pub name: String, pub span: Span }

#[derive(Debug, Clone)]
pub struct ArrayExpr { pub elements: Vec<Expression>, pub span: Span }

#[derive(Debug, Clone)]
pub struct ObjectExpr { pub pairs: Vec<(String, Expression)>, pub span: Span }

#[derive(Debug, Clone)]
pub struct PropertyAccessExpr {
    pub object: Box<Expression>,
    pub property: String,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub struct IndexAccessExpr {
    pub object: Box<Expression>,
    pub index: Box<Expression>,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub struct ComparisonExpr {
    pub left: Box<Expression>,
    pub op: ComparisonOp,
    pub right: Box<Expression>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonOp { Eq, Ne, Gt, Lt, Ge, Le }

#[derive(Debug, Clone)]
pub struct LogicalExpr {
    pub left: Box<Expression>,
    pub op: LogicalOp,
    pub right: Box<Expression>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicalOp { And, Or }

#[derive(Debug, Clone)]
pub struct NegationExpr {
    pub operand: Box<Expression>,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub struct InterpolationExpr {
    pub expression: Box<Expression>,
    pub span: Span,
}
```

### 3.14 Diagnostic Type

The validation engine (Section 4) produces diagnostics conforming to this type. This type
is also the bridge to LSP integration.

```rust
/// A diagnostic produced by the validation engine.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    /// Severity level.
    pub severity: Severity,
    /// The validation rule that produced this diagnostic (e.g., "S01", "P06").
    pub rule_id: String,
    /// Human-readable diagnostic message.
    pub message: String,
    /// Source location of the issue.
    pub span: Span,
    /// Optional suggested fix for LSP code actions.
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

/// A suggested code fix.
#[derive(Debug, Clone)]
pub struct Fix {
    /// Description of the fix.
    pub message: String,
    /// Text edits to apply.
    pub edits: Vec<TextEdit>,
}

/// A text replacement.
#[derive(Debug, Clone)]
pub struct TextEdit {
    pub span: Span,
    pub new_text: String,
}
```

---

## 4. Validation Rules

This section defines 42 numbered validation rules organized into five categories: Scope (S),
Pipeline Purity (P), Types (T), Hooks (H), and Workflows (W).

For each rule, the specification provides:
- **Rule ID** and **Severity**
- **Description** of what the rule enforces
- **Violation example** showing code that triggers the diagnostic
- **Correct example** showing compliant code
- **Diagnostic message template** with `{placeholders}`

### 4.1 Scope Rules (S01--S13)

---

#### S01 -- Unresolved Variable Reference

**Severity**: Error

**Description**: Every variable reference in an expression MUST resolve to a name defined in
the current scope: a `let` binding, a parameter name, a step name (in pipelines), a parallel
arm name, a `for` loop variable, a `catch` error binding, or a built-in context variable.

**Violation**:
```cant
workflow deploy:
  if status == "ready":   # 'status' is not defined
    /done T1234
```

**Correct**:
```cant
workflow deploy:
  let status = task.status
  if status == "ready":
    /done T1234
```

**Diagnostic**: `S01: Unresolved reference '{name}' at line {line}. No binding, parameter, or context variable with this name is in scope.`

---

#### S02 -- Shadowed Binding

**Severity**: Warning

**Description**: A `let` binding SHOULD NOT shadow an existing binding in an enclosing scope.
Shadowing is permitted but the parser MUST emit a warning diagnostic.

**Violation**:
```cant
workflow example:
  let result = "initial"
  for item in items:
    let result = item.value   # shadows outer 'result'
```

**Correct**:
```cant
workflow example:
  let result = "initial"
  for item in items:
    let item_result = item.value
```

**Diagnostic**: `S02: Binding '{name}' at line {line} shadows an existing binding defined at line {original_line}.`

---

#### S03 -- Circular Import Chain

**Severity**: Error

**Description**: The transitive import graph MUST be acyclic. If file A imports file B and
file B (directly or transitively) imports file A, the parser MUST reject the cycle.

**Violation**:
```cant
# agents/a.cant
@import "./b.cant"

# agents/b.cant
@import "./a.cant"    # circular
```

**Correct**:
```cant
# agents/a.cant
@import "./shared.cant"

# agents/b.cant
@import "./shared.cant"   # shared dependency, no cycle
```

**Diagnostic**: `S03: Circular import chain detected: {path_a} -> {path_b} -> {path_a}. Break the cycle by extracting shared definitions.`

---

#### S04 -- Import Target Existence

**Severity**: Error

**Description**: The target file of an `@import` statement MUST exist on the filesystem at
the resolved path. See Section 6 for the resolution algorithm.

**Violation**:
```cant
@import "./agents/nonexistent.cant"
```

**Correct**:
```cant
@import "./agents/scanner.cant"   # file exists at this path
```

**Diagnostic**: `S04: Import target '{path}' does not exist. Resolved from '{import_source}' at line {line}.`

---

#### S05 -- Unique Names Within File

**Severity**: Error

**Description**: Agent, skill, workflow, and pipeline names MUST be unique within a single
file. Two `agent` blocks with the same name in one file is an error.

**Violation**:
```cant
agent scanner:
  model: opus

agent scanner:     # duplicate name
  model: sonnet
```

**Correct**:
```cant
agent security-scanner:
  model: opus

agent style-scanner:
  model: sonnet
```

**Diagnostic**: `S05: Duplicate {kind} name '{name}' at line {line}. A {kind} with this name is already defined at line {original_line}.`

---

#### S06 -- Valid Hook Event Name

**Severity**: Error

**Description**: The event name in an `on Event:` block MUST be one of the 16 CAAMP canonical
events listed in Section 5. Event names are case-sensitive (PascalCase).

**Violation**:
```cant
on TaskComplete:     # not a canonical event
  /done T1234
```

**Correct**:
```cant
on ResponseComplete:
  /done T1234
```

**Diagnostic**: `S06: Unknown event '{event}' at line {line}. Must be one of: SessionStart, SessionEnd, PromptSubmit, ResponseComplete, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, PreModel, PostModel, PreCompact, PostCompact, Notification, ConfigChange.`

---

#### S07 -- Unique Parallel Arm Names

**Severity**: Error

**Description**: Within a single `parallel:` block, all arm names MUST be unique.

**Violation**:
```cant
parallel:
  analysis = session "Analyze code"
  analysis = session "Another analysis"   # duplicate arm name
```

**Correct**:
```cant
parallel:
  security_analysis = session "Security analysis"
  style_analysis = session "Style analysis"
```

**Diagnostic**: `S07: Duplicate parallel arm name '{name}' at line {line}. An arm with this name already exists at line {original_line}.`

---

#### S08 -- Binding Used Before Definition

**Severity**: Error

**Description**: A `let` binding MUST be defined before it is referenced. Forward references
to bindings are not supported.

**Violation**:
```cant
workflow example:
  /info @all "Value is ${value}"
  let value = "computed"
```

**Correct**:
```cant
workflow example:
  let value = "computed"
  /info @all "Value is ${value}"
```

**Diagnostic**: `S08: Reference to '{name}' at line {line} before its definition at line {def_line}. Move the 'let' binding above this reference.`

---

#### S09 -- Import Path Traversal Prevention

**Severity**: Error

**Description**: Import paths MUST resolve to a location within the project root directory.
The project root is defined as the nearest ancestor directory containing a `.cleo/` directory
or a `.git/` directory. Paths that traverse above the project root using `..` sequences MUST
be rejected.

**Violation**:
```cant
@import "../../etc/passwd"
@import "../../../home/user/.ssh/id_rsa"
```

**Correct**:
```cant
@import "./agents/scanner.cant"
@import "../shared/utils.cant"   # still within project root
```

**Diagnostic**: `S09: Import path '{path}' escapes the project root '{root}'. Imports MUST resolve within the project directory.`

---

#### S10 -- Symlink Escape Prevention

**Severity**: Error

**Description**: When resolving import paths, the canonical (real) path after following all
symlinks MUST still be within the project root directory. An import that names a path inside
the project tree but whose symlink target is outside the tree MUST be rejected.

**Violation**:
```cant
# .cleo/skills/evil-link.cant -> /etc/shadow (symlink)
@import ".cleo/skills/evil-link.cant"
```

**Correct**:
```cant
# .cleo/skills/real-skill.cant is a regular file inside the project
@import ".cleo/skills/real-skill.cant"
```

**Diagnostic**: `S10: Import '{path}' resolves via symlink to '{real_path}', which is outside the project root '{root}'. Symlinks MUST NOT escape the project directory.`

---

#### S11 -- Import Chain Depth Limit

**Severity**: Error

**Description**: The transitive import chain depth MUST NOT exceed a configurable maximum.
The default limit is 64. This prevents stack overflow from deeply nested (but non-circular)
import chains and limits resource consumption during parsing.

**Violation**:
```cant
# a-1.cant imports a-2.cant imports a-3.cant ... imports a-65.cant
# Chain depth exceeds 64
@import "./chain/a-1.cant"
```

**Correct**:
```cant
# Keep import chains shallow; prefer flat imports over deep nesting
@import "./shared/types.cant"
@import "./shared/utils.cant"
```

**Diagnostic**: `S11: Import chain depth of {depth} exceeds the maximum of {max} at '{path}'. Flatten your import hierarchy.`

---

#### S12 -- Permission Escalation Prevention

**Severity**: Error

**Description**: An agent definition in an imported file MUST NOT declare permissions that
exceed the permissions of the importing context. If file A imports file B, agents in B MUST
NOT have permissions not held by agents in A. This enforces the principle of least privilege
across import boundaries.

**Violation**:
```cant
# main.cant
agent coordinator:
  permissions:
    tasks: read

@import "./agents/worker.cant"

# agents/worker.cant
agent worker:
  permissions:
    tasks: read, write, execute   # exceeds coordinator's 'read' permission
```

**Correct**:
```cant
# agents/worker.cant
agent worker:
  permissions:
    tasks: read   # does not exceed importing context
```

**Diagnostic**: `S12: Agent '{agent}' in imported file '{path}' declares permission '{domain}: {perm}' which exceeds the permissions of the importing context. Imported agents MUST NOT escalate privileges.`

---

#### S13 -- Permission Closed Set

**Severity**: Error

**Description**: Permission values MUST be from the closed set: `read`, `write`, `execute`.
Arbitrary strings MUST be rejected.

**Violation**:
```cant
agent example:
  permissions:
    tasks: read, admin    # 'admin' is not in the closed set
```

**Correct**:
```cant
agent example:
  permissions:
    tasks: read, write
```

**Diagnostic**: `S13: Invalid permission value '{value}' at line {line}. Permitted values are: read, write, execute.`

---

### 4.2 Pipeline Purity Rules (P01--P07)

Pipeline definitions MUST be deterministic. The following rules enforce this invariant.

---

#### P01 -- No Sessions in Pipelines

**Severity**: Error

**Description**: Pipeline bodies MUST NOT contain `session` expressions. Sessions invoke LLM
interactions, which are non-deterministic.

**Violation**:
```cant
pipeline deploy:
  step build:
    command: "pnpm"
    args: ["run", "build"]
  session "Review the build output"   # NOT allowed in pipeline
```

**Correct**:
```cant
pipeline deploy:
  step build:
    command: "pnpm"
    args: ["run", "build"]
  step verify:
    command: "pnpm"
    args: ["run", "verify"]
```

**Diagnostic**: `P01: Session expression at line {line} is not permitted inside a pipeline. Pipelines must be deterministic. Move session logic to a workflow.`

---

#### P02 -- No Discretion Conditions in Pipelines

**Severity**: Error

**Description**: Pipeline bodies MUST NOT contain discretion conditions (`**...**`).
Discretion conditions require AI evaluation, which is non-deterministic.

**Violation**:
```cant
pipeline deploy:
  step build:
    command: "pnpm"
    args: ["run", "build"]
  if **build looks successful**:   # NOT allowed in pipeline
    step publish:
      command: "pnpm"
      args: ["publish"]
```

**Correct**:
```cant
pipeline deploy:
  step build:
    command: "pnpm"
    args: ["run", "build"]
  step publish:
    command: "pnpm"
    args: ["publish"]
    condition: build.exitCode == 0
```

**Diagnostic**: `P02: Discretion condition at line {line} is not permitted inside a pipeline. Pipelines must be deterministic. Use a 'condition:' property with a concrete expression.`

---

#### P03 -- No Approval Gates in Pipelines

**Severity**: Error

**Description**: Pipeline bodies MUST NOT contain `approve:` gates. Approval gates suspend
execution for human input, which is incompatible with deterministic pipeline execution.

**Violation**:
```cant
pipeline deploy:
  step build:
    command: "pnpm"
    args: ["run", "build"]
  approve:
    message: "Deploy to production?"   # NOT allowed in pipeline
```

**Correct**:
```cant
# Use a workflow for approval-gated deployments
workflow deploy-with-approval:
  pipeline build-stage:
    step build:
      command: "pnpm"
      args: ["run", "build"]
  approve:
    message: "Deploy to production?"
```

**Diagnostic**: `P03: Approval gate at line {line} is not permitted inside a pipeline. Pipelines must be deterministic. Wrap the pipeline in a workflow for approval support.`

---

#### P04 -- No LLM-Dependent Calls in Pipelines

**Severity**: Error

**Description**: Pipeline bodies MUST NOT contain any construct that depends on LLM
evaluation. This includes session expressions (P01), discretion conditions (P02), and any
expression referencing LLM output context.

**Violation**:
```cant
pipeline analyze:
  step scan:
    command: "semgrep"
    args: ["--json", "."]
  # Referencing an LLM-produced variable
  if llm_review.approved:
    step deploy:
      command: "pnpm"
      args: ["publish"]
```

**Correct**:
```cant
pipeline analyze:
  step scan:
    command: "semgrep"
    args: ["--json", "."]
  step deploy:
    command: "pnpm"
    args: ["publish"]
    condition: scan.exitCode == 0
```

**Diagnostic**: `P04: Reference to LLM-dependent value '{name}' at line {line} is not permitted inside a pipeline. Pipelines must be deterministic.`

---

#### P05 -- Deterministic Pipeline Steps

**Severity**: Error

**Description**: Every pipeline step MUST produce deterministic output for the same input.
Steps MUST have a `command:` property. Steps MUST NOT use constructs that introduce
non-determinism (randomness, wall-clock time dependencies, network calls without caching).

**Violation**:
```cant
pipeline example:
  step random:
    command: "shuf"              # non-deterministic output
    args: ["-n", "1", "names.txt"]
```

**Correct**:
```cant
pipeline example:
  step sorted:
    command: "sort"
    args: ["names.txt"]
```

**Diagnostic**: `P05: Pipeline step '{name}' at line {line} must be deterministic. Review the command for non-deterministic behavior.`

Note: P05 is advisory in nature. Static analysis cannot fully determine whether a given
command is deterministic. Implementations SHOULD flag known non-deterministic commands and
MAY provide a configuration allowlist override.

---

#### P06 -- No Shell Interpolation in Commands (CRITICAL)

**Severity**: Error

**Description**: Pipeline `command:` values MUST NOT contain interpolated variables or shell
metacharacters. All dynamic values MUST be passed via the `args:` array property, which
bypasses shell interpretation entirely. The runtime MUST use `Command::new(binary).args(vec)`
and MUST NEVER pass interpolated strings through `sh -c` or equivalent shell invocation.

This rule is CRITICAL for preventing command injection attacks.

**Violation**:
```cant
pipeline deploy:
  step push:
    command: "docker push ${registry}/${image}:${tag}"   # SHELL INJECTION RISK
```

**Correct**:
```cant
pipeline deploy:
  step push:
    command: "docker"
    args: ["push", "${registry}/${image}:${tag}"]
    # args array elements are passed directly to the process,
    # never interpreted by a shell
```

**Diagnostic**: `P06: SECURITY: Pipeline command at line {line} contains interpolation in the command string. Use 'args:' array for dynamic values to prevent command injection. command: MUST name a binary only.`

---

#### P07 -- Command Allowlist

**Severity**: Warning

**Description**: Pipeline `command:` values SHOULD be validated against a configurable command
allowlist. If a command is not on the allowlist, the validator MUST emit a warning. The
allowlist is defined in the project's `.cleo/config.json` under `cant.pipeline.allowedCommands`.

An empty or absent allowlist disables this check.

**Violation**:
```cant
# With allowlist: ["pnpm", "cargo", "gh"]
pipeline example:
  step evil:
    command: "curl"     # not on allowlist
    args: ["https://evil.example.com/exfiltrate"]
```

**Correct**:
```cant
# With allowlist: ["pnpm", "cargo", "gh"]
pipeline example:
  step build:
    command: "pnpm"    # on allowlist
    args: ["run", "build"]
```

**Diagnostic**: `P07: Command '{command}' at line {line} is not in the pipeline command allowlist. Allowed commands: {allowlist}. Configure in .cleo/config.json under cant.pipeline.allowedCommands.`

---

### 4.3 Type Rules (T01--T07)

---

#### T01 -- Property Type Mismatch

**Severity**: Error

**Description**: Property values MUST match the expected type for that property name. Known
property types are:

| Property | Expected Type |
|----------|---------------|
| `model` | string |
| `persist` | string (`"project"`, `"session"`, `"global"`) |
| `prompt` | string |
| `skills` | array of strings |
| `tier` | string |
| `description` | string |
| `timeout` | duration |
| `command` | string |
| `args` | array |
| `condition` | expression (boolean) |
| `stdin` | string (step name reference) |

**Violation**:
```cant
agent example:
  model: 42          # expected string, got number
  skills: "ct-cleo"  # expected array, got string
```

**Correct**:
```cant
agent example:
  model: "opus"
  skills: ["ct-cleo"]
```

**Diagnostic**: `T01: Property '{key}' at line {line} expects type {expected} but received {actual}.`

---

#### T02 -- Comparison Operand Compatibility

**Severity**: Error

**Description**: Comparison operands MUST be type-compatible. Strings may be compared with
strings, numbers with numbers, booleans with booleans. Cross-type comparisons MUST be
rejected.

**Violation**:
```cant
if task.status == 42:    # comparing string with number
  /done T1234
```

**Correct**:
```cant
if task.status == "done":
  /done T1234
```

**Diagnostic**: `T02: Cannot compare {left_type} with {right_type} at line {line}. Comparison operands must be the same type.`

---

#### T03 -- Interpolation Operand Stringifiable

**Severity**: Error

**Description**: Expressions inside string interpolation `${...}` MUST evaluate to a type
that can be represented as a string: string, number, boolean, or task reference. Arrays and
objects MUST NOT appear inside interpolation.

**Violation**:
```cant
let items = ["a", "b", "c"]
let msg = "Items: ${items}"     # array is not stringifiable
```

**Correct**:
```cant
let count = 3
let msg = "Count: ${count}"     # number is stringifiable
```

**Diagnostic**: `T03: Expression in interpolation at line {line} evaluates to {type}, which cannot be converted to a string. Arrays and objects are not stringifiable.`

---

#### T04 -- Context Reference Resolution

**Severity**: Error

**Description**: Names used in `context:` blocks and `context:` properties on session
expressions MUST resolve to a defined agent, skill, pipeline, or step name.

**Violation**:
```cant
workflow review:
  parallel:
    analysis = session "Analyze"
      context: nonexistent_pipeline   # no pipeline with this name
```

**Correct**:
```cant
workflow review:
  pipeline checks:
    step lint:
      command: "biome"
      args: ["check"]
  parallel:
    analysis = session "Analyze"
      context: checks   # references the pipeline defined above
```

**Diagnostic**: `T04: Context reference '{name}' at line {line} does not resolve to any defined agent, skill, pipeline, or step.`

---

#### T05 -- Parallel Arm Context References

**Severity**: Error

**Description**: Context references within parallel arms MUST reference names that are defined
OUTSIDE the parallel block or in a previously defined arm within the same block. An arm MUST
NOT reference another arm's output as context, because arms execute concurrently.

**Violation**:
```cant
parallel:
  a = session "First analysis"
  b = session "Second analysis"
    context: a    # 'a' is executing concurrently, not available
```

**Correct**:
```cant
workflow example:
  pipeline setup:
    step prepare:
      command: "pnpm"
      args: ["run", "prepare"]
  parallel:
    a = session "First analysis"
      context: setup
    b = session "Second analysis"
      context: setup
```

**Diagnostic**: `T05: Parallel arm '{arm}' at line {line} references sibling arm '{ref}' as context. Parallel arms execute concurrently and cannot reference each other's output.`

---

#### T06 -- Approval Gate Message Type

**Severity**: Error

**Description**: The `message:` property of an `approve:` gate MUST evaluate to a string
expression.

**Violation**:
```cant
approve:
  message: 42         # not a string
```

**Correct**:
```cant
approve:
  message: "Ready to deploy ${service} to production. Approve?"
```

**Diagnostic**: `T06: Approval gate 'message:' at line {line} must be a string expression, got {actual_type}.`

---

#### T07 -- Single-Pass Interpolation (SECURITY)

**Severity**: Error

**Description**: String interpolation MUST perform single-pass evaluation. When an
interpolated expression evaluates to a string containing `${...}`, the `${...}` in the result
MUST be treated as literal text. Nested or recursive interpolation MUST NOT be evaluated.

This prevents injection attacks where a dynamic value contains interpolation syntax.

**Violation scenario**:
```cant
# If user_input is "${secret.api_key}" (from external source)
let msg = "Hello ${user_input}"
# MUST produce: "Hello ${secret.api_key}" (literal)
# MUST NOT produce: "Hello sk-abc123..." (resolved)
```

**Correct behavior**: The runtime evaluates `${user_input}`, obtains the string
`"${secret.api_key}"`, and includes it literally in the result. No second evaluation pass
occurs.

**Diagnostic**: `T07: SECURITY: Interpolation at line {line} attempted nested evaluation. String interpolation is single-pass only; nested '${...}' in values is treated as literal text.`

---

### 4.4 Hook Rules (H01--H04)

---

#### H01 -- Valid Event Name

**Severity**: Error

**Description**: The event name in an `on Event:` block MUST be one of the 16 CAAMP canonical
events. See Section 5 for the complete list.

This rule is identical in intent to S06 but is categorized separately for hook-specific
diagnostics.

**Violation**:
```cant
on FileChanged:     # not a canonical event
  /info @all "File changed"
```

**Correct**:
```cant
on ConfigChange:
  /info @all "Configuration changed"
```

**Diagnostic**: `H01: Unknown hook event '{event}' at line {line}. See the CAAMP canonical event list for valid event names.`

---

#### H02 -- No Duplicate Hook Events

**Severity**: Error

**Description**: Within a single agent definition or a single file (for top-level hooks), there
MUST NOT be two `on` blocks for the same event.

**Violation**:
```cant
agent example:
  on SessionStart:
    /checkin @all
  on SessionStart:     # duplicate
    /info @all "Starting"
```

**Correct**:
```cant
agent example:
  on SessionStart:
    /checkin @all
    /info @all "Starting"
```

**Diagnostic**: `H02: Duplicate hook for event '{event}' at line {line}. A hook for this event is already defined at line {original_line}. Combine the logic into a single hook block.`

---

#### H03 -- No Workflow Constructs in Hooks

**Severity**: Error

**Description**: Hook bodies MUST NOT contain workflow-only constructs: `parallel:` blocks,
`approve:` gates, or nested workflow definitions. Hooks are synchronous event handlers, not
orchestration entry points.

**Violation**:
```cant
on SessionStart:
  parallel:
    a = session "Analysis"    # NOT allowed in hook body
  approve:
    message: "Continue?"      # NOT allowed in hook body
```

**Correct**:
```cant
on SessionStart:
  /checkin @all
  let status = session.status
  if status == "resuming":
    /info @all "Resuming previous session"
```

**Diagnostic**: `H03: Workflow construct '{construct}' at line {line} is not permitted inside a hook body. Hooks are synchronous event handlers.`

---

#### H04 -- Blocking Hook Handling

**Severity**: Warning

**Description**: Hooks for events with `canBlock: true` (PreToolUse, PermissionRequest) SHOULD
include explicit allow/deny handling. A blocking hook without decision logic may silently block
tool execution.

**Violation**:
```cant
on PreToolUse:
  /info @all "Tool use detected"
  # No allow/deny decision -- will this block the tool?
```

**Correct**:
```cant
on PreToolUse:
  if tool.name == "dangerous-tool":
    deny "This tool is not permitted"
  else:
    allow
```

**Diagnostic**: `H04: Blocking hook for '{event}' at line {line} does not include explicit allow/deny handling. This may silently block tool execution.`

---

### 4.5 Workflow Rules (W01--W11)

---

#### W01 -- Approval Gate Requires Message

**Severity**: Error

**Description**: Every `approve:` gate MUST include a `message:` property.

**Violation**:
```cant
approve:
  expires: 24h
  # message: is missing
```

**Correct**:
```cant
approve:
  message: "Deploy to production. Approve?"
  expires: 24h
```

**Diagnostic**: `W01: Approval gate at line {line} is missing the required 'message:' property.`

---

#### W02 -- Unique Parallel Arm Names

**Severity**: Error

**Description**: This is a workflow-context restatement of S07. Within a `parallel:` block
inside a workflow, all arm names MUST be unique. See S07 for details.

---

#### W03 -- Session Prompt Type

**Severity**: Error

**Description**: Session prompts MUST be string expressions. When using the `session "prompt"`
syntax, the argument MUST be a string literal or an expression evaluating to a string.

**Violation**:
```cant
workflow example:
  session 42                 # not a string
  session: nonexistent-agent # agent must be defined
```

**Correct**:
```cant
workflow example:
  session "Analyze the code for issues"
  session: reviewer   # 'reviewer' is a defined agent
```

**Diagnostic**: `W03: Session prompt at line {line} must be a string expression, got {actual_type}.`

---

#### W04 -- Loop Iterable Resolution

**Severity**: Error

**Description**: The iterable expression in a `for` loop MUST resolve to a value that can be
iterated: an array literal, a variable bound to an array, or a property access yielding an
array.

**Violation**:
```cant
for item in "not-an-array":
  /info @all "${item}"
```

**Correct**:
```cant
let tasks = [T1234, T5678]
for task in tasks:
  /info @all "Processing ${task}"
```

**Diagnostic**: `W04: For-loop iterable at line {line} must resolve to an array, got {actual_type}.`

---

#### W05 -- Try Block Non-Empty

**Severity**: Error

**Description**: A `try:` block MUST contain at least one statement. An empty try block is
likely an error.

**Violation**:
```cant
try:
  # empty
catch err:
  /info @all "Error: ${err}"
```

**Correct**:
```cant
try:
  session "Attempt risky operation"
catch err:
  /info @all "Error: ${err}"
```

**Diagnostic**: `W05: Try block at line {line} is empty. A try block must contain at least one statement.`

---

#### W06 -- Valid Workflow Names

**Severity**: Error

**Description**: Workflow and pipeline names MUST be valid identifiers: they MUST start with a
letter and contain only letters, digits, hyphens, and underscores.

**Violation**:
```cant
workflow 123-invalid:     # starts with digit
  /info @all "test"
```

**Correct**:
```cant
workflow deploy-v2:
  /info @all "deploying"
```

**Diagnostic**: `W06: Workflow name '{name}' at line {line} is not a valid identifier. Names must start with a letter and contain only letters, digits, hyphens, and underscores.`

---

#### W07 -- No Unreachable Code

**Severity**: Warning

**Description**: Statements after an unconditional return, break, or terminal directive (like
an `output` statement followed by more code) SHOULD be flagged as unreachable.

**Violation**:
```cant
workflow example:
  output result = "done"
  /info @all "This is unreachable"   # after output
```

**Correct**:
```cant
workflow example:
  /info @all "Processing"
  output result = "done"
```

**Diagnostic**: `W07: Unreachable statement at line {line}. This code follows an unconditional terminal statement.`

---

#### W08 -- Maximum Timeout Value (SECURITY)

**Severity**: Error

**Description**: `timeout:` values MUST NOT exceed a configurable maximum. The default maximum
is 3600 seconds (1 hour). This prevents resource exhaustion from workflows or pipeline steps
that hang indefinitely.

The maximum is configurable via `.cleo/config.json` under `cant.maxTimeout`.

**Violation**:
```cant
pipeline long:
  step hang:
    command: "sleep"
    args: ["99999"]
    timeout: 86400s    # 24 hours, exceeds 3600s default max
```

**Correct**:
```cant
pipeline bounded:
  step process:
    command: "pnpm"
    args: ["run", "build"]
    timeout: 300s
```

**Diagnostic**: `W08: SECURITY: Timeout value {value}s at line {line} exceeds the maximum of {max}s. Configure cant.maxTimeout in .cleo/config.json.`

---

#### W09 -- Maximum Parallel Arms (SECURITY)

**Severity**: Error

**Description**: A `parallel:` block MUST NOT contain more than a configurable maximum number
of arms. The default maximum is 32. This prevents resource exhaustion from spawning too many
concurrent operations.

The maximum is configurable via `.cleo/config.json` under `cant.maxParallelArms`.

**Violation**:
```cant
parallel:
  a1 = session "task 1"
  a2 = session "task 2"
  # ... 33 total arms
  a33 = session "task 33"    # exceeds 32 arm limit
```

**Correct**:
```cant
parallel:
  security = session "Security review"
  style = session "Style review"
  logic = session "Logic review"
```

**Diagnostic**: `W09: SECURITY: Parallel block at line {line} has {count} arms, exceeding the maximum of {max}. Configure cant.maxParallelArms in .cleo/config.json.`

---

#### W10 -- Maximum Repeat Count (SECURITY)

**Severity**: Error

**Description**: The count expression in a `repeat N:` loop MUST NOT exceed a configurable
maximum. The default maximum is 10,000. This prevents accidental or intentional resource
exhaustion from excessive iteration.

The maximum is configurable via `.cleo/config.json` under `cant.maxRepeatCount`.

**Violation**:
```cant
repeat 999999:
  session "Do something"   # excessive iteration
```

**Correct**:
```cant
repeat 5:
  session "Retry the operation"
```

**Diagnostic**: `W10: SECURITY: Repeat count {count} at line {line} exceeds the maximum of {max}. Configure cant.maxRepeatCount in .cleo/config.json.`

---

#### W11 -- Maximum Nesting Depth (SECURITY)

**Severity**: Error

**Description**: Control flow nesting depth MUST NOT exceed a configurable maximum. The default
maximum is 16 levels. This prevents parser stack overflow and excessive complexity.

Control flow constructs that increase nesting depth: `if`, `elif`, `else`, `for`, `repeat`,
`loop`, `try`, `catch`, `finally`, `parallel`, `workflow`, `pipeline`.

Additionally, the parser MUST enforce a maximum AST node count of 100,000 per file.

The maximum nesting depth is configurable via `.cleo/config.json` under
`cant.maxNestingDepth`.

**Violation**:
```cant
workflow deep:
  if a:
    if b:
      if c:
        # ... 17 levels deep
```

**Correct**:
```cant
workflow flat:
  if a and b and c:
    /info @all "All conditions met"
```

**Diagnostic**: `W11: SECURITY: Nesting depth of {depth} at line {line} exceeds the maximum of {max}. Flatten your control flow. Configure cant.maxNestingDepth in .cleo/config.json.`

---

#### W12 -- Choice Requires At Least Two Options

**Severity**: Error

**Description**: A `choice` block MUST contain at least 2 `option` clauses. A single-option
choice is meaningless — use `if` instead.

**Violation**:
```cant
choice **which approach**:
  option "only-one":
    session "Do the thing"
```

**Correct**:
```cant
choice **which approach**:
  option "conservative":
    session "Safe approach"
  option "aggressive":
    session "Fast approach"
```

**Diagnostic**: `W12: Choice block at line {line} has only {count} option(s). A choice block must contain at least 2 options. Use 'if' for single-branch discretion.`

---

#### W13 -- Block Must Not Contain Output Bindings

**Severity**: Error

**Description**: Reusable `block` definitions MUST NOT contain `output` statements. Outputs
are workflow-level declarations that feed the ExecutionResult. Allowing them in blocks would
create ambiguity about which workflow the output belongs to.

**Violation**:
```cant
block notify(msg):
  /info @all msg
  output notification_sent = true   # NOT allowed
```

**Correct**:
```cant
block notify(msg):
  /info @all msg

workflow deploy:
  notify("Deploying")
  output deployed = true   # outputs belong at workflow level
```

**Diagnostic**: `W13: Output binding '{name}' at line {line} is inside a block definition. Output bindings are only permitted at workflow top level.`

---

#### P08 -- No Throw in Pipelines

**Severity**: Error

**Description**: Pipeline bodies MUST NOT contain `throw` statements. Pipelines are
deterministic — errors are signaled by non-zero exit codes from pipeline steps, not by
explicit throw statements. Throw is a workflow-only construct.

**Violation**:
```cant
pipeline build:
  step compile:
    command: "cargo"
    args: ["build"]
  throw "Something went wrong"   # NOT allowed
```

**Correct**:
```cant
workflow build-with-error-handling:
  pipeline compile:
    step build:
      command: "cargo"
      args: ["build"]
  if compile.build.exitCode != 0:
    throw "Build failed with exit code ${compile.build.exitCode}"
```

**Diagnostic**: `P08: Throw statement at line {line} is inside a pipeline body. Pipelines are deterministic and must not contain throw. Use non-zero exit codes from pipeline steps to signal errors.`

---

## 5. CAAMP Event Mapping

CANT `on Event:` blocks are validated against the canonical event registry. Events come from
two sources: **provider events** (LLM-provider-lifecycle) and **domain events** (application
business logic). Both use the same `on Event:` syntax.

The canonical event registry is defined in `hook-mappings.json` (SSoT). Implementations
MUST NOT hardcode event names. The parser SHOULD accept any PascalCase identifier in `on`
blocks and defer validation to the validator, which reads the event registry.

See [CANT-EXECUTION-SEMANTICS.md](./CANT-EXECUTION-SEMANTICS.md) Section 9 for the Generic
Domain Event Protocol and Section 10 for CLEO domain event definitions.

### 5.0 Provider Events (16)

The original 16 CAAMP canonical events. These fire during AI coding tool runtime.

| # | CAAMP Event | CANT Block | Category | canBlock | Description |
|---|-------------|-----------|----------|----------|-------------|
| 1 | SessionStart | `on SessionStart:` | session | no | Fires when a coding session begins |
| 2 | SessionEnd | `on SessionEnd:` | session | no | Fires when a coding session ends |
| 3 | PromptSubmit | `on PromptSubmit:` | prompt | no | Fires when a user prompt is submitted |
| 4 | ResponseComplete | `on ResponseComplete:` | prompt | no | Fires when the model response is complete |
| 5 | PreToolUse | `on PreToolUse:` | tool | **yes** | Fires before a tool is invoked; handler may allow or deny |
| 6 | PostToolUse | `on PostToolUse:` | tool | no | Fires after successful tool invocation |
| 7 | PostToolUseFailure | `on PostToolUseFailure:` | tool | no | Fires after a tool invocation fails |
| 8 | PermissionRequest | `on PermissionRequest:` | tool | **yes** | Fires when a tool requests elevated permission; handler may allow or deny |
| 9 | SubagentStart | `on SubagentStart:` | agent | no | Fires when a subagent is spawned |
| 10 | SubagentStop | `on SubagentStop:` | agent | no | Fires when a subagent completes |
| 11 | PreModel | `on PreModel:` | context | no | Fires before an LLM model call |
| 12 | PostModel | `on PostModel:` | context | no | Fires after an LLM model call returns |
| 13 | PreCompact | `on PreCompact:` | context | no | Fires before context compaction |
| 14 | PostCompact | `on PostCompact:` | context | no | Fires after context compaction |
| 15 | Notification | `on Notification:` | context | no | Fires on a system notification |
| 16 | ConfigChange | `on ConfigChange:` | context | no | Fires when configuration changes |

### 5.1 Domain Events (CLEO)

Domain events fire when CLEO CQRS operations complete. They use the D:O:P pattern
(Domain:Operation:Phase) as machine-readable metadata. See
[CANT-EXECUTION-SEMANTICS.md](./CANT-EXECUTION-SEMANTICS.md) Section 10 for full details.

| # | Domain Event | CANT Block | Category | D:O:P | Description |
|---|-------------|-----------|----------|-------|-------------|
| 17 | TaskCreated | `on TaskCreated:` | task | `tasks:add:post` | A task was created via `tasks.add` |
| 18 | TaskStarted | `on TaskStarted:` | task | `tasks:start:post` | A task was started via `tasks.start` |
| 19 | TaskCompleted | `on TaskCompleted:` | task | `tasks:complete:post` | A task was completed via `tasks.complete` |
| 20 | TaskBlocked | `on TaskBlocked:` | task | `tasks:update:post` | A task was blocked |
| 21 | MemoryObserved | `on MemoryObserved:` | memory | `memory:observe:post` | An observation was recorded |
| 22 | MemoryPatternStored | `on MemoryPatternStored:` | memory | `memory:store:post` | A pattern was stored |
| 23 | MemoryLearningStored | `on MemoryLearningStored:` | memory | `memory:store:post` | A learning was stored |
| 24 | MemoryDecisionStored | `on MemoryDecisionStored:` | memory | `memory:store:post` | A decision was stored |
| 25 | PipelineStageCompleted | `on PipelineStageCompleted:` | pipeline | `pipeline:validate:post` | A lifecycle gate passed |
| 26 | PipelineManifestAppended | `on PipelineManifestAppended:` | pipeline | `pipeline:append:post` | A manifest entry was appended |
| 27 | SessionStarted | `on SessionStarted:` | session | `session:start:post` | A session was started |
| 28 | SessionEnded | `on SessionEnded:` | session | `session:end:post` | A session ended |
| 29 | ApprovalRequested | `on ApprovalRequested:` | session | `session:suspend:post` | An approval gate fired |
| 30 | ApprovalGranted | `on ApprovalGranted:` | session | `session:resume:post` | An approval was granted |
| 31 | ApprovalExpired | `on ApprovalExpired:` | session | `session:suspend:post` | An approval token expired |

Domain events are extensible. Additional domain sources (SignalDock, third-party integrations)
MAY register events via the `domainSources` section in `hook-mappings.json`.

### 5.2 Blocking Event Semantics

Events with `canBlock: true` (PreToolUse, PermissionRequest) have special semantics in hook
bodies. The hook handler MUST produce one of:

- **`allow`** -- Permit the action to proceed.
- **`deny "reason"`** -- Block the action with an explanation.

If a blocking hook handler completes without an explicit `allow` or `deny`, the behavior is
implementation-defined. Implementations SHOULD default to `allow` and emit a warning
diagnostic (H04).

### 5.2 Hook Context Variables

Within a hook body, the following context variables are available depending on the event:

| Variable | Available In | Type | Description |
|----------|-------------|------|-------------|
| `session` | All events | object | Current session state |
| `session.id` | All events | string | Session identifier |
| `session.status` | All events | string | Session status |
| `tool` | PreToolUse, PostToolUse, PostToolUseFailure | object | Tool invocation info |
| `tool.name` | Tool events | string | Name of the tool |
| `tool.exitCode` | PostToolUse, PostToolUseFailure | number | Exit code |
| `agent` | SubagentStart, SubagentStop | object | Subagent info |
| `agent.id` | Agent events | string | Subagent identifier |
| `model` | PreModel, PostModel | object | Model call info |
| `config` | ConfigChange | object | Changed configuration |
| `notification` | Notification | object | Notification payload |

---

## 6. Import Resolution Algorithm

### 6.1 Import Syntax Forms

CANT supports four import syntaxes:

| Syntax | Semantics |
|--------|-----------|
| `@import "./relative/path.cant"` | Import all exports from a file relative to the current file |
| `@import "@skill-name"` | Import a skill from `.cleo/skills/{skill-name}.cant` |
| `@import "bare-name"` | Bare specifier: search `.cleo/skills/` then `node_modules/` |
| `@import Name from "./path.cant"` | Import a specific named export from a file |

### 6.2 Resolution Algorithm

The import resolution algorithm proceeds as follows:

```
FUNCTION resolve_import(specifier, current_file, project_root):
  1. Determine specifier type:
     a. If specifier starts with "./" or "../" -> RELATIVE
     b. If specifier starts with "@" (not "@import") -> SKILL_SCOPE
     c. Otherwise -> BARE_SPECIFIER

  2. RELATIVE resolution:
     a. Let base_dir = directory containing current_file
     b. Let resolved = canonicalize(join(base_dir, specifier))
     c. SECURITY CHECK (S09): If resolved is not a descendant of project_root, REJECT
     d. SECURITY CHECK (S10): If realpath(resolved) is not a descendant of project_root, REJECT
     e. If file exists at resolved, RETURN resolved
     f. If file exists at resolved + ".cant", RETURN resolved + ".cant"
     g. REJECT with S04

  3. SKILL_SCOPE resolution:
     a. Let skill_name = specifier without leading "@"
     b. Let path = join(project_root, ".cleo/skills", skill_name + ".cant")
     c. Apply SECURITY CHECKS (S09, S10)
     d. If file exists at path, RETURN path
     e. REJECT with S04

  4. BARE_SPECIFIER resolution:
     a. Let path = join(project_root, ".cleo/skills", specifier + ".cant")
     b. If file exists at path, RETURN path
     c. Walk up from current_file looking for node_modules/{specifier}
     d. If found, check for a ".cant" entry point (package.json "cant" field or index.cant)
     e. Apply SECURITY CHECKS (S09, S10) at each step
     f. If found, RETURN path
     g. REJECT with S04
```

### 6.3 Project Root Detection

The project root is determined by searching upward from the current file's directory for:

1. A directory containing `.cleo/` -- preferred
2. A directory containing `.git/` -- fallback

If neither is found, the current working directory is used as the project root.

### 6.4 Security Constraints

- **S09**: The resolved path (after `..` normalization) MUST be a descendant of the project
  root. The resolver MUST normalize the path and verify containment BEFORE accessing the
  filesystem.
- **S10**: After following symlinks via `realpath()` or equivalent, the canonical path MUST
  still be within the project root.
- **S11**: The resolver MUST track import chain depth. Each recursive import increments the
  depth counter. When depth exceeds the configured maximum (default 64), resolution MUST fail.
- **Circular detection (S03)**: The resolver MUST maintain a set of files currently being
  resolved (the resolution stack). If a file appears on the stack, a circular import is
  detected.

### 6.5 Import Chain Example

```
project/
  .cleo/
    skills/
      ct-cleo.cant
  agents/
    coordinator.cant    <-- imports "./worker.cant" and "@ct-cleo"
    worker.cant
  workflows/
    deploy.cant         <-- imports "../agents/coordinator.cant"
```

Resolution from `workflows/deploy.cant`:

| Import | Resolution |
|--------|-----------|
| `@import "../agents/coordinator.cant"` | Relative: `project/agents/coordinator.cant` |
| `@import "@ct-cleo"` (in coordinator.cant) | Skill-scoped: `project/.cleo/skills/ct-cleo.cant` |
| `@import "./worker.cant"` (in coordinator.cant) | Relative to coordinator: `project/agents/worker.cant` |

---

## 7. Runtime Execution Model

CANT has a hybrid runtime: pipelines execute in Rust, workflows execute in TypeScript, and
the two communicate via napi-rs bindings.

### 7.1 Pipeline Execution (Rust)

Pipeline steps are executed by the Rust `cant-runtime` crate. Execution follows this model:

```
FUNCTION execute_pipeline(pipeline: PipelineDef, variables: Env) -> PipelineResult:
  1. For each step in pipeline.steps:
     a. If step.condition exists:
        - Evaluate condition against current variables
        - If false, skip this step (record as Skipped in result)
     b. Resolve step.command to a binary path
     c. SECURITY CHECK (P06): Verify command is a bare binary name, no shell metacharacters
     d. SECURITY CHECK (P07): If allowlist configured, verify command is on allowlist
     e. Build argument vector from step.args, evaluating interpolations
     f. Execute: Command::new(binary).args(arg_vec)
        - If step.stdin references a prior step, pipe that step's stdout to this step's stdin
        - Set timeout from step.timeout (subject to W08 max)
     g. Capture stdout, stderr, exit code
     h. Store result in variables as step.name.stdout, step.name.stderr, step.name.exitCode
     i. If exit code != 0 and no condition guards downstream steps, fail the pipeline
  2. Return PipelineResult with all step results

  CRITICAL: The executor MUST use Command::new(binary).args(vec) directly.
  It MUST NEVER invoke sh -c, bash -c, cmd /c, or any shell wrapper.
  It MUST NEVER pass the command string through shell expansion or interpretation.
```

### 7.2 Workflow Execution (TypeScript)

Workflow execution is handled by `packages/core/src/cant/workflow-executor.ts` within the
`@cleocode/core` package. The executor processes the statement list sequentially, dispatching
to the appropriate handler for each statement type:

```
FUNCTION execute_workflow(workflow: WorkflowDef, params: Record, ctx: ExecutionContext):
  1. Create a scope with workflow parameters bound to param values
  2. For each statement in workflow.body:
     a. Session: Dispatch to CLEO session manager, wait for response
     b. Parallel: Spawn all arms concurrently, apply join strategy (all/race/settle)
     c. Conditional: Evaluate condition
        - If discretion: call evaluateDiscretion(condition, context)
        - If expression: evaluate locally
     d. Loop (repeat/for/loop-until): Execute body, check termination condition
     e. TryCatch: Execute try body, catch exceptions, run finally
     f. ApprovalGate: Generate token, suspend session, wait for /approve directive
     g. Pipeline: Call Rust pipeline executor via napi-rs bridge
     h. Binding: Evaluate expression, add to scope
     i. Directive: Parse as Layer 1 message, dispatch to CLEO operations
     j. Output: Bind result value for workflow output
  3. Return WorkflowResult with output bindings
```

### 7.3 Discretion Evaluation

When the runtime encounters a discretion condition (`**prose text**`), it delegates evaluation
to a pluggable evaluator:

```typescript
/** Evaluates a discretion condition using AI judgment. */
interface DiscretionEvaluator {
  evaluate(condition: string, context: DiscretionContext): Promise<boolean>;
}

/** Context provided to the discretion evaluator. */
interface DiscretionContext {
  /** The current session identifier. */
  sessionId: string;
  /** Task references in scope. */
  taskRefs: string[];
  /** The agent performing the evaluation. */
  agentId: string;
  /** All variables in the current scope. */
  variables: Record<string, unknown>;
  /** Output from preceding pipeline steps or session results. */
  precedingResults: Record<string, unknown>;
}
```

**Default evaluator**: Calls the LLM API with the condition in a **structured field** (tool
use parameter or JSON mode field). The condition MUST NOT be concatenated into the system
prompt. The evaluator uses structured prompting to separate the condition from evaluation
instructions. The LLM returns a boolean `true`/`false` judgment.

**Pluggable evaluators**: Custom evaluators may be registered with the `WorkflowExecutor`
constructor. Use cases include regex-based evaluators for testing, rule-based evaluators for
common patterns, and alternative model evaluators.

**Rate limiting**: Implementations MUST enforce a configurable maximum number of discretion
evaluations per workflow execution. The default limit is 100. This prevents runaway costs from
loops containing discretion conditions.

### 7.4 Session Dispatch

Session statements invoke the CLEO session machinery:

```typescript
/** Dispatch a CANT session statement. */
async function dispatchSession(
  session: SessionExpr,
  scope: Scope,
  ctx: ExecutionContext,
): Promise<SessionResult> {
  if (session.target is Prompt) {
    // Create a new session with the prompt
    const prompt = evaluate(session.target.prompt, scope);
    const context = resolveContext(session.properties, scope);
    return ctx.sessionManager.create({ prompt, context });
  } else {
    // Invoke a named agent
    const agent = resolveAgent(session.target.agent, scope);
    return ctx.sessionManager.invokeAgent(agent, session.properties);
  }
}
```

### 7.5 Parallel Execution

Parallel blocks spawn all arms concurrently. The join strategy determines completion behavior:

| Modifier | Behavior |
|----------|----------|
| (default) | Wait for ALL arms to complete. Fail if any arm fails. |
| `race` | Return when the FIRST arm completes. Cancel remaining arms. |
| `settle` | Wait for ALL arms. Collect results as `{successes, failures}`. |

Arm results are bound to their names in the enclosing scope after the parallel block completes.

---

## 8. Approval Token Protocol

### 8.1 Token Schema

```typescript
/** An approval token for human-in-the-loop workflow gates. */
interface ApprovalToken {
  /** UUID v4 generated via CSPRNG (crypto.randomUUID or equivalent). */
  token: string;

  /** The session that generated this token. Token is bound to this session. */
  sessionId: string;

  /** The workflow that contains the approval gate. */
  workflowName: string;

  /** The name label of the specific approval gate. */
  gateName: string;

  /**
   * SHA-256 hash of the workflow definition text at the time the token was
   * created. Used for TOCTOU protection: if the workflow is modified between
   * token creation and approval, the token is invalidated.
   */
  workflowHash: string;

  /** The message displayed to the approver. */
  message: string;

  /** ISO 8601 timestamp of token creation. */
  createdAt: string;

  /**
   * ISO 8601 timestamp of token expiration. REQUIRED. Default is 24 hours
   * from creation if the workflow does not specify an `expires:` property.
   */
  expiresAt: string;

  /** Current token state. See state machine in Section 8.2. */
  status: 'pending' | 'approved' | 'rejected' | 'expired';

  /**
   * Identifier of the actor who approved/rejected. Informational only --
   * any authorized actor can approve (bearer token model).
   */
  approvedBy?: string;

  /** ISO 8601 timestamp of the approval/rejection action. */
  approvedAt?: string;

  /** ISO 8601 timestamp of when the token was consumed by the runtime. */
  usedAt?: string;

  /** Identifier of the agent/workflow that requested approval. */
  requestedBy: string;
}
```

### 8.2 State Machine

The approval token has exactly four states and three permitted transitions:

```
                    +-----------+
                    |  pending  |
                    +-----+-----+
                          |
            +-------------+-------------+
            |             |             |
            v             v             v
      +-----------+ +-----------+ +-----------+
      | approved  | | rejected  | |  expired  |
      +-----------+ +-----------+ +-----------+
```

- `pending -> approved`: Actor sends `/approve {token}`. Atomic CAS.
- `pending -> rejected`: Actor explicitly rejects. Atomic CAS.
- `pending -> expired`: Background expiration job or on-access check. Atomic CAS.

No other transitions are permitted. A token in `approved`, `rejected`, or `expired` state
MUST NOT be modified further. Each transition MUST be performed as an atomic compare-and-swap
operation:

```sql
UPDATE sessions
SET approval_tokens_json = json_set(approval_tokens_json, ...)
WHERE token = ? AND json_extract(approval_tokens_json, '$.status') = 'pending';
```

If the CAS operation affects zero rows, the transition MUST be rejected.

### 8.3 Approval Flow

1. Workflow execution reaches an `approve:` gate.
2. Runtime generates a UUID v4 token via CSPRNG.
3. Runtime computes SHA-256 hash of the current workflow definition text.
4. Runtime stores the `ApprovalToken` in the session's `approvalTokensJson` column.
5. Runtime sets session status to `suspended`.
6. Runtime displays the approval message to the user, including the token value.
7. User (or authorized agent) sends `/approve {token}` as a CANT Layer 1 directive.
8. Runtime receives the directive, looks up the token.
9. Runtime validates:
   - (a) Token exists
   - (b) `sessionId` matches the current or originating session
   - (c) `status` is `pending`
   - (d) Current time < `expiresAt`
   - (e) `workflowHash` matches the current workflow definition hash
10. If all checks pass, atomic CAS: `status = 'approved'`, set `approvedAt`, `approvedBy`.
11. If workflowHash mismatch: token rejected, new approval cycle required.
12. Workflow executor resumes from the checkpoint.

### 8.4 Storage

Approval tokens are stored in the existing CLEO sessions table via an additive
`approvalTokensJson` column. This leverages CLEO's existing session persistence without
introducing a new storage system.

The `approvalTokensJson` column MUST NOT be included in `handoffJson`, `debriefJson`, or
any session serialization exposed to agents. Token values MUST NOT appear in audit logs,
session summaries, or error messages.

---

## 9. Security Considerations

This section consolidates all security-relevant aspects of the CANT DSL. Each subsection
references the validation rules and runtime behaviors that provide defense.

### 9.1 Command Injection Prevention (P06)

**Threat**: A malicious or compromised `.cant` file constructs shell commands from
user-controlled or agent-controlled variables, enabling arbitrary code execution.

**Defense**: Pipeline `command:` values MUST name a bare binary. Dynamic values MUST be passed
exclusively through the `args:` array. The Rust pipeline executor MUST use
`Command::new(binary).args(vec)` and MUST NEVER delegate to a shell interpreter (`sh -c`,
`bash -c`, `cmd /c`).

**Validation**: Rule P06 statically rejects interpolation within `command:` strings.

### 9.2 Data Exfiltration via Pipeline Commands (P07)

**Threat**: A pipeline step executes an arbitrary binary (e.g., `curl`, `nc`) to exfiltrate
project data to an external endpoint.

**Defense**: Rule P07 provides a configurable command allowlist. Projects SHOULD define an
explicit allowlist in `.cleo/config.json`. Additionally, the runtime SHOULD support optional
network namespace isolation for untrusted `.cant` files.

**Validation**: Rule P07 emits warnings for commands not on the allowlist.

### 9.3 Resource Exhaustion (W08, W09, W10, W11)

**Threat**: A `.cant` file specifies extreme values for timeouts, parallel arms, repeat
counts, or nesting depth, causing the runtime to consume excessive memory, CPU, or time.

**Defense**: Four configurable limits with sane defaults:

| Rule | Resource | Default Limit |
|------|----------|---------------|
| W08 | Timeout per step/operation | 3,600 seconds |
| W09 | Parallel arms per block | 32 |
| W10 | Repeat loop iterations | 10,000 |
| W11 | Control flow nesting depth | 16 |

Additionally, the parser enforces:
- Maximum input file size: 1 MB
- Maximum AST node count: 100,000 per file

### 9.4 Import Path Traversal (S09, S10)

**Threat**: An `@import` statement references a path outside the project directory (via `..`
traversal or symlink) to read sensitive files or inject malicious definitions.

**Defense**:
- Rule S09 rejects resolved paths outside the project root after `..` normalization.
- Rule S10 rejects paths whose real (symlink-resolved) location is outside the project root.
- Rule S11 limits import chain depth to prevent stack exhaustion from deep (non-circular)
  chains.

### 9.5 Expression Interpolation Safety (T07)

**Threat**: A dynamic value containing `${...}` syntax triggers a second round of
interpolation, leaking secrets or executing unintended expressions.

**Defense**: Rule T07 mandates single-pass interpolation. The runtime evaluates `${expr}` once.
If the result contains `${...}`, it is treated as literal text. No recursive evaluation occurs.

### 9.6 Discretion Prompt Injection

**Threat**: A crafted discretion condition or contextual variable manipulates the LLM evaluator
into returning a false positive, bypassing approval logic.

**Defense**:
- The discretion condition text MUST be placed in a structured field (tool use parameter or
  JSON mode field), never concatenated into the system prompt.
- The default evaluator MUST use structured prompting to separate condition evaluation from
  instruction context.
- Rate limiting (default 100 evaluations per workflow) prevents brute-force manipulation.
- Sensitive decisions SHOULD use `approve:` gates for human verification, not discretion
  conditions.

### 9.7 Permission Escalation (S12, S13)

**Threat**: An imported `.cant` file declares permissions exceeding those of the importing
context, gaining unauthorized access to CLEO operations.

**Defense**:
- Rule S12 enforces that imported agents cannot escalate permissions beyond the importing
  context.
- Rule S13 restricts permission values to a closed set (`read`, `write`, `execute`),
  preventing injection of arbitrary permission strings.

### 9.8 Token Forgery and Replay

**Threat**: An attacker guesses or replays an approval token to resume a workflow without
authorization.

**Defense**:
- Tokens are UUID v4 generated via CSPRNG (128 bits of entropy).
- Tokens are bound to a specific session (`sessionId` check on validation).
- Tokens have mandatory expiration (`expiresAt`).
- `workflowHash` prevents TOCTOU attacks: if the workflow is modified after the token was
  issued, the token is invalidated.
- Status transitions use atomic CAS: a token can only be approved once.
- Token values MUST NOT appear in logs, error messages, or session serialization.
- Implementations SHOULD consider HMAC over `(token, sessionId, workflowName, gateName)` using
  a per-installation secret for non-transferability.

### 9.9 Audit Trail

The runtime MUST log the following events to the existing CLEO `audit_log` table:

| Event | Fields Logged |
|-------|---------------|
| Pipeline step execution | command, args (sanitized), exit code, duration |
| Discretion evaluation | condition text, result (true/false), evaluator type |
| Approval token created | workflowName, gateName, expiresAt, requestedBy (NOT the token value) |
| Approval token resolved | gateName, status transition, approvedBy (NOT the token value) |
| Workflow started | workflowName, parameters (sanitized) |
| Workflow completed | workflowName, duration, output count |
| Workflow failed | workflowName, error category, error message |

Token values (`token` field) MUST NEVER appear in audit logs.

---

## 10. Example .cant Files

This section provides 10 complete, syntactically valid `.cant` files demonstrating every
major language feature.

### Example 1: Simple Agent Definition

```cant
---
kind: agent
version: 1
---

# A basic agent with minimal configuration.
agent code-reviewer:
  model: "opus"
  persist: "session"
  prompt: "You review code for correctness, style, and security issues."
  skills: ["ct-cleo"]
```

### Example 2: Agent with Hooks and Permissions

```cant
---
kind: agent
version: 1
---

agent ops-lead:
  model: "opus"
  persist: "project"
  prompt: "You coordinate operations across the team. Never implement directly."
  skills: ["ct-cleo", "ct-orchestrator"]

  permissions:
    tasks: read, write
    session: read, write
    memory: read

  context:
    active-tasks
    recent-decisions

  on SessionStart:
    /checkin @all
    session "Review current sprint state"
      context: [active-tasks, recent-decisions]

  on ResponseComplete:
    if **the completed task unblocks other agents**:
      /action @all T{completed.id} #unblocked
    else:
      /info @all T{completed.id} #shipped
```

### Example 3: Skill Definition

```cant
---
kind: skill
version: 1
---

# A deployment skill with configurable parameters.
skill ct-deploy(target: string, env: string = "staging", timeout: duration = 300s):
  description: "Automated deployment skill for CLEO projects"
  tier: "core"
  provider: "claude-code"
  tags: ["deployment", "ops"]
```

### Example 4: Deterministic Pipeline (Deploy)

```cant
---
kind: pipeline
version: 1
---

# A CI/CD pipeline with no LLM involvement.
# Every step is deterministic. See rules P01-P07.
pipeline deploy(service: string, env: string):
  step lint:
    command: "biome"
    args: ["check", "--write", "."]
    timeout: 60s

  step build:
    command: "pnpm"
    args: ["run", "build"]
    timeout: 120s

  step test:
    command: "pnpm"
    args: ["run", "test", "--reporter=json"]
    timeout: 300s

  step publish:
    command: "pnpm"
    args: ["publish", "--tag", env]
    condition: test.exitCode == 0
    timeout: 60s
```

### Example 5: LLM-Involved Workflow (Code Review with Parallel Sessions)

```cant
---
kind: workflow
version: 1
---

@import "./agents/security-scanner.cant" as scanner
@import "./agents/style-checker.cant" as styler

agent reviewer:
  model: "opus"
  prompt: "Expert code reviewer. Focus on correctness and edge cases."
  skills: ["ct-cleo"]

workflow review(pr_url):
  # Phase 1: Deterministic checks
  pipeline checks:
    step fetch:
      command: "gh"
      args: ["pr", "diff", pr_url]
      timeout: 30s

    step lint:
      command: "biome"
      args: ["check", "--json"]
      stdin: fetch
      timeout: 60s

    step test:
      command: "pnpm"
      args: ["test", "--json"]
      timeout: 300s

  # Phase 2: Parallel LLM review
  parallel:
    security = session: scanner
      prompt: "Analyze this diff for security vulnerabilities"
      context: checks
    style = session: styler
      prompt: "Review style issues in this diff"
      context: checks
    depth = session: reviewer
      prompt: "Deep review for logic errors and edge cases"
      context: checks

  # Phase 3: AI-evaluated decision
  if **all reviews pass with no critical issues**:
    /done T{pr.task_id} #shipped
    output verdict = "approve"
  elif **security issues found**:
    /blocked T{pr.task_id} #security
    output verdict = "block"
  else:
    /action @author "Address review feedback"
    output verdict = "changes-requested"
```

### Example 6: Workflow with Approval Gate

```cant
---
kind: workflow
version: 1
---

workflow deploy-production(service: string):
  # Build and test first
  pipeline pre-deploy:
    step build:
      command: "pnpm"
      args: ["run", "build"]
      timeout: 120s

    step test:
      command: "pnpm"
      args: ["run", "test"]
      timeout: 300s

  # Require human approval before production deployment
  approve:
    message: "Build and tests passed for ${service}. Deploy to production?"
    expires: 4h

  # Only reached after /approve {token}
  pipeline release:
    step deploy:
      command: "pnpm"
      args: ["run", "deploy", "--env", "production", "--service", service]
      timeout: 600s

  /done @all #deployed
  output status = "deployed"
```

### Example 7: Workflow with Discretion Conditions

```cant
---
kind: workflow
version: 1
---

workflow triage(issue_url: string):
  # Gather context
  let issue = session "Read and summarize the issue at ${issue_url}"

  # AI-evaluated severity assessment
  if **the issue is a critical security vulnerability**:
    /action @security-team #P0 #critical
    output priority = "P0"
    output action = "immediate-patch"
  elif **the issue causes data loss or corruption**:
    /action @on-call #P1
    output priority = "P1"
    output action = "hotfix"
  elif **the issue affects user experience but has a workaround**:
    /info @all #P2
    output priority = "P2"
    output action = "next-sprint"
  else:
    /info @all #backlog
    output priority = "P3"
    output action = "backlog"
```

### Example 8: Import and Composition

```cant
---
kind: workflow
version: 1
---

# Import shared agent definitions
@import "./agents/analyzer.cant" as analyzer
@import "./agents/writer.cant" as writer
@import "@ct-cleo"

# Import a shared pipeline
@import "./pipelines/quality-checks.cant" as quality

workflow write-docs(module_path: string):
  # Run deterministic analysis first
  pipeline analysis:
    step parse:
      command: "jsdoc"
      args: ["--explain", module_path]
      timeout: 30s

  # Parallel authoring sessions
  parallel:
    api_docs = session: analyzer
      prompt: "Extract the public API surface from ${module_path}"
      context: analysis
    examples = session: writer
      prompt: "Write usage examples for the API"
      context: analysis

  # Compose output
  let combined = session "Combine API docs and examples into a cohesive document"
    context: [api_docs, examples]

  output documentation = combined
```

### Example 9: Loop and Conditional Patterns

```cant
---
kind: workflow
version: 1
---

workflow retry-deploy(service: string, max_retries: number = 3):
  let attempts = 0
  let success = false

  repeat max_retries:
    let attempts = attempts + 1

    try:
      pipeline attempt:
        step deploy:
          command: "pnpm"
          args: ["run", "deploy", "--service", service]
          timeout: 120s
      let success = true
    catch err:
      /info @all "Attempt ${attempts} failed: ${err}"
      if attempts == max_retries:
        /blocked @ops-lead "All ${max_retries} deploy attempts failed for ${service}"
        output status = "failed"

  if success:
    /done @all #deployed
    output status = "deployed"
```

### Example 10: Error Handling with Try/Catch

```cant
---
kind: workflow
version: 1
---

workflow safe-migration(db_name: string):
  # Create a backup before migration
  pipeline backup:
    step dump:
      command: "pg_dump"
      args: [db_name, "--format=custom", "--file=backup.dump"]
      timeout: 600s

  try:
    # Run the migration
    pipeline migrate:
      step apply:
        command: "pnpm"
        args: ["run", "migrate:up"]
        timeout: 300s

    # Verify the migration
    pipeline verify:
      step check:
        command: "pnpm"
        args: ["run", "migrate:verify"]
        timeout: 60s

    /done @all "Migration completed successfully"
    output status = "success"

  catch err:
    /info @all "Migration failed: ${err}. Rolling back."

    # Restore from backup
    pipeline rollback:
      step restore:
        command: "pg_restore"
        args: ["--dbname", db_name, "backup.dump"]
        timeout: 600s

    /blocked @ops-lead "Migration failed and was rolled back. Manual review needed."
    output status = "rolled-back"

  finally:
    # Clean up backup file regardless of outcome
    pipeline cleanup:
      step remove:
        command: "rm"
        args: ["-f", "backup.dump"]
        timeout: 10s
```

---

## 11. Migration Guide

This section describes how to convert existing AGENTS.md markdown instruction files into
`.cant` files. The `cant migrate` CLI command automates this process; this guide explains the
conversion rules for manual or review purposes.

### 11.1 Conversion Principles

1. **Conservative conversion**: When the converter cannot determine the correct `.cant`
   representation, it MUST emit a `# TODO: manual conversion needed` comment rather than
   guessing.
2. **@import bridge**: Converted `.cant` files are referenced from AGENTS.md via `@import`
   within CAAMP markers.
3. **Incremental adoption**: Not all content needs to be converted at once. Markdown and
   `.cant` files coexist.
4. **Round-trip fidelity**: `cant migrate` followed by manual review should not lose
   information.

### 11.2 Before/After: Agent Definition

**Before** (AGENTS.md markdown):

```markdown
## Code Review Agent

- **Model**: Opus
- **Persistence**: Project-level
- **Prompt**: You review code for correctness and security.
- **Skills**: ct-cleo, ct-orchestrator
- **Permissions**:
  - Tasks: read, write
  - Session: read
```

**After** (`.cleo/agents/code-reviewer.cant`):

```cant
---
kind: agent
version: 1
---

agent code-reviewer:
  model: "opus"
  persist: "project"
  prompt: "You review code for correctness and security."
  skills: ["ct-cleo", "ct-orchestrator"]

  permissions:
    tasks: read, write
    session: read
```

**Updated AGENTS.md**:

```markdown
<!-- CAAMP:START -->
@AGENTS.md
@import .cleo/agents/code-reviewer.cant
<!-- CAAMP:END -->
```

### 11.3 Before/After: Hook Definition

**Before** (markdown instruction):

```markdown
### On Session Start

When a session starts:
1. Check in with the team
2. Review the current sprint state
3. Load context: active tasks, recent decisions
```

**After** (`.cleo/hooks/session-start.cant`):

```cant
---
kind: hook
version: 1
---

on SessionStart:
  /checkin @all
  session "Review current sprint state"
    context: [active-tasks, recent-decisions]
```

### 11.4 Before/After: Workflow

**Before** (markdown procedure):

```markdown
### Deploy Procedure

1. Run `pnpm run build`
2. Run `pnpm run test`
3. If tests pass, ask for approval
4. Run `pnpm run deploy --env production`
```

**After** (`.cleo/workflows/deploy.cant`):

```cant
---
kind: workflow
version: 1
---

workflow deploy:
  pipeline build-and-test:
    step build:
      command: "pnpm"
      args: ["run", "build"]
      timeout: 120s

    step test:
      command: "pnpm"
      args: ["run", "test"]
      timeout: 300s

  approve:
    message: "Tests passed. Deploy to production?"

  pipeline release:
    step deploy:
      command: "pnpm"
      args: ["run", "deploy", "--env", "production"]
      timeout: 600s
```

### 11.5 Before/After: Permissions

**Before** (markdown list):

```markdown
### Permissions

This agent can:
- Read and write tasks
- Read sessions
- Read memory
- Cannot execute administrative operations
```

**After** (inside an agent definition):

```cant
  permissions:
    tasks: read, write
    session: read
    memory: read
```

### 11.6 Content That Does Not Convert

The following content types remain as markdown. The converter MUST NOT attempt to convert
them:

- Narrative documentation and explanations
- Architecture decision records
- Meeting notes and discussion threads
- Links to external resources
- Images and diagrams
- Content outside CAAMP markers

The converter MUST flag such content with:

```cant
# TODO: manual conversion needed -- narrative content at AGENTS.md line 42
```

### 11.7 CLI Usage

```bash
# Preview what would be converted (dry run)
cant migrate AGENTS.md --dry-run

# Convert and write .cant files, update AGENTS.md with @import references
cant migrate AGENTS.md --write

# Convert a specific section only
cant migrate AGENTS.md --section "Code Review Agent" --write
```

---

## Appendix A: Keyword Reference

The following words are reserved keywords in CANT and MUST NOT be used as identifiers in
contexts where they would be ambiguous:

| Keyword | Layer | Context |
|---------|-------|---------|
| `agent` | 2 | Agent definition |
| `skill` | 2 | Skill definition |
| `on` | 2 | Hook definition |
| `permissions` | 2 | Permission block |
| `context` | 2 | Context block |
| `let` | 2, 3 | Variable binding |
| `workflow` | 3 | Workflow definition |
| `pipeline` | 3 | Pipeline definition |
| `step` | 3 | Pipeline step |
| `session` | 3 | Session invocation |
| `parallel` | 3 | Parallel block |
| `race` | 3 | Parallel modifier |
| `settle` | 3 | Parallel modifier |
| `if` | 3 | Conditional |
| `elif` | 3 | Conditional |
| `else` | 3 | Conditional |
| `for` | 3 | For loop |
| `in` | 3 | For loop |
| `repeat` | 3 | Repeat loop |
| `loop` | 3 | Loop-until |
| `until` | 3 | Loop-until |
| `try` | 3 | Try block |
| `catch` | 3 | Catch clause |
| `finally` | 3 | Finally clause |
| `approve` | 3 | Approval gate |
| `output` | 3 | Output binding |
| `from` | 2 | Named import |
| `and` | expr | Logical AND |
| `or` | expr | Logical OR |
| `not` | expr | Logical NOT |
| `true` | expr | Boolean literal |
| `false` | expr | Boolean literal |
| `allow` | 2 | Blocking hook: permit action |
| `deny` | 2 | Blocking hook: reject action |

---

## Appendix B: Configuration Keys

CANT validation rules reference the following configuration keys in `.cleo/config.json`:

| Key | Type | Default | Used By |
|-----|------|---------|---------|
| `cant.maxTimeout` | number (seconds) | 3600 | W08 |
| `cant.maxParallelArms` | number | 32 | W09 |
| `cant.maxRepeatCount` | number | 10000 | W10 |
| `cant.maxNestingDepth` | number | 16 | W11 |
| `cant.maxImportDepth` | number | 64 | S11 |
| `cant.pipeline.allowedCommands` | string[] | [] (disabled) | P07 |
| `cant.discretion.maxEvaluations` | number | 100 | Runtime |

---

## Appendix C: Relationship to Existing Systems

| System | Relationship to CANT |
|--------|---------------------|
| **AGENTS.md** | Industry-standard entry point. `.cant` files are referenced via `@import`. AGENTS.md is NOT replaced. |
| **LAFS** | Response protocol. CANT encompasses LAFS as its response syntax. `@cleocode/lafs` continues to exist independently. |
| **CAAMP** | Hook event taxonomy. CANT's `on Event:` blocks map 1:1 to the 16 CAAMP canonical events. |
| **Conduit** | Transport layer. CANT messages are carried over Conduit; CANT defines content, Conduit defines transport. |
| **CLEO Dispatch** | Operation router. CANT directives map to CLEO CQRS operations via the directive-to-operation table. |
| **cant-core (Rust)** | The canonical parser implementation. Layer 1 is frozen in the existing crate; Layers 2-3 are additive modules. |
| **@cleocode/cant (TS)** | WASM/napi-rs wrapper providing `parseCantDocument()` to the TypeScript ecosystem. |
| **OpenProse (.prose)** | Inspiration for sessions, parallel, discretion. CANT differs by having a real parser and real runtime, not an LLM-simulated VM. |
| **Lobster (.lobster)** | Inspiration for deterministic pipelines, approval tokens, resume semantics. |

---

## Appendix D: Versioning

This specification uses semantic versioning. The `version:` field in frontmatter refers to
the schema version, not the spec version.

| Spec Version | Schema Version | Status | Changes |
|--------------|---------------|--------|---------|
| 1.0.0-draft | 1 | Current | Initial complete specification |

Backward compatibility guarantees:
- Layer 1 (`parse()`) MUST NEVER change behavior.
- Schema version 1 files MUST parse correctly in all future parser versions.
- New schema versions may add constructs but MUST NOT remove or alter existing syntax.

---

*Specification authored by @cleo-rust-lead. Security review by @versionguard-opencode.
Rust architecture review by @signaldock-core-agent. Documentation review by
@claude-opus-llmtxt. Based on the CANT DSL Implementation Plan v2 and the existing cant-core
parser (47 Rust tests, 8 TypeScript tests).*

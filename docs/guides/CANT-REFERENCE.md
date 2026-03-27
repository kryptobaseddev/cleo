# CANT Language Reference

**Version**: 1.0.0 | **Spec**: [`CANT-DSL-SPEC.md`](../specs/CANT-DSL-SPEC.md) | **Status**: Implemented

CANT (**C**LEO **A**gent **N**otation for **T**asks) is the non-prose DSL that powers the
CLEO ecosystem. It defines agents, skills, hooks, workflows, and pipelines in a structured,
parseable format with full LSP support.

---

## Why CANT?

CANT replaces prose-based agent instructions with a real language that has:

- **A real parser** (`cant-core`, Rust) -- not an LLM pretending to be a VM
- **A real LSP** (`cant-lsp`) -- diagnostics, completions, hover, go-to-definition
- **Static analysis** -- 42 validation rules catch errors before any LLM touches the file
- **Deterministic pipelines** -- shell commands with no LLM involvement at all
- **Minimal prose** -- prose only appears in session prompts and discretion conditions

The LLM is a tool invoked by the runtime, not the runtime itself.

---

## File Format

### Extension

All CANT files use the `.cant` extension. There are no compound extensions (`.cant.agent`,
`.cant.workflow`, etc.). The `kind:` frontmatter field determines the document type.

### Encoding and Indentation

- UTF-8 encoded, no BOM
- 2-space indentation (tabs rejected)
- Max file size: 1 MB
- Comments: `#` to end of line

### Document Modes

A `.cant` file operates in one of two modes:

| Mode | Trigger | Use |
|------|---------|-----|
| **Message mode** (Layer 1) | No frontmatter | Single CANT message: `/directive @addr T123 #tag` |
| **Document mode** (Layers 2-3) | Has `---` frontmatter | Agent definitions, workflows, pipelines |

---

## Frontmatter

Every document-mode `.cant` file begins with a YAML frontmatter block:

```cant
---
kind: workflow
version: 1
---
```

| Property | Required | Values |
|----------|----------|--------|
| `kind` | Yes | `agent`, `skill`, `hook`, `workflow`, `pipeline`, `config` |
| `version` | Yes | Schema version (currently `1`) |

The `kind` controls which top-level constructs are allowed:

| Kind | Allowed Constructs |
|------|-------------------|
| `agent` | `agent`, `on`, `@import`, `let` |
| `skill` | `skill`, `@import`, `let` |
| `hook` | `on`, `@import`, `let` |
| `workflow` | `workflow`, `pipeline`, `agent`, `@import`, `let` |
| `pipeline` | `pipeline`, `@import`, `let` |
| `config` | property assignments only |

---

## Three Layers, One Grammar

CANT is organized into three layers. All share one parser, one AST, and one grammar.

### Layer 1: Message Protocol

The original CANT -- structured messages between agents. This layer is **frozen**.

```cant
/done @all T1234 #shipped

## Phase A complete

Added assignee column. @versionguard-opencode see T5678.
```

Parsed elements:

| Token | Meaning |
|-------|---------|
| `/verb` | Directive (action, routing, or informational) |
| `@name` | Address (agent or group reference) |
| `T1234` | Task reference |
| `#tag` | Semantic tag |

Body text follows the header after a blank line. Addresses, task refs, and tags in the
body are extracted but not interpreted as directives.

### Layer 2: Instruction DSL

Defines **what agents, skills, and hooks ARE** -- structured properties, not paragraphs.

#### Agent Definition

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

  on SessionStart:
    /checkin @all
    session "Review current sprint state"
      context: [active-tasks, recent-decisions]
```

**Agent properties**: `model`, `prompt`, `persist`, `skills`, `timeout`, `retry`,
`backoff`, plus custom key-value pairs.

**Permissions**: Domain-scoped access control. Values: `read`, `write`, `execute`.

**Inline hooks**: `on Event:` blocks inside an agent apply only to that agent.

#### Skill Definition

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

Skills accept typed parameters with optional defaults.
Types: `string`, `number`, `boolean`, `duration`, `list`, `any`.

#### Hook Definition

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

Hook events MUST be one of the 16 CAAMP canonical events:

`SessionStart`, `SessionEnd`, `PromptSubmit`, `ResponseComplete`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
`SubagentStart`, `SubagentStop`, `PreModel`, `PostModel`,
`PreCompact`, `PostCompact`, `Notification`, `ConfigChange`

#### Import Statement

```cant
@import "./agents/security-scanner.cant"
@import scanner from "./agents/security-scanner.cant"
@import "@ct-cleo"
```

Imports bring definitions from other `.cant` files into scope. Named imports
(`scanner from "path"`) bind a specific export to a local name.

#### Let Binding

```cant
let status = task.status
let message = "Deploy ${service.name} to ${env}"
```

Binds a name to an expression value in the current scope.

### Layer 3: Orchestration DSL

Defines **how work FLOWS** -- workflows, pipelines, sessions, parallel execution,
control flow, discretion, and approval gates.

#### Workflow

Workflows MAY contain LLM-dependent constructs (sessions, discretion conditions,
approval gates).

```cant
---
kind: workflow
version: 1
---

workflow review(pr_url):
  # Deterministic pipeline first (no LLM)
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

  # Parallel LLM review
  parallel:
    security = session "Run security analysis"
      context: checks
    style = session "Review code style"
      context: checks

  # AI-evaluated conditional
  if **all reviews pass with no critical issues**:
    /done T{pr.task_id} #shipped
    output verdict = "approve"
  else:
    /action @author "Address review feedback"
    output verdict = "changes-requested"
```

#### Pipeline (Deterministic)

Pipelines MUST be deterministic -- **no sessions, no discretion, no approval gates,
no LLM calls**. The validator enforces this (rules P01-P07).

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

**Step properties**: `command` (required, binary name), `args` (array), `stdin`
(prior step name), `timeout`, `condition`.

The `command` property MUST name a binary. Arguments MUST go in `args`, never via
shell interpolation in the command string (rule P06).

#### Session

Sessions are the **only place prose enters** a workflow. Two invocation forms:

```cant
# Direct prompt
session "Analyze the code for security issues"
  context: [checks, prior-reviews]

# Agent reference
session: scanner
  context: [checks]
```

#### Parallel Block

```cant
parallel:
  security = session "Run security analysis"
  style = session: quick-check
    context: checks
  depth = session: reviewer
    context: checks
```

Join strategies (optional modifier after `parallel`):

| Modifier | Behavior |
|----------|----------|
| *(none)* | Wait for all arms to complete (default) |
| `race` | Return on first arm completion |
| `settle` | Wait for all, collect successes and failures |

Arm names must be unique within the block (rule S07).

#### Conditional

Conditions can be regular expressions or **discretion conditions** (AI-evaluated):

```cant
# Expression-based condition
if status == "ready":
  /done T1234

# Discretion condition (AI evaluates the prose)
if **all reviews pass with no critical issues**:
  /done T1234 #shipped
elif **security issues found**:
  /blocked T1234 #security
else:
  /action @author "Address review feedback"
```

Discretion conditions use `**prose text**` syntax. The prose is opaque to the parser --
it is passed to an LLM evaluator at runtime. Discretion conditions are **forbidden in
pipelines** (rule P02).

#### Loops

```cant
# Fixed count
repeat 3:
  session "Retry the operation"

# Collection iteration
for item in tasks:
  session "Process ${item}"

# Condition-based (with discretion)
loop:
  session "Check deployment status"
  until **deployment healthy for 5 minutes**
```

#### Try / Catch / Finally

```cant
try:
  session "Deploy to production"
catch err:
  /info @ops "Deployment failed: ${err}"
finally:
  /done T1234
```

The try body MUST contain at least one statement (rule W05).

#### Approval Gate

Human-in-the-loop approval that suspends workflow execution:

```cant
approve:
  message: "Ready to deploy to production?"
  timeout: 24h
```

The `message` property is required (rule W01). Default expiration is 24h.

#### Output Binding

```cant
output verdict = "approve"
output report = security.findings
```

Outputs are the return values of a workflow, accessible by the caller.

---

## Expression Language

The expression language is intentionally minimal. No function definitions, no closures,
no arithmetic operators.

```cant
# Variables and property access
agent.name
checks.lint.exitCode

# Comparisons
task.status == "done"
count > 0

# Boolean logic
task.done and not task.blocked
a == 1 or b == 2

# String interpolation (double-quoted only)
"Deploy ${service.name} to ${env}"

# Arrays and objects
["ct-cleo", "ct-orchestrator"]
{name: "ops-lead", model: "opus"}

# Task refs and addresses as values
T1234
@ops-lead

# Durations
30s
5m
24h
7d
```

Interpolation is **single-pass** (rule T07): if `service.name` evaluates to `"${evil}"`,
the result is literally `"${evil}"`. Use `\$` to escape a literal `${`.

---

## Where Prose Appears (and Where It Doesn't)

| Construct | Prose? | Rationale |
|-----------|--------|-----------|
| Session prompts | Yes | Instruction to the LLM |
| Discretion conditions (`**...**`) | Yes | AI-evaluated logic |
| Agent definitions | **No** | Structured properties |
| Control flow (`parallel`, `if`, `loop`) | **No** | Keywords |
| References (`T1234`, `@agent`, `#tag`) | **No** | Semantic tokens |
| Pipelines | **No** | Deterministic, no LLM |
| Context wiring | **No** | Explicit `context:` declarations |

---

## Validation Rules (Summary)

42 rules across 5 categories. Full details in [`CANT-DSL-SPEC.md` Section 4](../specs/CANT-DSL-SPEC.md#4-validation-rules).

### Scope Rules (S01-S13)

| Rule | Severity | What It Checks |
|------|----------|---------------|
| S01 | Error | Unresolved variable reference |
| S02 | Warning | Shadowed binding |
| S03 | Error | Circular import chain |
| S04 | Error | Import target existence |
| S05 | Error | Unique names within file |
| S06 | Error | Valid hook event name (16 CAAMP events) |
| S07 | Error | Unique parallel arm names |
| S08 | Error | Unique step names in pipeline |
| S09 | Warning | Unused binding |
| S10 | Error | Kind-construct mismatch (e.g., workflow in a `kind: agent` file) |
| S11 | Error | Import path traversal (`../../../etc/passwd`) |
| S12 | Error | Import path restricted to `.cant` extension |
| S13 | Error | Permission values from closed set (`read`, `write`, `execute`) |

### Pipeline Purity Rules (P01-P07)

Pipelines MUST be deterministic. These rules enforce it:

| Rule | Severity | What It Checks |
|------|----------|---------------|
| P01 | Error | No session statements in pipelines |
| P02 | Error | No discretion conditions in pipelines |
| P03 | Error | No approval gates in pipelines |
| P04 | Error | No parallel blocks in pipelines |
| P05 | Error | No nested workflows in pipelines |
| P06 | Error | Command must be a bare binary (no shell interpolation) |
| P07 | Error | Step stdin references must name an earlier step |

### Type Rules (T01-T07)

| Rule | Severity | What It Checks |
|------|----------|---------------|
| T01 | Error | Duration property expects duration value |
| T02 | Error | Model property expects valid model identifier |
| T03 | Error | Skills property expects array of strings |
| T04 | Error | Condition expression must be boolean-typed |
| T05 | Error | Repeat count must be a positive integer |
| T06 | Error | For-loop iterable must be array-typed |
| T07 | Error | Interpolation must be single-pass (no nested `${}`) |

### Hook Rules (H01-H04)

| Rule | Severity | What It Checks |
|------|----------|---------------|
| H01 | Error | Event name must be a canonical CAAMP event |
| H02 | Warning | Duplicate hook for same event in same scope |
| H03 | Error | Hook body must not be empty |
| H04 | Error | No nested hook definitions |

### Workflow Rules (W01-W11)

| Rule | Severity | What It Checks |
|------|----------|---------------|
| W01 | Error | Approval gate requires `message:` property |
| W02 | Error | Parallel block must have >= 2 arms |
| W03 | Warning | Unreachable code after unconditional output/throw |
| W04 | Error | Nesting depth limit (max 8 levels) |
| W05 | Error | Try body must not be empty |
| W06 | Error | Try must have at least catch or finally |
| W07 | Error | For-loop variable must not shadow parameter |
| W08 | Error | Output binding only at workflow top level |
| W09 | Error | Session not allowed in hook bodies |
| W10 | Error | Repeat count max limit (1000) |
| W11 | Error | AST node count limit (10,000 nodes per file) |

---

## Implementation Stack

| Component | Location | What It Does |
|-----------|----------|-------------|
| **cant-core** | `crates/cant-core/` | Rust parser + validator (all 3 layers, 479 tests) |
| **cant-lsp** | `crates/cant-lsp/` | LSP server (diagnostics, completions, hover, goto-def, symbols) |
| **cant-runtime** | `crates/cant-runtime/` | Pipeline executor (deterministic subprocess orchestration) |
| **cant-napi** | `crates/cant-napi/` | N-API bindings for Node.js (Layer 1 parsing) |
| **@cleocode/cant** | `packages/cant/` | TypeScript wrapper (WASM/native, migration tools) |
| **Workflow executor** | `packages/core/src/cant/` | TypeScript runtime (sessions, parallel, discretion, approvals) |

---

## Quick Syntax Reference

```cant
# ── Frontmatter ──────────────────────────────
---
kind: workflow
version: 1
---

# ── Imports ──────────────────────────────────
@import "./agents/scanner.cant"
@import scanner from "./agents/scanner.cant"

# ── Agent definition ─────────────────────────
agent name:
  model: opus | sonnet | haiku | "custom-id"
  prompt: "Agent instructions"
  persist: project | true | "custom"
  skills: ["skill-a", "skill-b"]
  timeout: 30s | 5m | 1h
  retry: 3
  backoff: none | linear | exponential
  permissions:
    domain: read, write, execute
  context:
    context-name
  on Event:
    # hook body

# ── Skill definition ────────────────────────
skill name(param: type = default):
  description: "What it does"
  tier: core | standard | specialized

# ── Hook definition ──────────────────────────
on CanonicalEvent:
  # statements

# ── Workflow definition ──────────────────────
workflow name(params):
  # any statements (sessions, parallel, conditionals, etc.)

# ── Pipeline definition (deterministic) ──────
pipeline name(params):
  step step-name:
    command: "binary"
    args: ["arg1", "arg2"]
    stdin: prior-step-name
    timeout: 60s
    condition: expr

# ── Session (only place prose enters) ────────
session "Prompt text"
session: agent-name
  context: [ref-a, ref-b]

# ── Parallel ─────────────────────────────────
parallel [race | settle]:
  name = session "Task"
  name = session: agent

# ── Conditional ──────────────────────────────
if expr | **discretion prose**:
  # body
elif expr | **discretion prose**:
  # body
else:
  # body

# ── Loops ────────────────────────────────────
repeat N:
  # body
for var in collection:
  # body
loop:
  # body
  until expr | **discretion prose**

# ── Error handling ───────────────────────────
try:
  # body
catch err:
  # body
finally:
  # body

# ── Approval gate ────────────────────────────
approve:
  message: "Approve this action?"
  timeout: 24h

# ── Bindings and output ─────────────────────
let name = expression
output name = expression

# ── Directives (Layer 1 in workflow bodies) ──
/verb @address T1234 #tag "argument"
```

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [`CANT-DSL-SPEC.md`](../specs/CANT-DSL-SPEC.md) | Formal specification (EBNF, AST types, 42 validation rules) |
| [`CANT-DSL-IMPLEMENTATION-PLAN.md`](../specs/CANT-DSL-IMPLEMENTATION-PLAN.md) | 7-phase implementation plan with security amendments |
| [`CANT-TYPESCRIPT-INTEGRATION.md`](../specs/CANT-TYPESCRIPT-INTEGRATION.md) | TypeScript/WASM integration guide |
| [`CLEO-CANT.md`](../concepts/CLEO-CANT.md) | Protocol-level spec (directive mapping, Conduit integration) |

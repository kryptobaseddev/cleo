# CANT DSL Implementation Plan

**Status**: v2 — Amendments applied from review cycle. Awaiting final approval.
**Author**: @cleo-rust-lead
**Date**: 2026-03-26 (v2: 2026-03-27)
**Reviewers**: @cleo-core (CONDITIONAL APPROVE), @signaldock-core-agent (APPROVED), @versionguard-opencode (REQUEST CHANGES -> pending v2), @claude-opus-llmtxt (APPROVED)
**Collaborative Doc**: slug `CVZzUNbZ`

### v2 Changelog
- Added 12 security validation rules from versionguard review (P06-P07, W08-W11, S09-S13, T07)
- Hardened approval token schema (workflowHash, mandatory expiresAt, usedAt, requestedBy, HMAC)
- Added `#[non_exhaustive]` mandate on ParsedCANTMessage
- Tightened backward compat Guarantee 3: NO new fields on ParsedCANTMessage
- Added audit trail integration requirement for Phase 6
- Added llmtxt-core to Phase 1 napi-rs scope (per claude-opus-llmtxt review)
- Mandated arg-vector dispatch for pipeline executor (CRITICAL: no shell interpolation)

---

## 1. Executive Summary

CANT (Collaborative Agent Notation Tongue) is being evolved from a message protocol parser (~900 LOC Rust, 47 tests) into a **full non-prose DSL** — the sole structured language for the CLEO ecosystem. Inspired by OpenProse (.prose) and Lobster (.lobster), CANT takes a fundamentally different approach: **real parser, real runtime, real static analysis** — not an LLM-simulated VM.

### What Exists Today

| Component | Status | LOC | Tests |
|-----------|--------|-----|-------|
| cant-core message parser (Rust/nom) | Done | ~900 | 47 |
| @cleocode/cant WASM wrapper (TS) | Done | ~250 | 8 |
| Directive classification (12 verbs) | Done | in parser | covered |
| .cant file format | Does not exist | 0 | 0 |
| Document-mode parser (agent defs, workflows) | Does not exist | 0 | 0 |
| Execution blocks (parallel, session, pipeline) | Spec only | 0 | 0 |
| Discretion conditions (**...**) | Spec only | 0 | 0 |
| LSP server | Does not exist | 0 | 0 |
| Linter/validator | Does not exist | 0 | 0 |
| Runtime executor | Does not exist | 0 | 0 |

### What We're Building

```
OpenProse (.prose)  -> agent orchestration, sessions, parallel, discretion
Lobster (.lobster)  -> deterministic pipelines, approvals, resume tokens
CLEO messages       -> directives, addressing, task refs, tags
              |
       CANT (.cant) -> unified non-prose DSL for the entire CLEO ecosystem
```

**Critical philosophical difference from OpenProse**: CANT is NOT an "LLM simulates a VM" pattern. CANT has:
- A **real parser** (cant-core, Rust, nom combinators)
- A **real runtime** (Rust pipeline executor + TS workflow executor)
- **Real static analysis** (LSP built from the same AST)
- The LLM is a **tool invoked at specific points** (session prompts, discretion conditions), not the execution engine

---

## 2. Locked Design Decisions

These decisions have been made by the project owner and are not up for review. The implementation plan is built around them.

### Decision 1: Runtime Model — Hybrid (C)

| Layer | Runtime | Language | Rationale |
|-------|---------|----------|-----------|
| Pipelines | Subprocess orchestration | Rust (`crates/cant-runtime/`) | Deterministic, no LLM, max perf |
| Workflows | CLEO dispatch + session mgmt | TypeScript (`packages/core/src/cant/`) | Needs task state, LLM dispatch |
| Bridge | napi-rs 3.8+ | Rust -> TS | Single Rust crate -> Node native + WASM targets |

napi-rs 3.8+ replaces the current wasm-bindgen/wasm-pack pattern. It compiles to both native Node.js addon AND WASM from one Rust crate, giving better Node perf and cleaner SSoT.

### Decision 2: Discretion Evaluation — (A) with (C) Pluggable

When the runtime encounters `**all reviews pass with no critical issues**`:
- Default: Call LLM API with structured context (`evaluateDiscretion(condition, context)`)
- Pluggable: Custom evaluators can override (regex-based, rule-based, different models, mock for testing)

### Decision 3: AGENTS.md Relationship — (C) Migration Path

- **AGENTS.md remains the industry-standard entry point** (widely prevalent in codebases)
- All core systems and tooling built around the CANT DSL
- `.cant` files work alongside markdown via `@import`
- `cant migrate` command converts markdown instructions -> .cant
- Special markdown <-> CANT bidirectional conversion handling

### Decision 4: Approval/Resume Tokens — (A) Session Persistence

- Use existing CLEO session persistence in `tasks.db` (sessions table)
- Sessions table already has: `status`, `scopeJson`, `handoffJson`, `debriefJson`, `resumeCount`
- Add `approvalTokensJson` column (additive migration)
- No separate storage system — CLEO session machinery handles everything

### Decision 5: Domain Events — (A) Extend CAAMP with Domain Categories

- CAAMP's 16 provider events (LLM-lifecycle) are extended with domain events (business logic)
- CLEO registers as the first domain source: 15 events across task, memory, pipeline, session categories
- All events use the same `on Event:` syntax in CANT — no separate namespace
- The canonical event registry lives in `hook-mappings.json` (SSoT)
- **CRITICAL**: Parsers MUST NOT hardcode event names. The `CANONICAL_EVENTS` const in cant-core MUST be replaced with runtime configuration read from the registry. The parser accepts any PascalCase identifier, validation checks against the registry.
- Domain events use the D:O:P pattern (Domain:Operation:Phase) as machine-readable metadata
- See `CANT-EXECUTION-SEMANTICS.md` Sections 9-12 for the full Generic Domain Event Protocol

### Decision 6: Event Registry SSoT — (A) hook-mappings.json

- `hook-mappings.json` is the single source of truth for ALL canonical events (provider + domain)
- Each event entry gains a `source` field: `"provider"` or `"domain"`
- A new `domainSources` section registers domain event sources (CLEO first, extensible)
- cant-core Rust validation reads from a passed-in event list, not a compile-time constant
- TypeScript types are generated/validated against the JSON registry
- Adding new domain events is additive and does NOT require Rust recompilation

---

## 3. Three-Layer Grammar Architecture

All three layers share ONE grammar, ONE parser (`cant-core`), ONE AST. A `.cant` file can use any combination of layers.

### Layer 1: Message Protocol (DONE — current cant-core, MUST NOT BREAK)

```
/directive @address T1234 #tag
```

Parses message headers: directives, @addresses, T-refs, #tags, header/body split. 12 canonical directives classified as actionable/routing/informational. This is the existing `parse()` function and it is **frozen** — no changes permitted.

### Layer 2: Instruction DSL (NEW — what agents ARE)

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

on SessionStart:
  /checkin @all
  session "Review current sprint state"
    context: [active-tasks, recent-decisions]

on TaskComplete:
  if **the completed task unblocks other agents**:
    /action @all T{completed.id} #unblocked
  else:
    /info @all T{completed.id} #shipped
```

Constructs: frontmatter, agent blocks, skill blocks, hook blocks (`on Event:`), property assignment, permissions, context wiring, `@import` statements, let/const bindings.

### Layer 3: Orchestration DSL (NEW — how work FLOWS)

```cant
---
kind: workflow
version: 1
---

@import "./agents/security-scanner.cant" as scanner
@import "./agents/style-checker.cant" as styler

agent reviewer:
  model: opus
  prompt: "Expert code reviewer. Focus on correctness and edge cases."
  skills: ["ct-cleo"]

workflow review(pr_url):
  # Phase 1: Deterministic checks (NO LLM, NO discretion)
  pipeline checks:
    step fetch:
      command: "gh pr diff {pr_url}"
      timeout: 30s

    step lint:
      command: "biome check --json"
      stdin: fetch
      timeout: 60s

    step test:
      command: "pnpm test --json"
      timeout: 300s

  # Phase 2: Parallel LLM review (sessions = ONLY place prose enters)
  parallel:
    security = scanner(target: pr_url)
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
    /review @human "Security issues require manual review"
      approval: required
    output verdict = "block"
  else:
    /action @author "Address review feedback"
    output verdict = "changes-requested"
```

Constructs: workflows (LLM-involved), pipelines (deterministic), sessions, parallel blocks, loops, conditionals, try/catch, discretion conditions (**...**), approval gates, resume tokens.

### The Non-Prose Invariant

**Prose appears in exactly TWO places:**
1. Session prompts (`prompt: "..."`) — the instruction to the LLM
2. Discretion conditions (`**...**`) — AI-evaluated logic

Everything else is structured, parseable, lintable:
- Agent definitions -> structured properties, not paragraphs
- Control flow -> keywords (parallel, if, loop), not sentences
- References -> T1234, @agent, #tag — tokens with semantic meaning
- Pipelines -> deterministic steps, zero LLM involvement
- Context wiring -> explicit `context:` declarations, not implicit

---

## 4. File Format Specification

### Extension
`.cant` is the UNIVERSAL extension. No `.cant.agent`, `.cant.workflow` variants. The frontmatter `kind:` field tells the parser and LSP what validation mode to use.

### Frontmatter
```yaml
---
kind: agent         # agent | skill | hook | workflow | pipeline | config
version: 1
---
```

Files without frontmatter are treated as **message mode** (Layer 1 backward compatibility).

### Expression Language

Minimal, intentional — NOT a general-purpose programming language:

| Expression | Example | Used For |
|------------|---------|----------|
| Variable reference | `agent.name` | Property access |
| String interpolation | `"Deploy ${service.name}"` | Dynamic strings |
| Comparison | `task.status == "done"` | Conditionals |
| Boolean operators | `a and b`, `not c` | Compound conditions |
| Task refs | `T1234` | First-class values |
| Addresses | `@agent-name` | First-class values |
| Literals | `"string"`, `42`, `true`, `[a, b]` | Values |

No function definitions, no closures, no arithmetic, no loops-in-expressions.

### Import Resolution

```
@import "./relative/path.cant"        -> resolve relative to current file
@import "@skill-name"                 -> .cleo/skills/{skill-name}.cant
@import "bare-name"                   -> .cleo/skills/ -> node_modules lookup -> error
@import "name" from "./path.cant"     -> named import from file
```

### CAAMP Event Mapping

The 16 canonical CAAMP events map directly to CANT `on Event:` blocks (PascalCase, verbatim):

| CAAMP Event | CANT Block | Category | Can Block? |
|-------------|-----------|----------|------------|
| SessionStart | `on SessionStart:` | session | no |
| SessionEnd | `on SessionEnd:` | session | no |
| PromptSubmit | `on PromptSubmit:` | prompt | no |
| ResponseComplete | `on ResponseComplete:` | prompt | no |
| PreToolUse | `on PreToolUse:` | tool | yes |
| PostToolUse | `on PostToolUse:` | tool | no |
| PostToolUseFailure | `on PostToolUseFailure:` | tool | no |
| PermissionRequest | `on PermissionRequest:` | tool | yes |
| SubagentStart | `on SubagentStart:` | agent | no |
| SubagentStop | `on SubagentStop:` | agent | no |
| PreModel | `on PreModel:` | context | no |
| PostModel | `on PostModel:` | context | no |
| PreCompact | `on PreCompact:` | context | no |
| PostCompact | `on PostCompact:` | context | no |
| Notification | `on Notification:` | context | no |
| ConfigChange | `on ConfigChange:` | context | no |

The parser validates event names against this allowlist (rule H01).

---

## 5. Implementation Phases

### Phase 0: CANT-DSL-SPEC.md (Formal Language Specification)

**Goal**: Complete language specification that serves as the test oracle for all subsequent phases. Grammar design IS the hard part — implementation follows mechanically.

**Deliverable**: `docs/specs/CANT-DSL-SPEC.md`

**Contents**:
1. Complete EBNF grammar (all 3 layers)
2. AST type definitions (Rust structs, all with `Span`)
3. ~30 numbered validation rules (testable)
4. File format specification
5. Runtime execution model
6. Import resolution algorithm
7. Discretion evaluation protocol
8. 10+ example `.cant` files covering each kind
9. Migration guide from markdown

**Effort**: medium

---

### Phase 1: napi-rs 3.8+ Migration

**Goal**: Replace wasm-bindgen/wasm-pack with napi-rs 3.8+ across all crates. Unblocks native Node.js performance and creates the build infrastructure for all subsequent phases.

**Dependencies**: Phase 0 reviewed (can proceed in parallel with spec finalization)

#### New Crate: `crates/cant-napi/`

Thin binding crate wrapping cant-core for Node/WASM via napi-rs:

| File | Purpose |
|------|---------|
| `Cargo.toml` | napi 3.8+, napi-derive, cant-core dependency |
| `src/lib.rs` | `#[napi]` exports: `parse()`, `classify_directive()` |
| `build.rs` | napi-rs build script |
| `package.json` | `@cleocode/cant-native` npm package |

#### Modifications to Existing

| File | Change |
|------|--------|
| `crates/cant-core/Cargo.toml` | Remove wasm-bindgen, js-sys, wasm feature, cdylib crate-type, wasm-pack metadata. Keep rlib only. |
| `crates/cant-core/src/wasm.rs` | **DELETE** |
| `crates/cant-core/src/lib.rs` | Remove `pub mod wasm` |
| `crates/conduit-core/Cargo.toml` | Same: remove wasm-bindgen, wasm feature |
| `crates/conduit-core/src/wasm.rs` | **DELETE** |
| `crates/lafs-core/Cargo.toml` | Same treatment |
| `crates/lafs-core/src/wasm.rs` | **DELETE** |
| `Cargo.toml` (workspace) | Add `crates/cant-napi` member, napi workspace deps |
| `packages/cant/src/wasm-loader.ts` -> `native-loader.ts` | Load napi addon (sync), graceful fallback |
| `packages/cant/src/parse.ts` | Call native addon. `initCantParser()` becomes no-op. |
| `packages/cant/src/index.ts` | Update exports |
| `build-wasm.sh` -> `build-native.sh` | napi-rs build pipeline |

##### Scope: llmtxt-core included (per claude-opus-llmtxt review)

llmtxt-core uses the identical wasm-bindgen pattern (19 WASM-exported functions, cdylib crate type, feature-gated wasm-bindgen). To avoid maintaining two binding strategies, llmtxt-core migrates to napi-rs in the same phase. @claude-opus-llmtxt executes the llmtxt-core side; @cleo-rust-lead handles cant/conduit/lafs crates.

### Backward Compatibility
- `parseCANTMessage()` signature **unchanged**
- `initCantParser()` kept as no-op for backward compat
- JS fallback parser preserved at `packages/cant/src/parse.ts`
- All 47 Rust tests + 8 TS tests pass unchanged

#### napi-rs Target Strategy
- Primary: `node` (native Node.js addon, best perf)
- Secondary: `wasm32` (browser fallback, replaces wasm-pack)
- Key advantage: Synchronous loading (no async `init()` needed like wasm-bindgen)

#### Tests: ~62 new
- 15 napi binding tests in `crates/cant-napi/`
- 47 cross-validation tests (native addon produces identical results to JS fallback for all Rust test cases)

**Effort**: medium

---

### Phase 2: Grammar Foundation (Layer 2 — Instruction DSL)

**Goal**: Parse `.cant` document-mode files: frontmatter, agent/skill/hook definitions, properties, imports, bindings.

**Dependencies**: Phase 0 (EBNF finalized), Phase 1 (napi-rs build infra)

#### New Rust Modules: `crates/cant-core/src/dsl/`

| Module | Purpose |
|--------|---------|
| `mod.rs` | DSL entry point: `parse_document()` |
| `ast.rs` | All AST node types with `Span` (CantDocument, AgentDef, SkillDef, HookDef, Property, etc.) |
| `frontmatter.rs` | Frontmatter parser (--- blocks, kind, version, properties) |
| `agent.rs` | Agent block parser |
| `skill.rs` | Skill block parser |
| `hook.rs` | Hook block parser (`on Event:`, validates against 16 CAAMP events) |
| `import.rs` | Import statement parser (`@import`) |
| `property.rs` | Property assignment parser (key: value) |
| `binding.rs` | Let/const binding parser |
| `permission.rs` | Permission block parser (allow/deny) |
| `context.rs` | Context block parser |
| `expression.rs` | Expression parser (variables, property access, comparisons, string interpolation) |
| `indent.rs` | Indentation-aware parsing (pre-process to INDENT/DEDENT tokens, Python-style) |
| `span.rs` | `Span { start, end, line, col }` for all AST nodes |
| `error.rs` | Parse error types with spans and rich messages |

#### Key Technical Decisions

**Indentation Strategy**: CANT uses significant indentation (2-space standard). Pre-process the input to compute indentation levels, converting physical whitespace into a token stream with explicit INDENT/DEDENT markers, then feed to nom combinators. This separates indentation tracking from grammar parsing.

**AST carries Span everywhere**: Every node knows its source location. Required for LSP (Phase 5) diagnostics, completions, hover, go-to-definition.

**Two independent entry points**: `parse()` (Layer 1, frozen) and `parse_document()` (Layers 2+3, new). No interaction between them.

#### Modifications

| File | Change |
|------|--------|
| `crates/cant-core/src/lib.rs` | Add `pub mod dsl;` and `pub fn parse_document()` |
| `crates/cant-napi/src/lib.rs` | Add `parse_document()` napi export |
| `packages/cant/src/types.ts` | Add TS types mirroring Rust AST |
| `packages/cant/src/index.ts` | Export `parseCantDocument()` |

#### Tests: ~140 new
- Frontmatter: 20 (valid, invalid, missing kind, version mismatch)
- Agent blocks: 25 (properties, permissions, context, nested hooks)
- Skill blocks: 15
- Hook blocks: 15 (all 16 CAAMP events, invalid events rejected)
- Imports: 10 (relative, absolute, bare identifier, from syntax)
- Expressions: 25 (property access, interpolation, comparisons, booleans)
- Indentation: 15 (2-space, tab rejection, mixed errors, recovery)
- Error reporting: 10 (span accuracy, message quality)
- Roundtrip: 5 (parse -> serialize -> parse identity)

**Effort**: large

---

### Phase 3: Orchestration Parsing (Layer 3)

**Goal**: Add workflow, pipeline, session, parallel, conditional, choice, loop, try/catch, throw, block_def/block_call, discretion, and approval gate parsing.

**Dependencies**: Phase 2 (AST types, expression parser, indentation handling)

#### New Rust Modules: `crates/cant-core/src/dsl/`

| Module | Purpose |
|--------|---------|
| `workflow.rs` | Workflow block parser: `workflow Name(params):` |
| `pipeline.rs` | Pipeline block parser: deterministic step sequences |
| `session.rs` | Session expression parser: `session "prompt"` / `session: agent-name` |
| `parallel.rs` | Parallel block parser: named arms with join strategies |
| `conditional.rs` | If/elif/else parser, discretion condition recognition |
| `choice.rs` | Choice block parser: AI multi-option selection with discretion criteria |
| `loop_.rs` | Loop parser: `for x in collection:`, `loop until **condition**:`, `repeat N:` |
| `try_catch.rs` | Try/catch/finally block parser |
| `throw.rs` | Throw statement parser: explicit error signaling |
| `block.rs` | Reusable block definition and block call parser |
| `discretion.rs` | Discretion condition parser: `** prose text **` extraction |
| `approval.rs` | Approval gate parser: message, timeout, required/optional |

#### AST Extensions in `dsl/ast.rs`

```rust
pub enum Statement {
    Session(SessionExpr),
    Parallel(ParallelBlock),
    Conditional(Conditional),
    Choice(ChoiceBlock),       // AI multi-option selection
    Loop(LoopStmt),
    TryCatch(TryCatch),
    Throw(ThrowStmt),          // Explicit error signaling
    ApprovalGate(ApprovalGate),
    BlockDef(BlockDef),        // Reusable block definition
    BlockCall(BlockCall),      // Block invocation
    PipeStep(PipeStep),
    Expression(Expression),
    Binding(Binding),
    Directive(Directive),      // Layer 1 directives in workflow bodies
}

pub struct WorkflowDef { name, params, body: Vec<Statement>, span }
pub struct PipelineDef { name, params, steps: Vec<PipeStep>, span }  // deterministic ONLY
pub struct SessionExpr { prompt_or_agent, properties, context, span }
pub struct ParallelBlock { arms: Vec<ParallelArm>, span }
pub struct DiscretionCondition { prose: String, span }
pub struct ApprovalGate { message, timeout, span }
```

**Key distinction**: `PipelineDef` contains only `PipeStep` nodes. `WorkflowDef` contains any `Statement`. This structural separation makes Phase 4 validation straightforward.

#### Tests: ~125 new
- Workflow: 25, Pipeline: 20, Parallel: 15, Conditional/discretion: 20, Loop: 10, Try/catch: 10, Approval: 10, Complex nested: 15

**Effort**: large

---

### Phase 4: Validation Engine (45 Static Analysis Rules)

**Goal**: Build the analysis layer that powers the LSP and CLI linter.

**Dependencies**: Phase 3 (complete AST)

#### New Module: `crates/cant-core/src/validate/`

| Module | Purpose |
|--------|---------|
| `mod.rs` | `ValidationEngine`, `run_all_rules()` |
| `context.rs` | `ValidationContext`: symbol tables, scope stacks |
| `scope.rs` | Rules S01-S08: scope analysis |
| `pipeline_purity.rs` | Rules P01-P05: pipeline determinism |
| `types.rs` | Rules T01-T06: type checking |
| `hooks.rs` | Rules H01-H04: hook validation |
| `workflows.rs` | Rules W01-W07: workflow validation |
| `imports.rs` | Import resolution validation |
| `diagnostic.rs` | `Diagnostic { severity, rule_id, message, span, fix? }` |

#### Validation Rules (45 total)

**Scope (S01-S13)**:
- S01: No unresolved variable references
- S02: No shadowed bindings (warn)
- S03: No circular import chains
- S04: Import targets exist (file-level)
- S05: Agent/skill/block names unique within file
- S06: Hook event names valid (from canonical event registry in hook-mappings.json — NOT hardcoded)
- S07: Parallel arm names unique within block
- S08: Bindings used before definition (error)
- S09: **[SECURITY]** Import paths MUST resolve within project root (directory containing `.cleo/` or `.git/`). Paths traversing above project root MUST be rejected.
- S10: **[SECURITY]** Import paths MUST NOT follow symlinks resolving outside the project root.
- S11: **[SECURITY]** Transitive import chain depth MUST NOT exceed configurable limit (default: 64).
- S12: **[SECURITY]** Agent permissions in imported files MUST NOT exceed permissions of importing context (principle of least privilege).
- S13: **[SECURITY]** Permission values MUST be from a closed set (`read`, `write`, `execute`). Arbitrary strings rejected.

**Pipeline Purity (P01-P08)**:
- P01: No `session` expressions in pipeline body
- P02: No discretion conditions (`** **`) in pipeline body
- P03: No `approve:` gates in pipeline body
- P04: No LLM-dependent calls in pipeline body
- P05: All pipeline steps must be deterministic
- P06: **[CRITICAL/SECURITY]** Pipeline `command:` values MUST NOT contain unescaped interpolation of user/agent-supplied variables. MUST use argument-array syntax (`args: [var]`) that bypasses shell interpretation. The Rust `cant-runtime` pipeline executor MUST use `Command::new(binary).args(vec)` and MUST NEVER pass interpolated strings through `sh -c`.
- P07: **[SECURITY]** Pipeline `command:` values SHOULD be validated against a configurable command allowlist to prevent execution of arbitrary binaries.
- P08: No `throw` statements in pipeline body (throw is workflow-only)

**Types (T01-T07)**:
- T01: Property values match expected types
- T02: Comparison operands type-compatible
- T03: String interpolation operands stringifiable
- T04: Context references resolve to valid agent/skill names
- T05: Parallel arm context references exist
- T06: Approval gate message evaluates to string
- T07: **[SECURITY]** String interpolation MUST perform single-pass evaluation with no nested interpolation. `${}` within interpolated values MUST be treated as literal text.

**Hooks (H01-H04)**:
- H01: Event name is in canonical event registry (provider + domain events)
- H02: No duplicate `on Event:` blocks for same event in same agent
- H03: Hook body must not contain workflow constructs (parallel, approval)
- H04: Blocking hooks (`canBlock: true`) must have explicit handling

**Workflows (W01-W13)**:
- W01: Approval gates require `message:` property
- W02: Parallel arms have unique names
- W03: Session prompts are string expressions
- W04: Loop iterables are resolvable collections
- W05: Try blocks have at least one statement
- W06: Workflow names are valid identifiers
- W07: No unreachable code after unconditional return/break
- W08: **[SECURITY]** `timeout:` values MUST NOT exceed configurable maximum (default: 3600s).
- W09: **[SECURITY]** `parallel:` blocks MUST NOT exceed configurable arm limit (default: 32).
- W10: **[SECURITY]** `repeat N:` count MUST NOT exceed configurable limit (default: 10000).
- W11: **[SECURITY]** Control flow nesting depth MUST NOT exceed configurable limit (default: 16). Parser enforces max input size (1MB) and max AST node count.
- W12: Choice blocks require at least 2 option clauses
- W13: Reusable block definitions must not contain output bindings

#### Diagnostic Output Type

```rust
pub struct Diagnostic {
    pub severity: Severity,  // Error, Warning, Info, Hint
    pub rule_id: String,     // "S01", "P03", etc.
    pub message: String,
    pub span: Span,
    pub fix: Option<Fix>,    // Suggested auto-fix (for LSP code actions)
}
```

Directly consumable by LSP (Phase 5) and CLI linter.

#### napi/TS Integration
- `crates/cant-napi/src/lib.rs`: Add `validate_document()` napi export
- `packages/cant/src/validate.ts`: New module exposing `validateCantDocument()`

#### Tests: ~145 new
- 3-5 tests per rule (30 rules x 4 avg = 120)
- 15 integration tests with complex documents triggering multiple rules
- 10 diagnostic quality tests (span accuracy, message clarity)

**Effort**: medium

---

### Phase 5: LSP Server (cant-lsp)

**Goal**: Ship a `cant-lsp` binary with diagnostics, completions, hover, go-to-definition, and a VS Code extension.

**Dependencies**: Phase 4 (validation engine, diagnostic type)

#### New Crate: `crates/cant-lsp/`

| File | Purpose |
|------|---------|
| `Cargo.toml` | tower-lsp 0.20, cant-core dependencies |
| `src/main.rs` | LSP server entry point |
| `src/backend.rs` | `LanguageServer` impl for tower-lsp |
| `src/capabilities.rs` | Server capability declarations |
| `src/diagnostics.rs` | cant-core Diagnostic -> LSP Diagnostic conversion |
| `src/completions.rs` | Completions: keywords, event names, agent names, properties, imports |
| `src/hover.rs` | Hover: type info, directive docs, property descriptions |
| `src/goto.rs` | Go-to-definition: imports, agent/skill references |
| `src/symbols.rs` | Document/workspace symbol provider |
| `src/semantic_tokens.rs` | Semantic token provider for highlighting |
| `src/document.rs` | Document state management, incremental updates |

#### VS Code Extension: `editors/vscode-cant/`

| File | Purpose |
|------|---------|
| `package.json` | VS Code extension manifest |
| `syntaxes/cant.tmLanguage.json` | TextMate grammar for syntax highlighting |
| `language-configuration.json` | Brackets, comments, indentation rules |
| `src/extension.ts` | LSP client connecting to cant-lsp via stdio |

#### LSP Capabilities

| Feature | Source |
|---------|--------|
| Diagnostics | Phase 4 validation engine (on-save + on-type) |
| Completions | Keywords, canonical events (provider + domain), agent/skill/block names, properties, file paths |
| Hover | Type info, directive docs (`/claim` = "actionable -> orchestrate.claim"), property descriptions |
| Go-to-definition | Import targets, agent/skill definition sites |
| Document symbols | Outline of agents, skills, hooks, workflows, pipelines |
| Code actions | Auto-fix from Diagnostic.fix (Phase 4) |
| Formatting | Canonical CANT style (consistent 2-space indent, property ordering) |

#### Tests: ~75 new
- 30 LSP protocol tests (mock client)
- 20 completion tests
- 15 diagnostic integration
- 10 TextMate grammar

**Effort**: large

---

### Phase 6: Runtime Integration

**Goal**: Execute `.cant` files — pipelines in Rust, workflows in TypeScript.

**Dependencies**: Phase 4 (validated AST), Phase 3 (orchestration parsing)

#### Pipeline Executor (Rust): `crates/cant-runtime/`

| File | Purpose |
|------|---------|
| `Cargo.toml` | cant-core, tokio dependencies |
| `src/lib.rs` | Runtime entry point |
| `src/pipeline.rs` | PipelineExecutor: subprocess orchestration |
| `src/step.rs` | Step execution: command running, stdout/stderr capture |
| `src/env.rs` | Environment/variable binding resolution |
| `src/error.rs` | Runtime error types |

Takes validated `PipelineDef` AST, executes each step as a subprocess, pipes output between steps, returns structured results. napi export: `execute_pipeline()`.

#### Workflow Executor (TypeScript): `packages/core/src/cant/`

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export |
| `workflow-executor.ts` | Orchestrates sessions via CLEO dispatch |
| `session-manager.ts` | Session lifecycle for CANT sessions |
| `parallel-runner.ts` | Concurrent arm execution |
| `discretion.ts` | `evaluateDiscretion(condition, context)` — pluggable, defaults to LLM |
| `approval.ts` | Token generation, validation, session storage, /approve resumption |
| `context-builder.ts` | Build execution context from CANT bindings |
| `types.ts` | Runtime types: ExecutionResult, StepResult, etc. |

#### Discretion Evaluation

```typescript
interface DiscretionEvaluator {
  evaluate(condition: string, context: DiscretionContext): Promise<boolean>;
}

interface DiscretionContext {
  sessionId: string;
  taskRefs: string[];
  agentId: string;
  variables: Record<string, unknown>;
}
```

Default: LLM API call with structured context. Pluggable: `WorkflowExecutor` constructor accepts optional evaluator.

#### Approval Token Schema Integration

Add to sessions table (`packages/core/src/store/tasks-schema.ts`):

```typescript
approvalTokensJson: text('approval_tokens_json'),  // Nullable, additive migration
```

`ApprovalToken` type in `@cleocode/contracts` (hardened per versionguard security review):

```typescript
interface ApprovalToken {
  token: string;           // UUID v4 (CSPRNG)
  sessionId: string;       // Bound to originating session
  workflowName: string;
  gateName: string;
  workflowHash: string;    // SHA-256 of workflow definition at gate time (TOCTOU protection)
  message: string;
  createdAt: string;       // ISO8601
  expiresAt: string;       // REQUIRED (not optional). Default 24h if workflow doesn't specify.
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedBy?: string;     // Informational — any authorized actor can approve (bearer token model, documented)
  approvedAt?: string;
  usedAt?: string;         // Timestamp of approval/rejection for audit trail
  requestedBy: string;     // Agent/workflow that requested approval
}
```

**Security invariants** (from versionguard review):
- Token validation MUST verify: (a) token exists, (b) `sessionId` matches current/originating session, (c) `status` is `pending`, (d) not expired
- Status transitions are **atomic CAS**: `pending -> approved`, `pending -> rejected`, `pending -> expired`. No other transitions permitted. DB operation MUST use `UPDATE ... WHERE status = 'pending'` pattern.
- On resumption, runtime MUST verify `workflowHash` matches current workflow definition. Hash mismatch = token rejected, new approval cycle required.
- `approvalTokensJson` is NEVER included in `handoffJson`, `debriefJson`, or any session serialization exposed to agents
- Token values MUST NOT appear in audit logs, session summaries, or error messages
- Application layer MUST use transaction with row-level locking when modifying `approvalTokensJson`
- Consider HMAC over `(token, sessionId, workflowName, gateName)` using per-installation secret for non-transferability

**Flow**:
1. Workflow hits `approve:` gate -> generate UUID token -> compute workflowHash -> store in session's `approvalTokensJson`
2. Workflow executor suspends session (status: `suspended`)
3. `/approve {token}` directive received via CANT Layer 1 parser
4. Token looked up: validate session binding, check `pending` status, verify not expired, verify workflowHash matches current workflow
5. Atomic CAS: `UPDATE ... SET status = 'approved' WHERE token = ? AND status = 'pending'`
6. Workflow executor resumes from checkpoint

#### Pipeline Executor Security (CRITICAL — from versionguard review)

The Rust pipeline executor MUST:
- Execute commands using `Command::new(binary).args(vec)` — **NEVER** pass interpolated strings through `sh -c`
- Validate command binaries against configurable allowlist before execution
- Log all executed commands and arguments to the existing `audit_log` table
- Support optional sandboxing mode (network namespace isolation, seccomp) for untrusted `.cant` files

#### Discretion Evaluation Safeguards

- The `DiscretionContext` MUST include raw condition text in a **structured field**, not interpolated into a system prompt
- The default evaluator MUST use structured prompting (tool use / JSON mode) to separate condition from evaluation instructions
- Rate limiting: configurable max discretion evaluations per workflow execution (default: 100)

#### Audit Trail Integration (from versionguard review)

Phase 6 runtime MUST log to the existing `audit_log` table:
- Pipeline step execution (command, args, exit code, duration)
- Discretion evaluations (condition, result, evaluator type)
- Approval token lifecycle events (created, approved, rejected, expired)
- Workflow start/complete/fail events

#### Hybrid Bridge (TS calls Rust for pipelines)

```typescript
import { executePipeline } from '@cleocode/cant-native';

// In workflow-executor.ts
if (step instanceof PipelineDef) {
  const result = await executePipeline(step, variables);
}
```

#### Tests: ~100 new
- Pipeline executor (Rust): 30, Workflow executor (TS): 25, Discretion: 15, Approval: 20, Bridge: 10

**Effort**: large

---

### Phase 7: Migration & Adoption

**Goal**: `cant migrate` CLI, AGENTS.md `@import` for `.cant` files, markdown <-> CANT conversion.

**Dependencies**: Phase 6 (runtime working), Phase 2 (document parser)

#### CLI Command: `cant migrate`

New at `packages/cleo/src/commands/cant-migrate.ts`:

```bash
cant migrate AGENTS.md                # Preview conversion
cant migrate AGENTS.md --write        # Write .cant files, update AGENTS.md with @import
cant migrate AGENTS.md --dry-run      # Show what would change
```

Conservative conversion: flags uncertain sections with `# TODO: manual conversion needed` rather than guessing.

#### AGENTS.md @import Support

New at `packages/caamp/src/core/instructions/cant-resolver.ts`:

Resolves `@import *.cant` lines within CAAMP:START/END markers. Parses referenced `.cant` file, extracts definitions, converts to provider instruction format.

```markdown
<!-- CAAMP:START -->
@AGENTS.md
@import .cleo/agents/core-agent.cant
@import .cleo/workflows/deploy.cant
<!-- CAAMP:END -->
```

#### Markdown <-> CANT Conversion Engine

New at `packages/cant/src/migrate/`:

| File | Purpose |
|------|---------|
| `index.ts` | Migration entry point |
| `markdown-parser.ts` | Heuristic markdown section parser |
| `converter.ts` | Markdown AST -> CANT AST |
| `serializer.ts` | CANT AST -> .cant file text |
| `diff.ts` | Before/after diff display |

#### Tests: ~55 new
- CLI: 15, @import: 10, Conversion: 20, Roundtrip: 10

**Effort**: medium

---

## 6. Cumulative Test Targets

| Phase | New Tests | Cumulative | Key Focus |
|-------|-----------|------------|-----------|
| Existing | -- | 55 | 47 Rust + 8 TS |
| Phase 1: napi-rs | ~62 | ~117 | Binding + cross-validation |
| Phase 2: Grammar | ~140 | ~257 | AST completeness |
| Phase 3: Orchestration | ~125 | ~382 | Control flow constructs |
| Phase 4: Validation | ~200 | ~582 | 45 rules (12 security + 3 new: W12, W13, P08), diagnostic quality |
| Phase 5: LSP | ~75 | ~642 | Protocol, completions, hover |
| Phase 6: Runtime | ~100 | ~742 | Execution correctness, security |
| Phase 7: Migration | ~55 | ~797 | Conversion fidelity |

---

## 7. New Crate/Module Summary

### New Rust Crates (3)

| Crate | Phase | Purpose |
|-------|-------|---------|
| `crates/cant-napi/` | 1 | napi-rs binding (Node native + WASM) |
| `crates/cant-lsp/` | 5 | LSP server binary (tower-lsp) |
| `crates/cant-runtime/` | 6 | Pipeline executor (subprocess orchestration) |

### New TypeScript Modules (3)

| Module | Phase | Purpose |
|--------|-------|---------|
| `packages/core/src/cant/` | 6 | Workflow executor, discretion, approval |
| `packages/cant/src/migrate/` | 7 | Markdown <-> CANT conversion engine |
| `packages/caamp/src/core/instructions/cant-resolver.ts` | 7 | @import resolution from AGENTS.md |

### Key Files Modified

| File | Phase(s) | Change |
|------|----------|--------|
| `crates/cant-core/Cargo.toml` | 1 | Remove wasm-bindgen, keep rlib only |
| `crates/cant-core/src/wasm.rs` | 1 | DELETE |
| `crates/cant-core/src/lib.rs` | 1, 2 | Remove wasm mod; add `pub mod dsl` + `parse_document()` |
| `crates/cant-core/src/parser.rs` | -- | **UNCHANGED** (Layer 1 frozen) |
| `packages/cant/src/wasm-loader.ts` -> `native-loader.ts` | 1 | napi-rs loader |
| `packages/cant/src/parse.ts` | 1, 2 | napi binding + parseCantDocument |
| `packages/cant/src/types.ts` | 2 | AST type definitions |
| `packages/core/src/store/tasks-schema.ts` | 6 | approvalTokensJson column |
| `packages/contracts/src/session.ts` | 6 | ApprovalToken type |
| `Cargo.toml` (workspace) | 1, 5, 6 | Add new crate members |

### New Spec Documents (1)

| Document | Phase | Purpose |
|----------|-------|---------|
| `docs/specs/CANT-DSL-SPEC.md` | 0 | Complete language specification (EBNF, AST, validation rules, examples) |

---

## 8. Backward Compatibility Guarantee

Throughout ALL phases:

1. `cant_core::parse(content: &str) -> ParsedCANTMessage` **NEVER** changes signature or behavior
2. `@cleocode/cant`'s `parseCANTMessage()` **NEVER** changes signature or behavior
3. `ParsedCANTMessage` struct/interface has **NO fields added, removed, or changed**. The struct MUST be annotated with `#[non_exhaustive]` in Rust to signal downstream crates should not depend on exhaustive field matching. New data from Layer 2/3 parsing belongs in the separate `CantDocument` AST type returned by `parse_document()`.
4. `.cant` files without frontmatter parse as Layer 1 messages
5. All 47 existing Rust tests and 8 existing TS tests pass at **EVERY** phase boundary. Recommend CI gate running original 55 tests as isolated job at every phase merge.
6. SignalDock's git dependency on `cant-core` is unaffected (it only calls `parse()`). Phase 1 crate-type change from `cdylib` to `rlib` is actually an improvement for Rust library consumers.

---

## 9. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| napi-rs 3.8 WASM maturity | Browser consumers may break | Medium | Keep JS fallback parser permanently |
| Indentation parsing with nom | Parser complexity spike | Medium | Pre-process to INDENT/DEDENT token stream (well-understood Python approach) |
| Discretion evaluation latency | Slow workflow execution | Low | Pluggable evaluator: short-circuit common patterns without LLM |
| Migration heuristic quality | Bad .cant output from markdown | Medium | Conservative conversion, --dry-run, TODO comments for uncertain sections |
| SignalDock dependency chain | Breaking git dep for external repo | Low | SignalDock only calls `parse()` — DSL modules are purely additive |
| Scope creep in expression language | CANT becomes a general-purpose language | Medium | Intentionally minimal: no functions, no closures, no arithmetic. Resist additions. |
| **Command injection via pipeline steps** | **Arbitrary code execution** | **High if unmitigated** | **P06: arg-vector dispatch mandatory. P07: command allowlist. NEVER sh -c.** |
| **Approval token replay/forgery** | **Unauthorized workflow resumption** | **Medium** | **Atomic CAS transitions, workflowHash TOCTOU protection, mandatory expiration, session binding** |
| **Discretion prompt injection** | **Bypassed approval logic** | **Medium** | **Structured prompting (tool use/JSON mode), condition in structured field not system prompt** |
| **Import path traversal** | **Filesystem probing, data leakage** | **Medium** | **S09: project root containment. S10: symlink escape prevention.** |

---

## 10. Review Requested

This plan requires approval from:
- [ ] **@cleo-core** (PRIME orchestrator) — architectural alignment, placement, CLEO integration
- [ ] **@signaldock-core-agent** — Rust crate architecture, cant-core changes, napi-rs migration impact on git dep
- [ ] **@versionguard-opencode** — Security review, validation rules completeness, backward compat verification

**Vote**: Approve / Request Changes / Block

Please review and respond in the cleoos-project group conversation.

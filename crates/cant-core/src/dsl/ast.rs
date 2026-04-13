//! AST node types for the CANT DSL (Layer 2 Instruction DSL).
//!
//! Every node includes a [`Span`] field for LSP integration and error
//! reporting. Types here mirror the formal spec in `CANT-DSL-SPEC.md`
//! Section 3.

use super::span::Span;
use serde::{Deserialize, Serialize};

// ── Document Root ────────────────────────────────────────────────────

/// The root AST node for a parsed `.cant` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CantDocument {
    /// The document type, derived from the `kind:` frontmatter field.
    /// `None` for Layer 1 message-mode files or documents without frontmatter.
    pub kind: Option<DocumentKind>,
    /// Parsed frontmatter block. `None` if no frontmatter present.
    pub frontmatter: Option<Frontmatter>,
    /// The top-level constructs in the document body.
    pub sections: Vec<Section>,
    /// Span covering the entire document.
    pub span: Span,
}

/// Document kinds corresponding to the `kind:` frontmatter value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DocumentKind {
    /// An agent definition document.
    Agent,
    /// A skill definition document.
    Skill,
    /// A hook definition document.
    Hook,
    /// A workflow definition document.
    Workflow,
    /// A pipeline definition document.
    Pipeline,
    /// A configuration document.
    Config,
    /// A message document (Layer 1 backward compatibility).
    Message,
    /// A protocol definition document — RCASD/IVTR protocol contract.
    ///
    /// CleoOS v2 (ULTRAPLAN §8): typed replacement for the hand-written
    /// protocols-markdown files in `packages/core/src/validation/protocols/`.
    Protocol,
    /// A lifecycle definition document — pipeline stage definitions.
    ///
    /// CleoOS v2 (ULTRAPLAN §8): typed replacement for the TypeScript const
    /// `PIPELINE_STAGES` in `packages/core/src/lifecycle/stages.ts`.
    Lifecycle,
    /// A team definition document — 3-tier hierarchy (orchestrator / leads / workers).
    ///
    /// CleoOS v2 (ULTRAPLAN §10): declares the multi-agent hierarchy with
    /// HITL routing rules and role enforcement.
    Team,
    /// A tool definition document — LLM-callable tool declarations.
    ///
    /// CleoOS v2 (ULTRAPLAN §8): custom Pi-tool registrations beyond the
    /// built-in dispatcher tools.
    Tool,
    /// A model-routing document — tier matrix + classifier config.
    ///
    /// CleoOS v2 (ULTRAPLAN §11): low/mid/high tier matrix driving the
    /// 3-layer classifier / router / pipeline.
    ModelRouting,
    /// A mental-model definition document — per-agent persistent model schema.
    ///
    /// CleoOS v2 (ULTRAPLAN §12): per-project BRAIN namespace config with
    /// validate-on-load policy.
    MentalModel,
}

/// Parsed YAML-style frontmatter block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frontmatter {
    /// Document kind extracted from the `kind:` property.
    pub kind: Option<DocumentKind>,
    /// Schema version extracted from the `version:` property.
    pub version: Option<String>,
    /// All frontmatter properties including kind and version.
    pub properties: Vec<Property>,
    /// Span covering the entire frontmatter block (including `---` delimiters).
    pub span: Span,
}

// ── Top-Level Sections ───────────────────────────────────────────────

/// Top-level constructs that may appear in a document body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Section {
    /// An agent definition block.
    Agent(AgentDef),
    /// A skill definition block.
    Skill(SkillDef),
    /// A hook definition block.
    Hook(HookDef),
    /// A workflow definition block (Layer 3).
    Workflow(WorkflowDef),
    /// A pipeline definition block (Layer 3).
    Pipeline(PipelineDef),
    /// A team definition block (CleoOS v2 — 3-tier hierarchy).
    Team(TeamDef),
    /// A tool definition block (CleoOS v2 — LLM-callable tool).
    Tool(ToolDef),
    /// An import statement.
    Import(ImportStatement),
    /// A let/const binding.
    Binding(LetBinding),
    /// A comment line.
    Comment(Comment),
}

// ── Agent Definition ─────────────────────────────────────────────────

/// An agent definition block.
///
/// ```cant
/// agent ops-lead:
///   model: opus
///   permissions:
///     tasks: read, write
///   context:
///     active-tasks
///     memory-bridge
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDef {
    /// The agent name identifier.
    pub name: Spanned<String>,
    /// Key-value properties (model, prompt, persist, skills, etc.).
    pub properties: Vec<Property>,
    /// Permission declarations.
    pub permissions: Vec<Permission>,
    /// Context references from a `context:` block.
    pub context_refs: Vec<ContextRef>,
    /// Inline hook definitions (`on Event:` within the agent block).
    pub hooks: Vec<HookDef>,
    /// Properties from a `context_sources:` sub-block (CleoOS v2 — JIT context pull config).
    ///
    /// Stored as raw properties; the bridge interprets them at spawn time.
    /// Lint rule `JIT-001` requires an `on_overflow:` entry whenever this is non-empty.
    pub context_sources: Vec<Property>,
    /// Properties from a `mental_model:` sub-block (CleoOS v2 — per-agent persistent model).
    ///
    /// Lint rules `MM-001` / `MM-002` require `scope:` and `validate: true` respectively
    /// whenever this is non-empty.
    pub mental_model: Vec<Property>,
    /// Path-scoped file permissions declared via `permissions: files:` sub-block (T422).
    ///
    /// `None` means no path ACL was declared (tool-level enforcement only).
    /// `Some(_)` means the agent has explicit path constraints; an empty `write`
    /// vec means the agent is read-only (default-deny for writes).
    pub file_permissions: Option<PathPermissions>,
    /// Span covering the entire agent definition.
    pub span: Span,
}

/// A spanned string value used for identifiers within AST nodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spanned<T> {
    /// The wrapped value.
    pub value: T,
    /// Source location of the value.
    pub span: Span,
}

impl<T> Spanned<T> {
    /// Creates a new spanned value.
    pub fn new(value: T, span: Span) -> Self {
        Self { value, span }
    }
}

// ── Skill Definition ─────────────────────────────────────────────────

/// A skill definition block.
///
/// ```cant
/// skill ct-deploy:
///   description: "Deployment automation"
///   tier: core
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDef {
    /// The skill name identifier.
    pub name: Spanned<String>,
    /// Key-value properties.
    pub properties: Vec<Property>,
    /// Span covering the entire skill definition.
    pub span: Span,
}

// ── Team Definition (CleoOS v2) ──────────────────────────────────────

/// A team definition block (`team Name:`).
///
/// Declares a 3-tier multi-agent hierarchy (orchestrator / leads / workers)
/// with HITL routing rules and role enforcement (ULTRAPLAN §10).
///
/// ```cant
/// team platform:
///   orchestrator: cleo-prime
///   leads:
///     engineering: engineering-lead
///   consult-when: "request spans multiple domains"
///   stages: [discover, plan, execute, review]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDef {
    /// The team name identifier.
    pub name: Spanned<String>,
    /// Key-value properties (description, enforcement, routing, etc.).
    ///
    /// Sub-blocks like `leads:`, `workers:`, and `routing:` are parsed uniformly
    /// via the existing `Property` / `Value::Array` machinery so that hierarchy
    /// lint rules (TEAM-001..003) can inspect them by key.
    pub properties: Vec<Property>,
    /// Human-readable condition under which the orchestrator should escalate to
    /// HITL consultation (Wave 7a — ULTRAPLAN §10.3).
    ///
    /// Sourced from the `consult-when:` sub-field of the team block.
    /// `None` when the field is absent; lint rule TEAM-002 enforces presence
    /// on team blocks that declare leads.
    pub consult_when: Option<String>,
    /// Ordered execution stage names for this team (Wave 7a — ULTRAPLAN §10.3).
    ///
    /// Sourced from the `stages: [...]` sub-field of the team block.
    /// Empty when the field is absent; lint rule TEAM-002 enforces non-empty
    /// stages on team blocks that declare leads.
    pub stages: Vec<String>,
    /// Span covering the entire team definition.
    pub span: Span,
}

// ── Tool Definition (CleoOS v2) ──────────────────────────────────────

/// A tool definition block (`tool Name:`).
///
/// Declares an LLM-callable tool beyond the built-in dispatcher tools
/// (ULTRAPLAN §8).
///
/// ```cant
/// tool dispatch_worker:
///   description: "Spawn a worker subagent"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    /// The tool name identifier.
    pub name: Spanned<String>,
    /// Key-value properties (description, schema, permissions, etc.).
    pub properties: Vec<Property>,
    /// Span covering the entire tool definition.
    pub span: Span,
}

// ── Hook Definition ──────────────────────────────────────────────────

/// A hook definition block triggered by a CAAMP canonical event.
///
/// ```cant
/// on SessionStart:
///   /checkin @all
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDef {
    /// The CAAMP event name (must be one of the 16 canonical events).
    pub event: Spanned<String>,
    /// The hook body statements.
    pub body: Vec<Statement>,
    /// Span covering the entire hook definition.
    pub span: Span,
}

// Re-export generated event types from the SSoT (hook-mappings.json via build.rs).
pub use crate::generated::events::{
    CANONICAL_EVENT_NAMES_CSV, CanonicalEvent, EventCategory, EventSource, is_canonical_event,
};

// ── Properties ───────────────────────────────────────────────────────

/// A key-value property assignment.
///
/// ```cant
/// model: opus
/// prompt: "You coordinate operations"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Property {
    /// The property key.
    pub key: Spanned<String>,
    /// The property value.
    pub value: Value,
    /// Span covering the entire property line.
    pub span: Span,
}

/// Property values in the CANT DSL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Value {
    /// A string literal (may contain interpolations in double-quoted form).
    String(StringValue),
    /// A numeric value.
    Number(f64),
    /// A boolean value.
    Boolean(bool),
    /// An array of values.
    Array(Vec<Value>),
    /// A bare identifier (not quoted).
    Identifier(String),
    /// A duration value (e.g., `30s`, `5m`).
    Duration(DurationValue),
    /// A multi-line prose block using pipe-then-indent syntax.
    ///
    /// Used for narrative sections like `tone:`, `prompt:`, and other
    /// free-form text in `kind:agent` documents.
    ///
    /// ```cant
    /// tone: |
    ///   You are calm and precise.
    ///   Never use jargon.
    /// ```
    ProseBlock(ProseBlock),
    /// Span for the value.
    #[serde(skip)]
    _Span(Span),
}

/// A multi-line prose block using pipe-then-indent syntax.
///
/// Collects indented lines following a `|` marker into a structured
/// text block. Leading common whitespace is trimmed from all lines.
///
/// ```cant
/// prompt: |
///   You coordinate all operations.
///   Be concise and actionable.
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProseBlock {
    /// The collected lines of prose text (common indentation stripped).
    pub lines: Vec<String>,
    /// Span covering the entire prose block (from `|` through last line).
    pub span: Span,
}

/// A string value that may contain interpolation segments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringValue {
    /// The raw string content (without surrounding quotes).
    pub raw: String,
    /// Whether this was a double-quoted string (supports interpolation).
    pub double_quoted: bool,
    /// Span of the string value.
    pub span: Span,
}

/// A duration value with amount and unit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DurationValue {
    /// The numeric amount.
    pub amount: u64,
    /// The time unit.
    pub unit: DurationUnit,
    /// Span of the duration value.
    pub span: Span,
}

/// Duration time units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DurationUnit {
    /// Seconds (`s`).
    Seconds,
    /// Minutes (`m`).
    Minutes,
    /// Hours (`h`).
    Hours,
    /// Days (`d`).
    Days,
}

// ── Permissions ──────────────────────────────────────────────────────

/// A permission declaration within a `permissions:` block.
///
/// ```cant
/// tasks: read, write
/// files: write[backend/**, tests/backend/**]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permission {
    /// The domain being granted permissions (e.g., "tasks", "session").
    pub domain: String,
    /// The permission access levels.
    pub access: Vec<String>,
    /// Glob patterns when this is a glob-bounded permission
    /// (e.g., `files: write[backend/**]`).
    ///
    /// Empty vec means no glob bounds (plain access level).
    pub globs: Vec<String>,
    /// Span covering the entire permission line.
    pub span: Span,
}

/// Path-scoped file permissions for a CANT agent (T422 — ULTRAPLAN §9.2).
///
/// Declares which file path globs the agent may read, write, or delete.
/// Enforced at runtime by the `tool_call` hook in `cleo-cant-bridge.ts`.
///
/// An **empty `write` list means the agent has NO write permission** (read-only).
/// An absent field means that access level is unrestricted (default-allow).
///
/// ```cant
/// agent backend-dev:
///   role: worker
///   permissions:
///     files:
///       write: ["packages/cleo/**", "crates/**"]
///       read:  ["**/*"]
///       delete: ["packages/cleo/**"]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PathPermissions {
    /// Glob patterns for paths this agent is allowed to write (Edit/Write tool).
    ///
    /// Empty vec = no writes allowed (security-first default-deny).
    /// Absent (None on AgentDef) = unrestricted (no declared ACL).
    pub write: Vec<String>,
    /// Glob patterns for paths this agent is allowed to read.
    ///
    /// Empty vec = no reads allowed.
    /// Absent = unrestricted (default-allow for reads).
    pub read: Vec<String>,
    /// Glob patterns for paths this agent is allowed to delete.
    ///
    /// Empty vec = no deletes allowed.
    /// Absent = unrestricted.
    pub delete: Vec<String>,
}

// ── Context References ──────────────────────────────────────────────

/// A context reference within a `context:` block.
///
/// ```cant
/// context:
///   active-tasks
///   "memory-bridge"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRef {
    /// The context reference name (bare identifier or unquoted string content).
    pub name: String,
    /// Source location.
    pub span: Span,
}

// ── Import Statement ─────────────────────────────────────────────────

/// An import statement.
///
/// ```cant
/// @import "./agents/scanner.cant"
/// @import scanner from "./agents/scanner.cant"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportStatement {
    /// The import path (string literal content).
    pub path: String,
    /// Optional named alias (for `name from "path"` syntax).
    pub alias: Option<String>,
    /// Span covering the entire import statement.
    pub span: Span,
}

// ── Bindings ─────────────────────────────────────────────────────────

/// A let binding.
///
/// ```cant
/// let status = task.status
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LetBinding {
    /// The binding name.
    pub name: Spanned<String>,
    /// The bound expression value.
    pub value: Expression,
    /// Span covering the entire binding.
    pub span: Span,
}

// ── Statements ───────────────────────────────────────────────────────

/// Statement types that may appear in hook and workflow bodies.
///
/// Covers Layer 2 (hook bodies) and Layer 3 (workflow orchestration) constructs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Statement {
    /// A let binding statement.
    Binding(LetBinding),
    /// A bare expression statement.
    Expression(Expression),
    /// A Layer 1 directive used inside a hook or workflow body.
    Directive(DirectiveStmt),
    /// A property assignment.
    Property(Property),
    /// A comment.
    Comment(Comment),
    /// A session invocation (Layer 3).
    Session(SessionExpr),
    /// A parallel execution block (Layer 3).
    Parallel(ParallelBlock),
    /// An if/elif/else conditional (Layer 3).
    Conditional(Conditional),
    /// A `repeat N:` loop (Layer 3).
    Repeat(RepeatLoop),
    /// A `for x in collection:` loop (Layer 3).
    ForLoop(ForLoop),
    /// A `loop: ... until condition` loop (Layer 3).
    LoopUntil(LoopUntil),
    /// A try/catch/finally block (Layer 3).
    TryCatch(TryCatch),
    /// A human-in-the-loop approval gate (Layer 3).
    ApprovalGate(ApprovalGate),
    /// An inline pipeline definition (Layer 3).
    Pipeline(PipelineDef),
    /// A single pipeline step (Layer 3).
    PipeStep(PipeStep),
    /// An output binding (`output name = expr`) (Layer 3).
    Output(OutputStmt),
}

/// A Layer 1 directive used inside a hook or workflow body.
///
/// ```cant
/// /checkin @all
/// /done T1234 #shipped
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectiveStmt {
    /// The directive verb (e.g., `"checkin"`, `"done"`).
    pub verb: String,
    /// Addresses referenced in the directive.
    pub addresses: Vec<String>,
    /// Task references in the directive.
    pub task_refs: Vec<String>,
    /// Tags in the directive.
    pub tags: Vec<String>,
    /// Optional trailing string argument.
    pub argument: Option<String>,
    /// Span covering the entire directive statement.
    pub span: Span,
}

// ── Expressions (re-exported from ast_expressions) ──────────────────
//
// Type definitions live in `ast_expressions.rs` to stay within file size limits.
// Re-exported here so consumers see a unified `ast` module.

pub use super::ast_expressions::{
    AddressExpr, ArrayExpr, BooleanExpr, ComparisonExpr, ComparisonOp, DurationExpr, Expression,
    InterpolationExpr, LogicalExpr, LogicalOp, NameExpr, NegationExpr, NumberExpr,
    PropertyAccessExpr, StringExpr, StringSegment, TaskRefExpr,
};

/// A comment in the source code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    /// The comment text (without the `#` prefix).
    pub text: String,
    /// Source location.
    pub span: Span,
}

// ── Layer 3: Orchestration AST Types (re-exported) ──────────────────
//
// Type definitions live in `ast_orchestration.rs` to stay within file size limits.
// Re-exported here so consumers see a unified `ast` module.

pub use super::ast_orchestration::{
    ApprovalGate, Condition, Conditional, DiscretionCondition, ElifBranch, ForLoop, LoopUntil,
    OutputStmt, ParallelArm, ParallelBlock, ParallelModifier, ParamDef, PipeStep, PipelineDef,
    RepeatLoop, SessionExpr, SessionTarget, TryCatch, WorkflowDef,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_events_count() {
        // 16 provider + 15 domain = 31 total
        assert_eq!(CanonicalEvent::ALL.len(), 31);
        assert_eq!(CanonicalEvent::provider_events().count(), 16);
        assert_eq!(CanonicalEvent::domain_events().count(), 15);
    }

    #[test]
    fn is_canonical_event_valid_provider() {
        assert!(is_canonical_event("SessionStart"));
        assert!(is_canonical_event("ConfigChange"));
        assert!(is_canonical_event("PostToolUseFailure"));
    }

    #[test]
    fn is_canonical_event_valid_domain() {
        assert!(is_canonical_event("TaskCompleted"));
        assert!(is_canonical_event("MemoryObserved"));
        assert!(is_canonical_event("PipelineStageCompleted"));
        assert!(is_canonical_event("ApprovalGranted"));
    }

    #[test]
    fn is_canonical_event_invalid() {
        assert!(!is_canonical_event("TaskComplete")); // Wrong name (no 'd')
        assert!(!is_canonical_event("sessionstart")); // Wrong case
        assert!(!is_canonical_event(""));
    }

    #[test]
    fn event_metadata_accessible() {
        let event = CanonicalEvent::from_str("PreToolUse").unwrap();
        assert_eq!(event.category(), EventCategory::Tool);
        assert_eq!(event.source(), EventSource::Provider);
        assert!(event.can_block());
    }

    #[test]
    fn domain_event_metadata() {
        let event = CanonicalEvent::from_str("TaskCompleted").unwrap();
        assert_eq!(event.category(), EventCategory::Task);
        assert_eq!(event.source(), EventSource::Domain);
        assert!(!event.can_block());
    }

    #[test]
    fn document_kind_variants() {
        let kinds = [
            DocumentKind::Agent,
            DocumentKind::Skill,
            DocumentKind::Hook,
            DocumentKind::Workflow,
            DocumentKind::Pipeline,
            DocumentKind::Config,
            DocumentKind::Message,
            DocumentKind::Protocol,
            DocumentKind::Lifecycle,
            DocumentKind::Team,
            DocumentKind::Tool,
            DocumentKind::ModelRouting,
            DocumentKind::MentalModel,
        ];
        assert_eq!(kinds.len(), 13);
    }
}

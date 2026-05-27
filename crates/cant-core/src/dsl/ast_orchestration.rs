//! Layer 3 Orchestration AST types for the CANT DSL.
//!
//! These types represent workflow, pipeline, session, parallel, conditional,
//! loop, try/catch, and approval gate constructs. They are re-exported from
//! [`super::ast`] so consumers see a unified AST module.

use super::ast::{Expression, Property, Spanned, Statement};
use super::span::Span;
use serde::{Deserialize, Serialize};

/// A formal parameter declaration for workflows and pipelines.
///
/// ```cant
/// workflow review(pr_url, env: string = "staging"):
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamDef {
    /// The parameter name.
    pub name: Spanned<String>,
    /// Span covering the entire parameter.
    pub span: Span,
}

/// A workflow definition. Workflows MAY contain LLM-dependent constructs,
/// sessions, discretion conditions, and approval gates.
///
/// ```cant
/// workflow review(pr_url):
///   session "Analyze the code"
///   if **code quality acceptable**:
///     /done T{pr.task_id}
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    /// The workflow name identifier.
    pub name: Spanned<String>,
    /// Formal parameters. Empty if no parameter list.
    pub params: Vec<ParamDef>,
    /// The workflow body statements.
    pub body: Vec<Statement>,
    /// Span covering the entire workflow definition.
    pub span: Span,
}

/// A pipeline definition. Pipelines MUST be deterministic: no sessions,
/// no discretion, no approval gates, no LLM calls.
///
/// ```cant
/// pipeline deploy(service):
///   step build:
///     command: "pnpm"
///     args: ["run", "build"]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineDef {
    /// The pipeline name identifier.
    pub name: Spanned<String>,
    /// Formal parameters. Empty if no parameter list.
    pub params: Vec<ParamDef>,
    /// The pipeline steps.
    pub steps: Vec<PipeStep>,
    /// Span covering the entire pipeline definition.
    pub span: Span,
}

/// A single step in a pipeline.
///
/// ```cant
/// step build:
///   command: "pnpm"
///   args: ["run", "build"]
///   timeout: 120s
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipeStep {
    /// The step name identifier.
    pub name: Spanned<String>,
    /// Step properties (command, args, stdin, timeout, condition, plus custom).
    pub properties: Vec<Property>,
    /// Span covering the entire step definition.
    pub span: Span,
}

/// A session invocation -- the ONLY place prose enters a workflow.
///
/// ```cant
/// session "Analyze the code"
/// session: scanner
///   context: [active-tasks]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionExpr {
    /// Either a prompt string or an agent name reference.
    pub target: SessionTarget,
    /// Session configuration properties (prompt, context, model, etc.).
    pub properties: Vec<Property>,
    /// Span covering the entire session expression.
    pub span: Span,
}

/// The target of a session invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionTarget {
    /// A direct prompt string: `session "Analyze the code"`
    Prompt(String),
    /// An agent reference: `session: scanner`
    Agent(String),
}

/// A parallel execution block.
///
/// ```cant
/// parallel:
///   a = session "Task A"
///   b = session: reviewer
///     context: a
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelBlock {
    /// Join strategy modifier. `None` = wait for all.
    pub modifier: Option<ParallelModifier>,
    /// Named parallel arms.
    pub arms: Vec<ParallelArm>,
    /// Span covering the entire parallel block.
    pub span: Span,
}

/// Join strategy modifier for parallel blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParallelModifier {
    /// Return on first arm completion.
    Race,
    /// Wait for all, collect successes and failures.
    Settle,
}

/// A named arm within a parallel block.
///
/// ```cant
/// a = session "Task A"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelArm {
    /// The arm name (for referencing results).
    pub name: String,
    /// The body statement of this arm.
    pub body: Box<Statement>,
    /// Span covering the entire arm.
    pub span: Span,
}

/// An if/elif/else conditional.
///
/// ```cant
/// if **all reviews pass**:
///   /done T1234
/// elif status == "partial":
///   /info @author "Partial pass"
/// else:
///   /action @author "Address issues"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conditional {
    /// The `if` condition. May be a discretion condition.
    pub condition: Condition,
    /// Statements in the `if` body.
    pub then_body: Vec<Statement>,
    /// Zero or more `elif` clauses.
    pub elif_branches: Vec<ElifBranch>,
    /// Optional `else` clause body.
    pub else_body: Option<Vec<Statement>>,
    /// Span covering the entire conditional.
    pub span: Span,
}

/// An elif clause in a conditional.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElifBranch {
    /// The elif condition.
    pub condition: Condition,
    /// The elif body statements.
    pub body: Vec<Statement>,
    /// Span covering this elif clause.
    pub span: Span,
}

/// A condition: either a regular expression or a discretion condition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Condition {
    /// A regular boolean expression.
    Expression(Expression),
    /// A discretion condition: `**prose text**`, evaluated by an AI evaluator.
    Discretion(DiscretionCondition),
}

/// An AI-evaluated discretion condition.
///
/// Discretion conditions contain free-form prose between `**` delimiters.
/// They are opaque strings -- NOT evaluated by the parser.
///
/// ```cant
/// if **all reviews pass with no critical issues**:
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscretionCondition {
    /// The prose text between `**` delimiters.
    pub prose: String,
    /// Span covering the entire discretion condition including delimiters.
    pub span: Span,
}

/// A `repeat N:` loop.
///
/// ```cant
/// repeat 3:
///   session "Retry the operation"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatLoop {
    /// The count expression. MUST evaluate to a positive integer.
    pub count: Expression,
    /// The loop body statements.
    pub body: Vec<Statement>,
    /// Span covering the entire repeat loop.
    pub span: Span,
}

/// A `for x in collection:` loop.
///
/// ```cant
/// for item in tasks:
///   session "Process ${item}"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForLoop {
    /// The loop variable name.
    pub variable: Spanned<String>,
    /// The iterable expression.
    pub iterable: Expression,
    /// The loop body statements.
    pub body: Vec<Statement>,
    /// Span covering the entire for loop.
    pub span: Span,
}

/// A `loop: ... until condition` loop.
///
/// ```cant
/// loop:
///   session "Check deployment status"
///   until **deployment healthy for 5 minutes**
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopUntil {
    /// The loop body statements (before the `until`).
    pub body: Vec<Statement>,
    /// The termination condition. May be a discretion condition.
    pub condition: Condition,
    /// Span covering the entire loop.
    pub span: Span,
}

/// A try/catch/finally block.
///
/// ```cant
/// try:
///   session "Deploy to production"
/// catch err:
///   /info @ops "Deployment failed: ${err}"
/// finally:
///   /done T1234
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TryCatch {
    /// The try body statements.
    pub try_body: Vec<Statement>,
    /// Optional error binding name for the catch clause.
    pub catch_name: Option<String>,
    /// Optional catch body statements.
    pub catch_body: Option<Vec<Statement>>,
    /// Optional finally body statements.
    pub finally_body: Option<Vec<Statement>>,
    /// Span covering the entire try/catch/finally block.
    pub span: Span,
}

/// A human-in-the-loop approval gate.
///
/// ```cant
/// approve:
///   message: "Ready to deploy to production?"
///   timeout: 24h
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalGate {
    /// The approval gate properties (message, timeout, expires, etc.).
    pub properties: Vec<Property>,
    /// Span covering the entire approval gate.
    pub span: Span,
}

/// An output binding statement.
///
/// ```cant
/// output verdict = "approve"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputStmt {
    /// The output variable name.
    pub name: Spanned<String>,
    /// The output value expression.
    pub value: Expression,
    /// Span covering the entire output statement.
    pub span: Span,
}

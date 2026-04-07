#![deny(unsafe_code)] // napi-rs macros generate unsafe internally — forbid would conflict
//! napi-rs bindings for the cant-core CANT parser.
//!
//! This crate provides Node.js native addon bindings for the CANT parser,
//! replacing the previous wasm-bindgen approach. It wraps [`cant_core::parse`]
//! and [`cant_core::classify_directive`] with napi-rs `#[napi]` exports for
//! synchronous, high-performance access from TypeScript/JavaScript.

use cant_runtime::env::StepEnv;
use cant_runtime::pipeline::{PipelineConfig, execute_pipeline};
use napi_derive::napi;

/// The classification of a directive extracted from a CANT message.
///
/// Maps to the Rust [`cant_core::DirectiveType`] enum, exposed as a
/// string enum for JavaScript consumers.
#[napi(string_enum)]
pub enum JsDirectiveType {
    /// Maps to a CQRS mutation (e.g., `/done`, `/claim`, `/blocked`).
    Actionable,
    /// Signals routing without direct state mutation (e.g., `/action`, `/review`).
    Routing,
    /// Carries context only; triggers no operation (e.g., `/ack`, `/info`).
    Informational,
}

/// The structured result of parsing a CANT message, exposed to JavaScript.
///
/// Contains all extracted elements from both the header and body of the message.
/// Fields use camelCase naming automatically via napi-rs conversion.
#[napi(object)]
pub struct JsParsedCantMessage {
    /// The directive verb if present (e.g., `"done"` from `/done`), or `None`.
    pub directive: Option<String>,
    /// The classification of the directive as a lowercase string.
    pub directive_type: String,
    /// All `@`-addresses found in the message, without the `@` prefix.
    pub addresses: Vec<String>,
    /// All task references found in the message, including the `T` prefix.
    pub task_refs: Vec<String>,
    /// All `#`-tags found in the message, without the `#` prefix.
    pub tags: Vec<String>,
    /// The raw text of the first line (the header).
    pub header_raw: String,
    /// Everything after the first newline (the body).
    pub body: String,
}

/// Parse a CANT message and return the structured result.
///
/// This is the primary entry point for CANT parsing from Node.js.
/// It delegates to [`cant_core::parse`] and converts the result into
/// a JavaScript-compatible object.
///
/// # Arguments
///
/// * `content` - The raw CANT message text to parse.
#[napi]
pub fn cant_parse(content: String) -> JsParsedCantMessage {
    let msg = cant_core::parse(&content);
    JsParsedCantMessage {
        directive: msg.directive,
        directive_type: match msg.directive_type {
            cant_core::DirectiveType::Actionable => "actionable".to_string(),
            cant_core::DirectiveType::Routing => "routing".to_string(),
            cant_core::DirectiveType::Informational => "informational".to_string(),
        },
        addresses: msg.addresses,
        task_refs: msg.task_refs,
        tags: msg.tags,
        header_raw: msg.header_raw,
        body: msg.body,
    }
}

/// Classify a directive verb into its [`JsDirectiveType`].
///
/// Delegates to [`cant_core::classify_directive`] and returns the
/// corresponding napi string enum variant.
///
/// # Arguments
///
/// * `verb` - The directive verb to classify (e.g., `"done"`, `"action"`).
#[napi]
pub fn cant_classify_directive(verb: String) -> JsDirectiveType {
    match cant_core::classify_directive(&verb) {
        cant_core::DirectiveType::Actionable => JsDirectiveType::Actionable,
        cant_core::DirectiveType::Routing => JsDirectiveType::Routing,
        cant_core::DirectiveType::Informational => JsDirectiveType::Informational,
    }
}

// ── Layer 2/3: Document Parsing ─────────────────────────────────────

/// A parse error from document parsing, exposed to JavaScript.
#[napi(object)]
pub struct JsParseError {
    /// Human-readable error message.
    pub message: String,
    /// Line number (1-based) where the error occurred.
    pub line: u32,
    /// Column number (1-based) where the error occurred.
    pub col: u32,
    /// Byte offset of the error start.
    pub start: u32,
    /// Byte offset of the error end.
    pub end: u32,
    /// Severity: "error" or "warning".
    pub severity: String,
}

/// The result of parsing a `.cant` document (Layer 2/3).
///
/// On success, returns the full AST as a JSON-compatible object.
/// On failure, returns an array of parse errors with source locations.
#[napi(object)]
pub struct JsParseDocumentResult {
    /// Whether parsing succeeded.
    pub success: bool,
    /// The parsed AST as a JSON value (null if parsing failed).
    /// Contains: kind, frontmatter, sections (with agent/skill/hook/workflow/pipeline defs).
    pub document: Option<serde_json::Value>,
    /// Parse errors (empty if parsing succeeded).
    pub errors: Vec<JsParseError>,
}

/// Parse a `.cant` document file (Layer 2/3: agents, skills, hooks, workflows, pipelines).
///
/// This is the bridge between the Rust `cant_core::dsl::parse_document` function
/// and JavaScript/TypeScript consumers. It returns the full AST as a JSON-compatible
/// object that can be traversed in JS.
///
/// # Arguments
///
/// * `content` - The raw `.cant` file content to parse.
///
/// # Returns
///
/// A [`JsParseDocumentResult`] with either:
/// - `success: true` + `document` containing the full AST
/// - `success: false` + `errors` array with parse diagnostics
#[napi]
pub fn cant_parse_document(content: String) -> JsParseDocumentResult {
    match cant_core::parse_document(&content) {
        Ok(doc) => {
            let json_value = serde_json::to_value(&doc).unwrap_or(serde_json::Value::Null);
            JsParseDocumentResult {
                success: true,
                document: Some(json_value),
                errors: vec![],
            }
        }
        Err(errors) => JsParseDocumentResult {
            success: false,
            document: None,
            errors: errors
                .into_iter()
                .map(|e| JsParseError {
                    message: e.message,
                    line: e.span.line,
                    col: e.span.col,
                    start: e.span.start as u32,
                    end: e.span.end as u32,
                    severity: match e.severity {
                        cant_core::dsl::error::Severity::Error => "error".to_string(),
                        cant_core::dsl::error::Severity::Warning => "warning".to_string(),
                    },
                })
                .collect(),
        },
    }
}

// ── Validation ──────────────────────────────────────────────────────

/// A validation diagnostic from the 42-rule validation engine.
#[napi(object)]
pub struct JsDiagnostic {
    /// The rule ID (e.g., "S01", "P06", "W08").
    pub rule_id: String,
    /// Human-readable diagnostic message.
    pub message: String,
    /// Severity: "error", "warning", "info", or "hint".
    pub severity: String,
    /// Line number (1-based).
    pub line: u32,
    /// Column number (1-based).
    pub col: u32,
}

/// The result of validating a `.cant` document.
#[napi(object)]
pub struct JsValidateResult {
    /// Whether validation passed with no errors (warnings are allowed).
    pub valid: bool,
    /// Total number of diagnostics.
    pub total: u32,
    /// Number of errors.
    pub error_count: u32,
    /// Number of warnings.
    pub warning_count: u32,
    /// All diagnostics from the validation engine.
    pub diagnostics: Vec<JsDiagnostic>,
}

/// Parse and validate a `.cant` document in one call.
///
/// First parses the document, then runs all 42 validation rules.
/// Returns parse errors if parsing fails, or validation diagnostics
/// if parsing succeeds.
///
/// # Arguments
///
/// * `content` - The raw `.cant` file content to parse and validate.
#[napi]
pub fn cant_validate_document(content: String) -> JsValidateResult {
    let doc = match cant_core::parse_document(&content) {
        Ok(doc) => doc,
        Err(errors) => {
            let parse_diagnostics: Vec<JsDiagnostic> = errors
                .into_iter()
                .map(|e| JsDiagnostic {
                    rule_id: "PARSE".to_string(),
                    message: e.message,
                    severity: "error".to_string(),
                    line: e.span.line,
                    col: e.span.col,
                })
                .collect();
            let count = parse_diagnostics.len() as u32;
            return JsValidateResult {
                valid: false,
                total: count,
                error_count: count,
                warning_count: 0,
                diagnostics: parse_diagnostics,
            };
        }
    };

    let diagnostics = cant_core::validate_document(&doc);
    let js_diagnostics: Vec<JsDiagnostic> = diagnostics
        .iter()
        .map(|d| JsDiagnostic {
            rule_id: d.rule_id.clone(),
            message: d.message.clone(),
            severity: match d.severity {
                cant_core::validate::diagnostic::Severity::Error => "error".to_string(),
                cant_core::validate::diagnostic::Severity::Warning => "warning".to_string(),
                cant_core::validate::diagnostic::Severity::Info => "info".to_string(),
                cant_core::validate::diagnostic::Severity::Hint => "hint".to_string(),
            },
            line: d.span.line,
            col: d.span.col,
        })
        .collect();

    let error_count = js_diagnostics
        .iter()
        .filter(|d| d.severity == "error")
        .count() as u32;
    let warning_count = js_diagnostics
        .iter()
        .filter(|d| d.severity == "warning")
        .count() as u32;
    let total = js_diagnostics.len() as u32;

    JsValidateResult {
        valid: error_count == 0,
        total,
        error_count,
        warning_count,
        diagnostics: js_diagnostics,
    }
}

// ── Agent Profile Extraction ────────────────────────────────────────

/// An extracted agent profile from a `.cant` file.
///
/// This is the bridge type that maps a CANT AgentDef AST node
/// into a flat structure suitable for insertion into the `agent_profiles` table.
#[napi(object)]
pub struct JsAgentProfile {
    /// Agent name (e.g., "cleo-historian").
    pub name: String,
    /// Model preference (e.g., "opus", "sonnet").
    pub model: Option<String>,
    /// System prompt / soul text.
    pub prompt: Option<String>,
    /// Persist scope (e.g., "project", "true").
    pub persist: Option<String>,
    /// Skills as JSON array string.
    pub skills_json: String,
    /// Permissions as JSON object string.
    pub permissions_json: String,
    /// Hooks as JSON array string.
    pub hooks_json: String,
    /// All properties as JSON object string.
    pub properties_json: String,
}

/// Extract agent profiles from a parsed `.cant` document.
///
/// Parses the document and extracts all `agent` blocks as flat profile structures
/// suitable for database insertion. Returns an empty array if parsing fails
/// or no agent blocks are found.
///
/// # Arguments
///
/// * `content` - The raw `.cant` file content.
#[napi]
pub fn cant_extract_agent_profiles(content: String) -> Vec<JsAgentProfile> {
    let doc = match cant_core::parse_document(&content) {
        Ok(doc) => doc,
        Err(_) => return vec![],
    };

    doc.sections
        .iter()
        .filter_map(|section| {
            if let cant_core::dsl::ast::Section::Agent(agent) = section {
                Some(extract_agent_profile(agent))
            } else {
                None
            }
        })
        .collect()
}

/// Convert an AgentDef AST node into a JsAgentProfile.
fn extract_agent_profile(agent: &cant_core::dsl::ast::AgentDef) -> JsAgentProfile {
    let mut model = None;
    let mut prompt = None;
    let mut persist = None;
    let mut skills_vec: Vec<String> = vec![];
    let mut props_map = serde_json::Map::new();

    for prop in &agent.properties {
        let key = &prop.key.value;
        let value_str = format_value(&prop.value);

        match key.as_str() {
            "model" => model = Some(value_str.clone()),
            "prompt" => prompt = Some(value_str.clone()),
            "persist" => persist = Some(value_str.clone()),
            "skills" => {
                if let cant_core::dsl::ast::Value::Array(items) = &prop.value {
                    skills_vec = items.iter().map(format_value).collect();
                }
            }
            _ => {}
        }
        props_map.insert(key.clone(), serde_json::Value::String(value_str));
    }

    let mut perms_map = serde_json::Map::new();
    for perm in &agent.permissions {
        let access: Vec<serde_json::Value> = perm
            .access
            .iter()
            .map(|a| serde_json::Value::String(a.clone()))
            .collect();
        perms_map.insert(perm.domain.clone(), serde_json::Value::Array(access));
    }

    let hooks_json = serde_json::to_string(
        &agent
            .hooks
            .iter()
            .map(|h| {
                serde_json::json!({
                    "event": h.event.value,
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    JsAgentProfile {
        name: agent.name.value.clone(),
        model,
        prompt,
        persist,
        skills_json: serde_json::to_string(&skills_vec).unwrap_or_else(|_| "[]".to_string()),
        permissions_json: serde_json::to_string(&perms_map).unwrap_or_else(|_| "{}".to_string()),
        hooks_json,
        properties_json: serde_json::to_string(&props_map).unwrap_or_else(|_| "{}".to_string()),
    }
}

/// Format a CANT Value into a plain string.
fn format_value(value: &cant_core::dsl::ast::Value) -> String {
    match value {
        cant_core::dsl::ast::Value::String(s) => s.raw.clone(),
        cant_core::dsl::ast::Value::Number(n) => n.to_string(),
        cant_core::dsl::ast::Value::Boolean(b) => b.to_string(),
        cant_core::dsl::ast::Value::Identifier(id) => id.clone(),
        cant_core::dsl::ast::Value::Duration(d) => {
            format!("{}{}", d.amount, format_duration_unit(&d.unit))
        }
        cant_core::dsl::ast::Value::Array(items) => {
            let strs: Vec<String> = items.iter().map(format_value).collect();
            format!("[{}]", strs.join(", "))
        }
        cant_core::dsl::ast::Value::ProseBlock(block) => block.lines.join("\n"),
        cant_core::dsl::ast::Value::_Span(_) => String::new(),
    }
}

/// Format a DurationUnit into its string suffix.
fn format_duration_unit(unit: &cant_core::dsl::ast::DurationUnit) -> &'static str {
    match unit {
        cant_core::dsl::ast::DurationUnit::Seconds => "s",
        cant_core::dsl::ast::DurationUnit::Minutes => "m",
        cant_core::dsl::ast::DurationUnit::Hours => "h",
        cant_core::dsl::ast::DurationUnit::Days => "d",
    }
}

// ── Pipeline Execution (async) ──────────────────────────────────────

/// A single step result returned to JavaScript from a pipeline run.
///
/// Mirrors the Rust [`cant_runtime::step::StepResult`] but exposes only
/// the metadata that JS callers need (lengths instead of full output to
/// keep IPC payloads bounded).
#[napi(object)]
pub struct JsPipelineStep {
    /// The step name from the pipeline definition.
    pub name: String,
    /// Subprocess exit code (0 = success).
    pub exit_code: i32,
    /// Length in bytes of captured stdout.
    pub stdout_len: u32,
    /// Length in bytes of captured stderr.
    pub stderr_len: u32,
    /// Wall-clock duration of the step in milliseconds.
    pub duration_ms: u32,
    /// Whether the step was skipped due to a condition.
    pub skipped: bool,
}

/// The aggregate result of executing a pipeline, exposed to JavaScript.
///
/// Mirrors the shape produced by the standalone `cant-cli` so that the
/// CLEO TS layer can render the same envelope regardless of which path
/// produced it. Logical failures populate `error` rather than throwing.
#[napi(object)]
pub struct JsPipelineResult {
    /// The pipeline name (echoes back the requested name even on failure).
    pub name: String,
    /// Whether all steps completed with exit code 0.
    pub success: bool,
    /// Total wall-clock duration in milliseconds.
    pub duration_ms: u32,
    /// Per-step results in execution order.
    pub steps: Vec<JsPipelineStep>,
    /// Optional error message describing why the pipeline did not run
    /// (file read failure, parse error, missing pipeline, runtime error).
    pub error: Option<String>,
}

/// Parse a `.cant` file, locate the named pipeline, and execute it via
/// the Rust runtime ([`cant_runtime::pipeline::execute_pipeline`]).
///
/// This is the async napi-rs equivalent of the deleted `cant-cli execute`
/// subcommand. It never throws on logical failure: parse errors, missing
/// pipelines, and runtime errors are all reported via the `error` field
/// of the returned [`JsPipelineResult`] with `success: false`.
///
/// # Arguments
///
/// * `file_path` - Absolute or relative path to a `.cant` file.
/// * `pipeline_name` - The name of the `pipeline { ... }` block to run.
#[napi]
pub async fn cant_execute_pipeline(file_path: String, pipeline_name: String) -> JsPipelineResult {
    use cant_core::dsl::ast::Section;
    use std::fs;

    // Read the .cant file from disk.
    let content = match fs::read_to_string(&file_path) {
        Ok(s) => s,
        Err(e) => {
            return JsPipelineResult {
                name: pipeline_name,
                success: false,
                duration_ms: 0,
                steps: vec![],
                error: Some(format!("read error: {e}")),
            };
        }
    };

    // Parse the document.
    let doc = match cant_core::parse_document(&content) {
        Ok(d) => d,
        Err(errors) => {
            let messages: Vec<String> = errors.into_iter().map(|e| e.message).collect();
            return JsPipelineResult {
                name: pipeline_name,
                success: false,
                duration_ms: 0,
                steps: vec![],
                error: Some(format!("parse error: {}", messages.join("; "))),
            };
        }
    };

    // Locate the named pipeline section.
    let pipeline = doc.sections.iter().find_map(|s| match s {
        Section::Pipeline(p) if p.name.value == pipeline_name => Some(p),
        _ => None,
    });
    let Some(pipeline) = pipeline else {
        return JsPipelineResult {
            name: pipeline_name.clone(),
            success: false,
            duration_ms: 0,
            steps: vec![],
            error: Some(format!(
                "pipeline '{pipeline_name}' not found in {file_path}"
            )),
        };
    };

    // Execute the pipeline via the runtime.
    let env = StepEnv::new();
    let config = PipelineConfig::default();
    match execute_pipeline(pipeline, env, &config).await {
        Ok(result) => JsPipelineResult {
            name: result.name,
            success: result.success,
            duration_ms: result.duration_ms as u32,
            steps: result
                .steps
                .into_iter()
                .map(|s| JsPipelineStep {
                    name: s.name,
                    exit_code: s.exit_code,
                    stdout_len: s.stdout.len() as u32,
                    stderr_len: s.stderr.len() as u32,
                    duration_ms: s.duration_ms as u32,
                    skipped: s.skipped,
                })
                .collect(),
            error: None,
        },
        Err(e) => JsPipelineResult {
            name: pipeline_name,
            success: false,
            duration_ms: 0,
            steps: vec![],
            error: Some(format!("runtime error: {e}")),
        },
    }
}

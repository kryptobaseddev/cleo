//! CANT document renderer — emits a textual representation of a parsed
//! [`CantDocument`] suitable for round-tripping back through the parser.
//!
//! This is the forward half of the Wave 1 byte-identical round-trip contract
//! described in `docs/plans/CLEO-ULTRAPLAN.md` §17. Given an AST produced by
//! [`crate::parse_document`], [`render_document`] emits a deterministic
//! `.cant` source string using the canonical formatting rules enforced by
//! this module.
//!
//! # Canonical Formatting Rules
//!
//! The renderer commits to one formatting style so hand-authored fixtures
//! that match the style can round-trip byte-for-byte:
//!
//! - Line terminator: `\n` (LF)
//! - Indentation: 2 spaces per level (matches the parser's requirement)
//! - Frontmatter: `---\n`, then each property on its own line as `key: value\n`,
//!   then `---\n`. Properties are emitted in source order (from
//!   [`Frontmatter::properties`]).
//! - A blank line separates the closing `---` from the first section, and
//!   also separates top-level sections from each other.
//! - Agent/skill/etc. headers: `<kind> <name>:\n`
//! - Properties in a block: `  key: value\n`
//! - Prose blocks: `  key: |\n`, followed by each prose line indented two
//!   spaces deeper than the key line.
//! - Permissions: `  permissions:\n    domain: access1, access2\n`
//! - Context references: `  context:\n    name1\n    name2\n`
//!
//! # Wave 1 Scope
//!
//! Per ULTRAPLAN §17 Wave 1, only [`render_protocol`], [`render_agent`],
//! and [`render_skill`] are fully implemented. The remaining kind-specific
//! dispatchers return a placeholder string so that a Wave 4 author can tell
//! at a glance which rendering support is still missing.

use crate::dsl::ast::{
    AgentDef, CantDocument, ContextRef, DocumentKind, Frontmatter, Permission, Property,
    ProseBlock, Section, SkillDef, StringValue, Value,
};

pub mod protocol;

#[cfg(test)]
mod tests;

/// Number of spaces per indentation level. Matches `indent::INDENT_WIDTH`.
const INDENT_WIDTH: usize = 2;

/// Renders a parsed [`CantDocument`] back into a `.cant` source string.
///
/// This is the top-level entry point for the Wave 1 render pipeline.
///
/// # Round-Trip Contract
///
/// For any hand-authored fixture that matches the canonical formatting
/// rules documented at the module level,
/// `render_document(&parse_document(src).unwrap())` equals `src`
/// byte-for-byte.
///
/// # Arguments
///
/// * `doc` - A parsed CANT document (obtained from [`crate::parse_document`]).
///
/// # Returns
///
/// The rendered source string. An empty document produces an empty string.
pub fn render_document(doc: &CantDocument) -> String {
    // Fast path: nothing to render.
    if doc.frontmatter.is_none() && doc.sections.is_empty() {
        return String::new();
    }

    // Dispatch on the document kind when it is known — each kind-specific
    // renderer knows how to arrange its top-level sections.
    match doc.kind {
        Some(DocumentKind::Protocol) => protocol::render_protocol(doc),
        Some(DocumentKind::Agent) => render_agent_document(doc),
        Some(DocumentKind::Skill) => render_skill_document(doc),
        Some(DocumentKind::Team) => render_team(doc),
        Some(DocumentKind::Tool) => render_tool(doc),
        Some(DocumentKind::Lifecycle) => render_lifecycle(doc),
        Some(DocumentKind::Workflow) => render_workflow(doc),
        Some(DocumentKind::Pipeline) => render_pipeline(doc),
        Some(DocumentKind::ModelRouting) => render_model_routing(doc),
        Some(DocumentKind::MentalModel) => render_mental_model(doc),
        Some(DocumentKind::Hook) => render_hook(doc),
        Some(DocumentKind::Message) => render_message(doc),
        Some(DocumentKind::Config) => render_config(doc),
        // Fallback: document without a declared kind — render as a generic
        // sequence of sections, which handles mixed-kind documents and
        // documents that omit frontmatter entirely.
        None => render_generic_document(doc),
    }
}

// ── Kind-specific document wrappers ──────────────────────────────────

/// Renders a `kind: agent` document: frontmatter (if any) plus agent sections.
fn render_agent_document(doc: &CantDocument) -> String {
    render_generic_document(doc)
}

/// Renders a `kind: skill` document: frontmatter (if any) plus skill sections.
fn render_skill_document(doc: &CantDocument) -> String {
    render_generic_document(doc)
}

/// Renders a generic document: frontmatter (if any) followed by every section
/// separated by a blank line. Each kind-specific renderer should delegate
/// here when it has no extra layout rules of its own.
pub(crate) fn render_generic_document(doc: &CantDocument) -> String {
    let mut out = String::new();

    if let Some(fm) = &doc.frontmatter {
        out.push_str(&render_frontmatter(fm));
    }

    for (idx, section) in doc.sections.iter().enumerate() {
        // First section: separate from frontmatter by a blank line. If the
        // document has no frontmatter, the first section starts at offset 0.
        let needs_leading_blank = idx == 0 && doc.frontmatter.is_some();
        let needs_separator = idx > 0;
        if needs_leading_blank || needs_separator {
            out.push('\n');
        }
        out.push_str(&render_section(section));
    }

    out
}

// ── Placeholder renderers (Wave 1 scope carve-out) ───────────────────

/// Placeholder — full rendering lands in a later wave.
fn render_team(_doc: &CantDocument) -> String {
    placeholder("team")
}

/// Placeholder — full rendering lands in a later wave.
fn render_tool(_doc: &CantDocument) -> String {
    placeholder("tool")
}

/// Placeholder — full rendering lands in a later wave.
fn render_lifecycle(_doc: &CantDocument) -> String {
    placeholder("lifecycle")
}

/// Placeholder — full rendering lands in a later wave.
fn render_workflow(_doc: &CantDocument) -> String {
    placeholder("workflow")
}

/// Placeholder — full rendering lands in a later wave.
fn render_pipeline(_doc: &CantDocument) -> String {
    placeholder("pipeline")
}

/// Placeholder — full rendering lands in a later wave.
fn render_model_routing(_doc: &CantDocument) -> String {
    placeholder("model-routing")
}

/// Placeholder — full rendering lands in a later wave.
fn render_mental_model(_doc: &CantDocument) -> String {
    placeholder("mental-model")
}

/// Placeholder — full rendering lands in a later wave.
fn render_hook(_doc: &CantDocument) -> String {
    placeholder("hook")
}

/// Placeholder — full rendering lands in a later wave.
fn render_message(_doc: &CantDocument) -> String {
    placeholder("message")
}

/// Placeholder — full rendering lands in a later wave.
fn render_config(_doc: &CantDocument) -> String {
    placeholder("config")
}

/// Builds the Wave-1 placeholder marker for a not-yet-implemented kind.
fn placeholder(kind: &str) -> String {
    format!("[kind: {kind} rendering not yet implemented]")
}

// ── Frontmatter ──────────────────────────────────────────────────────

/// Renders a [`Frontmatter`] block in the canonical form:
///
/// ```text
/// ---
/// kind: agent
/// version: "1.0"
/// ---
/// ```
///
/// Properties are emitted in source order. The returned string always ends
/// in a newline after the closing `---`.
pub fn render_frontmatter(fm: &Frontmatter) -> String {
    let mut out = String::new();
    out.push_str("---\n");

    for prop in &fm.properties {
        out.push_str(&render_property(prop, 0));
    }

    out.push_str("---\n");
    out
}

// ── Sections ─────────────────────────────────────────────────────────

/// Renders a single top-level [`Section`], including a trailing newline
/// on the final line of the section body.
pub(crate) fn render_section(section: &Section) -> String {
    match section {
        Section::Agent(a) => render_agent(a),
        Section::Skill(s) => render_skill(s),
        Section::Team(_)
        | Section::Tool(_)
        | Section::Hook(_)
        | Section::Workflow(_)
        | Section::Pipeline(_)
        | Section::Import(_)
        | Section::Binding(_)
        | Section::Comment(_) => {
            // Non-Wave-1 sections fall through to an empty string so that
            // fixtures built around the Wave 1 subset stay deterministic.
            // Expanding this match is the first step of later waves.
            String::new()
        }
    }
}

// ── Agent ────────────────────────────────────────────────────────────

/// Renders an [`AgentDef`] block.
///
/// Layout:
///
/// ```text
/// agent <name>:
///   <property>
///   permissions:
///     <perm>
///   context:
///     <ref>
/// ```
pub fn render_agent(agent: &AgentDef) -> String {
    let mut out = String::new();
    out.push_str(&format!("agent {}:\n", agent.name.value));

    // Properties (including prose blocks) come first, in source order.
    for prop in &agent.properties {
        out.push_str(&render_property(prop, 1));
    }

    // Permissions block, if any.
    if !agent.permissions.is_empty() {
        out.push_str(&render_permissions(&agent.permissions, 1));
    }

    // Context references, if any.
    if !agent.context_refs.is_empty() {
        out.push_str(&render_context_refs(&agent.context_refs, 1));
    }

    // NOTE: hooks, context_sources, and mental_model sub-blocks are not yet
    // rendered in Wave 1. Fixtures under tests/fixtures/render-round-trip/
    // intentionally avoid these features until a later wave adds support.

    out
}

// ── Skill ────────────────────────────────────────────────────────────

/// Renders a [`SkillDef`] block.
///
/// Layout:
///
/// ```text
/// skill <name>:
///   <property>
/// ```
pub fn render_skill(skill: &SkillDef) -> String {
    let mut out = String::new();
    out.push_str(&format!("skill {}:\n", skill.name.value));

    for prop in &skill.properties {
        out.push_str(&render_property(prop, 1));
    }

    out
}

// ── Properties and values ────────────────────────────────────────────

/// Renders a single [`Property`] at the given indent level.
///
/// `indent_level` is the number of 2-space indent steps (0 = top-level /
/// frontmatter, 1 = inside a section body, 2 = inside a sub-block, etc.).
///
/// Prose block values render across multiple lines; all other values render
/// on a single line.
pub fn render_property(prop: &Property, indent_level: usize) -> String {
    let indent = indent_str(indent_level);

    match &prop.value {
        Value::ProseBlock(pb) => render_prose_block(&prop.key.value, pb, indent_level),
        other => {
            format!("{}{}: {}\n", indent, prop.key.value, render_value(other))
        }
    }
}

/// Renders a single [`Value`] as a one-line string.
///
/// Prose block values are not handled here — they require the owning
/// property key and must be rendered via [`render_prose_block`]. Passing a
/// [`Value::ProseBlock`] returns an empty string to flag the misuse without
/// panicking.
pub fn render_value(value: &Value) -> String {
    match value {
        Value::String(sv) => render_string_value(sv),
        Value::Identifier(id) => id.clone(),
        Value::Number(n) => format_number(*n),
        Value::Boolean(b) => b.to_string(),
        Value::Duration(d) => {
            let unit = match d.unit {
                crate::dsl::ast::DurationUnit::Seconds => "s",
                crate::dsl::ast::DurationUnit::Minutes => "m",
                crate::dsl::ast::DurationUnit::Hours => "h",
                crate::dsl::ast::DurationUnit::Days => "d",
            };
            format!("{}{}", d.amount, unit)
        }
        Value::Array(items) => {
            let rendered: Vec<String> = items.iter().map(render_value).collect();
            format!("[{}]", rendered.join(", "))
        }
        Value::ProseBlock(_) => String::new(),
        Value::_Span(_) => String::new(),
    }
}

/// Renders a [`StringValue`] preserving the original quoting discipline.
///
/// Double-quoted strings are re-quoted; bare strings (including
/// frontmatter identifiers stored as [`Value::String`] with
/// `double_quoted: false`) render as their raw content.
fn render_string_value(sv: &StringValue) -> String {
    if sv.double_quoted {
        format!("\"{}\"", sv.raw)
    } else {
        sv.raw.clone()
    }
}

/// Formats an `f64` so that integer-valued numbers render without a trailing
/// `.0` (the parser accepts both `42` and `42.0`, but users author `42`).
fn format_number(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Renders a [`ProseBlock`] as `key: |` followed by indented content lines.
///
/// Blank lines inside the prose block are emitted as bare `\n` to match the
/// parser's behaviour of preserving empty lines. The block terminates on
/// the final content line; the surrounding renderer is responsible for
/// layout beyond the block.
pub fn render_prose_block(key: &str, block: &ProseBlock, key_indent_level: usize) -> String {
    let mut out = String::new();
    let key_indent = indent_str(key_indent_level);
    out.push_str(&format!("{}{}: |\n", key_indent, key));

    let content_indent = indent_str(key_indent_level + 1);
    for line in &block.lines {
        if line.is_empty() {
            // Preserve the blank line but do not emit trailing whitespace.
            out.push('\n');
        } else {
            out.push_str(&format!("{}{}\n", content_indent, line));
        }
    }
    out
}

// ── Permissions ──────────────────────────────────────────────────────

/// Renders a `permissions:` sub-block.
///
/// ```text
/// permissions:
///   tasks: read, write
///   files: write[backend/**]
/// ```
pub fn render_permissions(perms: &[Permission], parent_indent_level: usize) -> String {
    let mut out = String::new();
    let parent_indent = indent_str(parent_indent_level);
    out.push_str(&format!("{}permissions:\n", parent_indent));

    let child_indent = indent_str(parent_indent_level + 1);
    for perm in perms {
        out.push_str(&child_indent);
        out.push_str(&render_permission_line(perm));
        out.push('\n');
    }
    out
}

/// Renders a single permission as `domain: access1, access2` or
/// `domain: access[glob1, glob2]` when glob bounds are present.
fn render_permission_line(perm: &Permission) -> String {
    let access_joined = perm.access.join(", ");
    if perm.globs.is_empty() {
        format!("{}: {}", perm.domain, access_joined)
    } else {
        // The parser only accepts a single access verb before `[`, matching
        // the grammar (see `parse_access_and_globs` in permission.rs).
        let globs_joined = perm.globs.join(", ");
        format!("{}: {}[{}]", perm.domain, access_joined, globs_joined)
    }
}

// ── Context refs ─────────────────────────────────────────────────────

/// Renders a `context:` sub-block listing bare-name context references.
fn render_context_refs(refs: &[ContextRef], parent_indent_level: usize) -> String {
    let mut out = String::new();
    let parent_indent = indent_str(parent_indent_level);
    out.push_str(&format!("{}context:\n", parent_indent));

    let child_indent = indent_str(parent_indent_level + 1);
    for reference in refs {
        out.push_str(&format!("{}{}\n", child_indent, reference.name));
    }
    out
}

// ── Shared helpers ───────────────────────────────────────────────────

/// Builds an indentation string of `level * INDENT_WIDTH` spaces.
fn indent_str(level: usize) -> String {
    " ".repeat(level * INDENT_WIDTH)
}

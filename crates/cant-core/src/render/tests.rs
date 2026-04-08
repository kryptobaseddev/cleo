//! Inline unit tests for the Wave 1 render module.
//!
//! These cover the smallest slices of the render pipeline: empty documents,
//! individual property values, prose blocks, and minimal agent sections.
//! Full fixture round-trip coverage lives in
//! `crates/cant-core/tests/render_round_trip.rs`.

use super::{
    render_agent, render_document, render_frontmatter, render_permissions, render_property,
    render_prose_block, render_value,
};
use crate::dsl::ast::Section;
use crate::dsl::parse_document;

// ── Helper: parse a source string and return its document, panicking on
//    parse errors so test failures point at the offending input.
fn parse(src: &str) -> crate::dsl::ast::CantDocument {
    parse_document(src)
        .unwrap_or_else(|errs| panic!("expected clean parse, got errors: {errs:#?}"))
}

#[test]
fn render_empty_document_produces_empty_string() {
    let doc = parse("");
    assert_eq!(render_document(&doc), "");
}

#[test]
fn render_frontmatter_kind_only() {
    let doc = parse("---\nkind: protocol\n---\n");
    let fm = doc.frontmatter.as_ref().expect("frontmatter");
    assert_eq!(render_frontmatter(fm), "---\nkind: protocol\n---\n");
}

#[test]
fn render_frontmatter_kind_and_version() {
    let doc = parse("---\nkind: agent\nversion: \"1.0\"\n---\n");
    let fm = doc.frontmatter.as_ref().expect("frontmatter");
    assert_eq!(
        render_frontmatter(fm),
        "---\nkind: agent\nversion: \"1.0\"\n---\n"
    );
}

#[test]
fn render_simple_property_string_value() {
    let doc = parse("agent ops:\n  prompt: \"You coordinate things\"\n");
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    let prop = &agent.properties[0];
    assert_eq!(render_property(prop, 1), "  prompt: \"You coordinate things\"\n");
}

#[test]
fn render_simple_property_identifier_value() {
    let doc = parse("agent ops:\n  model: opus\n");
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    let prop = &agent.properties[0];
    assert_eq!(render_property(prop, 1), "  model: opus\n");
}

#[test]
fn render_array_value() {
    let doc = parse("agent deployer:\n  skills: [\"ct-deploy\", \"ct-monitor\"]\n");
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    let prop = &agent.properties[0];
    // Arrays render with single-space separators after commas.
    assert_eq!(
        render_value(&prop.value),
        "[\"ct-deploy\", \"ct-monitor\"]"
    );
}

#[test]
fn render_prose_block_heredoc_pipe() {
    let doc = parse("agent ops:\n  tone: |\n    You are calm.\n    Be precise.\n");
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    let prop = &agent.properties[0];
    let crate::dsl::ast::Value::ProseBlock(pb) = &prop.value else {
        panic!("expected prose block");
    };
    assert_eq!(
        render_prose_block(&prop.key.value, pb, 1),
        "  tone: |\n    You are calm.\n    Be precise.\n"
    );
}

#[test]
fn render_agent_block_minimal() {
    let doc = parse("agent ops:\n  model: opus\n  persist: true\n");
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    assert_eq!(
        render_agent(agent),
        "agent ops:\n  model: opus\n  persist: true\n"
    );
}

#[test]
fn render_agent_with_permissions_block() {
    let src =
        "agent scanner:\n  model: opus\n  permissions:\n    tasks: read, write\n    session: read\n";
    let doc = parse(src);
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    assert_eq!(render_agent(agent), src);
}

#[test]
fn render_permissions_standalone() {
    let src = "agent scanner:\n  permissions:\n    tasks: read, write\n";
    let doc = parse(src);
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    let perms = render_permissions(&agent.permissions, 1);
    assert_eq!(perms, "  permissions:\n    tasks: read, write\n");
}

#[test]
fn render_agent_with_context_block() {
    let src = "agent ops:\n  model: opus\n  context:\n    active-tasks\n    memory-bridge\n";
    let doc = parse(src);
    let Section::Agent(agent) = &doc.sections[0] else {
        panic!("expected Agent section");
    };
    assert_eq!(render_agent(agent), src);
}

#[test]
fn render_skill_block_minimal() {
    let src = "skill ct-deploy:\n  description: \"Deployment automation\"\n  tier: core\n";
    let doc = parse(src);
    let Section::Skill(skill) = &doc.sections[0] else {
        panic!("expected Skill section");
    };
    assert_eq!(super::render_skill(skill), src);
}

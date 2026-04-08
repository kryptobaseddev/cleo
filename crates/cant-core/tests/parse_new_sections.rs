//! Integration tests for CleoOS v2 grammar additions: `team`, `tool`, and JIT
//! agent fixtures live under `tests/fixtures/` and must round-trip through
//! [`cant_core::dsl::parse_document`] with no parse errors and lint clean.

use cant_core::dsl::ast::{DocumentKind, Section};
use cant_core::dsl::parse_document;
use cant_core::validate::validate;
use std::path::PathBuf;

/// Returns the absolute path to a fixture file under `tests/fixtures/`.
fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push(name);
    p
}

fn read_fixture(name: &str) -> String {
    let path = fixture_path(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read fixture {}: {}", path.display(), e))
}

#[test]
fn team_platform_fixture_parses_clean() {
    let content = read_fixture("team-platform.cant");
    let doc = parse_document(&content)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {:#?}", errs.len(), errs));
    assert_eq!(doc.kind, Some(DocumentKind::Team));
    assert_eq!(doc.sections.len(), 1);
    match &doc.sections[0] {
        Section::Team(team) => {
            assert_eq!(team.name.value, "platform");
        }
        other => panic!("expected Section::Team, got {other:?}"),
    }

    let diags = validate(&doc);
    let errors: Vec<_> = diags
        .iter()
        .filter(|d| matches!(d.severity, cant_core::validate::diagnostic::Severity::Error))
        .collect();
    assert!(
        errors.is_empty(),
        "team-platform.cant emitted {} validation errors: {:#?}",
        errors.len(),
        errors
    );
}

#[test]
fn tool_dispatch_fixture_parses_clean() {
    let content = read_fixture("tool-dispatch.cant");
    let doc = parse_document(&content)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {:#?}", errs.len(), errs));
    assert_eq!(doc.kind, Some(DocumentKind::Tool));
    assert_eq!(doc.sections.len(), 1);
    match &doc.sections[0] {
        Section::Tool(tool) => {
            assert_eq!(tool.name.value, "dispatch_worker");
        }
        other => panic!("expected Section::Tool, got {other:?}"),
    }

    let diags = validate(&doc);
    let errors: Vec<_> = diags
        .iter()
        .filter(|d| matches!(d.severity, cant_core::validate::diagnostic::Severity::Error))
        .collect();
    assert!(
        errors.is_empty(),
        "tool-dispatch.cant emitted {} validation errors: {:#?}",
        errors.len(),
        errors
    );
}

/// Documents the known parse-level limitations of the T197 prototype at
/// `~/.agents/agents/cleo-subagent/cleo-subagent.cant`.
///
/// The prototype uses multi-line array syntax inside its `tools:` sub-block
/// that the line-based parser never supported, even on the pre-Wave-0
/// baseline (commit `e52559d7`). This test asserts the failure mode is
/// unchanged so that any future parser improvement that enables the prototype
/// is detected and the test can be updated to assert success.
///
/// Marked `#[ignore]` because it depends on an external file under
/// `$HOME/.agents/`.
#[test]
#[ignore = "depends on prototype file under $HOME/.agents/; documents pre-existing parser limitation"]
fn prototype_cleo_subagent_known_limitation() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let mut path = PathBuf::from(home);
    path.push(".agents/agents/cleo-subagent/cleo-subagent.cant");
    if !path.exists() {
        return;
    }
    let content = std::fs::read_to_string(&path).expect("read prototype");
    // Pre-existing limitation: multi-line array syntax inside `tools:` is
    // unsupported. The parser produces ~105 errors starting near line 32.
    let result = parse_document(&content);
    assert!(
        result.is_err(),
        "prototype unexpectedly parsed clean — update this test to assert success"
    );
}

#[test]
fn jit_backend_dev_fixture_parses() {
    let content = read_fixture("jit-backend-dev.cant");
    let doc = parse_document(&content)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {:#?}", errs.len(), errs));
    assert_eq!(doc.kind, Some(DocumentKind::Agent));
    assert_eq!(doc.sections.len(), 1);
    match &doc.sections[0] {
        Section::Agent(agent) => {
            assert_eq!(agent.name.value, "backend-dev");
            assert!(
                !agent.context_sources.is_empty(),
                "expected context_sources sub-block to be populated"
            );
            assert!(
                !agent.mental_model.is_empty(),
                "expected mental_model sub-block to be populated"
            );
            // The fixture has `files: write[backend/**, tests/backend/**]`,
            // verifying the new glob-bounded permission syntax round-trips.
            let files_perm = agent
                .permissions
                .iter()
                .find(|p| p.domain == "files")
                .expect("files permission not found");
            assert_eq!(files_perm.access, vec!["write".to_string()]);
            assert_eq!(
                files_perm.globs,
                vec!["backend/**".to_string(), "tests/backend/**".to_string()]
            );
        }
        other => panic!("expected Section::Agent, got {other:?}"),
    }

    let diags = validate(&doc);
    let errors: Vec<_> = diags
        .iter()
        .filter(|d| matches!(d.severity, cant_core::validate::diagnostic::Severity::Error))
        .collect();
    assert!(
        errors.is_empty(),
        "jit-backend-dev.cant emitted {} validation errors: {:#?}",
        errors.len(),
        errors
    );
}

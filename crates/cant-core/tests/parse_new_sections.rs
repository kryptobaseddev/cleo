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

// ── T615: Starter bundle parse + validate check (temporary diagnostic) ───────

#[test]
fn t615_starter_bundle_parse_errors_diagnostic() {
    let base = {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.pop(); // up from crates/cant-core to repo root
        p
    };

    let files = vec![
        "packages/cleo-os/starter-bundle/team.cant",
        "packages/cleo-os/starter-bundle/agents/cleo-orchestrator.cant",
        "packages/cleo-os/starter-bundle/agents/dev-lead.cant",
        "packages/cleo-os/starter-bundle/agents/code-worker.cant",
        "packages/cleo-os/starter-bundle/agents/docs-worker.cant",
    ];

    let mut report = String::new();
    let mut total_parse = 0usize;
    let mut total_val = 0usize;

    for rel in &files {
        let path = base.join(rel);
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        match parse_document(&content) {
            Ok(doc) => {
                let diags = validate(&doc);
                let errs: Vec<_> = diags
                    .iter()
                    .filter(|d| {
                        matches!(d.severity, cant_core::validate::diagnostic::Severity::Error)
                    })
                    .collect();
                if errs.is_empty() {
                    report.push_str(&format!("OK: {rel}\n"));
                } else {
                    report.push_str(&format!("VAL_ERR {rel}: {} errors\n", errs.len()));
                    for e in &errs {
                        report.push_str(&format!("  [{}] {}\n", e.rule_id, e.message));
                    }
                    total_val += errs.len();
                }
            }
            Err(errs) => {
                report.push_str(&format!("PARSE_ERR {rel}: {} errors\n", errs.len()));
                for e in errs.iter().take(20) {
                    report.push_str(&format!("  line {}: {}\n", e.span.line, e.message));
                }
                if errs.len() > 20 {
                    report.push_str(&format!("  ...{} more\n", errs.len() - 20));
                }
                total_parse += errs.len();
            }
        }
    }

    report.push_str(&format!(
        "\nTotal parse errors: {total_parse}, validation errors: {total_val}\n"
    ));
    // Print for visibility, then assert
    eprintln!("{report}");
    assert_eq!(
        total_parse + total_val,
        0,
        "Starter bundle errors:\n{report}"
    );
}

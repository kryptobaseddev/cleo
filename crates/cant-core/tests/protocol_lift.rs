//! Wave 4 integration tests: Protocol + Lifecycle `.cant` file parsing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//!
//! Verifies that all 12 protocol `.cant` files and the 1 lifecycle `.cant`
//! file created during the Wave 4 protocol-to-CANT lift parse without error
//! and produce the expected `DocumentKind`.
//!
//! These files live at:
//! - `packages/core/src/validation/protocols/cant/*.cant`
//! - `packages/core/src/lifecycle/cant/lifecycle-rcasd.cant`
//!
//! Reference: `docs/plans/CLEO-ULTRAPLAN.md` Section 17 Wave 4.

use cant_core::dsl::ast::DocumentKind;
use cant_core::dsl::parse_document;
use std::path::PathBuf;

/// Returns the absolute path to a protocol `.cant` file.
fn protocol_cant_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Navigate from crates/cant-core/ up to repo root
    p.pop(); // -> crates/
    p.pop(); // -> repo root
    p.push("packages");
    p.push("core");
    p.push("src");
    p.push("validation");
    p.push("protocols");
    p.push("cant");
    p.push(name);
    p
}

/// Returns the absolute path to the lifecycle `.cant` file.
fn lifecycle_cant_path() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // -> crates/
    p.pop(); // -> repo root
    p.push("packages");
    p.push("core");
    p.push("src");
    p.push("lifecycle");
    p.push("cant");
    p.push("lifecycle-rcasd.cant");
    p
}

/// Reads a file, panicking with a useful message on failure.
fn read_file(path: &PathBuf) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
}

/// Asserts a `.cant` file parses successfully and has the expected kind.
fn assert_parses_with_kind(path: &PathBuf, expected_kind: DocumentKind) {
    let content = read_file(path);
    let doc = parse_document(&content).unwrap_or_else(|errs| {
        let messages: Vec<String> = errs.iter().map(|e| format!("  - {}", e.message)).collect();
        panic!(
            "parse failed for {}: {} errors:\n{}",
            path.display(),
            errs.len(),
            messages.join("\n")
        )
    });
    assert_eq!(
        doc.kind,
        Some(expected_kind),
        "wrong DocumentKind for {}",
        path.display()
    );
    assert!(
        doc.frontmatter.is_some(),
        "expected frontmatter in {}",
        path.display()
    );
}

// ── Protocol .cant files (12 tests) ────────────────────────────────

#[test]
fn protocol_research_parses() {
    let path = protocol_cant_path("research.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_consensus_parses() {
    let path = protocol_cant_path("consensus.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_architecture_decision_parses() {
    let path = protocol_cant_path("architecture-decision.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_specification_parses() {
    let path = protocol_cant_path("specification.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_decomposition_parses() {
    let path = protocol_cant_path("decomposition.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_implementation_parses() {
    let path = protocol_cant_path("implementation.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_validation_parses() {
    let path = protocol_cant_path("validation.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_testing_parses() {
    let path = protocol_cant_path("testing.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_release_parses() {
    let path = protocol_cant_path("release.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_contribution_parses() {
    let path = protocol_cant_path("contribution.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_provenance_parses() {
    let path = protocol_cant_path("provenance.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

#[test]
fn protocol_artifact_publish_parses() {
    let path = protocol_cant_path("artifact-publish.cant");
    assert_parses_with_kind(&path, DocumentKind::Protocol);
}

// ── Lifecycle .cant file (1 test) ──────────────────────────────────

#[test]
fn lifecycle_rcasd_parses() {
    let path = lifecycle_cant_path();
    assert_parses_with_kind(&path, DocumentKind::Lifecycle);
}

// ── Aggregate: all protocol files found ────────────────────────────

#[test]
fn all_twelve_protocol_files_exist() {
    let expected = [
        "research.cant",
        "consensus.cant",
        "architecture-decision.cant",
        "specification.cant",
        "decomposition.cant",
        "implementation.cant",
        "validation.cant",
        "testing.cant",
        "release.cant",
        "contribution.cant",
        "provenance.cant",
        "artifact-publish.cant",
    ];
    for name in &expected {
        let path = protocol_cant_path(name);
        assert!(
            path.exists(),
            "missing protocol .cant file: {}",
            path.display()
        );
    }
}

#[test]
fn protocol_frontmatter_preserves_id_field() {
    // Spot-check that frontmatter properties beyond kind/version are preserved
    let path = protocol_cant_path("research.cant");
    let content = read_file(&path);
    let doc = parse_document(&content).unwrap();
    let fm = doc.frontmatter.as_ref().unwrap();

    // Find the 'id' property
    let id_prop = fm
        .properties
        .iter()
        .find(|p| p.key.value == "id")
        .expect("frontmatter should have 'id' property");
    match &id_prop.value {
        cant_core::dsl::ast::Value::Identifier(v) => assert_eq!(v, "RSCH"),
        other => panic!("expected Identifier for id, got {other:?}"),
    }

    // Find the 'enforcement' property
    let enforcement_prop = fm
        .properties
        .iter()
        .find(|p| p.key.value == "enforcement")
        .expect("frontmatter should have 'enforcement' property");
    match &enforcement_prop.value {
        cant_core::dsl::ast::Value::Identifier(v) => assert_eq!(v, "strict"),
        other => panic!("expected Identifier for enforcement, got {other:?}"),
    }
}

#[test]
fn lifecycle_frontmatter_has_version() {
    let path = lifecycle_cant_path();
    let content = read_file(&path);
    let doc = parse_document(&content).unwrap();
    let fm = doc.frontmatter.as_ref().unwrap();
    assert_eq!(fm.version, Some("1.0.0".to_string()));
}

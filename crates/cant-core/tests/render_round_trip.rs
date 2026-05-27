//! Round-trip integration tests for the Wave 1 render pipeline
//! (`docs/plans/CLEO-ULTRAPLAN.md` §17).
//!
//! These tests load hand-authored fixtures from
//! `tests/fixtures/render-round-trip/`, parse them via
//! [`cant_core::parse_document`], render the resulting AST via
//! [`cant_core::render_document`], and assert the rendered output is
//! **byte-identical** to the fixture source.
//!
//! This is Option A of the two round-trip contracts discussed in the
//! Wave 1 brief: fixtures are written to match the renderer's canonical
//! formatting rules so no normalisation step is needed.

use cant_core::dsl::ast::DocumentKind;
use cant_core::{parse_document, render_document};
use std::path::PathBuf;

/// Returns the absolute path to a fixture under `tests/fixtures/render-round-trip/`.
fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push("render-round-trip");
    p.push(name);
    p
}

/// Reads a fixture file to a string, panicking with a helpful message on I/O errors.
fn read_fixture(name: &str) -> String {
    let path = fixture_path(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read fixture {}: {}", path.display(), e))
}

/// Parses a fixture, rendering it and asserting byte-identical round-trip.
///
/// The assertion uses raw string comparison so failures surface the exact
/// diverging byte.
fn assert_byte_identical_round_trip(src: &str) {
    let doc = parse_document(src)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {errs:#?}", errs.len()));
    let rendered = render_document(&doc);
    assert_eq!(
        rendered, src,
        "round-trip mismatch\n── expected ──\n{src}\n── rendered ──\n{rendered}\n── ──"
    );
}

#[test]
fn empty_document_round_trip() {
    // Empty input → Message-mode document → empty render.
    assert_byte_identical_round_trip("");
}

#[test]
fn frontmatter_only_round_trip() {
    // Frontmatter-only documents with no sections still round-trip.
    let src = "---\nkind: protocol\n---\n";
    assert_byte_identical_round_trip(src);
}

#[test]
fn protocol_fixture_round_trips_byte_identical() {
    let src = read_fixture("sample-protocol-research.cant");
    let doc = parse_document(&src)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {errs:#?}", errs.len()));
    assert_eq!(doc.kind, Some(DocumentKind::Protocol));
    let rendered = render_document(&doc);
    assert_eq!(
        rendered, src,
        "protocol fixture round-trip mismatch\n── expected ──\n{src}\n── rendered ──\n{rendered}\n── ──"
    );
}

#[test]
fn agent_fixture_round_trips_byte_identical() {
    let src = read_fixture("sample-agent-worker.cant");
    let doc = parse_document(&src)
        .unwrap_or_else(|errs| panic!("parse failed: {} errors: {errs:#?}", errs.len()));
    assert_eq!(doc.kind, Some(DocumentKind::Agent));
    let rendered = render_document(&doc);
    assert_eq!(
        rendered, src,
        "agent fixture round-trip mismatch\n── expected ──\n{src}\n── rendered ──\n{rendered}\n── ──"
    );
}

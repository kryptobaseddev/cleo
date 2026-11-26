//! Regression tests for the cross-file import rules (T14603): S03 circular
//! imports, S11 import depth and S12 permission escalation run through
//! [`cant_core::validate_document_file`] against real files on disk.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use cant_core::validate::diagnostic::Diagnostic;
use cant_core::{parse_document, validate_document, validate_document_file};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Creates a fresh project directory (with a `.cleo/` marker) for one test.
fn project(name: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "cant-validate-imports-{name}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".cleo")).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, content: &str) -> PathBuf {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
    path
}

fn validate_path(path: &Path) -> Vec<Diagnostic> {
    let content = std::fs::read_to_string(path).unwrap();
    let doc = parse_document(&content).unwrap_or_else(|e| panic!("parse failed: {e:#?}"));
    validate_document_file(&doc, path)
}

fn rule_ids(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.rule_id.as_str()).collect()
}

#[test]
fn cyclic_import_is_refused_with_s03() {
    let dir = project("cycle");
    let a = write(&dir, "agents/a.cant", "@import \"./b.cant\"\n");
    write(&dir, "agents/b.cant", "@import \"./a.cant\"\n");

    let diags = validate_path(&a);
    let s03: Vec<_> = diags.iter().filter(|d| d.rule_id == "S03").collect();
    assert_eq!(s03.len(), 1, "diagnostics: {diags:#?}");
    assert!(
        s03[0]
            .message
            .contains("agents/a.cant -> agents/b.cant -> agents/a.cant"),
        "message: {}",
        s03[0].message
    );

    // The single-document entry point has no file to resolve imports from.
    let doc = parse_document(&std::fs::read_to_string(&a).unwrap()).unwrap();
    assert!(!rule_ids(&validate_document(&doc)).contains(&"S03"));
}

#[test]
fn self_import_is_refused_with_s03() {
    let dir = project("self");
    let a = write(&dir, "a.cant", "@import \"./a\"\n");
    assert!(rule_ids(&validate_path(&a)).contains(&"S03"));
}

#[test]
fn acyclic_diamond_imports_pass() {
    let dir = project("diamond");
    let main = write(
        &dir,
        "main.cant",
        "@import \"./left.cant\"\n@import \"./right.cant\"\n",
    );
    write(&dir, "left.cant", "@import \"./shared.cant\"\n");
    write(&dir, "right.cant", "@import \"./shared.cant\"\n");
    write(&dir, "shared.cant", "agent helper:\n  model: opus\n");

    let diags = validate_path(&main);
    let ids = rule_ids(&diags);
    assert!(
        !ids.contains(&"S03") && !ids.contains(&"S11") && !ids.contains(&"S12"),
        "diagnostics: {diags:#?}"
    );
}

#[test]
fn skill_scope_import_cycle_is_refused() {
    let dir = project("skill");
    let main = write(&dir, "agents/main.cant", "@import \"@ct-loop\"\n");
    write(
        &dir,
        ".cleo/skills/ct-loop.cant",
        "@import \"../../agents/main.cant\"\n",
    );
    assert!(rule_ids(&validate_path(&main)).contains(&"S03"));
}

#[test]
fn escalating_imported_agent_is_reported_with_s12() {
    let dir = project("escalate");
    let main = write(
        &dir,
        "main.cant",
        "@import \"./agents/worker.cant\"\n\nagent coordinator:\n  model: opus\n  permissions:\n    tasks: read\n",
    );
    write(
        &dir,
        "agents/worker.cant",
        "agent worker:\n  model: opus\n  permissions:\n    tasks: read, write\n    session: read\n",
    );

    let diags = validate_path(&main);
    let s12: Vec<_> = diags.iter().filter(|d| d.rule_id == "S12").collect();
    assert_eq!(s12.len(), 2, "diagnostics: {diags:#?}");
    assert!(s12.iter().any(|d| d.message.contains("'tasks: write'")));
    assert!(s12.iter().any(|d| d.message.contains("'session: read'")));
    assert!(
        s12[0]
            .message
            .contains("in imported file 'agents/worker.cant'")
    );
}

#[test]
fn imported_agent_within_context_passes_s12() {
    let dir = project("within");
    let main = write(
        &dir,
        "main.cant",
        "@import \"./agents/worker.cant\"\n\nagent coordinator:\n  model: opus\n  permissions:\n    tasks: read, write\n",
    );
    write(
        &dir,
        "agents/worker.cant",
        "agent worker:\n  model: opus\n  permissions:\n    tasks: read\n",
    );
    assert!(!rule_ids(&validate_path(&main)).contains(&"S12"));
}

#[test]
fn import_chain_over_the_limit_is_reported_with_s11() {
    let dir = project("deep");
    // 66 files: chain-0 imports chain-1 ... imports chain-65 (limit 64).
    for i in 0..66 {
        let body = if i < 65 {
            format!("@import \"./chain-{}.cant\"\n", i + 1)
        } else {
            String::new()
        };
        write(&dir, &format!("chain-{i}.cant"), &body);
    }
    let diags = validate_path(&dir.join("chain-0.cant"));
    let s11: Vec<_> = diags.iter().filter(|d| d.rule_id == "S11").collect();
    assert_eq!(s11.len(), 1, "diagnostics: {diags:#?}");
    assert!(
        s11[0]
            .message
            .contains("depth of 65 exceeds the maximum of 64")
    );

    // 64 files stay within the limit.
    let shallow = project("shallow");
    for i in 0..64 {
        let body = if i < 63 {
            format!("@import \"./chain-{}.cant\"\n", i + 1)
        } else {
            String::new()
        };
        write(&shallow, &format!("chain-{i}.cant"), &body);
    }
    assert!(!rule_ids(&validate_path(&shallow.join("chain-0.cant"))).contains(&"S11"));
}

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

#[test]
fn escalation_through_an_agentless_file_is_reported_with_s12() {
    let dir = project("agentless-mid");
    let main = write(
        &dir,
        "main.cant",
        "@import \"./mid.cant\"\n\nagent coordinator:\n  model: opus\n  permissions:\n    tasks: read\n",
    );
    write(&dir, "mid.cant", "@import \"./worker.cant\"\n");
    write(
        &dir,
        "worker.cant",
        "agent worker:\n  model: opus\n  permissions:\n    tasks: write\n",
    );

    let diags = validate_path(&main);
    let s12: Vec<_> = diags.iter().filter(|d| d.rule_id == "S12").collect();
    assert_eq!(s12.len(), 1, "diagnostics: {diags:#?}");
    assert!(s12[0].message.contains("'tasks: write'"));
    assert!(s12[0].message.contains("in imported file 'worker.cant'"));
}

/// A project directory inside a sandbox, with a file OUTSIDE the project
/// that would be reported (S12 escalation and an S03 cycle back into the
/// project) if the walk ever read it.
fn sandbox(name: &str) -> (PathBuf, PathBuf) {
    let base = project(name);
    let proj = base.join("proj");
    std::fs::create_dir_all(proj.join(".cleo")).unwrap();
    write(
        &base,
        "outside.cant",
        "@import \"./proj/main.cant\"\n\nagent evil:\n  model: opus\n  permissions:\n    tasks: read, write, execute\n",
    );
    (base, proj)
}

const COORDINATOR: &str = "\nagent coordinator:\n  model: opus\n  permissions:\n    tasks: read\n";

/// Asserts the outside file was not read: neither its S12 escalation nor
/// its S03 cycle back into the project is reported.
fn assert_outside_not_read(diags: &[Diagnostic]) {
    let ids = rule_ids(diags);
    assert!(
        !ids.contains(&"S12") && !ids.contains(&"S03"),
        "outside file was read: {diags:#?}"
    );
}

#[test]
fn parent_traversal_escape_is_refused_unread() {
    let (_base, proj) = sandbox("escape-dotdot");
    let main = write(
        &proj,
        "main.cant",
        &format!("@import \"./mid.cant\"\n{COORDINATOR}"),
    );
    write(&proj, "mid.cant", "@import \"../outside.cant\"\n");

    let diags = validate_path(&main);
    let s09: Vec<_> = diags.iter().filter(|d| d.rule_id == "S09").collect();
    assert_eq!(s09.len(), 1, "diagnostics: {diags:#?}");
    assert!(s09[0].message.contains("in 'mid.cant'"));
    assert_outside_not_read(&diags);

    // From the root file itself: reported once (by the string check), unread.
    let root = write(
        &proj,
        "root.cant",
        &format!("@import \"../outside.cant\"\n{COORDINATOR}"),
    );
    let diags = validate_path(&root);
    assert_eq!(rule_ids(&diags).iter().filter(|r| **r == "S09").count(), 1);
    assert_outside_not_read(&diags);
}

#[test]
fn skill_scope_escape_is_refused_unread() {
    let (_base, proj) = sandbox("escape-skill");
    let main = write(
        &proj,
        "main.cant",
        &format!("@import \"@../../../outside\"\n{COORDINATOR}"),
    );
    let diags = validate_path(&main);
    assert!(rule_ids(&diags).contains(&"S09"), "diagnostics: {diags:#?}");
    assert_outside_not_read(&diags);
}

#[test]
fn absolute_import_is_refused_unread() {
    let (base, proj) = sandbox("escape-absolute");
    let outside = base.join("outside.cant").canonicalize().unwrap();
    let main = write(
        &proj,
        "main.cant",
        &format!(
            "@import \"./mid.cant\"\n@import \"@{}\"\n{COORDINATOR}",
            outside.display()
        ),
    );
    write(
        &proj,
        "mid.cant",
        &format!("@import \"{}\"\n", outside.display()),
    );

    let diags = validate_path(&main);
    let s10: Vec<_> = diags.iter().filter(|d| d.rule_id == "S10").collect();
    assert_eq!(s10.len(), 2, "diagnostics: {diags:#?}");
    assert!(s10.iter().any(|d| d.message.contains("in 'mid.cant'")));
    assert_outside_not_read(&diags);
}

#[cfg(unix)]
#[test]
fn symlink_escape_is_refused_unread() {
    let (base, proj) = sandbox("escape-symlink");
    std::os::unix::fs::symlink(base.join("outside.cant"), proj.join("link.cant")).unwrap();
    let main = write(
        &proj,
        "main.cant",
        &format!("@import \"./link.cant\"\n{COORDINATOR}"),
    );

    let diags = validate_path(&main);
    let s10: Vec<_> = diags.iter().filter(|d| d.rule_id == "S10").collect();
    assert_eq!(s10.len(), 1, "diagnostics: {diags:#?}");
    assert!(s10[0].message.contains("symlink"));
    assert_outside_not_read(&diags);
}

/// T14645: a git repository without its own `.cleo/`, nested under a
/// directory that has one (a home directory with `~/.cleo/`), is rooted at
/// the repository, never at the farther `.cleo/` ancestor.
#[test]
fn nearest_git_repo_wins_over_a_farther_cleo_ancestor() {
    let home = project("nested-root");
    write(
        &home,
        ".cleo/skills/evil.cant",
        "agent evil:\n  model: opus\n  permissions:\n    tasks: read, write, execute\n",
    );
    write(
        &home,
        "outside.cant",
        "agent evil:\n  model: opus\n  permissions:\n    tasks: read, write, execute\n",
    );

    // A `.git` directory, and the `.git` file a linked worktree has.
    let repo = home.join("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    let worktree = home.join("worktree");
    write(&worktree, ".git", "gitdir: /elsewhere\n");

    for root in [&repo, &worktree] {
        // `@evil` would resolve to ~/.cleo/skills/evil.cant (S12) if the
        // root were the home directory.
        let main = write(
            root,
            "main.cant",
            &format!("@import \"@evil\"\n{COORDINATOR}"),
        );
        let diags = validate_path(&main);
        assert!(
            !rule_ids(&diags).contains(&"S12"),
            "home skill read: {diags:#?}"
        );

        // Containment is the repository: `../outside.cant` escapes it.
        write(root, "mid.cant", "@import \"../outside.cant\"\n");
        let main = write(
            root,
            "main.cant",
            &format!("@import \"./mid.cant\"\n{COORDINATOR}"),
        );
        let diags = validate_path(&main);
        assert!(rule_ids(&diags).contains(&"S09"), "diagnostics: {diags:#?}");
        assert!(
            !rule_ids(&diags).contains(&"S12"),
            "outside read: {diags:#?}"
        );
    }
}

/// T14645: `\` separates specifier components like `/` on every host, so
/// `.\` and `..\` imports are relative and a `..\` escape is refused unread.
#[test]
fn backslash_specifiers_resolve_relative_and_escapes_are_refused() {
    let (_base, proj) = sandbox("backslash");
    let main = write(
        &proj,
        "main.cant",
        &format!("@import \".\\\\sub\\\\mid.cant\"\n{COORDINATOR}"),
    );
    write(&proj, "sub/mid.cant", "@import \"..\\\\main.cant\"\n");
    let diags = validate_path(&main);
    assert!(
        rule_ids(&diags).contains(&"S03"),
        "not resolved: {diags:#?}"
    );

    write(
        &proj,
        "sub/mid.cant",
        "@import \"..\\\\..\\\\outside.cant\"\n",
    );
    let diags = validate_path(&main);
    let s09: Vec<_> = diags.iter().filter(|d| d.rule_id == "S09").collect();
    assert_eq!(s09.len(), 1, "diagnostics: {diags:#?}");
    assert_outside_not_read(&diags);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! `compute_project_hash` canonicalises its input as the TypeScript SSoT
//! `computeProjectHash` (`@cleocode/paths`) does (T14130): a symlinked path
//! and a linked git worktree hash as the real main checkout.
//!
//! The Rust side always runs. The TypeScript side runs when `node` and the
//! built `packages/paths/dist` are present (a workspace build), and the test
//! then asserts both implementations return the same hash for each path;
//! without them it says it skipped that comparison.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Command;

use worktrunk_core::paths::compute_project_hash;

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?} failed");
}

/// A main checkout with one commit, a symlink to it, and a linked worktree.
fn fixture(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let main = dir.join("main");
    std::fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    git(
        &main,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    let link = dir.join("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&main, &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&main, &link).unwrap();
    let worktree = dir.join("wt");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            worktree.to_str().unwrap(),
            "-b",
            "task",
        ],
    );
    (main, link, worktree)
}

/// `computeProjectHash` from the built TypeScript package, or `None` when it
/// cannot be run here.
fn ts_hash(path: &Path) -> Option<String> {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/paths/dist/index.js");
    if !dist.exists() {
        return None;
    }
    let script = format!(
        "import({:?}).then((m) => process.stdout.write(m.computeProjectHash(process.argv[1])))",
        format!("file://{}", dist.canonicalize().ok()?.display()),
    );
    let out = Command::new("node")
        .args(["--input-type=module", "-e", &script, path.to_str()?])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn symlinked_and_linked_worktree_paths_hash_as_the_main_checkout() {
    let tmp = tempfile::tempdir().unwrap();
    let (main, link, worktree) = fixture(tmp.path());
    let expected = compute_project_hash(main.to_str().unwrap());

    for path in [&main, &link, &worktree] {
        assert_eq!(
            compute_project_hash(path.to_str().unwrap()),
            expected,
            "{} should hash as the main checkout",
            path.display()
        );
    }

    let ts: Vec<Option<String>> = [&main, &link, &worktree]
        .iter()
        .map(|p| ts_hash(p))
        .collect();
    if ts.iter().any(Option::is_none) {
        // CI builds packages/paths first and sets this, so a skip there fails.
        assert!(
            std::env::var_os("WORKTRUNK_REQUIRE_TS_PARITY").is_none(),
            "WORKTRUNK_REQUIRE_TS_PARITY is set but node or packages/paths/dist is not available"
        );
        eprintln!(
            "skipped the TypeScript comparison: node or packages/paths/dist is not available"
        );
        return;
    }
    for (path, hash) in [&main, &link, &worktree].iter().zip(ts) {
        assert_eq!(
            hash.as_deref(),
            Some(expected.as_str()),
            "TypeScript computeProjectHash disagrees for {}",
            path.display()
        );
    }
}

#[test]
fn a_path_that_does_not_exist_hashes_as_given() {
    // Neither side can resolve it, so both hash the raw bytes (unchanged since T10207).
    assert_eq!(
        compute_project_hash("/mnt/projects/cleocode"),
        "1e3146b7352ba279"
    );
}

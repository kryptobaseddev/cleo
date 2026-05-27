// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Integration tests for [`worktrunk_core::copy::copy_dir_recursive`].
//!
//! Exercises the rayon-parallel copy across real temp directories: nested
//! subfolders, file content equality, symlink preservation, idempotent re-run
//! (skip vs `force`), and the `root` ancestry guard.

use std::fs;
use std::path::Path;

use tempfile::TempDir;
use worktrunk_core::Progress;
use worktrunk_core::copy::{copy_dir_recursive, copy_leaf, ensure_path_within_root};

fn write(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, body).unwrap();
}

#[test]
fn copies_nested_tree_preserving_content() {
    let src = TempDir::new().unwrap();
    let dst = TempDir::new().unwrap();

    write(&src.path().join("README.md"), "hello");
    write(&src.path().join("src").join("lib.rs"), "fn main(){}");
    write(
        &src.path().join("src").join("inner").join("mod.rs"),
        "// inner",
    );

    let progress = Progress::counting();
    let (files, _bytes) =
        copy_dir_recursive(src.path(), &dst.path().join("out"), None, false, &progress).unwrap();
    assert_eq!(files, 3);

    assert_eq!(
        fs::read_to_string(dst.path().join("out").join("README.md")).unwrap(),
        "hello"
    );
    assert_eq!(
        fs::read_to_string(dst.path().join("out").join("src").join("lib.rs")).unwrap(),
        "fn main(){}"
    );
    assert_eq!(
        fs::read_to_string(
            dst.path()
                .join("out")
                .join("src")
                .join("inner")
                .join("mod.rs")
        )
        .unwrap(),
        "// inner"
    );

    let (snap_files, _) = progress.snapshot();
    assert_eq!(snap_files, 3);
}

#[test]
fn skips_existing_without_force() {
    let src = TempDir::new().unwrap();
    let dst = TempDir::new().unwrap();
    write(&src.path().join("a.txt"), "src-content");

    // Pre-create at destination.
    write(&dst.path().join("a.txt"), "preserved");

    let result = copy_leaf(
        &src.path().join("a.txt"),
        &dst.path().join("a.txt"),
        None,
        false,
    )
    .unwrap();
    assert!(
        result.is_none(),
        "should skip when dest exists & force=false"
    );

    assert_eq!(
        fs::read_to_string(dst.path().join("a.txt")).unwrap(),
        "preserved"
    );
}

#[test]
fn force_overwrites_existing() {
    let src = TempDir::new().unwrap();
    let dst = TempDir::new().unwrap();
    write(&src.path().join("a.txt"), "src-content");
    write(&dst.path().join("a.txt"), "old");

    let result = copy_leaf(
        &src.path().join("a.txt"),
        &dst.path().join("a.txt"),
        None,
        true,
    )
    .unwrap();
    assert_eq!(result, Some(11));

    assert_eq!(
        fs::read_to_string(dst.path().join("a.txt")).unwrap(),
        "src-content"
    );
}

#[test]
#[cfg(unix)]
fn preserves_symlinks() {
    let src = TempDir::new().unwrap();
    let dst = TempDir::new().unwrap();

    write(&src.path().join("real.txt"), "real");
    std::os::unix::fs::symlink("real.txt", src.path().join("link.txt")).unwrap();

    let progress = Progress::disabled();
    let (files, _) = copy_dir_recursive(src.path(), dst.path(), None, false, &progress).unwrap();
    assert_eq!(files, 2);

    let link_meta = dst.path().join("link.txt").symlink_metadata().unwrap();
    assert!(link_meta.file_type().is_symlink());
}

#[test]
fn ensure_path_within_root_rejects_escape() {
    let root = TempDir::new().unwrap();
    let inside = root.path().join("inside");
    fs::create_dir_all(&inside).unwrap();

    assert!(ensure_path_within_root(&inside, root.path()).is_ok());

    // A clearly external path must be rejected.
    let outside = Path::new("/tmp");
    let res = ensure_path_within_root(outside, root.path());
    // On systems where /tmp resolves under root.path() this could be Ok (unlikely)
    // — but the path here is clearly outside, so we expect Err.
    if outside.starts_with(root.path()) {
        // Defensive: accept ok if TempDir happens to live under /tmp.
    } else {
        assert!(res.is_err(), "expected refusal for path outside root");
    }
}

#[test]
fn empty_tree_returns_zero() {
    let src = TempDir::new().unwrap();
    let dst = TempDir::new().unwrap();

    let progress = Progress::disabled();
    let (files, bytes) =
        copy_dir_recursive(src.path(), &dst.path().join("out"), None, false, &progress).unwrap();
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
    assert!(dst.path().join("out").is_dir());
}

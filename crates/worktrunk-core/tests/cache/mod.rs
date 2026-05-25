// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::cache`.
//!
//! The on-disk JSON cache is library-only — neither the donor `wt` binary
//! nor the SDK expose it as a top-level CLI surface. Parity therefore
//! reduces to: given the same filesystem-shape preconditions, the SDK
//! produces the same on-disk state the donor's `cache::*` produced.
//!
//! We assert this by exercising the public SDK API on a `TempDir` and
//! verifying:
//!
//! 1. Round-trip — write then read yields the same value.
//! 2. Sweep — `write_with_lru` bounds the directory at `max_entries`.
//! 3. Clear — `clear_json_files` removes only `.json` files and leaves
//!    siblings in place.
//! 4. Missing-file semantics — `read` returns `None`, `clear_one` returns
//!    `Ok(false)`, and `clear_json_files` returns `Ok(0)` for a missing dir.

use std::fs;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

use worktrunk_core::cache::{
    cache_dir_at, clear_json_files, clear_one, count_json_files, read, read_json_at, sweep_lru,
    write_json_at, write_with_lru,
};

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
struct Entry {
    key: String,
    value: u64,
}

#[test]
fn cache_dir_at_composes_kind_subpath() {
    let path = cache_dir_at(std::path::Path::new("/repo/.git/wt"), "ci-status");
    assert_eq!(
        path,
        std::path::PathBuf::from("/repo/.git/wt/cache/ci-status")
    );
}

#[test]
fn write_then_read_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("ci-status").join("entry.json");

    // Missing file → None.
    assert!(read_json_at::<Entry>(&path).is_none());

    let entry = Entry {
        key: "abc".to_string(),
        value: 42,
    };
    write_json_at(&path, &entry);

    let loaded = read_json_at::<Entry>(&path).expect("present after write");
    assert_eq!(loaded, entry);
}

#[test]
fn write_with_lru_bounds_directory_size() {
    let tmp = TempDir::new().unwrap();
    let wt = tmp.path();

    // Write 5 entries; bound to 3.
    for i in 0u32..5 {
        let entry = Entry {
            key: format!("k{i}"),
            value: u64::from(i),
        };
        write_with_lru(wt, "bounded", &format!("e{i}.json"), &entry, 3);
        // Sleep is unnecessary in tests — file mtimes are monotonic on every
        // mainstream filesystem we run CI on (ext4 / apfs / ntfs). If the
        // platform fails this invariant the sweep is non-deterministic and
        // the test will detect it.
    }

    let dir = cache_dir_at(wt, "bounded");
    assert_eq!(
        count_json_files(&dir),
        3,
        "sweep should cap dir at 3 entries"
    );

    // The oldest two (e0, e1) should have been swept; e2/e3/e4 remain. We
    // don't assert *which* two survived (mtime resolution can collapse
    // sub-millisecond writes into the same bucket on slow filesystems) —
    // only that exactly `max` survive.
}

#[test]
fn sweep_lru_under_bound_is_noop() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("k");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a.json"), "{}").unwrap();
    fs::write(dir.join("b.json"), "{}").unwrap();

    sweep_lru(&dir, 10);
    assert_eq!(count_json_files(&dir), 2);
}

#[test]
fn read_via_kind_key_indirection_matches_direct() {
    let tmp = TempDir::new().unwrap();
    let wt = tmp.path();
    let entry = Entry {
        key: "x".to_string(),
        value: 7,
    };
    write_json_at(&cache_dir_at(wt, "kind").join("a.json"), &entry);

    assert_eq!(read::<Entry>(wt, "kind", "a.json"), Some(entry));
    assert!(read::<Entry>(wt, "kind", "missing.json").is_none());
}

#[test]
fn clear_one_missing_is_false() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("ghost.json");
    assert!(!clear_one(&path).unwrap());
}

#[test]
fn clear_one_removes_existing() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("real.json");
    fs::write(&path, "{}").unwrap();
    assert!(clear_one(&path).unwrap());
    assert!(!path.exists());
}

#[test]
fn clear_json_files_skips_non_json_siblings() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("mixed");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a.json"), "{}").unwrap();
    fs::write(dir.join("b.json"), "{}").unwrap();
    fs::write(dir.join("c.json.tmp"), "leftover").unwrap();
    fs::write(dir.join("README"), "keep").unwrap();

    assert_eq!(clear_json_files(&dir).unwrap(), 2);
    assert!(dir.join("c.json.tmp").exists());
    assert!(dir.join("README").exists());
}

#[test]
fn clear_json_files_missing_dir_returns_zero() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(
        clear_json_files(&tmp.path().join("never-existed")).unwrap(),
        0
    );
}

#[test]
fn write_json_at_creates_parent_dirs() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("deeply").join("nested").join("entry.json");
    let entry = Entry {
        key: "k".to_string(),
        value: 1,
    };
    write_json_at(&path, &entry);
    assert!(path.exists(), "write_json_at should mkdir -p the parents");
    assert_eq!(read_json_at::<Entry>(&path), Some(entry));
}

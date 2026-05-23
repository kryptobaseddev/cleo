// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Snapshot of git refs at a point in time.
//!
//! Vendored shape from `worktrunk::git::repository::ref_snapshot::RefSnapshot`
//! per T10219 (Saga T10176, Decision D010).
//!
//! The original `RefSnapshot` in worktrunk is a 1383-LOC module that combines
//! struct shape + cache-building logic + integration-reason analysis. This SDK
//! version vendors ONLY the public data shape that consumers (e.g.
//! `step/prune.rs`) borrow as `&RefSnapshot`. Building the snapshot and
//! computing integration reasons against it are deferred to `Repo` trait
//! methods so the implementation can live behind the substitute boundary.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Classification of a git reference inside a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RefKind {
    /// Local branch under `refs/heads/`.
    LocalBranch,
    /// Remote-tracking branch under `refs/remotes/<remote>/`.
    RemoteBranch,
    /// Tag under `refs/tags/`.
    Tag,
    /// Any other ref (notes, stash, etc.).
    Other,
}

/// A single ref record inside a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefEntry {
    /// Full ref name (e.g. `refs/heads/main`, `refs/remotes/origin/main`).
    pub name: String,
    /// OID the ref points at (40-char hex string).
    pub oid: String,
    /// Kind of ref.
    pub kind: RefKind,
    /// For remote-tracking refs, the remote name (e.g. `origin`); else `None`.
    pub remote: Option<String>,
}

/// Snapshot of all refs in a repository at the moment `capture_refs` ran.
///
/// Consumers borrow `&RefSnapshot` and pass it to
/// [`Repo::integration_reason`](super::repo::Repo::integration_reason) to ask
/// "given this snapshot, is branch X integrated into target Y?". The snapshot
/// itself exposes deterministic by-name lookup; richer cache-building lives in
/// the Repo trait impl.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RefSnapshot {
    entries: BTreeMap<String, RefEntry>,
}

impl RefSnapshot {
    /// Construct an empty snapshot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a snapshot from an iterator of [`RefEntry`].
    pub fn from_entries<I: IntoIterator<Item = RefEntry>>(it: I) -> Self {
        let mut entries = BTreeMap::new();
        for e in it {
            entries.insert(e.name.clone(), e);
        }
        Self { entries }
    }

    /// Number of refs in the snapshot.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the snapshot has no refs.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Look up a ref by its full name.
    pub fn get(&self, name: &str) -> Option<&RefEntry> {
        self.entries.get(name)
    }

    /// Iterate over all entries in deterministic name order.
    pub fn iter(&self) -> impl Iterator<Item = &RefEntry> {
        self.entries.values()
    }

    /// Iterate over entries of a particular kind.
    pub fn iter_kind(&self, kind: RefKind) -> impl Iterator<Item = &RefEntry> + '_ {
        self.entries.values().filter(move |e| e.kind == kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_round_trip() {
        let s = RefSnapshot::new();
        assert!(s.is_empty());
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn from_entries_deduplicates_by_name() {
        let s = RefSnapshot::from_entries([
            RefEntry {
                name: "refs/heads/main".into(),
                oid: "aaa".into(),
                kind: RefKind::LocalBranch,
                remote: None,
            },
            RefEntry {
                name: "refs/heads/main".into(),
                oid: "bbb".into(),
                kind: RefKind::LocalBranch,
                remote: None,
            },
        ]);
        assert_eq!(s.len(), 1);
        assert_eq!(s.get("refs/heads/main").unwrap().oid, "bbb");
    }

    #[test]
    fn iter_kind_filters_correctly() {
        let s = RefSnapshot::from_entries([
            RefEntry {
                name: "refs/heads/main".into(),
                oid: "aaa".into(),
                kind: RefKind::LocalBranch,
                remote: None,
            },
            RefEntry {
                name: "refs/remotes/origin/main".into(),
                oid: "ccc".into(),
                kind: RefKind::RemoteBranch,
                remote: Some("origin".into()),
            },
            RefEntry {
                name: "refs/tags/v1.0.0".into(),
                oid: "ddd".into(),
                kind: RefKind::Tag,
                remote: None,
            },
        ]);
        assert_eq!(s.iter_kind(RefKind::LocalBranch).count(), 1);
        assert_eq!(s.iter_kind(RefKind::RemoteBranch).count(), 1);
        assert_eq!(s.iter_kind(RefKind::Tag).count(), 1);
    }

    #[test]
    fn serde_round_trip() {
        let s = RefSnapshot::from_entries([RefEntry {
            name: "refs/heads/main".into(),
            oid: "abc".into(),
            kind: RefKind::LocalBranch,
            remote: None,
        }]);
        let j = serde_json::to_string(&s).unwrap();
        let back: RefSnapshot = serde_json::from_str(&j).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back.get("refs/heads/main").unwrap().oid, "abc");
    }
}

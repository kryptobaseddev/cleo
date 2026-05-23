// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Git-domain SDK types — substituted shapes for worktrunk's `git::*` surface.
//!
//! This module ships the typed surface T10220/T10221 consumers compile against:
//!
//! - [`BranchDeletionMode`] — pure-data vendor of worktrunk's deletion-mode enum.
//! - [`RefSnapshot`] / [`RefEntry`] / [`RefKind`] — pure-data shape of
//!   worktrunk's ref-snapshot type.
//! - [`Repo`] trait + [`ProcessRepo`] default impl — the substitute boundary
//!   for worktrunk's `Repository` god-object.
//!
//! See the [T10219 audit doc] for the operation-count rationale.
//!
//! [T10219 audit doc]: ../../../../docs/research/t10219-worktrunk-sdk-interface-audit.md

pub mod branch;
pub mod ref_snapshot;
pub mod repo;

pub use branch::BranchDeletionMode;
pub use ref_snapshot::{RefEntry, RefKind, RefSnapshot};
pub use repo::{BranchRef, ProcessRepo, RefType, RemovalPlan, Repo, unimplemented_in_sdk};

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity test suite for `worktrunk-core` SDK primitives (T10222 · SAGA T10176 · ADR-078).
//!
//! These tests verify that each pure-SDK primitive extracted from the donor
//! `worktrunk` CLI binary (T10220 step extraction · T10221 lifecycle extraction)
//! agrees with the original binary's observable behaviour on canonical
//! fixtures.
//!
//! # Test design
//!
//! Two layers of assertion run per primitive:
//!
//! 1. **SDK-only invariants** (always run): given a fixture, the SDK function
//!    produces the expected typed output. These tests are *not* gated on the
//!    `wt` binary — they protect the SDK from accidental regressions even
//!    when the donor binary isn't available.
//!
//! 2. **Binary parity** (`#[ignore]` by default — opt-in via `--ignored`):
//!    invoke the `wt` binary on the same fixture and compare its
//!    JSON-output (or filesystem state, for state-mutating primitives) to
//!    the SDK's. These tests are ignored when the binary is missing because
//!    CI does not yet build `/mnt/projects/worktrunk` upstream.
//!
//! # Running
//!
//! ```text
//! cargo test -p worktrunk-core --test parity                # SDK-only layer
//! cargo test -p worktrunk-core --test parity -- --ignored   # adds binary parity
//! ```
//!
//! To run the binary-parity layer locally, first build the donor:
//!
//! ```text
//! cd /mnt/projects/worktrunk && cargo build --release
//! export WORKTRUNK_WT_BIN=/mnt/projects/worktrunk/target/release/wt
//! cargo test -p worktrunk-core --test parity -- --ignored
//! ```
//!
//! Or set `WORKTRUNK_WT_BIN` to any compatible `wt` build.
//!
//! # Coverage
//!
//! - `prune` — integration-probe + candidate classification
//! - `promote` — `move_or_copy_entry` cross-device fallback fidelity
//! - `squash` — `classify_squash` decision table
//! - `copy_ignored` — `plan_copy_ignored` entry enumeration
//! - `relocate` — `expected_path_for` `SSoT` layout
//! - `cache` — JSON read/write/sweep mechanics
//! - `remove_dir` — recursive parallel removal
//! - `sync` — counting semaphore (no donor equivalent; smoke only)
//! - `diff` — `parse_numstat_line` + `parse_shortstat` against real git output

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod cache;
mod common;
mod copy_ignored;
mod diff;
mod promote;
mod prune;
mod relocate;
mod remove_dir;
mod squash;
mod sync;

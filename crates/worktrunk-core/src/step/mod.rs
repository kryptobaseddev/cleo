// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK primitives for `wt step <command>` operations.
//!
//! Per ADR-078 (boundary registry) and the T10219 audit, the
//! `worktrunk::commands::step::*` CLI handlers mix three concerns:
//!
//! 1. **CLI orchestration** — argument parsing, output formatting, pager
//!    routing, JSON envelope shaping. Lives in the CLI binary.
//! 2. **Interactive policy** — HITL approval prompts, hook plan
//!    confirmation, LLM-message review. Lives in the CLI binary.
//! 3. **Core algorithm** — git operations, filesystem moves, dependency
//!    graphs, candidate selection. Belongs in the SDK.
//!
//! This module extracts the third concern as pure functions. Every
//! function in [`copy_ignored`], [`promote`], [`squash`], [`prune`],
//! [`relocate`], and [`shared`] obeys the separation-of-concerns contract:
//!
//! - Inputs are typed values (paths, refs, configs, a `&dyn Repo`).
//! - Outputs are typed values (counts, plans, classified results).
//! - **NO** `println!` / `eprintln!` / styling / colour codes.
//! - **NO** hook firing, no approval prompts, no LLM calls.
//! - **NO** process working-directory mutations.
//!
//! CLI callers wrap these primitives with their own UI, hook plans, and
//! HITL gates.

pub mod copy_ignored;
pub mod promote;
pub mod prune;
pub mod relocate;
pub mod shared;
pub mod squash;

pub use copy_ignored::{CopyIgnoredOutcome, CopyIgnoredPlan, plan_copy_ignored, run_copy_ignored};
pub use promote::{
    PromoteOutcome, PromotePlan, distribute_staged_files, exchange_branches, move_or_copy_entry,
    plan_promote, stage_ignored_files,
};
pub use prune::{
    PruneCandidate, PruneCandidateKind, PrunePlan, build_prune_plan, integration_is_integrated,
};
pub use relocate::{
    RelocateCandidate, RelocateCycleBreak, RelocatePlan, build_relocation_plan, expected_path_for,
};
pub use shared::{
    BUILTIN_COPY_IGNORED_EXCLUDES, filter_ignored_entries, list_ignored_entries,
    list_and_filter_ignored_entries,
};
pub use squash::{SquashClassification, SquashInputs, classify_squash};

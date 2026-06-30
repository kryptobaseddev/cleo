// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Central per-class resource concurrency arbiter (T12001 · Epic T11992).
//!
//! The supervisor-side counterpart of the Node `ResourceGovernor`'s `local`-mode
//! slot directories. Where local mode arbitrates heavy-op concurrency through
//! cross-process lockfiles, the `supervisor` mode routes the same decision here
//! so a single in-memory counter is the machine-wide source of truth — builds,
//! tests and exodus can never co-schedule past their budget.
//!
//! ## Division of labour
//!
//! The **client** computes the per-class `budget` from its live memory-pressure
//! sample (the budget logic stays in one place — the already-tested Node
//! `computeClassBudget`). The **supervisor** enforces the in-flight COUNT
//! centrally: it admits while `in_flight < budget` and DEFERS otherwise with a
//! `retry_after_ms` back-off — never a silent drop, sharing the `queue_admit`
//! deferral contract. A held slot is returned by an explicit `release` (or
//! reclaimed when the holder process dies and the governor's stale-lock recovery
//! kicks in on the local fallback).
//!
//! In-flight holders are keyed by `(class → {holder_id})` as a set, so a
//! re-entrant admit of the same holder never double-counts and a release of an
//! unknown holder is an idempotent no-op.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Default back-off hint when a class is saturated, in milliseconds. Mirrors the
/// Node `DEFAULT_RESOURCE_RETRY_AFTER_MS` so both surfaces agree.
const DEFAULT_RETRY_AFTER_MS: u64 = 2_000;

/// The outcome of a [`ResourceArbiter::admit`] decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceAdmitOutcome {
    /// Admitted — run the heavy op now. `slots_remaining` = free slots left.
    Admitted {
        /// Free slots remaining for the class after this admit.
        slots_remaining: u32,
    },
    /// Deferred — the class is at capacity. Back off `retry_after_ms`, re-request.
    Deferred {
        /// Suggested back-off before re-requesting, in milliseconds.
        retry_after_ms: u64,
    },
}

/// Machine-wide per-class concurrency arbiter. Cheap to clone (`Arc` bump) — all
/// clones share the same contended counter, exactly like [`crate::llm_queue::LlmQueue`].
#[derive(Clone, Default)]
pub struct ResourceArbiter {
    in_flight: Arc<Mutex<HashMap<String, HashSet<String>>>>,
}

impl ResourceArbiter {
    /// Build an empty arbiter. Class entries are created lazily on first admit.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Admit (or defer) one slot of `class` for `holder_id` against `budget`.
    ///
    /// Admits while the class's in-flight holder count is below `budget`; a
    /// re-entrant admit of a holder already holding a slot is idempotent (it does
    /// not consume a second slot). When the class is saturated the request is
    /// DEFERRED with a `retry_after_ms` back-off.
    pub fn admit(&self, class: &str, holder_id: &str, budget: u32) -> ResourceAdmitOutcome {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let holders = guard.entry(class.to_string()).or_default();

        // Re-entrant admit: the holder already owns a slot — no double count.
        if holders.contains(holder_id) {
            let used = u32::try_from(holders.len()).unwrap_or(u32::MAX);
            return ResourceAdmitOutcome::Admitted {
                slots_remaining: budget.saturating_sub(used),
            };
        }

        let used = u32::try_from(holders.len()).unwrap_or(u32::MAX);
        if used < budget {
            holders.insert(holder_id.to_string());
            return ResourceAdmitOutcome::Admitted {
                slots_remaining: budget.saturating_sub(used + 1),
            };
        }

        ResourceAdmitOutcome::Deferred {
            retry_after_ms: DEFAULT_RETRY_AFTER_MS,
        }
    }

    /// Release a previously-admitted slot. Returns `(released, in_flight_remaining)`
    /// where `released` is whether a held slot was actually removed (false for an
    /// unknown holder) and `in_flight_remaining` is the class's holder count after.
    pub fn release(&self, class: &str, holder_id: &str) -> (bool, u32) {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let Some(holders) = guard.get_mut(class) else {
            return (false, 0);
        };
        let released = holders.remove(holder_id);
        let remaining = u32::try_from(holders.len()).unwrap_or(u32::MAX);
        if holders.is_empty() {
            guard.remove(class);
        }
        (released, remaining)
    }

    /// Current in-flight holder count for `class` (introspection / tests).
    #[must_use]
    pub fn in_flight(&self, class: &str) -> u32 {
        let guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .get(class)
            .map_or(0, |h| u32::try_from(h.len()).unwrap_or(u32::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_up_to_budget_then_defers() {
        let arb = ResourceArbiter::new();
        assert_eq!(
            arb.admit("db-heavy", "a", 1),
            ResourceAdmitOutcome::Admitted { slots_remaining: 0 }
        );
        // Class is now full (budget 1) — a different holder defers.
        assert_eq!(
            arb.admit("db-heavy", "b", 1),
            ResourceAdmitOutcome::Deferred {
                retry_after_ms: DEFAULT_RETRY_AFTER_MS
            }
        );
    }

    #[test]
    fn reentrant_admit_does_not_double_count() {
        let arb = ResourceArbiter::new();
        arb.admit("test-run", "a", 2);
        arb.admit("test-run", "a", 2); // same holder again
        assert_eq!(arb.in_flight("test-run"), 1);
        // A second distinct holder still fits within budget 2.
        assert!(matches!(
            arb.admit("test-run", "b", 2),
            ResourceAdmitOutcome::Admitted { .. }
        ));
    }

    #[test]
    fn release_frees_a_slot_and_is_idempotent() {
        let arb = ResourceArbiter::new();
        arb.admit("full-build", "a", 1);
        assert_eq!(arb.release("full-build", "a"), (true, 0));
        // Releasing again is a no-op (unknown holder).
        assert_eq!(arb.release("full-build", "a"), (false, 0));
        // The slot is free again.
        assert!(matches!(
            arb.admit("full-build", "b", 1),
            ResourceAdmitOutcome::Admitted { .. }
        ));
    }
}

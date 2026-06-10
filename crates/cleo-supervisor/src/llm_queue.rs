// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! In-process LLM-queue priority scheduler + per-provider rate governor — the
//! contended counters that live in the Rust arbiter (T11630 · AC3).
//!
//! ## What lands here
//!
//! [`LlmQueue`] is the supervisor-side admission controller for outbound LLM
//! calls. Unlike [`crate::lease_handler::LeaseArbiter`] (which arbitrates a
//! PERSISTED `cleo.db` row under `BEGIN IMMEDIATE`), the LLM queue is a CHEAP,
//! in-memory contended counter: there is no durable state to persist (an LLM
//! rate budget is wall-clock-relative and resets on restart), so a single
//! `std::sync::Mutex` over the whole admit decision is both correct and faster
//! than a `SQLite` txn. The admit decision is ONE atomic read-modify-write under
//! that mutex — queue position AND provider budget are decided together, never
//! as two independent bare atomics that could interleave (AC2/AC3).
//!
//! ## The two coupled invariants
//!
//!   * **Priority (AC1)** — concurrent admits are ordered by priority class
//!     (`lead(0) > worker(1) > background(2)`), tie-broken by a monotonic ticket
//!     (FIFO within a class). A lead agent is never starved behind a background
//!     consolidation: the moment a budget token frees, the highest-priority
//!     waiter is the one admitted. This mirrors the `(priority ASC, ticket ASC)`
//!     grant order [`crate::lease_handler::LeaseArbiter::enqueue_waiter`] uses.
//!   * **Rate (AC2)** — each provider carries a [`RateBucket`] token-bucket
//!     (`tokens_remaining` / `req_remaining` / refill window). An admit DEBITS
//!     both the estimated token cost and one request slot; an over-budget admit
//!     is DEFERRED with a `retry_after_ms` back-off (AC4 — never a silent drop).
//!
//! ## Externally-readable in-flight state (watchdog seam — T11628)
//!
//! On a successful admit the queue records `(child_id → in_flight)`. The
//! watchdog (T11628) reads [`LlmQueue::has_in_flight_call`] to detect a child
//! that admitted an LLM call but never released (stuck request). The state is
//! cleared on [`LlmQueue::release`] (normal completion) OR swept by
//! [`LlmQueue::sweep_expired`] / the per-admit TTL (a child that died mid-call).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// The priority class of an LLM admission request. Lower numeric value = higher
/// priority (admitted sooner). Mirrors the advisory-priority ordering the
/// writer-lease queue uses (`0` = highest).
///
/// `[serde(rename_all = "snake_case")]` so the wire string matches the TS
/// contract (`"lead" | "worker" | "background"`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum PriorityClass {
    /// A lead/orchestrator agent — highest priority, never starved (AC1).
    Lead,
    /// A worker agent — normal priority.
    Worker,
    /// Background consolidation / dreaming — lowest priority, yields to all.
    Background,
}

impl PriorityClass {
    /// The numeric rank used to order admits (`0` = highest priority). Lower
    /// admits sooner; the [`BTreeMap`] key orders on this then the ticket.
    #[must_use]
    pub fn rank(self) -> u8 {
        match self {
            PriorityClass::Lead => 0,
            PriorityClass::Worker => 1,
            PriorityClass::Background => 2,
        }
    }
}

/// Default per-provider per-window token budget when a provider has no explicit
/// bucket configured yet.
///
/// Generous enough that the common single-agent case is never throttled, while
/// still bounding a runaway fan-out.
pub const DEFAULT_TOKENS_PER_WINDOW: u64 = 2_000_000;

/// Default per-provider per-window request budget.
pub const DEFAULT_REQUESTS_PER_WINDOW: u32 = 5_000;

/// Default rate-bucket window length (ms). One minute is the granularity most
/// provider rate limits (RPM / TPM) are quoted in.
pub const DEFAULT_WINDOW_MS: u64 = 60_000;

/// Default in-flight TTL (ms): a child that admits a call but never releases
/// within this window is swept so its budget debit is not leaked forever. Sized
/// well above a normal completion latency.
pub const DEFAULT_INFLIGHT_TTL_MS: u64 = 600_000;

/// Current wall-clock in epoch milliseconds (matches Node's `Date.now()`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// A per-provider token-bucket rate governor (AC2).
///
/// Tracks the remaining token + request budget within the current refill window.
/// The bucket refills (resets to full) when the wall-clock crosses the window
/// boundary — a simple fixed-window counter, which is sufficient because the
/// goal is to keep concurrent workers UNDER a provider quota, not to smooth a
/// single client's request shape.
#[derive(Debug, Clone)]
pub struct RateBucket {
    /// Tokens remaining in the current window.
    pub tokens_remaining: u64,
    /// Requests remaining in the current window.
    pub req_remaining: u32,
    /// Epoch-ms timestamp the current window started at.
    pub window_start_ms: u64,
    /// The full token budget granted at each window refill.
    pub tokens_per_window: u64,
    /// The full request budget granted at each window refill.
    pub requests_per_window: u32,
    /// The window length in ms.
    pub window_ms: u64,
}

impl RateBucket {
    /// Build a bucket at full budget for the current window.
    #[must_use]
    pub fn new(tokens_per_window: u64, requests_per_window: u32, window_ms: u64, now: u64) -> Self {
        Self {
            tokens_remaining: tokens_per_window,
            req_remaining: requests_per_window,
            window_start_ms: now,
            tokens_per_window,
            requests_per_window,
            window_ms,
        }
    }

    /// A bucket with the crate defaults.
    #[must_use]
    pub fn with_defaults(now: u64) -> Self {
        Self::new(
            DEFAULT_TOKENS_PER_WINDOW,
            DEFAULT_REQUESTS_PER_WINDOW,
            DEFAULT_WINDOW_MS,
            now,
        )
    }

    /// Refill the bucket to full IFF the current window has elapsed. Idempotent
    /// within a window — the fixed-window counter resets exactly once per
    /// boundary crossing.
    fn refill_if_elapsed(&mut self, now: u64) {
        if now.saturating_sub(self.window_start_ms) >= self.window_ms {
            self.tokens_remaining = self.tokens_per_window;
            self.req_remaining = self.requests_per_window;
            self.window_start_ms = now;
        }
    }

    /// Milliseconds until the current window refills (the back-off a deferred
    /// caller should wait before re-requesting). At least 1ms so a caller always
    /// makes forward progress.
    fn retry_after_ms(&self, now: u64) -> u64 {
        let elapsed = now.saturating_sub(self.window_start_ms);
        self.window_ms.saturating_sub(elapsed).max(1)
    }

    /// Whether this bucket can currently admit `est_tokens` + one request.
    fn can_admit(&self, est_tokens: u64) -> bool {
        self.tokens_remaining >= est_tokens && self.req_remaining >= 1
    }

    /// Debit `est_tokens` + one request slot. Caller MUST have checked
    /// [`Self::can_admit`] first under the same lock.
    fn debit(&mut self, est_tokens: u64) {
        self.tokens_remaining = self.tokens_remaining.saturating_sub(est_tokens);
        self.req_remaining = self.req_remaining.saturating_sub(1);
    }
}

/// The decision returned by [`LlmQueue::admit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmitDecision {
    /// The call is admitted — execute it now.
    Admitted {
        /// Remaining token budget for the provider AFTER this admit's debit.
        tokens_remaining: u64,
    },
    /// The call is deferred — the caller MUST wait `retry_after_ms` and
    /// re-request (AC4 — never a silent drop).
    Deferred {
        /// Back-off in ms before the caller should re-request.
        retry_after_ms: u64,
        /// Remaining token budget for the provider (informational).
        tokens_remaining: u64,
        /// Number of higher/equal-priority waiters ahead of this request.
        queue_position: u32,
    },
}

/// A single in-flight admitted call's bookkeeping (watchdog seam — T11628).
#[derive(Debug, Clone)]
struct InFlightCall {
    /// The provider the call debited (so [`LlmQueue::release`] can refund a
    /// request slot if desired and the sweep can attribute the leak).
    provider: String,
    /// Epoch-ms the call was admitted at (TTL sweep reference).
    admitted_at_ms: u64,
    /// The TTL after which an unreleased call is swept.
    ttl_ms: u64,
}

/// A queued (deferred) waiter, ordered by `(priority rank, ticket)`.
#[derive(Debug, Clone)]
struct Waiter {
    /// The provider the waiter targets.
    provider: String,
    /// The estimated token cost of the waiting request.
    est_tokens: u64,
    /// The child that is waiting (for observability / sweep).
    child_id: String,
}

/// The mutable state guarded by the [`LlmQueue`] mutex. ALL admit/release logic
/// runs as a single atomic read-modify-write over this struct.
#[derive(Debug, Default)]
struct LlmQueueState {
    /// Per-provider rate buckets, lazily created at full budget on first use.
    buckets: HashMap<String, RateBucket>,
    /// The priority-ordered waiter set, keyed `(priority rank, monotonic ticket)`
    /// so iteration is ascending priority then FIFO — the exact grant order.
    waiters: BTreeMap<(u8, u64), Waiter>,
    /// In-flight admitted calls keyed by child id (watchdog-readable — T11628).
    in_flight: HashMap<String, InFlightCall>,
    /// Monotonic ticket counter for FIFO tie-break within a priority class.
    next_ticket: u64,
}

/// The supervisor-side LLM-queue priority scheduler + per-provider rate governor.
///
/// `Clone` (cheap `Arc` bump) so the accept-loop dispatcher can hold one shared
/// instance across all connected clients — the contended counters are PROCESS-
/// global, exactly like a real provider quota (AC2/AC3).
#[derive(Clone, Default)]
pub struct LlmQueue {
    state: Arc<Mutex<LlmQueueState>>,
}

impl LlmQueue {
    /// Build an empty queue. Provider buckets are created lazily at full default
    /// budget on first admit.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Configure (or reconfigure) a provider's rate bucket. Resets the bucket to
    /// full for the current window. Used by the supervisor to seed a provider's
    /// real quota; absent a call, the provider gets [`DEFAULT_TOKENS_PER_WINDOW`]
    /// / [`DEFAULT_REQUESTS_PER_WINDOW`] on first admit.
    pub fn configure_provider(
        &self,
        provider: &str,
        tokens_per_window: u64,
        requests_per_window: u32,
        window_ms: u64,
    ) {
        let now = now_ms();
        let mut state = self.lock();
        state.buckets.insert(
            provider.to_string(),
            RateBucket::new(tokens_per_window, requests_per_window, window_ms, now),
        );
    }

    /// The single atomic admit decision (AC1+AC2+AC3+AC4).
    ///
    /// Under ONE mutex acquisition this:
    ///   1. refills the provider bucket if its window elapsed,
    ///   2. checks whether a HIGHER-priority waiter is already queued for the
    ///      SAME provider — if so, this request must not jump it (AC1 fairness),
    ///   3. checks the provider budget can cover `est_tokens` + one request,
    ///   4. on success: debits the bucket, records the in-flight call, removes
    ///      any prior waiter row for this child, and returns `Admitted`,
    ///   5. on failure: enqueues (idempotently) a priority-ordered waiter and
    ///      returns `Deferred { retry_after_ms, queue_position }` — NEVER a
    ///      silent drop (AC4).
    ///
    /// `est_tokens` is the caller's estimate of the request's token cost; an
    /// estimate of `0` still consumes one request slot.
    #[must_use]
    pub fn admit(
        &self,
        provider: &str,
        priority: PriorityClass,
        est_tokens: u64,
        child_id: &str,
    ) -> AdmitDecision {
        self.admit_with_ttl(
            provider,
            priority,
            est_tokens,
            child_id,
            DEFAULT_INFLIGHT_TTL_MS,
        )
    }

    /// [`Self::admit`] with an explicit in-flight TTL (test seam + watchdog tuning).
    #[must_use]
    pub fn admit_with_ttl(
        &self,
        provider: &str,
        priority: PriorityClass,
        est_tokens: u64,
        child_id: &str,
        ttl_ms: u64,
    ) -> AdmitDecision {
        let now = now_ms();
        let mut state = self.lock();

        // (1) Refill the bucket if its window elapsed, then read its budget.
        let bucket = state
            .buckets
            .entry(provider.to_string())
            .or_insert_with(|| RateBucket::with_defaults(now));
        bucket.refill_if_elapsed(now);
        let can_budget = bucket.can_admit(est_tokens);
        let tokens_remaining = bucket.tokens_remaining;
        let retry_after = bucket.retry_after_ms(now);

        // (2) Fairness: count strictly-higher-or-equal-priority waiters AHEAD of
        // this request for the SAME provider. A lower-priority request must not
        // overtake a queued higher-priority one even when budget is available —
        // that is exactly the starvation AC1 forbids. A request at the SAME
        // priority that is already at the head (ahead == 0) may proceed.
        let my_rank = priority.rank();
        let ahead = Self::count_ahead(&state.waiters, provider, my_rank);

        // (3) Admit IFF the budget covers it AND no higher/equal-priority waiter
        // is ahead of us.
        if can_budget && ahead == 0 {
            // Debit under the SAME lock — queue position + budget decided together.
            if let Some(b) = state.buckets.get_mut(provider) {
                b.debit(est_tokens);
            }
            let tokens_after = state
                .buckets
                .get(provider)
                .map_or(tokens_remaining, |b| b.tokens_remaining);
            // Clear any stale waiter row for this child (it just got admitted).
            Self::remove_waiter_for_child(&mut state.waiters, child_id);
            state.in_flight.insert(
                child_id.to_string(),
                InFlightCall {
                    provider: provider.to_string(),
                    admitted_at_ms: now,
                    ttl_ms,
                },
            );
            return AdmitDecision::Admitted {
                tokens_remaining: tokens_after,
            };
        }

        // (5) Deferred — enqueue an idempotent priority-ordered waiter (so the
        // governor can report an accurate queue_position + so AC1 fairness sees
        // it) and return a structured back-off. NEVER a silent drop (AC4).
        let queue_position =
            Self::enqueue_waiter(&mut state, provider, priority, est_tokens, child_id);
        AdmitDecision::Deferred {
            retry_after_ms: retry_after,
            tokens_remaining,
            queue_position,
        }
    }

    /// Release an in-flight call on normal completion (clears the watchdog
    /// in-flight bit). Idempotent — a second release for the same child no-ops.
    /// Does NOT refund the rate debit (the token cost was real); it only frees
    /// the in-flight tracking so the watchdog stops watching a completed call.
    pub fn release(&self, child_id: &str) {
        let mut state = self.lock();
        state.in_flight.remove(child_id);
        Self::remove_waiter_for_child(&mut state.waiters, child_id);
    }

    /// Whether `child_id` currently has an admitted-but-unreleased LLM call
    /// (watchdog read surface — T11628). Expired entries (past their TTL) are
    /// treated as NOT in-flight so a dead child does not look stuck forever.
    #[must_use]
    pub fn has_in_flight_call(&self, child_id: &str) -> bool {
        let now = now_ms();
        let state = self.lock();
        state
            .in_flight
            .get(child_id)
            .is_some_and(|c| now.saturating_sub(c.admitted_at_ms) <= c.ttl_ms)
    }

    /// Number of currently-tracked in-flight calls (observability).
    #[must_use]
    pub fn in_flight_count(&self) -> usize {
        self.lock().in_flight.len()
    }

    /// Number of queued (deferred) waiters (observability).
    #[must_use]
    pub fn waiter_count(&self) -> usize {
        self.lock().waiters.len()
    }

    /// Sweep in-flight calls whose TTL has elapsed (a child that admitted a call
    /// but died before releasing). Returns the swept `(child_id, provider)` pairs
    /// so the caller can log / emit an event and attribute the leak to a
    /// provider. The watchdog (T11628) drives this on its tick.
    pub fn sweep_expired(&self) -> Vec<(String, String)> {
        let now = now_ms();
        let mut state = self.lock();
        let expired: Vec<(String, String)> = state
            .in_flight
            .iter()
            .filter(|(_, c)| now.saturating_sub(c.admitted_at_ms) > c.ttl_ms)
            .map(|(id, c)| (id.clone(), c.provider.clone()))
            .collect();
        for (id, _) in &expired {
            state.in_flight.remove(id);
        }
        expired
    }

    /// The total estimated token demand of all currently-queued (deferred)
    /// waiters for `provider` — how much budget the backlog wants. Observability
    /// surface for the watchdog / a future autoscaler.
    #[must_use]
    pub fn queued_token_demand(&self, provider: &str) -> u64 {
        let state = self.lock();
        state
            .waiters
            .values()
            .filter(|w| w.provider == provider)
            .fold(0u64, |acc, w| acc.saturating_add(w.est_tokens))
    }

    // ── internals ──────────────────────────────────────────────────────────

    /// Lock the state, recovering a poisoned mutex (a panic while admitting must
    /// not wedge the whole governor — the in-memory state is reconstructible).
    fn lock(&self) -> std::sync::MutexGuard<'_, LlmQueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Count waiters for `provider` whose priority rank is strictly higher
    /// (lower numeric) than `my_rank` — they MUST be served first (AC1). A
    /// same-rank waiter does not block (FIFO within a class is handled by the
    /// ticket order once budget frees).
    fn count_ahead(waiters: &BTreeMap<(u8, u64), Waiter>, provider: &str, my_rank: u8) -> u32 {
        let n = waiters
            .iter()
            .filter(|((rank, _), w)| *rank < my_rank && w.provider == provider)
            .count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    /// Enqueue (idempotently per child) a priority-ordered waiter and return the
    /// caller's queue position (number of waiters ahead by grant order:
    /// strictly-higher priority, OR same priority with a lower ticket).
    fn enqueue_waiter(
        state: &mut LlmQueueState,
        provider: &str,
        priority: PriorityClass,
        est_tokens: u64,
        child_id: &str,
    ) -> u32 {
        let rank = priority.rank();
        // Idempotent: if this child already has a waiter row, reuse its ticket so
        // repeated deferrals do not keep pushing it to the back of its class.
        let existing_ticket = state
            .waiters
            .iter()
            .find(|(_, w)| w.child_id == child_id)
            .map(|((_, ticket), _)| *ticket);
        let ticket = match existing_ticket {
            Some(t) => t,
            None => {
                let t = state.next_ticket;
                state.next_ticket = state.next_ticket.saturating_add(1);
                state.waiters.insert(
                    (rank, t),
                    Waiter {
                        provider: provider.to_string(),
                        est_tokens,
                        child_id: child_id.to_string(),
                    },
                );
                t
            }
        };
        // Position = waiters ahead of (rank, ticket) for this provider by grant
        // order: a strictly-higher class, or the same class with a lower ticket.
        let ahead = state
            .waiters
            .iter()
            .filter(|((r, tk), w)| {
                w.provider == provider && (*r < rank || (*r == rank && *tk < ticket))
            })
            .count();
        u32::try_from(ahead).unwrap_or(u32::MAX)
    }

    /// Remove any waiter row owned by `child_id` (on admit or release).
    fn remove_waiter_for_child(waiters: &mut BTreeMap<(u8, u64), Waiter>, child_id: &str) {
        let key = waiters
            .iter()
            .find(|(_, w)| w.child_id == child_id)
            .map(|(k, _)| *k);
        if let Some(k) = key {
            waiters.remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC2: a provider whose token budget is exhausted defers the next admit with
    /// a `retry_after_ms` back-off — never a silent drop (AC4).
    #[test]
    fn token_bucket_exhaustion_defers_with_retry_after() {
        let q = LlmQueue::new();
        // Tiny budget: 100 tokens / 10 requests in a 60s window.
        q.configure_provider("anthropic", 100, 10, 60_000);

        // First admit (80 tokens) fits.
        match q.admit("anthropic", PriorityClass::Worker, 80, "w1") {
            AdmitDecision::Admitted { tokens_remaining } => assert_eq!(tokens_remaining, 20),
            other => panic!("expected Admitted, got {other:?}"),
        }
        q.release("w1");

        // Second admit (50 tokens) exceeds the remaining 20 → Deferred.
        match q.admit("anthropic", PriorityClass::Worker, 50, "w2") {
            AdmitDecision::Deferred {
                retry_after_ms,
                tokens_remaining,
                ..
            } => {
                assert!(
                    retry_after_ms >= 1,
                    "a deferral must carry a positive back-off"
                );
                assert_eq!(tokens_remaining, 20, "budget unchanged on a deferral");
            }
            other => panic!("expected Deferred, got {other:?}"),
        }
    }

    /// AC2: the request-count budget is enforced independently of the token
    /// budget — exhausting `req_remaining` defers even with tokens to spare.
    #[test]
    fn request_budget_exhaustion_defers() {
        let q = LlmQueue::new();
        // Plenty of tokens, but only ONE request per window.
        q.configure_provider("openai", 1_000_000, 1, 60_000);
        assert!(matches!(
            q.admit("openai", PriorityClass::Worker, 10, "w1"),
            AdmitDecision::Admitted { .. }
        ));
        q.release("w1");
        // Second request: tokens fine, but the single request slot is spent.
        match q.admit("openai", PriorityClass::Worker, 10, "w2") {
            AdmitDecision::Deferred { .. } => {}
            other => panic!("expected Deferred on request-budget exhaustion, got {other:?}"),
        }
    }

    /// AC1: a lead agent is admitted ahead of a queued background request — the
    /// background request that was deferred (budget exhausted) does NOT block a
    /// lead once budget frees; the lead preempts.
    #[test]
    fn lead_preempts_a_queued_background_request() {
        let q = LlmQueue::new();
        // Budget for exactly ONE in-flight call's worth of tokens at a time.
        q.configure_provider("anthropic", 100, 10, 60_000);

        // A background request takes the budget.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Background, 100, "bg1"),
            AdmitDecision::Admitted { .. }
        ));
        // A SECOND background request is deferred (budget exhausted) and queued.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Background, 100, "bg2"),
            AdmitDecision::Deferred { .. }
        ));
        // The first background releases AND we cross a window so budget refills.
        q.release("bg1");
        q.configure_provider("anthropic", 100, 10, 60_000); // refill

        // Now a LEAD requests. It must be admitted immediately even though bg2 is
        // queued ahead in arrival order — lead outranks background (AC1).
        match q.admit("anthropic", PriorityClass::Lead, 100, "lead1") {
            AdmitDecision::Admitted { .. } => {}
            other => panic!("lead must preempt a queued background request, got {other:?}"),
        }
    }

    /// AC1: a worker does NOT overtake an already-queued lead for the same
    /// provider — the higher-priority waiter is served first when budget frees.
    #[test]
    fn worker_does_not_overtake_a_queued_lead() {
        let q = LlmQueue::new();
        q.configure_provider("anthropic", 100, 10, 60_000);

        // Background fills the budget.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Background, 100, "bg1"),
            AdmitDecision::Admitted { .. }
        ));
        // A lead is deferred (budget gone) and queued.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Lead, 50, "lead1"),
            AdmitDecision::Deferred { .. }
        ));
        // Refill the budget so a fresh admit could in principle succeed.
        q.release("bg1");
        q.configure_provider("anthropic", 100, 10, 60_000);

        // A WORKER now requests. A lead is queued ahead of it, so the worker must
        // be DEFERRED (it cannot jump the queued lead) — AC1 anti-starvation.
        match q.admit("anthropic", PriorityClass::Worker, 50, "w1") {
            AdmitDecision::Deferred { queue_position, .. } => {
                assert!(
                    queue_position >= 1,
                    "the worker sits behind the queued lead"
                );
            }
            other => panic!("worker must not overtake a queued lead, got {other:?}"),
        }
    }

    /// AC3/T11628: a successful admit records an externally-readable in-flight
    /// bit; release clears it.
    #[test]
    fn in_flight_tracking_set_on_admit_cleared_on_release() {
        let q = LlmQueue::new();
        q.configure_provider("anthropic", 1_000_000, 100, 60_000);
        assert!(!q.has_in_flight_call("w1"), "no call before admit");

        assert!(matches!(
            q.admit("anthropic", PriorityClass::Worker, 100, "w1"),
            AdmitDecision::Admitted { .. }
        ));
        assert!(
            q.has_in_flight_call("w1"),
            "in-flight after admit (watchdog seam)"
        );
        assert_eq!(q.in_flight_count(), 1);

        q.release("w1");
        assert!(!q.has_in_flight_call("w1"), "cleared on release");
        assert_eq!(q.in_flight_count(), 0);
    }

    /// AC4: the in-flight TTL sweep clears a leaked call (child died mid-request)
    /// so a budget debit + watchdog bit is not pinned forever.
    #[test]
    fn expired_in_flight_call_is_swept() {
        let q = LlmQueue::new();
        q.configure_provider("anthropic", 1_000_000, 100, 60_000);
        // Admit with a 1ms TTL so a tiny sleep pushes it strictly past expiry.
        assert!(matches!(
            q.admit_with_ttl("anthropic", PriorityClass::Worker, 100, "w1", 1),
            AdmitDecision::Admitted { .. }
        ));
        // At the admit instant the call is still in-flight (within its TTL).
        assert!(
            q.has_in_flight_call("w1"),
            "in-flight immediately after admit"
        );
        // Let the TTL strictly elapse.
        std::thread::sleep(std::time::Duration::from_millis(3));
        // has_in_flight_call treats an elapsed entry as not-in-flight.
        assert!(!q.has_in_flight_call("w1"), "expired call is not in-flight");
        let swept = q.sweep_expired();
        assert_eq!(swept, vec![("w1".to_string(), "anthropic".to_string())]);
        assert_eq!(q.in_flight_count(), 0, "swept entry removed");
    }

    /// `queued_token_demand` sums the estimated token cost of all deferred
    /// waiters for a provider (the backlog's budget demand).
    #[test]
    fn queued_token_demand_sums_deferred_waiters() {
        let q = LlmQueue::new();
        q.configure_provider("anthropic", 100, 10, 60_000);
        // Exhaust the budget so subsequent admits defer + queue.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Background, 100, "bg"),
            AdmitDecision::Admitted { .. }
        ));
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Worker, 30, "w1"),
            AdmitDecision::Deferred { .. }
        ));
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Worker, 70, "w2"),
            AdmitDecision::Deferred { .. }
        ));
        assert_eq!(
            q.queued_token_demand("anthropic"),
            100,
            "30 + 70 queued tokens"
        );
        assert_eq!(
            q.queued_token_demand("openai"),
            0,
            "no waiters for another provider"
        );
    }

    /// A fresh provider with no explicit configuration admits under the generous
    /// crate-default budget (the common single-agent case is never throttled).
    #[test]
    fn unconfigured_provider_uses_default_budget() {
        let q = LlmQueue::new();
        match q.admit("brand-new-provider", PriorityClass::Lead, 1_000, "w1") {
            AdmitDecision::Admitted { tokens_remaining } => {
                assert_eq!(tokens_remaining, DEFAULT_TOKENS_PER_WINDOW - 1_000);
            }
            other => panic!("expected Admitted under default budget, got {other:?}"),
        }
    }

    /// Idempotent deferral: re-requesting after a defer keeps the same queue
    /// ticket rather than pushing the child to the back of its class.
    #[test]
    fn repeated_deferral_is_idempotent_per_child() {
        let q = LlmQueue::new();
        q.configure_provider("anthropic", 100, 10, 60_000);
        // Exhaust budget.
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Worker, 100, "bg"),
            AdmitDecision::Admitted { .. }
        ));
        // Two workers defer; each keeps its own ticket across repeated requests.
        let first = q.admit("anthropic", PriorityClass::Worker, 50, "w1");
        let again = q.admit("anthropic", PriorityClass::Worker, 50, "w1");
        match (first, again) {
            (
                AdmitDecision::Deferred {
                    queue_position: p1, ..
                },
                AdmitDecision::Deferred {
                    queue_position: p2, ..
                },
            ) => assert_eq!(
                p1, p2,
                "same child keeps its queue position across re-requests"
            ),
            other => panic!("expected two deferrals, got {other:?}"),
        }
        assert_eq!(q.waiter_count(), 1, "one waiter row per child (idempotent)");
    }

    /// A window refill restores the budget so a previously-deferred provider
    /// admits again (the fixed-window counter resets at the boundary).
    #[test]
    fn window_refill_restores_budget() {
        let q = LlmQueue::new();
        // 1ms window so the next admit after a tiny sleep crosses the boundary.
        q.configure_provider("anthropic", 100, 10, 1);
        assert!(matches!(
            q.admit("anthropic", PriorityClass::Worker, 100, "w1"),
            AdmitDecision::Admitted { .. }
        ));
        q.release("w1");
        std::thread::sleep(std::time::Duration::from_millis(3));
        // The window elapsed → refill → admit succeeds again.
        match q.admit("anthropic", PriorityClass::Worker, 100, "w2") {
            AdmitDecision::Admitted { .. } => {}
            other => panic!("expected Admitted after window refill, got {other:?}"),
        }
    }
}

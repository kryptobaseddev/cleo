// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Heartbeat-deadline watchdog: kill a rogue/stuck worker that stops
//! heartbeating, with a deadline TIERED by the LLM-queue's knowledge of an
//! in-flight LLM call (T11628 · AC1/AC2).
//!
//! ## What lands here
//!
//! [`Watchdog`] is a generalization of [`crate::lease_handler::LeaseArbiter::reclaim_or_kill`]:
//! the same two-phase sweep (snapshot candidates under the lock → act WITHOUT
//! holding the lock), but keyed on a heartbeat clock instead of a persisted
//! lease TTL. Each managed worker MUST touch a heartbeat over the v1.1 lease IPC
//! (`worker_heartbeat`) within a deadline; on a miss the supervisor runs the
//! canonical SIGTERM→grace→SIGKILL cascade against that ONE child's pid
//! ([`crate::process`]) and emits a `child_killed_unresponsive` event (AC1).
//!
//! ## Tiered deadline (AC2 · RISK-7)
//!
//! A healthy agent can legitimately go quiet for minutes while it waits on a
//! single slow LLM completion. Killing it at the NORMAL deadline would be a
//! false positive. So the watchdog tiers the deadline per child on every sweep:
//!
//! ```text
//! deadline = if in_flight_llm(child) { EXTENDED } else { NORMAL }
//! ```
//!
//! `in_flight_llm(child)` is the OR of two sources, so neither path can be
//! bypassed:
//!   1. [`crate::llm_queue::LlmQueue::has_in_flight_call`] — the supervisor's own
//!      admission ledger (a call that went through the `queue_admit` seam).
//!   2. the worker's self-reported `in_flight_llm` flag on its last heartbeat —
//!      for a caller that talks to a provider WITHOUT going through the queue.
//!
//! ## Kill isolation (AC2)
//!
//! The sweep acts per-child: one unresponsive worker's SIGTERM/SIGKILL targets
//! ONLY its pid. A sibling worker and the supervisor process itself are never
//! touched — the kill path is `process::request_terminate(pid)` /
//! `process::force_kill(pid)` against a single resolved pid, never a process
//! group or `-1`. A child whose `generation` (incarnation token) changed between
//! the candidate snapshot and the kill is skipped, so a freshly-restarted child
//! is never clobbered by a stale deadline (T11626 incarnation guard).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;

use crate::lease_ipc::ChildKilled;
use crate::llm_queue::LlmQueue;
use crate::supervisor::ChildRegistry;

/// Default NORMAL heartbeat deadline.
///
/// A worker that is NOT inside an LLM call MUST heartbeat at least this often or
/// it is considered stuck. Sized well above a sane heartbeat interval (the
/// worker should beat every ~10s).
pub const DEFAULT_NORMAL_DEADLINE: Duration = Duration::from_secs(30);

/// Default EXTENDED heartbeat deadline.
///
/// A worker the supervisor knows is inside an LLM call gets this far longer
/// window before it is considered stuck, so a slow-but-healthy long completion
/// is never false-killed (AC2 · RISK-7).
pub const DEFAULT_EXTENDED_DEADLINE: Duration = Duration::from_secs(600);

/// Default grace window between the SIGTERM and the SIGKILL in the per-child
/// kill cascade — matches the supervisor's `DEFAULT_STOP_GRACE` intent.
pub const DEFAULT_KILL_GRACE: Duration = Duration::from_secs(5);

/// One worker's last recorded heartbeat (T11628).
///
/// Public only because it is a type parameter of the public [`HeartbeatSink`]
/// alias; its fields are private and it is constructed exclusively via
/// [`record_heartbeat`].
#[derive(Debug, Clone, Copy)]
pub struct HeartbeatRecord {
    /// Monotonic instant of the worker's most recent heartbeat.
    last_beat: Instant,
    /// The worker's OWN view (on that beat) of whether it is inside an LLM call.
    /// OR-ed with the queue's view so a non-`queue_admit` caller is still tiered.
    in_flight_llm: bool,
}

/// The shared heartbeat ledger.
///
/// Cloned into both the watchdog sweep task (reader) and the lease arbiter
/// (writer, on each `worker_heartbeat`), so a beat recorded on the IPC blocking
/// thread is visible to the next sweep tick without a channel.
pub type HeartbeatSink = Arc<Mutex<HashMap<String, HeartbeatRecord>>>;

/// Record a worker heartbeat into the shared sink (the arbiter's write path).
///
/// Called from the lease IPC handler when a `worker_heartbeat` frame arrives.
/// Resets `child_id`'s deadline clock to now and stores the worker's self-report
/// of whether it is inside an LLM call (the second tiering source — AC2).
pub fn record_heartbeat(sink: &HeartbeatSink, child_id: &str, in_flight_llm: bool) {
    let mut guard = lock_sink(sink);
    guard.insert(
        child_id.to_string(),
        HeartbeatRecord {
            last_beat: Instant::now(),
            in_flight_llm,
        },
    );
}

/// Lock the sink, recovering a poisoned mutex (a panic while recording a beat
/// must not wedge the watchdog — the in-memory ledger is reconstructible from
/// the next heartbeat).
fn lock_sink(sink: &HeartbeatSink) -> std::sync::MutexGuard<'_, HashMap<String, HeartbeatRecord>> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A child that has blown its (tiered) heartbeat deadline — a sweep candidate.
///
/// Captured under the sink lock, then acted on AFTER the lock is released so the
/// kill cascade (which may block on a grace timeout) never holds the ledger.
#[derive(Debug, Clone)]
pub struct StaleCandidate {
    /// The logical id of the stale child.
    pub child_id: String,
    /// How long since its last heartbeat (for the kill reason / logging).
    pub since: Duration,
    /// Which tier's deadline it blew (for the kill reason / logging).
    pub deadline: Duration,
}

/// The heartbeat-deadline watchdog (T11628).
///
/// Holds the shared heartbeat ledger and a clone of the shared [`LlmQueue`] so it
/// can tier each child's deadline by the supervisor's in-flight-call knowledge.
/// `Clone` is a cheap `Arc` bump so the sweep task and the arbiter share one
/// instance.
#[derive(Clone)]
pub struct Watchdog {
    sink: HeartbeatSink,
    llm_queue: LlmQueue,
    normal_deadline: Duration,
    extended_deadline: Duration,
}

impl Watchdog {
    /// Build a watchdog over a shared [`LlmQueue`] with the crate-default
    /// deadlines. Shares the queue's `Arc<Mutex<…>>` so `has_in_flight_call`
    /// reads the SAME in-flight ledger the `queue_admit` path writes.
    #[must_use]
    pub fn new(llm_queue: LlmQueue) -> Self {
        Self {
            sink: Arc::new(Mutex::new(HashMap::new())),
            llm_queue,
            normal_deadline: DEFAULT_NORMAL_DEADLINE,
            extended_deadline: DEFAULT_EXTENDED_DEADLINE,
        }
    }

    /// Build a watchdog with explicit deadlines (test seam + tuning).
    #[must_use]
    pub fn with_deadlines(
        llm_queue: LlmQueue,
        normal_deadline: Duration,
        extended_deadline: Duration,
    ) -> Self {
        Self {
            sink: Arc::new(Mutex::new(HashMap::new())),
            llm_queue,
            normal_deadline,
            extended_deadline,
        }
    }

    /// The shared heartbeat ledger — clone this into the lease arbiter so a
    /// `worker_heartbeat` it receives is recorded where the sweep reads it.
    #[must_use]
    pub fn sink(&self) -> HeartbeatSink {
        Arc::clone(&self.sink)
    }

    /// Record a heartbeat for `child_id` directly (test seam + the in-process
    /// fast path). Equivalent to [`record_heartbeat`] on this watchdog's sink.
    pub fn record(&self, child_id: &str, in_flight_llm: bool) {
        record_heartbeat(&self.sink, child_id, in_flight_llm);
    }

    /// Drop a child from the heartbeat ledger (e.g. after it exited or was
    /// killed) so a dead id does not linger. Idempotent.
    pub fn forget(&self, child_id: &str) {
        lock_sink(&self.sink).remove(child_id);
    }

    /// The deadline that applies to `child_id` RIGHT NOW: EXTENDED iff the
    /// supervisor knows the child is inside an LLM call (either via the queue's
    /// admission ledger OR the worker's last self-report), else NORMAL (AC2).
    #[must_use]
    pub fn deadline_for(&self, child_id: &str) -> Duration {
        if self.is_in_flight(child_id) {
            self.extended_deadline
        } else {
            self.normal_deadline
        }
    }

    /// Whether the supervisor currently believes `child_id` is inside an LLM
    /// call. OR of the two tiering sources so neither path can be bypassed.
    fn is_in_flight(&self, child_id: &str) -> bool {
        if self.llm_queue.has_in_flight_call(child_id) {
            return true;
        }
        lock_sink(&self.sink)
            .get(child_id)
            .is_some_and(|r| r.in_flight_llm)
    }

    /// Phase 1 of the sweep: snapshot the children whose last heartbeat is older
    /// than their (tiered) deadline AND that are in `known_children` — never act
    /// while holding the ledger lock (mirrors `reclaim_or_kill`'s candidate
    /// snapshot). `known_children` scopes the sweep to currently-registered
    /// children so a forgotten id is not re-killed.
    ///
    /// A child with NO heartbeat record yet is NOT stale — it has not been given
    /// a chance to beat (the watchdog seeds a beat on spawn).
    #[must_use]
    pub fn stale_candidates(&self, known_children: &[String]) -> Vec<StaleCandidate> {
        let now = Instant::now();
        let guard = lock_sink(&self.sink);
        let mut stale = Vec::new();
        for child_id in known_children {
            let Some(rec) = guard.get(child_id) else {
                // No beat recorded yet — not a candidate (grace before first beat).
                continue;
            };
            // Tier the deadline: EXTENDED iff in-flight (queue OR self-report).
            let in_flight = self.llm_queue.has_in_flight_call(child_id) || rec.in_flight_llm;
            let deadline = if in_flight {
                self.extended_deadline
            } else {
                self.normal_deadline
            };
            let since = now.saturating_duration_since(rec.last_beat);
            if since > deadline {
                stale.push(StaleCandidate {
                    child_id: child_id.clone(),
                    since,
                    deadline,
                });
            }
        }
        stale
    }
}

/// Default interval between watchdog sweeps. Short relative to the NORMAL
/// deadline so a stuck worker is detected within one extra tick of its deadline.
pub const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// Run ONE watchdog sweep (T11628 · AC1/AC2).
///
/// Snapshots the stale candidates among the registry's currently-registered
/// children (tiered by in-flight state), kills each ONE at a time with the
/// SIGTERM→grace→SIGKILL cascade, forgets it from the ledger, and emits its
/// `child_killed_unresponsive` event over `kill_events`. Returns the killed
/// `child_id`s (for tests + logging).
///
/// Candidate snapshot (read under the ledger lock) and the kills (which may
/// block on a grace timeout) are TWO phases — the lock is never held across the
/// `.await` kill, mirroring `LeaseArbiter::reclaim_or_kill`.
pub async fn run_one_sweep(
    watchdog: &Watchdog,
    registry: &ChildRegistry,
    grace: Duration,
    kill_events: &UnboundedSender<ChildKilled>,
) -> Vec<String> {
    let known = registry.child_ids().await;
    // Phase 1: snapshot candidates (no lock held across the awaits below).
    let candidates = watchdog.stale_candidates(&known);
    let mut killed_ids = Vec::new();
    // Phase 2: act per-child — isolated kill, then emit the event.
    for cand in candidates {
        let reason = format!(
            "unresponsive: no heartbeat for {}ms (deadline {}ms)",
            cand.since.as_millis(),
            cand.deadline.as_millis(),
        );
        if let Some(event) = registry
            .kill_unresponsive(&cand.child_id, grace, &reason)
            .await
        {
            // Drop the dead child from the ledger so it is not re-swept.
            watchdog.forget(&cand.child_id);
            killed_ids.push(event.child_id.clone());
            // A closed receiver (no clients / shutdown) is not fatal — the kill
            // already happened; the event is best-effort observability.
            let _ = kill_events.send(event);
        }
    }
    killed_ids
}

/// Drive the watchdog sweep forever on a fixed interval (the production wiring,
/// T11628 step 4).
///
/// This is the background task the supervisor `tokio::spawn`s. The first tick
/// fires after one interval so freshly-spawned children get a grace window to
/// send their first heartbeat. Returns only if the registry is dropped (never,
/// in production) — the caller races it against the shutdown signal.
pub async fn run_watchdog(
    watchdog: Watchdog,
    registry: ChildRegistry,
    grace: Duration,
    interval: Duration,
    kill_events: UnboundedSender<ChildKilled>,
) {
    let mut ticker = tokio::time::interval(interval);
    // Skip the immediate first tick so we wait one full interval before the
    // first sweep (the default MissedTickBehavior::Burst would fire at t=0).
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let killed = run_one_sweep(&watchdog, &registry, grace, &kill_events).await;
        if !killed.is_empty() {
            tracing::info!(killed = ?killed, "watchdog swept unresponsive children");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_queue::PriorityClass;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// A child that just beat is never stale (its clock was reset to now).
    #[test]
    fn fresh_heartbeat_is_not_stale() {
        let wd = Watchdog::new(LlmQueue::new());
        wd.record("w1", false);
        assert!(
            wd.stale_candidates(&ids(&["w1"])).is_empty(),
            "a child that just beat is healthy"
        );
    }

    /// A child with NO heartbeat record yet is not a candidate (grace before the
    /// first beat) — the watchdog never kills a child it never heard from.
    #[test]
    fn child_without_a_beat_is_not_stale() {
        let wd = Watchdog::new(LlmQueue::new());
        assert!(wd.stale_candidates(&ids(&["never-beat"])).is_empty());
    }

    /// AC1: a child that blew the NORMAL deadline with no in-flight call IS a
    /// stale candidate (the sweep would SIGTERM→SIGKILL it).
    #[test]
    fn missed_normal_deadline_is_stale() {
        // 1ms normal deadline so a tiny sleep blows it.
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        wd.record("w1", false);
        std::thread::sleep(Duration::from_millis(5));
        let stale = wd.stale_candidates(&ids(&["w1"]));
        assert_eq!(stale.len(), 1, "a child past the normal deadline is stale");
        assert_eq!(stale[0].child_id, "w1");
        assert_eq!(stale[0].deadline, Duration::from_millis(1));
    }

    /// AC2 (RISK-7): a child past the NORMAL deadline but with an in-flight LLM
    /// call (per the shared queue) is NOT killed — it gets the EXTENDED window.
    #[test]
    fn in_flight_llm_call_extends_the_deadline_via_queue() {
        let queue = LlmQueue::new();
        queue.configure_provider("anthropic", 1_000_000, 100, 60_000);
        // Tiny NORMAL deadline, generous EXTENDED.
        let wd = Watchdog::with_deadlines(
            queue.clone(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        // The child admitted an LLM call through the queue (the watchdog seam).
        assert!(matches!(
            queue.admit("anthropic", PriorityClass::Worker, 100, "w1"),
            crate::llm_queue::AdmitDecision::Admitted { .. }
        ));
        wd.record("w1", false); // self-report false; the QUEUE knows it is in-flight
        std::thread::sleep(Duration::from_millis(5));
        // Past the 1ms NORMAL deadline, but the queue reports in-flight → EXTENDED.
        assert_eq!(
            wd.deadline_for("w1"),
            Duration::from_secs(600),
            "an in-flight call grants the extended deadline"
        );
        assert!(
            wd.stale_candidates(&ids(&["w1"])).is_empty(),
            "a slow-but-healthy in-flight worker is NOT a kill candidate (RISK-7)"
        );
    }

    /// AC2: the worker's OWN self-reported `in_flight_llm` flag also extends the
    /// deadline — a caller that talks to a provider WITHOUT the queue is covered.
    #[test]
    fn in_flight_self_report_extends_the_deadline() {
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        wd.record("w1", true); // self-reported in-flight; queue knows nothing
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(wd.deadline_for("w1"), Duration::from_secs(600));
        assert!(
            wd.stale_candidates(&ids(&["w1"])).is_empty(),
            "self-reported in-flight extends the deadline even without the queue"
        );
    }

    /// AC2 (isolation): when one child is stale and a sibling is fresh, ONLY the
    /// stale child is a candidate — the sweep never proposes killing the sibling.
    #[test]
    fn kill_isolation_only_the_stale_child_is_a_candidate() {
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        wd.record("stale", false);
        std::thread::sleep(Duration::from_millis(5));
        // The sibling beats AFTER the sleep, so its clock is fresh.
        wd.record("fresh", false);
        let stale = wd.stale_candidates(&ids(&["stale", "fresh"]));
        assert_eq!(stale.len(), 1, "only the stale child is a candidate");
        assert_eq!(stale[0].child_id, "stale");
    }

    /// `forget` drops a child so a dead/killed id is no longer swept.
    #[test]
    fn forget_drops_a_child_from_the_ledger() {
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        wd.record("w1", false);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(wd.stale_candidates(&ids(&["w1"])).len(), 1);
        wd.forget("w1");
        assert!(
            wd.stale_candidates(&ids(&["w1"])).is_empty(),
            "a forgotten child is no longer swept"
        );
    }

    /// A heartbeat received AFTER a child went stale rescues it: the next sweep
    /// sees the refreshed clock and the child is no longer a candidate.
    #[test]
    fn a_late_heartbeat_rescues_a_stale_child() {
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );
        wd.record("w1", false);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(wd.stale_candidates(&ids(&["w1"])).len(), 1, "stale first");
        // The worker comes back to life with a fresh beat.
        wd.record("w1", false);
        assert!(
            wd.stale_candidates(&ids(&["w1"])).is_empty(),
            "a late heartbeat resets the deadline clock"
        );
    }

    /// The shared sink is visible across clones: a beat recorded via one handle
    /// (the arbiter's clone) is seen by another (the sweep task's clone).
    #[test]
    fn shared_sink_is_visible_across_clones() {
        let wd = Watchdog::new(LlmQueue::new());
        let sink = wd.sink();
        record_heartbeat(&sink, "w1", false); // arbiter-side write
        // The watchdog (sweep-side) sees it: fresh, so not stale.
        assert!(wd.stale_candidates(&ids(&["w1"])).is_empty());
    }

    // ── End-to-end sweep over a real registry + child (T11628) ──────────────

    /// Build a spawn request for a long-running sleep child (the "stuck worker").
    #[cfg(unix)]
    fn sleep_spawn(child_id: &str, secs: u64) -> crate::ipc::SpawnRequest {
        crate::ipc::SpawnRequest {
            child_id: child_id.into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), format!("sleep {secs}")],
            env: vec![],
            cwd: None,
        }
    }

    /// AC1+AC2: an integration sweep over a real registry. A spawned child that
    /// never heartbeats past its (NORMAL) deadline is SIGTERM→SIGKILLed by the
    /// sweep, a `child_killed_unresponsive` event is emitted, and a fresh sibling
    /// is left running (isolation). The in-flight self-report rescues a third
    /// child past the same deadline (RISK-7).
    #[cfg(unix)]
    #[tokio::test]
    async fn run_one_sweep_kills_stuck_child_spares_healthy_and_in_flight() {
        use crate::process;
        use crate::supervisor::ChildRegistry;
        use tokio::sync::mpsc::unbounded_channel;

        let (lifecycle_tx, _lifecycle_rx) = unbounded_channel();
        let registry = ChildRegistry::new(lifecycle_tx);

        // Tiny NORMAL deadline, generous EXTENDED, so a short test exercises both.
        let wd = Watchdog::with_deadlines(
            LlmQueue::new(),
            Duration::from_millis(1),
            Duration::from_secs(600),
        );

        let stuck = registry.spawn(&sleep_spawn("stuck", 60)).await.expect("spawn stuck");
        let in_flight = registry
            .spawn(&sleep_spawn("in_flight", 60))
            .await
            .expect("spawn in_flight");

        // Both beat once, but only `in_flight` self-reports an LLM call in flight.
        wd.record("stuck", false);
        wd.record("in_flight", true);
        // Let the 1ms NORMAL deadline elapse for the non-in-flight child.
        tokio::time::sleep(Duration::from_millis(10)).await;
        // A healthy sibling beats AFTER the sleep, so its clock is fresh.
        let healthy = registry.spawn(&sleep_spawn("healthy", 60)).await.expect("spawn healthy");
        wd.record("healthy", false);

        let (kill_tx, mut kill_rx) = unbounded_channel();
        let killed = run_one_sweep(&wd, &registry, Duration::from_secs(2), &kill_tx).await;

        assert_eq!(killed, vec!["stuck".to_string()], "only the stuck child is killed");

        // The kill event was emitted.
        let event = tokio::time::timeout(Duration::from_secs(2), kill_rx.recv())
            .await
            .expect("kill event within timeout")
            .expect("kill event present");
        assert_eq!(event.child_id, "stuck");
        assert!(event.reason.contains("unresponsive"));

        // The stuck child is dead; the healthy + in-flight siblings live on.
        for _ in 0..100 {
            if !process::is_alive(stuck.pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!process::is_alive(stuck.pid), "stuck child must be dead");
        assert!(process::is_alive(in_flight.pid), "in-flight child spared (RISK-7)");
        assert!(process::is_alive(healthy.pid), "healthy sibling spared (isolation)");

        // The stuck child was forgotten, so a second sweep never re-kills it
        // (its ledger entry is gone — it is not even a candidate). Refresh the
        // surviving children's beats first so the tiny NORMAL deadline does not
        // make THEM candidates on this second tick.
        wd.record("healthy", false);
        wd.record("in_flight", true);
        let second = run_one_sweep(&wd, &registry, Duration::from_secs(2), &kill_tx).await;
        assert!(
            !second.contains(&"stuck".to_string()),
            "a forgotten child is not re-killed"
        );

        let _ = process::force_kill(in_flight.pid);
        let _ = process::force_kill(healthy.pid);
    }
}

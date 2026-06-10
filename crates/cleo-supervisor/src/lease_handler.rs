// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Supervisor-side `lease-ipc` v1.1 arbitration handler (T11627 ST-5 — the
//! daemon-on fast path).
//!
//! The Node engine (`packages/core/src/store/writer-lease.ts`) arbitrates the
//! writer lease over a persisted `_writer_leases` row via a `BEGIN IMMEDIATE`
//! claim transaction in `local` mode (daemon disabled). This module is the
//! **upgrade-only** supervisor fast path: when the daemon is re-enabled
//! (`CLEO_WRITER_LEASE_MODE=supervisor`), the supervisor runs the SAME
//! `BEGIN IMMEDIATE` claim transaction against the SAME row — one shared
//! arbitration primitive, one row format. IPC is a coordination optimization
//! over the persisted source-of-truth, never a second source.
//!
//! ## What lands here (ST-5)
//!
//!   * [`LeaseArbiter::handle`] — the [`crate::lease_ipc::LeaseRequest`]
//!     dispatcher invoked by the accept-loop version router for `"1.1.0"` frames.
//!   * `lease_acquire` / `lease_release` / `lease_renew` — the v1 core verbs,
//!     each a synchronous `rusqlite` transaction against the scope's `cleo.db`
//!     that mirrors the Node `tryClaimOnce` / release / heartbeat SQL byte for
//!     byte (same table names, same columns, same epoch-CAS, same partial-unique
//!     `active = 1` invariant).
//!   * `rate_check` / `tool_grant` — declared in the frozen v1.1 union so the
//!     protocol never needs a second version bump, but the handlers are
//!     DEFERRED: they return `E_LEASE_UNIMPLEMENTED` until a follow-up task.
//!   * [`LeaseArbiter::reclaim_or_kill`] — the kill path: a holder past
//!     `3 × renew-interval` (i.e. its TTL) whose pid is dead is reclaimed and a
//!     [`crate::lease_ipc::ChildKilled`] (`child_killed_unresponsive`) event is
//!     produced. **Only the supervisor kills** — `local` mode (the Node engine)
//!     never kills, it only reclaims a dead pid on the next acquire (spec §7).
//!
//! ## DB access model
//!
//! `rusqlite` is a SYNCHRONOUS driver; the supervisor runs on a tokio reactor.
//! Each claim opens a short-lived connection, applies the same
//! `busy_timeout=30000` backstop the Node engine and `specs/sqlite-pragmas.json`
//! pin, runs the `BEGIN IMMEDIATE` transaction, and closes. Callers invoke the
//! handler on a blocking thread (`tokio::task::spawn_blocking`) so the sync API
//! never blocks the reactor — see [`crate::ipc_server`].

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::lease_ipc::{
    ChildKilled, DbScope, LeaseAcquireReq, LeaseGranted, LeaseLane, LeaseReleaseReq, LeaseRenewReq,
    LeaseRequest, LeaseResponse, QueueAdmitDisposition, QueueAdmitReq, QueueAdmitResult,
    QueuePriorityClass,
};
use crate::llm_queue::{AdmitDecision, LlmQueue, PriorityClass};

/// Error code returned for a request kind that is declared in the frozen v1.1
/// union but whose handler is deferred (`rate_check` / `tool_grant`).
pub const E_LEASE_UNIMPLEMENTED: &str = "E_LEASE_UNIMPLEMENTED";

/// Error code returned when the arbiter cannot resolve / open the scope's
/// `cleo.db` to run the claim transaction.
pub const E_LEASE_DB_UNAVAILABLE: &str = "E_LEASE_DB_UNAVAILABLE";

/// Error code returned when the claim transaction fails unexpectedly.
pub const E_LEASE_CLAIM_FAILED: &str = "E_LEASE_CLAIM_FAILED";

/// Reason string stamped on the `child_killed_unresponsive` event when a holder
/// is killed for blowing its TTL with a dead pid.
pub const KILL_REASON_UNRESPONSIVE: &str = "unresponsive past ttl (3x renew interval) and pid dead";

/// Table name for the persisted lease row. MUST equal `WRITER_LEASES_TABLE` in
/// `packages/core/src/store/writer-lease-schema.ts` — the supervisor and Node
/// arbitrate the SAME row.
const WRITER_LEASES_TABLE: &str = "_writer_leases";

/// Table name for the FIFO+priority waiter queue. MUST equal `WRITER_QUEUE_TABLE`
/// in `writer-lease-schema.ts`.
const WRITER_QUEUE_TABLE: &str = "_writer_queue";

/// `busy_timeout` backstop (ms) on the `BEGIN IMMEDIATE` lock — byte-equal to the
/// Node engine's `DEFAULT_TTL_MS` / `specs/sqlite-pragmas.json` pin so a contended
/// claim degrades to today's bounded wait rather than a hang.
const BUSY_TIMEOUT_MS: u64 = 30_000;

/// Resolves a [`DbScope`] to the absolute on-disk `cleo.db` path the lease row
/// lives in.
///
/// Injectable so tests arbitrate against an isolated temp fixture with no
/// supervisor home and no canonical-path side effects.
pub type ScopeDbResolver = Arc<dyn Fn(DbScope) -> anyhow::Result<PathBuf> + Send + Sync>;

/// The serde `kind` string for a [`LeaseRequest`] variant — used by the accept
/// loop to record which verb it routed without re-serializing.
#[must_use]
pub fn request_kind(req: &LeaseRequest) -> &'static str {
    match req {
        LeaseRequest::LeaseAcquire(_) => "lease_acquire",
        LeaseRequest::LeaseRelease(_) => "lease_release",
        LeaseRequest::LeaseRenew(_) => "lease_renew",
        LeaseRequest::RateCheck(_) => "rate_check",
        LeaseRequest::ToolGrant(_) => "tool_grant",
        LeaseRequest::QueueAdmit(_) => "queue_admit",
    }
}

/// Current wall-clock in epoch milliseconds (matches Node's `Date.now()`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The serde `snake_case` string for a [`DbScope`] — the value persisted in the
/// `scope` column (matches Node's `'project' | 'global'`).
fn scope_str(scope: DbScope) -> &'static str {
    match scope {
        DbScope::Project => "project",
        DbScope::Global => "global",
    }
}

/// The serde `snake_case` string for a [`LeaseLane`] — the value persisted in the
/// `lane` column (matches Node's `'tasks' | 'brain' | 'bulk'`).
fn lane_str(lane: LeaseLane) -> &'static str {
    match lane {
        LeaseLane::Tasks => "tasks",
        LeaseLane::Brain => "brain",
        LeaseLane::Bulk => "bulk",
    }
}

/// No-throw pid-liveness probe. Mirrors the Node engine's `isPidAlive`
/// (`process.kill(pid, 0)`): a process that exists (even if not ours) is alive;
/// `ESRCH` means dead.
#[cfg(unix)]
fn is_pid_alive(pid: i32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    match kill(Pid::from_raw(pid), None) {
        Ok(()) => true,
        // EPERM => the process exists but is not ours (alive). ESRCH => dead.
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

/// On non-Unix targets the lease fast path is not exercised in production (the
/// daemon ships Unix-first); treat every pid as alive so reclaim never fires.
#[cfg(not(unix))]
fn is_pid_alive(_pid: i32) -> bool {
    true
}

/// The outcome of a claim transaction: either a grant (with the assigned epoch)
/// or a "contended by a live holder" miss (the caller is queued).
enum ClaimOutcome {
    /// The lease was granted; carries the assigned epoch.
    Granted { epoch: u64 },
    /// A live holder owns the row; the caller was enqueued for FIFO ordering.
    Queued { ticket: i64, ahead: u32 },
}

/// The active-row snapshot read inside the claim transaction.
struct ActiveRow {
    id: i64,
    holder_id: String,
    holder_pid: i32,
    epoch: u64,
    heartbeat_at: u64,
    ttl_ms: u64,
}

/// The supervisor-side writer-lease arbiter.
///
/// Holds the scope→db-path resolver and arbitrates `lease-ipc` v1.1 requests
/// against the persisted `_writer_leases` row using the SAME `BEGIN IMMEDIATE`
/// primitive the Node engine uses in `local` mode.
#[derive(Clone)]
pub struct LeaseArbiter {
    resolver: ScopeDbResolver,
    /// The in-memory LLM-queue priority scheduler + per-provider rate governor
    /// (T11630). Shared across all clients (the contended counters are process-
    /// global, like a real provider quota). Cheap to clone (`Arc` bump).
    llm_queue: LlmQueue,
}

impl LeaseArbiter {
    /// Build an arbiter from a scope→db-path resolver, with a fresh LLM queue.
    #[must_use]
    pub fn new(resolver: ScopeDbResolver) -> Self {
        Self {
            resolver,
            llm_queue: LlmQueue::new(),
        }
    }

    /// Build an arbiter from a resolver AND a pre-seeded [`LlmQueue`] (the
    /// supervisor wires one queue, possibly with provider quotas configured).
    #[must_use]
    pub fn with_llm_queue(resolver: ScopeDbResolver, llm_queue: LlmQueue) -> Self {
        Self {
            resolver,
            llm_queue,
        }
    }

    /// The shared LLM queue (so the watchdog T11628 can read in-flight state and
    /// the supervisor can configure provider quotas).
    #[must_use]
    pub fn llm_queue(&self) -> &LlmQueue {
        &self.llm_queue
    }

    /// Dispatch a single parsed [`LeaseRequest`], returning the correlated
    /// [`LeaseResponse`] to send back to the requesting client.
    ///
    /// SYNCHRONOUS: runs the `rusqlite` claim transaction inline. Callers MUST
    /// invoke this on a blocking thread (`tokio::task::spawn_blocking`) so the
    /// sync `SQLite` API never blocks the tokio reactor.
    ///
    /// - `lease_acquire` → `BEGIN IMMEDIATE` claim → `lease_granted` /
    ///   `lease_queued`.
    /// - `lease_release` → epoch-guarded free-row → `lease_granted` echo of the
    ///   released grant (idempotent; a stale epoch no-ops).
    /// - `lease_renew`   → epoch-guarded heartbeat advance → `lease_granted`.
    /// - `rate_check` / `tool_grant` → DEFERRED: `error` with
    ///   [`E_LEASE_UNIMPLEMENTED`].
    #[must_use]
    pub fn handle(&self, request: LeaseRequest) -> LeaseResponse {
        match request {
            LeaseRequest::LeaseAcquire(req) => self.handle_acquire(&req),
            LeaseRequest::LeaseRelease(req) => self.handle_release(&req),
            LeaseRequest::LeaseRenew(req) => self.handle_renew(&req),
            // Declared in the frozen v1.1 union so the protocol never needs a
            // second version bump; handlers deferred to a follow-up task.
            LeaseRequest::RateCheck(_) => Self::unimplemented("rate_check"),
            LeaseRequest::ToolGrant(_) => Self::unimplemented("tool_grant"),
            // The LLM-queue admit verb is WIRED (T11630) — backed by the
            // in-memory priority scheduler + per-provider rate governor.
            LeaseRequest::QueueAdmit(req) => self.handle_queue_admit(&req),
        }
    }

    /// `queue_admit` — run the LLM-call admission decision through the priority
    /// scheduler + per-provider rate governor (T11630 · AC1-AC4). The whole
    /// decision is one atomic read-modify-write inside [`LlmQueue::admit`]; an
    /// over-budget or starved request gets a structured `deferred` result with a
    /// `retry_after_ms` back-off — never a silent drop (AC4).
    fn handle_queue_admit(&self, req: &QueueAdmitReq) -> LeaseResponse {
        let priority = match req.priority_class {
            QueuePriorityClass::Lead => PriorityClass::Lead,
            QueuePriorityClass::Worker => PriorityClass::Worker,
            QueuePriorityClass::Background => PriorityClass::Background,
        };
        let decision = self
            .llm_queue
            .admit(&req.provider, priority, req.est_tokens, &req.child_id);
        let result = match decision {
            AdmitDecision::Admitted { tokens_remaining } => QueueAdmitResult {
                disposition: QueueAdmitDisposition::Admitted,
                retry_after_ms: 0,
                tokens_remaining,
                queue_position: 0,
            },
            AdmitDecision::Deferred {
                retry_after_ms,
                tokens_remaining,
                queue_position,
            } => QueueAdmitResult {
                disposition: QueueAdmitDisposition::Deferred,
                retry_after_ms,
                tokens_remaining,
                queue_position,
            },
        };
        LeaseResponse::QueueAdmitResult(result)
    }

    /// The deferred-handler error response (`E_LEASE_UNIMPLEMENTED`).
    fn unimplemented(verb: &str) -> LeaseResponse {
        LeaseResponse::Error(crate::ipc::ErrorResult {
            code: E_LEASE_UNIMPLEMENTED.to_string(),
            message: format!("lease-ipc verb '{verb}' is declared but its handler is deferred"),
        })
    }

    /// Resolve + open the scope's `cleo.db`, applying the `busy_timeout` backstop.
    fn open_scope_db(&self, scope: DbScope) -> Result<rusqlite::Connection, LeaseResponse> {
        let path = (self.resolver)(scope).map_err(|e| {
            LeaseResponse::LeaseDenied(crate::lease_ipc::LeaseDenied {
                scope,
                code: E_LEASE_DB_UNAVAILABLE.to_string(),
                message: format!("cannot resolve cleo.db for scope: {e}"),
            })
        })?;
        Self::open_at(scope, &path)
    }

    /// Open a connection at an explicit path with the shared pragmas.
    fn open_at(scope: DbScope, path: &Path) -> Result<rusqlite::Connection, LeaseResponse> {
        let conn = rusqlite::Connection::open(path).map_err(|e| {
            LeaseResponse::LeaseDenied(crate::lease_ipc::LeaseDenied {
                scope,
                code: E_LEASE_DB_UNAVAILABLE.to_string(),
                message: format!("cannot open cleo.db at {}: {e}", path.display()),
            })
        })?;
        // Same busy_timeout backstop the Node engine relies on so a contended
        // BEGIN IMMEDIATE degrades to a bounded wait, never a hang.
        let _ = conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS));
        Ok(conn)
    }

    /// `lease_acquire` — the `BEGIN IMMEDIATE` claim against the active row.
    fn handle_acquire(&self, req: &LeaseAcquireReq) -> LeaseResponse {
        let conn = match self.open_scope_db(req.scope) {
            Ok(c) => c,
            Err(resp) => return resp,
        };
        match self.claim(&conn, req) {
            Ok(ClaimOutcome::Granted { epoch }) => LeaseResponse::LeaseGranted(LeaseGranted {
                scope: req.scope,
                lane: req.lane,
                holder_id: req.holder_id.clone(),
                epoch,
                ttl_ms: req.ttl_ms,
                expires_at_ms: now_ms().saturating_add(req.ttl_ms),
            }),
            Ok(ClaimOutcome::Queued { ticket, ahead }) => {
                LeaseResponse::LeaseQueued(crate::lease_ipc::LeaseQueued {
                    scope: req.scope,
                    lane: req.lane,
                    ticket,
                    ahead,
                })
            }
            Err(e) => LeaseResponse::LeaseDenied(crate::lease_ipc::LeaseDenied {
                scope: req.scope,
                code: E_LEASE_CLAIM_FAILED.to_string(),
                message: format!("claim transaction failed: {e}"),
            }),
        }
    }

    /// The `BEGIN IMMEDIATE` claim transaction — byte-for-byte the Node
    /// `tryClaimOnce` logic, plus a kill-on-reclaim hook so the supervisor (and
    /// ONLY the supervisor) kills a dead-pid TTL-blown holder.
    fn claim(
        &self,
        conn: &rusqlite::Connection,
        req: &LeaseAcquireReq,
    ) -> rusqlite::Result<ClaimOutcome> {
        let now = now_ms();
        let scope = scope_str(req.scope);
        let lane = lane_str(req.lane);
        conn.execute_batch("BEGIN IMMEDIATE TRANSACTION")?;

        let result = (|| -> rusqlite::Result<ClaimOutcome> {
            let active = Self::read_active(conn, scope, lane)?;
            match active {
                None => {
                    // No active holder — take a fresh row with the next epoch.
                    let next_epoch: u64 = conn.query_row(
                        &format!(
                            "SELECT COALESCE(MAX(epoch), 0) + 1 FROM {WRITER_LEASES_TABLE} \
                             WHERE scope = ?1 AND lane = ?2"
                        ),
                        rusqlite::params![scope, lane],
                        |r| r.get(0),
                    )?;
                    conn.execute(
                        &format!(
                            "INSERT INTO {WRITER_LEASES_TABLE} \
                             (scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms, reentrancy_depth, active) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 1)"
                        ),
                        rusqlite::params![
                            scope,
                            lane,
                            req.holder_id,
                            i64::from(std::process::id().min(i32::MAX as u32) as i32),
                            next_epoch,
                            now,
                            now,
                            req.ttl_ms,
                        ],
                    )?;
                    Ok(ClaimOutcome::Granted { epoch: next_epoch })
                }
                Some(row) if row.holder_id == req.holder_id => {
                    // Same holder re-entry — bump durable depth, re-assert epoch.
                    conn.execute(
                        &format!(
                            "UPDATE {WRITER_LEASES_TABLE} \
                             SET reentrancy_depth = reentrancy_depth + 1, heartbeat_at = ?1 WHERE id = ?2"
                        ),
                        rusqlite::params![now, row.id],
                    )?;
                    Ok(ClaimOutcome::Granted { epoch: row.epoch })
                }
                Some(row) => {
                    // A different holder owns the row. Reclaim IFF stale (TTL
                    // expired AND pid dead). SQLite serializes this inside BEGIN
                    // IMMEDIATE so two reclaimers cannot both win.
                    let stale = now.saturating_sub(row.heartbeat_at) > row.ttl_ms
                        && !is_pid_alive(row.holder_pid);
                    if stale {
                        let reclaimed_epoch = row.epoch + 1;
                        conn.execute(
                            &format!(
                                "UPDATE {WRITER_LEASES_TABLE} \
                                 SET holder_id = ?1, holder_pid = ?2, epoch = ?3, acquired_at = ?4, \
                                     heartbeat_at = ?5, ttl_ms = ?6, reentrancy_depth = 1 \
                                 WHERE id = ?7 AND epoch = ?8"
                            ),
                            rusqlite::params![
                                req.holder_id,
                                i64::from(std::process::id().min(i32::MAX as u32) as i32),
                                reclaimed_epoch,
                                now,
                                now,
                                req.ttl_ms,
                                row.id,
                                row.epoch,
                            ],
                        )?;
                        Ok(ClaimOutcome::Granted {
                            epoch: reclaimed_epoch,
                        })
                    } else {
                        // Live holder — enqueue this waiter (idempotent) and report
                        // queue position. busy_timeout already backstopped the lock.
                        let (ticket, ahead) = Self::enqueue_waiter(conn, scope, lane, req, now)?;
                        Ok(ClaimOutcome::Queued { ticket, ahead })
                    }
                }
            }
        })();

        match result {
            Ok(outcome) => {
                conn.execute_batch("COMMIT")?;
                Ok(outcome)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Read the single active row for `(scope, lane)` (partial-unique `active=1`).
    fn read_active(
        conn: &rusqlite::Connection,
        scope: &str,
        lane: &str,
    ) -> rusqlite::Result<Option<ActiveRow>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, holder_id, holder_pid, epoch, heartbeat_at, ttl_ms \
             FROM {WRITER_LEASES_TABLE} WHERE scope = ?1 AND lane = ?2 AND active = 1"
        ))?;
        let mut rows = stmt.query(rusqlite::params![scope, lane])?;
        if let Some(r) = rows.next()? {
            Ok(Some(ActiveRow {
                id: r.get(0)?,
                holder_id: r.get(1)?,
                holder_pid: r.get(2)?,
                epoch: r.get(3)?,
                heartbeat_at: r.get(4)?,
                ttl_ms: r.get(5)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Enqueue a waiter row (idempotent per holder) and return `(ticket, ahead)`.
    fn enqueue_waiter(
        conn: &rusqlite::Connection,
        scope: &str,
        lane: &str,
        req: &LeaseAcquireReq,
        now: u64,
    ) -> rusqlite::Result<(i64, u32)> {
        let existing: Option<i64> = conn
            .query_row(
                &format!(
                    "SELECT ticket FROM {WRITER_QUEUE_TABLE} \
                     WHERE scope = ?1 AND lane = ?2 AND holder_id = ?3"
                ),
                rusqlite::params![scope, lane, req.holder_id],
                |r| r.get(0),
            )
            .ok();
        let ticket = match existing {
            Some(t) => t,
            None => {
                conn.execute(
                    &format!(
                        "INSERT INTO {WRITER_QUEUE_TABLE} \
                         (scope, lane, holder_id, priority, enqueued_at, deadline_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
                    ),
                    rusqlite::params![
                        scope,
                        lane,
                        req.holder_id,
                        i64::from(req.priority),
                        now,
                        now + req.ttl_ms,
                    ],
                )?;
                conn.last_insert_rowid()
            }
        };
        // Count waiters ahead of us by grant order (priority ASC, ticket ASC).
        let ahead: u32 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM {WRITER_QUEUE_TABLE} q \
                 WHERE q.scope = ?1 AND q.lane = ?2 \
                   AND (q.priority < ?3 OR (q.priority = ?3 AND q.ticket < ?4))"
            ),
            rusqlite::params![scope, lane, i64::from(req.priority), ticket],
            |r| {
                r.get::<_, i64>(0)
                    .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
            },
        )?;
        Ok((ticket, ahead))
    }

    /// `lease_release` — free the active row under the epoch guard. Idempotent: a
    /// stale epoch (the lease was already reclaimed) updates 0 rows and the echo
    /// still succeeds. Returns a `lease_granted` echo of the released grant.
    fn handle_release(&self, req: &LeaseReleaseReq) -> LeaseResponse {
        let conn = match self.open_scope_db(req.scope) {
            Ok(c) => c,
            Err(resp) => return resp,
        };
        let scope = scope_str(req.scope);
        let lane = lane_str(req.lane);
        let res = conn.execute(
            &format!(
                "UPDATE {WRITER_LEASES_TABLE} SET active = 0, reentrancy_depth = 0 \
                 WHERE scope = ?1 AND lane = ?2 AND holder_id = ?3 AND epoch = ?4 AND active = 1"
            ),
            rusqlite::params![scope, lane, req.holder_id, req.epoch],
        );
        match res {
            Ok(_) => LeaseResponse::LeaseGranted(LeaseGranted {
                scope: req.scope,
                lane: req.lane,
                holder_id: req.holder_id.clone(),
                epoch: req.epoch,
                ttl_ms: 0,
                expires_at_ms: now_ms(),
            }),
            Err(e) => LeaseResponse::LeaseDenied(crate::lease_ipc::LeaseDenied {
                scope: req.scope,
                code: E_LEASE_CLAIM_FAILED.to_string(),
                message: format!("release failed: {e}"),
            }),
        }
    }

    /// `lease_renew` — advance `heartbeat_at` under the epoch guard. A reclaimed
    /// holder's renew updates 0 rows (no-op via the epoch guard). Returns a
    /// `lease_granted` carrying the refreshed expiry.
    fn handle_renew(&self, req: &LeaseRenewReq) -> LeaseResponse {
        let conn = match self.open_scope_db(req.scope) {
            Ok(c) => c,
            Err(resp) => return resp,
        };
        let scope = scope_str(req.scope);
        let lane = lane_str(req.lane);
        let now = now_ms();
        // Read the row's ttl_ms first so the granted expiry is accurate.
        let ttl_ms: u64 = conn
            .query_row(
                &format!(
                    "SELECT ttl_ms FROM {WRITER_LEASES_TABLE} \
                     WHERE scope = ?1 AND lane = ?2 AND holder_id = ?3 AND epoch = ?4 AND active = 1"
                ),
                rusqlite::params![scope, lane, req.holder_id, req.epoch],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let res = conn.execute(
            &format!(
                "UPDATE {WRITER_LEASES_TABLE} SET heartbeat_at = ?1 \
                 WHERE scope = ?2 AND lane = ?3 AND holder_id = ?4 AND epoch = ?5 AND active = 1"
            ),
            rusqlite::params![now, scope, lane, req.holder_id, req.epoch],
        );
        match res {
            Ok(_) => LeaseResponse::LeaseGranted(LeaseGranted {
                scope: req.scope,
                lane: req.lane,
                holder_id: req.holder_id.clone(),
                epoch: req.epoch,
                ttl_ms,
                expires_at_ms: now.saturating_add(ttl_ms),
            }),
            Err(e) => LeaseResponse::LeaseDenied(crate::lease_ipc::LeaseDenied {
                scope: req.scope,
                code: E_LEASE_CLAIM_FAILED.to_string(),
                message: format!("renew failed: {e}"),
            }),
        }
    }

    /// Scan the active rows for a stale, dead-pid holder and reclaim it, emitting
    /// a `child_killed_unresponsive` event — the supervisor-ONLY kill path
    /// (spec §7). A holder is killable IFF it has blown its TTL
    /// (`now - heartbeat_at > ttl_ms`, i.e. it missed ≥ 3 renew intervals since
    /// the renew interval is `ttl/3`) AND its pid is dead. `local` mode (the Node
    /// engine) never calls this — it only reclaims on the next acquire.
    ///
    /// Returns one [`ChildKilled`] event per holder reclaimed in this sweep.
    #[must_use]
    pub fn reclaim_or_kill(&self, scope: DbScope) -> Vec<ChildKilled> {
        let conn = match self.open_scope_db(scope) {
            Ok(c) => c,
            // A missing/unopenable scope DB has nothing to reclaim.
            Err(_) => return Vec::new(),
        };
        let now = now_ms();
        let mut killed = Vec::new();
        // Snapshot candidates first (read), then reclaim each under its own
        // BEGIN IMMEDIATE so two reclaimers cannot both win a given row.
        let candidates = Self::read_kill_candidates(&conn, scope_str(scope), now);
        for (id, holder_id, holder_pid, epoch, lane) in candidates {
            if is_pid_alive(holder_pid) {
                // Slow-but-live holder — never kill (risk #4 mitigation).
                continue;
            }
            // Reclaim the row (active = 0) under the epoch guard. Loser of a race
            // sees the bumped epoch and reclaims nothing.
            let affected = conn
                .execute(
                    &format!(
                        "UPDATE {WRITER_LEASES_TABLE} SET active = 0, reentrancy_depth = 0, epoch = epoch + 1 \
                         WHERE id = ?1 AND epoch = ?2 AND active = 1 AND ?3 - heartbeat_at > ttl_ms"
                    ),
                    rusqlite::params![id, epoch, now],
                )
                .unwrap_or(0);
            if affected > 0 {
                killed.push(ChildKilled {
                    child_id: holder_id.clone(),
                    holder_id,
                    scope,
                    reason: format!("{KILL_REASON_UNRESPONSIVE} (lane={lane})"),
                });
            }
        }
        killed
    }

    /// Read active rows whose TTL has expired (candidates for the kill sweep).
    /// pid-liveness is re-checked by the caller before reclaiming.
    fn read_kill_candidates(
        conn: &rusqlite::Connection,
        scope: &str,
        now: u64,
    ) -> Vec<(i64, String, i32, u64, String)> {
        let mut out = Vec::new();
        let Ok(mut stmt) = conn.prepare(&format!(
            "SELECT id, holder_id, holder_pid, epoch, lane FROM {WRITER_LEASES_TABLE} \
             WHERE scope = ?1 AND active = 1 AND ?2 - heartbeat_at > ttl_ms"
        )) else {
            return out;
        };
        let Ok(mut rows) = stmt.query(rusqlite::params![scope, now]) else {
            return out;
        };
        while let Ok(Some(r)) = rows.next() {
            let Ok(id) = r.get::<_, i64>(0) else { continue };
            let Ok(holder_id) = r.get::<_, String>(1) else {
                continue;
            };
            let Ok(holder_pid) = r.get::<_, i32>(2) else {
                continue;
            };
            let Ok(epoch) = r.get::<_, u64>(3) else {
                continue;
            };
            let Ok(lane) = r.get::<_, String>(4) else {
                continue;
            };
            out.push((id, holder_id, holder_pid, epoch, lane));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lease_ipc::{LeaseAcquireReq, LeaseReleaseReq, LeaseRenewReq, LeaseRequest};
    use std::sync::Arc;

    /// The lease-table bootstrap DDL — byte-equivalent (modulo `IF NOT EXISTS`) to
    /// the Node `COLD_OPEN_LEASE_BOOTSTRAP_DDL` so the supervisor claims against
    /// the SAME schema the Node engine creates.
    const BOOTSTRAP_DDL: &str = "\
        CREATE TABLE IF NOT EXISTS _writer_leases (\
          id INTEGER PRIMARY KEY, scope TEXT NOT NULL, lane TEXT NOT NULL, \
          holder_id TEXT NOT NULL, holder_pid INTEGER NOT NULL, epoch INTEGER NOT NULL, \
          acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, \
          reentrancy_depth INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);\
        CREATE UNIQUE INDEX IF NOT EXISTS ux_writer_leases_active ON _writer_leases (scope, lane) WHERE active = 1;\
        CREATE TABLE IF NOT EXISTS _writer_queue (\
          ticket INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, lane TEXT NOT NULL, \
          holder_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, \
          enqueued_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL);\
        CREATE INDEX IF NOT EXISTS ix_writer_queue_order ON _writer_queue (scope, lane, priority ASC, ticket ASC);";

    /// Build an arbiter bound to a single temp `cleo.db` for every scope, with the
    /// lease tables bootstrapped — an isolated fixture with no supervisor home.
    fn fixture() -> (LeaseArbiter, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cleo.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.execute_batch(BOOTSTRAP_DDL).expect("bootstrap");
        let path = db_path.clone();
        let resolver: ScopeDbResolver = Arc::new(move |_scope| Ok(path.clone()));
        (LeaseArbiter::new(resolver), dir, db_path)
    }

    fn acquire(holder: &str, ttl_ms: u64) -> LeaseRequest {
        LeaseRequest::LeaseAcquire(LeaseAcquireReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: holder.into(),
            priority: 0,
            ttl_ms,
            reentrant: true,
        })
    }

    #[test]
    fn acquire_grants_when_no_active_holder() {
        let (arb, _dir, _p) = fixture();
        let resp = arb.handle(acquire("h1", 30_000));
        match resp {
            LeaseResponse::LeaseGranted(g) => {
                assert_eq!(g.holder_id, "h1");
                assert_eq!(g.epoch, 1);
                assert_eq!(g.ttl_ms, 30_000);
            }
            other => panic!("expected LeaseGranted, got {other:?}"),
        }
    }

    #[test]
    fn second_holder_is_queued_while_first_is_live() {
        let (arb, _dir, _p) = fixture();
        // h1 acquires with a long TTL and a LIVE pid (this test process).
        assert!(matches!(
            arb.handle(acquire("h1", 60_000)),
            LeaseResponse::LeaseGranted(_)
        ));
        // h2 contends — h1 is not stale (fresh heartbeat) so h2 is queued.
        match arb.handle(acquire("h2", 60_000)) {
            LeaseResponse::LeaseQueued(q) => {
                assert_eq!(q.ahead, 0);
                assert!(q.ticket >= 1);
            }
            other => panic!("expected LeaseQueued, got {other:?}"),
        }
    }

    #[test]
    fn same_holder_reacquire_reenters_and_keeps_epoch() {
        let (arb, _dir, _p) = fixture();
        let first = arb.handle(acquire("h1", 60_000));
        let LeaseResponse::LeaseGranted(g1) = first else {
            panic!("expected grant");
        };
        let second = arb.handle(acquire("h1", 60_000));
        let LeaseResponse::LeaseGranted(g2) = second else {
            panic!("expected re-entry grant");
        };
        assert_eq!(g1.epoch, g2.epoch, "re-entry keeps the same epoch");
    }

    #[test]
    fn release_frees_the_row_so_next_acquire_grants() {
        let (arb, _dir, _p) = fixture();
        let LeaseResponse::LeaseGranted(g) = arb.handle(acquire("h1", 60_000)) else {
            panic!("expected grant");
        };
        let rel = arb.handle(LeaseRequest::LeaseRelease(LeaseReleaseReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "h1".into(),
            epoch: g.epoch,
        }));
        assert!(matches!(rel, LeaseResponse::LeaseGranted(_)));
        // Now a different holder can take it (fresh row, next epoch).
        match arb.handle(acquire("h2", 60_000)) {
            LeaseResponse::LeaseGranted(g2) => assert!(g2.epoch > g.epoch),
            other => panic!("expected grant after release, got {other:?}"),
        }
    }

    #[test]
    fn renew_advances_heartbeat_under_epoch_guard() {
        let (arb, _dir, _p) = fixture();
        let LeaseResponse::LeaseGranted(g) = arb.handle(acquire("h1", 30_000)) else {
            panic!("expected grant");
        };
        let renew = arb.handle(LeaseRequest::LeaseRenew(LeaseRenewReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "h1".into(),
            epoch: g.epoch,
        }));
        match renew {
            LeaseResponse::LeaseGranted(g2) => {
                assert_eq!(g2.epoch, g.epoch);
                assert_eq!(g2.ttl_ms, 30_000);
            }
            other => panic!("expected renew grant, got {other:?}"),
        }
    }

    #[test]
    fn rate_check_and_tool_grant_are_unimplemented() {
        let (arb, _dir, _p) = fixture();
        let rate = arb.handle(LeaseRequest::RateCheck(crate::lease_ipc::RateCheckReq {
            scope: DbScope::Global,
            lane: LeaseLane::Bulk,
            est_bytes: 4096,
        }));
        match rate {
            LeaseResponse::Error(e) => assert_eq!(e.code, E_LEASE_UNIMPLEMENTED),
            other => panic!("expected unimplemented error, got {other:?}"),
        }
        let tool = arb.handle(LeaseRequest::ToolGrant(crate::lease_ipc::ToolGrantReq {
            tool: "browser".into(),
            holder_id: "h1".into(),
        }));
        match tool {
            LeaseResponse::Error(e) => assert_eq!(e.code, E_LEASE_UNIMPLEMENTED),
            other => panic!("expected unimplemented error, got {other:?}"),
        }
    }

    /// T11630: the `queue_admit` verb is WIRED through the LLM queue — an admit
    /// within budget returns `admitted`; an over-budget admit returns `deferred`
    /// with a `retry_after_ms` back-off (AC4 — never a silent drop / unimplemented).
    #[test]
    fn queue_admit_is_wired_and_admits_then_defers() {
        let (arb, _dir, _p) = fixture();
        // Seed a tiny provider budget so the second admit is forced to defer.
        arb.llm_queue()
            .configure_provider("anthropic", 100, 10, 60_000);

        // First admit (lead, 80 tokens) fits → admitted.
        let first = arb.handle(LeaseRequest::QueueAdmit(QueueAdmitReq {
            provider: "anthropic".into(),
            priority_class: QueuePriorityClass::Lead,
            est_tokens: 80,
            child_id: "lead-1".into(),
        }));
        match first {
            LeaseResponse::QueueAdmitResult(r) => {
                assert_eq!(r.disposition, QueueAdmitDisposition::Admitted);
                assert_eq!(r.retry_after_ms, 0);
                assert_eq!(r.tokens_remaining, 20);
                assert!(
                    arb.llm_queue().has_in_flight_call("lead-1"),
                    "admit records the in-flight bit (watchdog seam)"
                );
            }
            other => panic!("expected admitted queue_admit_result, got {other:?}"),
        }

        // Second admit (50 tokens) exceeds the remaining 20 → deferred.
        let second = arb.handle(LeaseRequest::QueueAdmit(QueueAdmitReq {
            provider: "anthropic".into(),
            priority_class: QueuePriorityClass::Worker,
            est_tokens: 50,
            child_id: "worker-1".into(),
        }));
        match second {
            LeaseResponse::QueueAdmitResult(r) => {
                assert_eq!(r.disposition, QueueAdmitDisposition::Deferred);
                assert!(
                    r.retry_after_ms >= 1,
                    "a deferral carries a positive back-off"
                );
            }
            other => panic!("expected deferred queue_admit_result, got {other:?}"),
        }
    }

    #[test]
    fn stale_dead_pid_holder_is_reclaimed_and_killed() {
        let (arb, _dir, db_path) = fixture();
        // Plant an active row with an already-expired TTL and a pid that is dead
        // (1 is init/PID-namespace-root which is not killable by us, so use a pid
        // that is certainly dead: a very high pid value).
        let dead_pid: i32 = 2_147_483_000; // never a live pid
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.execute(
            "INSERT INTO _writer_leases \
             (scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms, reentrancy_depth, active) \
             VALUES ('project', 'tasks', 'dead-holder', ?1, 5, 0, 0, 1000, 1, 1)",
            rusqlite::params![dead_pid],
        )
        .expect("seed stale row");
        let killed = arb.reclaim_or_kill(DbScope::Project);
        assert_eq!(
            killed.len(),
            1,
            "the stale dead-pid holder must be reclaimed"
        );
        assert_eq!(killed[0].holder_id, "dead-holder");
        assert!(killed[0].reason.contains("unresponsive"));
        // The next acquire should now grant (the stale row was reclaimed).
        match arb.handle(acquire("h-new", 30_000)) {
            LeaseResponse::LeaseGranted(_) => {}
            other => panic!("expected grant after reclaim, got {other:?}"),
        }
    }

    #[test]
    fn live_holder_is_never_killed_even_past_ttl() {
        let (arb, _dir, db_path) = fixture();
        // Plant an active row that is past TTL but whose pid is THIS process (live).
        let live_pid = i32::try_from(std::process::id()).unwrap_or(1);
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.execute(
            "INSERT INTO _writer_leases \
             (scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms, reentrancy_depth, active) \
             VALUES ('project', 'tasks', 'live-holder', ?1, 5, 0, 0, 1000, 1, 1)",
            rusqlite::params![live_pid],
        )
        .expect("seed past-ttl-but-live row");
        let killed = arb.reclaim_or_kill(DbScope::Project);
        assert!(
            killed.is_empty(),
            "a live holder must never be killed (risk #4)"
        );
    }
}

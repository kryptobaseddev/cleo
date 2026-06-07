// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Supervisor core: spawn, monitor, and crash-restart a child worker.
//!
//! Ports the `StudioSupervisor` lifecycle from
//! `packages/core/src/sentient/daemon.ts`:
//!
//!   * `start()`  — spawn the child; attach a crash handler.
//!   * on crash   — wait the [`crate::backoff::Backoff`] delay, then respawn.
//!   * `stop()`   — send SIGTERM, wait the grace window, then SIGKILL.
//!
//! The child is spawned with [`tokio::process::Command`]. On Unix the child is
//! placed in its own process group and signalled via [`crate::process`]; on
//! Windows it is assigned to the supervisor's [`crate::jobobject::JobObject`] so
//! it dies when the supervisor exits.
//!
//! Reaping is owned exclusively by tokio's process driver. Every supervised
//! child is a [`tokio::process::Child`] whose exit is observed via
//! `Child::wait()` (the monitor tasks + the stop cascade); tokio registers its
//! own `SIGCHLD` handler and reaps those pids. The supervisor therefore does
//! NOT run a global `waitpid(-1)` reaper alongside `Child::wait()` — doing so
//! would race tokio's driver and steal exit statuses, surfacing as spurious
//! `ECHILD` (lost exit codes, false stop failures). See T11626.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

use crate::backoff::Backoff;
use crate::ipc::{
    ChildState, ChildStatus, LifecycleEvent, LifecycleEventKind, MonitorResult, RestartResult,
    SpawnRequest, SpawnResult,
};
use crate::jobobject::JobObject;
use crate::process;

/// Canonical environment key carrying the active CLEO session id (T11347).
///
/// Mirror of `CANONICAL_SESSION_ENV_KEY` in
/// `packages/core/src/sessions/session-id.ts`. The supervisor reads its OWN
/// value of this key at startup to learn its root session id, and passes a
/// child's value of this key through to the child VERBATIM (never rewriting it)
/// so the worker resolves exactly ONE session via `resolveSessionIdFromEnv`
/// with zero DB scan (T11629, DHQ-047 class).
///
/// # Inheritance hazard (T11629 review fix)
///
/// A spawned [`Child`] inherits the supervisor's WHOLE environment, including
/// the supervisor's own `CLEO_SESSION_ID` (its root session). If a worker
/// [`SpawnRequest`] omits its own `CLEO_SESSION_ID`, the child would otherwise
/// SILENTLY inherit the supervisor's root session as its OWN session — and
/// because the supervisor also stamps [`PARENT_SESSION_ID_ENV_KEY`] = root, the
/// worker would resolve `parent == child == root`: exactly the DHQ-047
/// session-bleed class this work dissolves. To close that latent hazard the
/// supervisor ACTIVELY NEUTRALISES the inherited value to the empty string when
/// the request carries no explicit session id AND the supervisor itself has a
/// root session (see [`ChildRegistry::stamp_fork_tree_session_env`]). An empty
/// value is treated as ABSENT by the TS `resolveSessionIdFromEnv`, so the worker
/// falls through to its own DB-resolved identity instead of inheriting the root.
pub const SESSION_ID_ENV_KEY: &str = "CLEO_SESSION_ID";

/// Canonical environment key carrying the active CLEO agent id (T11343).
///
/// Mirror of the `CLEO_AGENT_ID` key read by `resolveAgentIdFromEnv` in
/// `packages/core/src/sessions/session-id.ts`. Passed through to spawned
/// children VERBATIM alongside [`SESSION_ID_ENV_KEY`].
pub const AGENT_ID_ENV_KEY: &str = "CLEO_AGENT_ID";

/// Canonical environment key carrying the fork-tree PARENT session id (T11629).
///
/// The supervisor stamps this key into every child it spawns, set to the
/// supervisor's OWN root session id (the value of [`SESSION_ID_ENV_KEY`] in the
/// supervisor's environment at startup). The Node side reads it via
/// `resolveParentSessionIdFromEnv` to build the session fork tree, attributing
/// each worker session to the supervisor root that spawned it.
///
/// An explicit `CLEO_PARENT_SESSION_ID` already present on a [`SpawnRequest`]
/// takes precedence — the caller may override the fork-tree parent (e.g. a
/// nested orchestrator). The supervisor only stamps the default when the
/// request did not supply one.
pub const PARENT_SESSION_ID_ENV_KEY: &str = "CLEO_PARENT_SESSION_ID";

/// Read the supervisor's own root session id from its process environment
/// ([`SESSION_ID_ENV_KEY`]) (T11629).
///
/// An empty value is treated as absent (mirrors the TS
/// `resolveSessionIdFromEnv`, which skips empty-string env vars), so a
/// supervisor launched with `CLEO_SESSION_ID=""` stamps no fork-tree parent.
#[must_use]
fn read_root_session_from_env() -> Option<String> {
    match std::env::var(SESSION_ID_ENV_KEY) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// Default grace window between SIGTERM and SIGKILL when stopping a child.
///
/// Matches the 10-second grace period the TS `StudioSupervisor.stop()` uses.
pub const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(10);

/// Threshold of continuous uptime after which a child is considered healthy and
/// its backoff schedule is reset to the initial delay.
///
/// Mirrors the TS supervisor's intent to reset `currentDelay` after a stable
/// long-run (the comment references ">= 30 s uptime handled by caller").
pub const HEALTHY_UPTIME_RESET: Duration = Duration::from_secs(30);

/// Specification for a child worker the supervisor manages.
#[derive(Debug, Clone)]
pub struct ChildSpec {
    /// Logical id (stable across restarts).
    pub child_id: String,
    /// Program to execute.
    pub program: String,
    /// Program arguments.
    pub args: Vec<String>,
    /// Environment overrides layered on the supervisor's environment.
    pub env: Vec<(String, String)>,
    /// Optional working directory.
    pub cwd: Option<String>,
}

impl ChildSpec {
    /// Construct a minimal spec with no args/env/cwd.
    #[must_use]
    pub fn new(child_id: impl Into<String>, program: impl Into<String>) -> Self {
        Self {
            child_id: child_id.into(),
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
        }
    }
}

impl From<&SpawnRequest> for ChildSpec {
    /// Lower a wire [`SpawnRequest`] into the supervisor's internal [`ChildSpec`].
    ///
    /// The IPC env is a `Vec<EnvPair>` (TS-shaped) which is flattened into the
    /// `Vec<(String, String)>` the [`Command`] builder consumes.
    fn from(req: &SpawnRequest) -> Self {
        Self {
            child_id: req.child_id.clone(),
            program: req.program.clone(),
            args: req.args.clone(),
            env: req
                .env
                .iter()
                .map(|p| (p.key.clone(), p.value.clone()))
                .collect(),
            cwd: req.cwd.clone(),
        }
    }
}

/// The outcome of a child exit observed by [`Supervisor::run_once`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitObservation {
    /// Exit code if the child exited normally.
    pub code: Option<i32>,
    /// Whether the supervisor was asked to stop (expected exit).
    pub expected: bool,
    /// The backoff delay scheduled before the next restart, if any.
    pub next_restart_delay: Option<Duration>,
}

/// A managed child worker with crash-restart supervision.
pub struct Supervisor {
    spec: ChildSpec,
    backoff: Backoff,
    grace: Duration,
    job: Arc<JobObject>,
    /// Live child handle, guarded so the signal loop and the monitor loop can
    /// both observe/act on it.
    child: Arc<Mutex<Option<Child>>>,
    restart_count: u32,
    stopping: Arc<std::sync::atomic::AtomicBool>,
}

impl Supervisor {
    /// Create a supervisor for `spec` with the canonical default backoff and
    /// stop-grace window.
    ///
    /// # Errors
    ///
    /// Returns an error if the platform child-containment handle (Job Object on
    /// Windows) cannot be created.
    pub fn new(spec: ChildSpec) -> anyhow::Result<Self> {
        Ok(Self {
            spec,
            backoff: Backoff::with_defaults(),
            grace: DEFAULT_STOP_GRACE,
            job: Arc::new(JobObject::new()?),
            child: Arc::new(Mutex::new(None)),
            restart_count: 0,
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Override the backoff schedule (used by tests/harnesses).
    #[must_use]
    pub fn with_backoff(mut self, backoff: Backoff) -> Self {
        self.backoff = backoff;
        self
    }

    /// Override the stop grace window.
    #[must_use]
    pub fn with_grace(mut self, grace: Duration) -> Self {
        self.grace = grace;
        self
    }

    /// Total restarts observed so far.
    #[must_use]
    pub fn restart_count(&self) -> u32 {
        self.restart_count
    }

    /// The pid of the currently-running child, if any.
    pub async fn current_pid(&self) -> Option<u32> {
        self.child.lock().await.as_ref().and_then(Child::id)
    }

    /// Build the tokio Command for this spec, configuring the platform-specific
    /// process group / containment.
    fn build_command(&self) -> Command {
        let mut cmd = Command::new(&self.spec.program);
        cmd.args(&self.spec.args);
        for (k, v) in &self.spec.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &self.spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());
        cmd.kill_on_drop(true);

        // On Unix, put the child in its own process group so the supervisor can
        // signal the whole group and so a stray terminal signal doesn't race.
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        cmd
    }

    /// Spawn the child once and record its handle.
    ///
    /// # Errors
    ///
    /// Returns an error if the program cannot be spawned, or (on Windows) if it
    /// cannot be assigned to the Job Object.
    pub async fn spawn(&self) -> anyhow::Result<u32> {
        let mut cmd = self.build_command();
        let child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.spec.program))?;
        let pid = child.id().unwrap_or(0);
        // Bind the child to the Job Object on Windows so it dies with us.
        if pid != 0 {
            self.job.assign(pid)?;
        }
        *self.child.lock().await = Some(child);
        tracing::info!(child_id = %self.spec.child_id, pid, "spawned child");
        Ok(pid)
    }

    /// Wait for the current child to exit, returning its exit code (if any).
    ///
    /// Returns `None` immediately if there is no live child.
    ///
    /// # Errors
    ///
    /// Returns an error if waiting on the child fails.
    pub async fn wait(&self) -> anyhow::Result<Option<i32>> {
        // Take the child out so the await isn't holding the lock for its whole
        // lifetime (which would deadlock stop()).
        let mut child = match self.child.lock().await.take() {
            Some(c) => c,
            None => return Ok(None),
        };
        let status = child.wait().await?;
        Ok(status.code())
    }

    /// Reap any zombie children via a global `waitpid(-1, WNOHANG)` (Unix).
    /// No-op on Windows. Returns the count.
    ///
    /// # Caution (T11626)
    ///
    /// This is a global reaper: it harvests ANY exited child of this process,
    /// not just this supervisor's. It MUST NOT be invoked while a
    /// [`tokio::process::Child::wait`] is outstanding for the same children —
    /// tokio's process driver owns reaping for the children it spawned, and a
    /// competing `waitpid(-1)` will steal their exit status and surface as
    /// `ECHILD` from `Child::wait()`. It is retained only for reaping
    /// inadvertently-inherited grandchildren that are not tokio-managed.
    pub fn reap(&self) -> usize {
        process::reap_zombies()
    }

    /// Run one spawn→wait→(maybe schedule restart) cycle and return the
    /// observation. This is the unit the monitor loop drives repeatedly; it does
    /// NOT itself sleep for the backoff — it returns the scheduled delay so the
    /// caller (and tests) can decide whether/when to restart.
    ///
    /// # Errors
    ///
    /// Returns an error if the child cannot be spawned or waited on.
    pub async fn run_once(&mut self) -> anyhow::Result<ExitObservation> {
        self.spawn().await?;
        let started = std::time::Instant::now();
        let code = self.wait().await?;
        let expected = self.stopping.load(std::sync::atomic::Ordering::SeqCst);

        if expected {
            return Ok(ExitObservation {
                code,
                expected: true,
                next_restart_delay: None,
            });
        }

        // Unexpected exit — count it and compute the next backoff delay.
        self.restart_count = self.restart_count.saturating_add(1);

        // If the child ran long enough to be healthy, reset the backoff first so
        // a single late crash doesn't inherit a huge delay.
        if started.elapsed() >= HEALTHY_UPTIME_RESET {
            self.backoff.reset();
        }
        let delay = self.backoff.next_delay();
        tracing::warn!(
            child_id = %self.spec.child_id,
            code = ?code,
            restart_count = self.restart_count,
            delay_ms = delay.as_millis() as u64,
            "child exited unexpectedly; scheduling restart"
        );
        Ok(ExitObservation {
            code,
            expected: false,
            next_restart_delay: Some(delay),
        })
    }

    /// Run the full supervision loop until [`Supervisor::request_stop`] is
    /// called: spawn, wait, sleep the backoff, respawn.
    ///
    /// # Errors
    ///
    /// Returns an error only if a spawn/wait fails irrecoverably.
    pub async fn run_forever(&mut self) -> anyhow::Result<()> {
        loop {
            let obs = self.run_once().await?;
            if obs.expected {
                return Ok(());
            }
            match obs.next_restart_delay {
                Some(delay) => tokio::time::sleep(delay).await,
                None => return Ok(()),
            }
            if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                return Ok(());
            }
        }
    }

    /// Signal the supervision loop to stop after the current child exits.
    pub fn request_stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Stop the current child: SIGTERM, wait up to the grace window, then
    /// SIGKILL. Mirrors `StudioSupervisor.stop()`.
    ///
    /// # Errors
    ///
    /// Returns an error if waiting on the child fails.
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.request_stop();
        let pid = {
            let guard = self.child.lock().await;
            guard.as_ref().and_then(Child::id)
        };
        let Some(pid) = pid else {
            return Ok(());
        };

        // Phase 1: graceful SIGTERM.
        let _ = process::request_terminate(pid);

        // Phase 2: wait up to the grace window for a clean exit.
        let waited = tokio::time::timeout(self.grace, self.wait()).await;
        match waited {
            Ok(Ok(_)) => {
                tracing::info!(pid, "child exited within grace window");
                return Ok(());
            }
            Ok(Err(e)) => return Err(e),
            Err(_elapsed) => {
                // Phase 3: grace expired — force kill.
                tracing::warn!(pid, "grace window expired; sending SIGKILL");
                let _ = process::force_kill(pid);
                // Let tokio's process driver reap the killed child: await its
                // exit instead of a global waitpid(-1), which would race the
                // driver and steal exit statuses (T11626). The child is dead, so
                // this resolves promptly. If the wait future above already took
                // the child out of the slot it was dropped (kill_on_drop) and
                // this returns Ok(None) immediately.
                let _ = self.wait().await;
            }
        }
        Ok(())
    }
}

/// Error raised by [`ChildRegistry`] operations that target a child id.
///
/// These map onto the [`crate::ipc::ErrorResult`] codes the IPC server returns
/// to the client; the `code()` accessor yields the stable machine-readable code.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    /// The requested `child_id` is not present in the registry.
    #[error("no such child: {child_id}")]
    UnknownChild {
        /// The id that was not found.
        child_id: String,
    },
    /// A `Spawn` referenced a `child_id` that is already registered.
    #[error("child already registered: {child_id}")]
    DuplicateChild {
        /// The id that already exists.
        child_id: String,
    },
    /// Spawning (or respawning) the OS process failed.
    #[error("spawn failed for {child_id}: {source}")]
    Spawn {
        /// The affected child id.
        child_id: String,
        /// The underlying spawn error.
        #[source]
        source: anyhow::Error,
    },
}

impl RegistryError {
    /// The stable machine-readable error code for this error.
    ///
    /// Mirrors the `E_*` codes the TS contract peer expects in an
    /// [`crate::ipc::ErrorResult`].
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownChild { .. } => "E_UNKNOWN_CHILD",
            Self::DuplicateChild { .. } => "E_DUPLICATE_CHILD",
            Self::Spawn { .. } => "E_SPAWN_FAILED",
        }
    }
}

/// Shared, mutable bookkeeping for a single managed child, updated by the
/// per-child monitor task and read by `monitor`/`health` snapshots.
#[derive(Debug)]
struct ChildBook {
    /// OS pid of the currently-running incarnation (0 when not running).
    pid: u32,
    /// Current liveness state.
    state: ChildState,
    /// Total restarts observed for this child.
    restart_count: u32,
    /// Monotonic incarnation token (T11626). Incremented on every (re)spawn so
    /// each monitor task can identify the exact incarnation it supervises. A
    /// monitor only writes its exit into the book when `generation` still equals
    /// the value captured at its spawn — otherwise a newer incarnation already
    /// replaced it, and the stale monitor must not clobber the live child.
    generation: u64,
}

/// One supervised child in a [`ChildRegistry`].
///
/// Owns the immutable spec, the platform containment handle, and the shared
/// [`ChildBook`] the monitor task mutates. The live [`Child`] handle itself is
/// moved into the detached monitor task on each spawn so a concurrent `restart`
/// can replace it without contending for the OS wait.
struct ManagedChild {
    spec: ChildSpec,
    job: Arc<JobObject>,
    book: Arc<Mutex<ChildBook>>,
}

/// A registry of supervised children keyed by logical `child_id`.
///
/// Generalizes the single-[`ChildSpec`] [`Supervisor`] into the multi-child
/// surface the IPC command channel drives (T11253): `Spawn`/`Restart`/`Monitor`/
/// `Health` map onto registry operations. Every unexpected child exit and every
/// restart is broadcast as a [`LifecycleEvent`] over the supplied event sender,
/// which the IPC server forwards to all connected clients via the
/// [`crate::ipc_transport::Fanout`] codec.
///
/// Cloning a registry yields another handle to the same underlying state, so the
/// accept loop and per-client tasks can share one registry cheaply.
#[derive(Clone)]
pub struct ChildRegistry {
    children: Arc<Mutex<HashMap<String, ManagedChild>>>,
    events: UnboundedSender<LifecycleEvent>,
    started_at: std::time::Instant,
    /// The supervisor's OWN root session id, captured at construction from the
    /// [`SESSION_ID_ENV_KEY`] env var. Stamped as [`PARENT_SESSION_ID_ENV_KEY`]
    /// (the fork-tree parent) onto every spawned child unless the request
    /// already carries an explicit parent. `None` when the supervisor was
    /// launched without a session id in its environment (T11629).
    root_session_id: Option<String>,
}

impl ChildRegistry {
    /// Create an empty registry that publishes lifecycle events on `events`.
    ///
    /// Captures the supervisor's root session id from the process environment
    /// ([`SESSION_ID_ENV_KEY`]) so it can be stamped as the fork-tree parent on
    /// every child this registry spawns (T11629).
    #[must_use]
    pub fn new(events: UnboundedSender<LifecycleEvent>) -> Self {
        Self::with_root_session(events, read_root_session_from_env())
    }

    /// Create an empty registry with an explicit root session id, bypassing the
    /// process-environment read.
    ///
    /// This is the seam tests use to assert the stamped fork-tree parent
    /// deterministically without mutating the shared process environment
    /// (T11629). Production code uses [`ChildRegistry::new`].
    #[must_use]
    pub fn with_root_session(
        events: UnboundedSender<LifecycleEvent>,
        root_session_id: Option<String>,
    ) -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
            events,
            started_at: std::time::Instant::now(),
            root_session_id,
        }
    }

    /// The supervisor's root session id (the fork-tree parent stamped onto
    /// children), if one was present in the environment at construction.
    #[must_use]
    pub fn root_session_id(&self) -> Option<&str> {
        self.root_session_id.as_deref()
    }

    /// Resolve the fork-tree session environment a child must see, stamping the
    /// parent edge AND closing the inherited-session bleed hazard (T11629).
    ///
    /// A spawned [`Child`] inherits the supervisor's whole environment, so the
    /// supervisor's own `CLEO_SESSION_ID` (root session) leaks into every child
    /// unless explicitly overridden. This method mutates the child's env override
    /// list to enforce BOTH halves of the fork-tree contract:
    ///
    /// ## Parent edge ([`PARENT_SESSION_ID_ENV_KEY`])
    ///
    ///   * If the request ALREADY carries an explicit `CLEO_PARENT_SESSION_ID`
    ///     override, it is left untouched — the caller's declared fork-tree
    ///     parent wins (e.g. a nested orchestrator chains its own root through).
    ///   * Otherwise, when the supervisor has a root session id, append
    ///     `CLEO_PARENT_SESSION_ID=<root>` so the worker's session is attributed
    ///     to the supervisor root that spawned it.
    ///   * When the supervisor has no root session id, nothing is stamped.
    ///
    /// ## Child session anti-bleed (review fix)
    ///
    /// The verbatim pass-through key `CLEO_SESSION_ID` is NEVER rewritten when the
    /// request supplies it — an explicit worker session flows through byte-for-
    /// byte. But when the request OMITS `CLEO_SESSION_ID` and the supervisor HAS a
    /// root session, the child would otherwise inherit the supervisor's root as
    /// its OWN session (yielding `parent == child == root` — the DHQ-047 bleed).
    /// To prevent that the supervisor appends `CLEO_SESSION_ID=""` (empty), which
    /// `resolveSessionIdFromEnv` treats as ABSENT, so the worker resolves its own
    /// DB-backed identity instead of silently adopting the supervisor's session.
    ///
    /// `CLEO_AGENT_ID` is left to flow through unchanged either way: agent
    /// identity is not the bleed vector and an inherited agent id is benign.
    fn stamp_fork_tree_session_env(&self, env: &mut Vec<(String, String)>) {
        // --- Parent edge ---
        let parent_present = env.iter().any(|(k, _)| k == PARENT_SESSION_ID_ENV_KEY);
        if !parent_present
            && let Some(root) = &self.root_session_id
        {
            env.push((PARENT_SESSION_ID_ENV_KEY.to_string(), root.clone()));
        }

        // --- Child session anti-bleed ---
        // Only neutralise the inherited root when (a) the supervisor actually has
        // a root session that WOULD leak, and (b) the request did not declare its
        // own session. An explicit worker `CLEO_SESSION_ID` is honoured verbatim.
        let session_present = env.iter().any(|(k, _)| k == SESSION_ID_ENV_KEY);
        if !session_present && self.root_session_id.is_some() {
            env.push((SESSION_ID_ENV_KEY.to_string(), String::new()));
        }
    }

    /// Number of children currently tracked (running or restarting).
    pub async fn len(&self) -> usize {
        self.children.lock().await.len()
    }

    /// Whether the registry currently tracks no children.
    pub async fn is_empty(&self) -> bool {
        self.children.lock().await.is_empty()
    }

    /// Spawn a new child from a wire [`SpawnRequest`] and begin supervising it.
    ///
    /// Registers the child, launches the OS process, attaches a detached monitor
    /// task that emits a [`LifecycleEventKind::ChildExited`] event when the
    /// process exits, and returns the assigned pid.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::DuplicateChild`] if `child_id` is already
    /// registered, or [`RegistryError::Spawn`] if the OS process cannot start.
    pub async fn spawn(&self, req: &SpawnRequest) -> Result<SpawnResult, RegistryError> {
        let child_id = req.child_id.clone();
        {
            let children = self.children.lock().await;
            if children.contains_key(&child_id) {
                return Err(RegistryError::DuplicateChild { child_id });
            }
        }

        let mut spec = ChildSpec::from(req);
        // Resolve the fork-tree session env before the spec is stored, so it is
        // reapplied verbatim on every restart too (T11629). This stamps the
        // parent edge AND, when the request omits its own session, neutralises
        // the supervisor's inherited CLEO_SESSION_ID so the worker cannot bleed
        // the root as its own identity. An explicit worker CLEO_SESSION_ID /
        // CLEO_AGENT_ID flows through ChildSpec::from unmodified.
        self.stamp_fork_tree_session_env(&mut spec.env);
        let job = Arc::new(JobObject::new().map_err(|e| RegistryError::Spawn {
            child_id: child_id.clone(),
            source: anyhow::Error::new(e),
        })?);
        // Generation 0 is the initial incarnation; each restart bumps it.
        let generation = 0u64;
        let book = Arc::new(Mutex::new(ChildBook {
            pid: 0,
            state: ChildState::Running,
            restart_count: 0,
            generation,
        }));

        let child = Self::spawn_process(&spec, &job).map_err(|source| RegistryError::Spawn {
            child_id: child_id.clone(),
            source,
        })?;
        let pid = child.id().unwrap_or(0);
        book.lock().await.pid = pid;

        let managed = ManagedChild {
            spec: spec.clone(),
            job: Arc::clone(&job),
            book: Arc::clone(&book),
        };
        self.children.lock().await.insert(child_id.clone(), managed);

        self.spawn_monitor(child_id.clone(), child, Arc::clone(&book), generation);
        tracing::info!(child_id = %child_id, pid, "registry spawned child");
        Ok(SpawnResult { child_id, pid })
    }

    /// Restart a registered child: stop the current incarnation, spawn a fresh
    /// one, bump the restart counter, and broadcast a
    /// [`LifecycleEventKind::ChildRestarted`] event.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::UnknownChild`] if `child_id` is not registered,
    /// or [`RegistryError::Spawn`] if the replacement process cannot start.
    pub async fn restart(&self, child_id: &str) -> Result<RestartResult, RegistryError> {
        let (spec, job, book) = {
            let children = self.children.lock().await;
            let managed = children
                .get(child_id)
                .ok_or_else(|| RegistryError::UnknownChild {
                    child_id: child_id.to_string(),
                })?;
            (
                managed.spec.clone(),
                Arc::clone(&managed.job),
                Arc::clone(&managed.book),
            )
        };

        // Terminate the running incarnation (best-effort) so the replacement has
        // a clean slate. The old monitor task observes the exit and would emit a
        // child_exited event; mark the book Restarting first so that exit is not
        // misread as an unexpected crash by snapshots taken mid-restart.
        let old_pid = {
            let mut guard = book.lock().await;
            guard.state = ChildState::Restarting;
            guard.pid
        };
        if old_pid != 0 {
            let _ = process::request_terminate(old_pid);
            let _ = process::force_kill(old_pid);
        }

        let child = Self::spawn_process(&spec, &job).map_err(|source| RegistryError::Spawn {
            child_id: child_id.to_string(),
            source,
        })?;
        let pid = child.id().unwrap_or(0);

        let (restart_count, generation) = {
            let mut guard = book.lock().await;
            guard.restart_count = guard.restart_count.saturating_add(1);
            guard.pid = pid;
            guard.state = ChildState::Running;
            // Bump the incarnation so the new monitor owns a fresh generation and
            // the old monitor (still blocked on the killed child's wait()) can no
            // longer write into the book (T11626).
            guard.generation = guard.generation.saturating_add(1);
            (guard.restart_count, guard.generation)
        };

        self.spawn_monitor(child_id.to_string(), child, Arc::clone(&book), generation);

        let _ = self.events.send(LifecycleEvent {
            event: LifecycleEventKind::ChildRestarted,
            child_id: child_id.to_string(),
            exit_code: None,
            signal: None,
            restart_delay_ms: None,
        });
        tracing::info!(child_id = %child_id, pid, restart_count, "registry restarted child");
        Ok(RestartResult {
            child_id: child_id.to_string(),
            pid,
            restart_count,
        })
    }

    /// Produce a monitor snapshot for one child (when `child_id` is `Some`) or
    /// for all children (when `None`).
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::UnknownChild`] when a specific `child_id` is
    /// requested but not registered.
    pub async fn monitor(
        &self,
        child_id: Option<&str>,
    ) -> Result<MonitorResult, RegistryError> {
        let children = self.children.lock().await;
        match child_id {
            Some(id) => {
                let managed = children
                    .get(id)
                    .ok_or_else(|| RegistryError::UnknownChild {
                        child_id: id.to_string(),
                    })?;
                Ok(MonitorResult {
                    children: vec![status_of(id, managed).await],
                })
            }
            None => {
                let mut rows = Vec::with_capacity(children.len());
                for (id, managed) in children.iter() {
                    rows.push(status_of(id, managed).await);
                }
                Ok(MonitorResult { children: rows })
            }
        }
    }

    /// Number of children currently tracked, for the health snapshot.
    pub async fn child_count(&self) -> u32 {
        u32::try_from(self.children.lock().await.len()).unwrap_or(u32::MAX)
    }

    /// Seconds since this registry was constructed (supervisor uptime).
    #[must_use]
    pub fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Build the platform-configured [`Command`] and spawn it, assigning the
    /// child to the containment [`JobObject`] (Windows) where applicable.
    fn spawn_process(spec: &ChildSpec, job: &JobObject) -> anyhow::Result<Child> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());
        cmd.kill_on_drop(true);
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        let child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", spec.program))?;
        if let Some(pid) = child.id()
            && pid != 0
        {
            job.assign(pid)?;
        }
        Ok(child)
    }

    /// Attach a detached task that waits for `child` to exit, records the exit on
    /// the shared [`ChildBook`], and broadcasts a `child_exited`
    /// [`LifecycleEvent`].
    ///
    /// The task ends after a single exit; a restart spawns a fresh monitor for
    /// the replacement incarnation, so each task supervises exactly one OS
    /// process lifetime.
    ///
    /// `generation` is the incarnation token captured when this monitor was
    /// spawned (T11626). The monitor only writes the `Stopped`/`pid = 0`
    /// transition when the book still carries that same generation. A concurrent
    /// `restart` bumps the generation before this (now-stale) monitor's
    /// `child.wait()` returns, so the late exit of the killed incarnation cannot
    /// clobber the freshly-restarted child to `Stopped`/`pid = 0`. Comparing the
    /// generation (not the coarse `state` enum) is what makes the guard
    /// incarnation-aware: the new incarnation's state is also `Running`, so a
    /// state-only check would mis-fire.
    fn spawn_monitor(
        &self,
        child_id: String,
        mut child: Child,
        book: Arc<Mutex<ChildBook>>,
        generation: u64,
    ) {
        let events = self.events.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            let code = status.ok().and_then(|s| s.code());
            // Only record the exit when this monitor still owns the live
            // incarnation. If a restart already bumped the generation, a newer
            // monitor owns the book and this stale exit must not touch it.
            let is_current = {
                let mut guard = book.lock().await;
                if guard.generation == generation {
                    if matches!(guard.state, ChildState::Running) {
                        guard.state = ChildState::Stopped;
                        guard.pid = 0;
                    }
                    true
                } else {
                    false
                }
            };
            if is_current {
                let _ = events.send(LifecycleEvent {
                    event: LifecycleEventKind::ChildExited,
                    child_id: child_id.clone(),
                    exit_code: code,
                    signal: None,
                    restart_delay_ms: None,
                });
                tracing::info!(child_id = %child_id, code = ?code, "registry child exited");
            } else {
                // Stale incarnation exit (superseded by a restart) — record it
                // for diagnostics but do not emit a child_exited event or mutate
                // the book; the live incarnation continues running.
                tracing::debug!(
                    child_id = %child_id,
                    code = ?code,
                    generation,
                    "ignoring exit of superseded child incarnation"
                );
            }
        });
    }
}

/// Snapshot a single managed child into its wire [`ChildStatus`].
async fn status_of(child_id: &str, managed: &ManagedChild) -> ChildStatus {
    let guard = managed.book.lock().await;
    ChildStatus {
        child_id: child_id.to_string(),
        pid: guard.pid,
        state: guard.state,
        restart_count: guard.restart_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn true_program() -> &'static str {
        if cfg!(windows) { "cmd" } else { "/bin/sh" }
    }

    /// Path to the always-available `true` binary on the host. macOS ships it at
    /// `/usr/bin/true` (no `/bin/true`), Linux at `/bin/true`; probe the
    /// canonical macOS path first and fall back to the Linux path.
    fn true_cmd() -> &'static str {
        if std::path::Path::new("/usr/bin/true").exists() {
            "/usr/bin/true"
        } else {
            "/bin/true"
        }
    }

    fn sleep_spec(id: &str, secs: u64) -> ChildSpec {
        // A portable short-lived child: `sh -c 'sleep N'` on unix.
        if cfg!(windows) {
            ChildSpec {
                child_id: id.into(),
                program: "cmd".into(),
                args: vec!["/C".into(), format!("timeout /T {secs} /NOBREAK")],
                env: vec![],
                cwd: None,
            }
        } else {
            ChildSpec {
                child_id: id.into(),
                program: "/bin/sh".into(),
                args: vec!["-c".into(), format!("sleep {secs}")],
                env: vec![],
                cwd: None,
            }
        }
    }

    #[tokio::test]
    async fn spawns_and_reports_pid() {
        let _ = true_program();
        let sup = Supervisor::new(sleep_spec("t", 30)).expect("new");
        let pid = sup.spawn().await.expect("spawn");
        assert!(pid > 0);
        assert!(process::is_alive(pid));
        sup.stop().await.expect("stop");
    }

    #[tokio::test]
    async fn unexpected_exit_schedules_backoff() {
        // A child that exits immediately triggers a restart schedule.
        let spec = if cfg!(windows) {
            ChildSpec {
                child_id: "fast".into(),
                program: "cmd".into(),
                args: vec!["/C".into(), "exit 3".into()],
                env: vec![],
                cwd: None,
            }
        } else {
            ChildSpec {
                child_id: "fast".into(),
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "exit 3".into()],
                env: vec![],
                cwd: None,
            }
        };
        let mut sup = Supervisor::new(spec).expect("new");
        let obs = sup.run_once().await.expect("run_once");
        assert!(!obs.expected);
        assert_eq!(sup.restart_count(), 1);
        // First backoff delay is the initial 1s.
        assert_eq!(
            obs.next_restart_delay,
            Some(Duration::from_millis(crate::backoff::INITIAL_RESTART_DELAY_MS))
        );
    }

    #[tokio::test]
    async fn stop_terminates_running_child_within_grace() {
        let sup = Supervisor::new(sleep_spec("long", 60))
            .expect("new")
            .with_grace(Duration::from_secs(5));
        let pid = sup.spawn().await.expect("spawn");
        assert!(process::is_alive(pid));
        sup.stop().await.expect("stop");
        // After stop, the child should no longer be alive (SIGTERM honoured).
        // Give the OS a brief moment to reap.
        for _ in 0..50 {
            if !process::is_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!process::is_alive(pid), "child should be dead after stop()");
    }

    // ── ChildRegistry (R2) ──────────────────────────────────────────────────

    use crate::ipc::{EnvPair, LifecycleEventKind};
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    fn spawn_req_sleep(child_id: &str, secs: u64) -> SpawnRequest {
        if cfg!(windows) {
            SpawnRequest {
                child_id: child_id.into(),
                program: "cmd".into(),
                args: vec!["/C".into(), format!("ping 127.0.0.1 -n {} >NUL", secs + 1)],
                env: vec![],
                cwd: None,
            }
        } else {
            SpawnRequest {
                child_id: child_id.into(),
                program: "/bin/sh".into(),
                args: vec!["-c".into(), format!("sleep {secs}")],
                env: vec![],
                cwd: None,
            }
        }
    }

    fn spawn_req_true(child_id: &str) -> SpawnRequest {
        if cfg!(windows) {
            SpawnRequest {
                child_id: child_id.into(),
                program: "cmd".into(),
                args: vec!["/C".into(), "exit 0".into()],
                env: vec![],
                cwd: None,
            }
        } else {
            SpawnRequest {
                child_id: child_id.into(),
                program: true_cmd().into(),
                args: vec![],
                env: vec![],
                cwd: None,
            }
        }
    }

    /// Drain a single lifecycle event from the channel with a timeout so a
    /// missing broadcast fails fast instead of hanging the test.
    async fn next_event(rx: &mut UnboundedReceiver<LifecycleEvent>) -> LifecycleEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for a lifecycle event")
            .expect("event channel closed unexpectedly")
    }

    #[test]
    fn spawn_request_lowers_into_child_spec() {
        let req = SpawnRequest {
            child_id: "w".into(),
            program: "/bin/echo".into(),
            args: vec!["hi".into()],
            env: vec![EnvPair {
                key: "K".into(),
                value: "V".into(),
            }],
            cwd: Some("/tmp".into()),
        };
        let spec = ChildSpec::from(&req);
        assert_eq!(spec.child_id, "w");
        assert_eq!(spec.program, "/bin/echo");
        assert_eq!(spec.args, vec!["hi".to_string()]);
        assert_eq!(spec.env, vec![("K".to_string(), "V".to_string())]);
        assert_eq!(spec.cwd, Some("/tmp".to_string()));
    }

    #[tokio::test]
    async fn registry_spawn_registers_and_reports_pid() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let result = registry
            .spawn(&spawn_req_sleep("w1", 30))
            .await
            .expect("spawn");
        assert_eq!(result.child_id, "w1");
        assert!(result.pid > 0);
        assert_eq!(registry.len().await, 1);
        assert!(!registry.is_empty().await);
        assert!(process::is_alive(result.pid));
        // Clean up the long-lived child.
        let _ = process::force_kill(result.pid);
    }

    #[tokio::test]
    async fn registry_duplicate_spawn_is_rejected() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let first = registry.spawn(&spawn_req_sleep("dup", 30)).await.expect("spawn");
        let err = registry
            .spawn(&spawn_req_sleep("dup", 30))
            .await
            .expect_err("duplicate child id must be rejected");
        assert_eq!(err.code(), "E_DUPLICATE_CHILD");
        let _ = process::force_kill(first.pid);
    }

    #[tokio::test]
    async fn registry_exit_broadcasts_child_exited_event() {
        let (tx, mut rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        registry.spawn(&spawn_req_true("quick")).await.expect("spawn");
        // `true` exits immediately — expect a child_exited event.
        let event = next_event(&mut rx).await;
        assert_eq!(event.event, LifecycleEventKind::ChildExited);
        assert_eq!(event.child_id, "quick");
    }

    #[tokio::test]
    async fn registry_restart_bumps_count_and_broadcasts_event() {
        let (tx, mut rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let first = registry
            .spawn(&spawn_req_sleep("svc", 30))
            .await
            .expect("spawn");
        let restarted = registry.restart("svc").await.expect("restart");
        assert_eq!(restarted.child_id, "svc");
        assert_eq!(restarted.restart_count, 1);
        assert_ne!(restarted.pid, first.pid, "restart must yield a fresh pid");

        // The channel carries a child_exited (from the killed first incarnation)
        // and a child_restarted; assert child_restarted is observed.
        let mut saw_restarted = false;
        for _ in 0..4 {
            let event = next_event(&mut rx).await;
            if event.event == LifecycleEventKind::ChildRestarted {
                assert_eq!(event.child_id, "svc");
                saw_restarted = true;
                break;
            }
        }
        assert!(saw_restarted, "restart must broadcast a child_restarted event");
        let _ = process::force_kill(restarted.pid);
    }

    #[tokio::test]
    async fn registry_restart_unknown_child_errors() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let err = registry
            .restart("nope")
            .await
            .expect_err("unknown child restart must error");
        assert_eq!(err.code(), "E_UNKNOWN_CHILD");
    }

    /// Regression (T11626): after a restart, the OLD monitor task (still blocked
    /// on the SIGKILL-ed first incarnation's `wait()`) must not clobber the live
    /// NEW incarnation to `Stopped`/pid=0. The incarnation generation guard makes
    /// the stale exit a no-op. Repeated restarts maximise the chance the stale
    /// monitor wins the book lock after the generation bump; the live child must
    /// always be reported `Running` with the current pid.
    #[tokio::test]
    async fn registry_restart_does_not_let_stale_monitor_clobber_new_child() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        registry
            .spawn(&spawn_req_sleep("race", 30))
            .await
            .expect("spawn");

        let mut last_pid = 0u32;
        for _ in 0..5 {
            let restarted = registry.restart("race").await.expect("restart");
            last_pid = restarted.pid;

            // Give the stale old monitor ample opportunity to observe its killed
            // child's exit and (incorrectly) try to write into the book.
            for _ in 0..10 {
                let snap = registry.monitor(Some("race")).await.expect("monitor");
                let row = &snap.children[0];
                assert_eq!(
                    row.state,
                    ChildState::Running,
                    "live restarted child must stay Running, not be clobbered by the stale monitor"
                );
                assert_eq!(
                    row.pid, restarted.pid,
                    "live restarted child pid must not be zeroed by the stale monitor"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        let _ = process::force_kill(last_pid);
    }

    #[tokio::test]
    async fn registry_monitor_all_and_one() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let a = registry.spawn(&spawn_req_sleep("a", 30)).await.expect("spawn a");
        let b = registry.spawn(&spawn_req_sleep("b", 30)).await.expect("spawn b");

        let all = registry.monitor(None).await.expect("monitor all");
        assert_eq!(all.children.len(), 2);

        let one = registry.monitor(Some("a")).await.expect("monitor a");
        assert_eq!(one.children.len(), 1);
        assert_eq!(one.children[0].child_id, "a");
        assert_eq!(one.children[0].state, ChildState::Running);

        let missing = registry
            .monitor(Some("zzz"))
            .await
            .expect_err("monitor of unknown child errors");
        assert_eq!(missing.code(), "E_UNKNOWN_CHILD");

        let _ = process::force_kill(a.pid);
        let _ = process::force_kill(b.pid);
    }

    #[tokio::test]
    async fn registry_health_counts_children() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        assert_eq!(registry.child_count().await, 0);
        let w = registry.spawn(&spawn_req_sleep("h", 30)).await.expect("spawn");
        assert_eq!(registry.child_count().await, 1);
        let _ = process::force_kill(w.pid);
    }

    // ── Session-env stamping + verbatim passthrough (T11629) ────────────────

    /// Build a spawn request whose child dumps the three session env vars it
    /// actually sees (one per line, in order: session, agent, parent) into
    /// `out_path`, then exits. Reading the file back proves what env the
    /// supervisor handed the child VERBATIM.
    #[cfg(unix)]
    fn spawn_req_dump_env(
        child_id: &str,
        out_path: &std::path::Path,
        env: Vec<EnvPair>,
    ) -> SpawnRequest {
        let script = format!(
            "printf '%s\\n%s\\n%s\\n' \"$CLEO_SESSION_ID\" \"$CLEO_AGENT_ID\" \"$CLEO_PARENT_SESSION_ID\" > {}",
            out_path.display()
        );
        SpawnRequest {
            child_id: child_id.into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script],
            env,
            cwd: None,
        }
    }

    /// Wait (bounded) for the child's env-dump file to materialise, then return
    /// its three lines: (session, agent, parent).
    #[cfg(unix)]
    async fn read_dumped_env(out_path: &std::path::Path) -> (String, String, String) {
        for _ in 0..200 {
            if let Ok(contents) = std::fs::read_to_string(out_path) {
                let mut lines = contents.lines();
                let session = lines.next().unwrap_or_default().to_string();
                let agent = lines.next().unwrap_or_default().to_string();
                let parent = lines.next().unwrap_or_default().to_string();
                return (session, agent, parent);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("child never wrote its env dump file at {}", out_path.display());
    }

    /// AC(a): the supervisor passes the stamped `CLEO_SESSION_ID` /
    /// `CLEO_AGENT_ID` env block through to the spawned child VERBATIM — no
    /// filtering, no rewrite. The child observes the EXACT values the request
    /// carried.
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_passes_session_env_to_child_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("env.txt");
        let (tx, _rx) = unbounded_channel();
        // Registry with NO root session, so the parent stamp does not interfere
        // with the verbatim-passthrough assertion.
        let registry = ChildRegistry::with_root_session(tx, None);

        let want_session = "ses_20260607150503_7962a8";
        let want_agent = "agent-t11629";
        let req = spawn_req_dump_env(
            "verbatim",
            &out,
            vec![
                EnvPair {
                    key: "CLEO_SESSION_ID".into(),
                    value: want_session.into(),
                },
                EnvPair {
                    key: "CLEO_AGENT_ID".into(),
                    value: want_agent.into(),
                },
            ],
        );
        registry.spawn(&req).await.expect("spawn");

        let (session, agent, parent) = read_dumped_env(&out).await;
        assert_eq!(
            session, want_session,
            "CLEO_SESSION_ID must reach the child byte-for-byte"
        );
        assert_eq!(
            agent, want_agent,
            "CLEO_AGENT_ID must reach the child byte-for-byte"
        );
        // No root session on the registry and no explicit parent on the request,
        // so the child sees an empty parent.
        assert_eq!(parent, "", "no parent should be stamped without a root session");
    }

    /// AC(b): the supervisor's OWN root session id is stamped onto the child as
    /// `CLEO_PARENT_SESSION_ID` (the fork-tree parent), while the child's own
    /// `CLEO_SESSION_ID` still passes through verbatim.
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_stamps_root_session_as_parent_on_child() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("env.txt");
        let (tx, _rx) = unbounded_channel();
        let root = "ses_20260607150503_7962a8";
        let registry = ChildRegistry::with_root_session(tx, Some(root.into()));
        assert_eq!(registry.root_session_id(), Some(root));

        let want_session = "ses_20260607151111_abcdef";
        let req = spawn_req_dump_env(
            "forked",
            &out,
            vec![EnvPair {
                key: "CLEO_SESSION_ID".into(),
                value: want_session.into(),
            }],
        );
        registry.spawn(&req).await.expect("spawn");

        let (session, _agent, parent) = read_dumped_env(&out).await;
        assert_eq!(session, want_session, "worker session passes through verbatim");
        assert_eq!(
            parent, root,
            "supervisor root session must become the child's CLEO_PARENT_SESSION_ID"
        );
    }

    /// Review-fix regression END-TO-END (T11629, DHQ-047 class): the supervisor
    /// HAS a root session and the worker request OMITS its own `CLEO_SESSION_ID`.
    /// The spawned child must NOT silently inherit the supervisor's root session
    /// as its own — the observed `CLEO_SESSION_ID` must be EMPTY (neutralised),
    /// distinct from the `CLEO_PARENT_SESSION_ID` (which is the root). This is the
    /// exact interaction the prior verbatim test side-stepped with
    /// `with_root_session(tx, None)`.
    ///
    /// The neutralising stamp (`CLEO_SESSION_ID=""`) is applied as an explicit env
    /// override on the child [`Command`]; an explicit override always wins over
    /// the inherited value, so the child observes the empty string regardless of
    /// what `CLEO_SESSION_ID` the supervisor process itself carries. The test
    /// therefore does not (and must not — the crate forbids `unsafe`) mutate this
    /// process's global environment; the pure-transform companion test
    /// `stamp_fork_tree_session_env_neutralises_inherited_root_when_request_omits_session`
    /// proves the override is appended, and this test proves it reaches the child.
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_does_not_bleed_root_session_into_child_omitting_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("env.txt");
        let (tx, _rx) = unbounded_channel();
        let root = "ses_20260607150503_7962a8";

        let registry = ChildRegistry::with_root_session(tx, Some(root.into()));
        // Request carries NO CLEO_SESSION_ID (only an agent id), mirroring a
        // fork-tree worker spawn that forgot to declare its own session.
        let req = spawn_req_dump_env(
            "no-session",
            &out,
            vec![EnvPair {
                key: "CLEO_AGENT_ID".into(),
                value: "agent-z".into(),
            }],
        );
        registry.spawn(&req).await.expect("spawn");

        let (session, agent, parent) = read_dumped_env(&out).await;

        assert_eq!(
            session, "",
            "child must NOT inherit the supervisor root as its own session (DHQ-047 bleed)"
        );
        assert_ne!(
            session, root,
            "neutralised child session must differ from the supervisor root"
        );
        assert_eq!(agent, "agent-z", "explicit agent id still flows through");
        assert_eq!(
            parent, root,
            "the root is the fork-tree PARENT, not the child's own session"
        );
    }

    /// AC(b) override: an explicit `CLEO_PARENT_SESSION_ID` on the request takes
    /// precedence — the supervisor does NOT clobber a caller-declared fork-tree
    /// parent with its own root.
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_explicit_parent_session_overrides_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("env.txt");
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::with_root_session(tx, Some("ses_root_aaaa".into()));

        let explicit_parent = "ses_explicit_bbbb";
        let req = spawn_req_dump_env(
            "explicit",
            &out,
            vec![EnvPair {
                key: "CLEO_PARENT_SESSION_ID".into(),
                value: explicit_parent.into(),
            }],
        );
        registry.spawn(&req).await.expect("spawn");

        let (_session, _agent, parent) = read_dumped_env(&out).await;
        assert_eq!(
            parent, explicit_parent,
            "an explicit request parent must win over the supervisor root"
        );
    }

    /// `stamp_fork_tree_session_env` is a pure transform on the env override
    /// list: it appends the parent only when absent, honours an explicit worker
    /// session verbatim, and no-ops the parent stamp without a root session.
    #[test]
    fn stamp_fork_tree_session_env_is_idempotent_and_non_destructive() {
        let (tx, _rx) = unbounded_channel();

        // With a root session AND an explicit worker session: appends the parent,
        // preserves existing keys, and does NOT neutralise the explicit session.
        let with_root = ChildRegistry::with_root_session(tx.clone(), Some("ses_root".into()));
        let mut env = vec![
            ("CLEO_SESSION_ID".to_string(), "ses_child".to_string()),
            ("CLEO_AGENT_ID".to_string(), "agent-x".to_string()),
        ];
        with_root.stamp_fork_tree_session_env(&mut env);
        assert_eq!(
            env,
            vec![
                ("CLEO_SESSION_ID".to_string(), "ses_child".to_string()),
                ("CLEO_AGENT_ID".to_string(), "agent-x".to_string()),
                ("CLEO_PARENT_SESSION_ID".to_string(), "ses_root".to_string()),
            ]
        );

        // Explicit parent already present: left untouched (no duplicate). The
        // request also carries its own session, so no neutralising stamp.
        let mut env2 = vec![
            ("CLEO_SESSION_ID".to_string(), "ses_child".to_string()),
            (
                "CLEO_PARENT_SESSION_ID".to_string(),
                "ses_explicit".to_string(),
            ),
        ];
        with_root.stamp_fork_tree_session_env(&mut env2);
        assert_eq!(
            env2,
            vec![
                ("CLEO_SESSION_ID".to_string(), "ses_child".to_string()),
                (
                    "CLEO_PARENT_SESSION_ID".to_string(),
                    "ses_explicit".to_string()
                ),
            ]
        );

        // No root session: no parent stamp AND no neutralising stamp (nothing
        // would leak, so the inherited session — if any — is the caller's own).
        let no_root = ChildRegistry::with_root_session(tx, None);
        let mut env3 = vec![("CLEO_AGENT_ID".to_string(), "agent-x".to_string())];
        no_root.stamp_fork_tree_session_env(&mut env3);
        assert_eq!(
            env3,
            vec![("CLEO_AGENT_ID".to_string(), "agent-x".to_string())]
        );
    }

    /// Review-fix regression (T11629, DHQ-047 class): when the supervisor HAS a
    /// root session and the worker request OMITS its own `CLEO_SESSION_ID`, the
    /// supervisor MUST neutralise the inherited root to an empty string so the
    /// child cannot silently resolve `parent == child == root`. The pure
    /// transform exercises the env mutation without spawning a process.
    #[test]
    fn stamp_fork_tree_session_env_neutralises_inherited_root_when_request_omits_session() {
        let (tx, _rx) = unbounded_channel();
        let with_root = ChildRegistry::with_root_session(tx, Some("ses_root".into()));

        // Request omits CLEO_SESSION_ID entirely (only an agent id present).
        let mut env = vec![("CLEO_AGENT_ID".to_string(), "agent-y".to_string())];
        with_root.stamp_fork_tree_session_env(&mut env);
        assert_eq!(
            env,
            vec![
                ("CLEO_AGENT_ID".to_string(), "agent-y".to_string()),
                // Parent edge stamped to the root...
                ("CLEO_PARENT_SESSION_ID".to_string(), "ses_root".to_string()),
                // ...and the inherited root session NEUTRALISED to empty so the
                // worker does not adopt the supervisor's session as its own.
                ("CLEO_SESSION_ID".to_string(), String::new()),
            ]
        );
    }

    /// The fork-tree parent stamp survives a restart: the replacement
    /// incarnation is spawned from the SAME stored spec (stamped once at the
    /// initial spawn), so the parent env is reapplied verbatim.
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_parent_stamp_persists_across_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("env.txt");
        let (tx, _rx) = unbounded_channel();
        let root = "ses_root_restart";
        let registry = ChildRegistry::with_root_session(tx, Some(root.into()));

        // A long-lived child so the first incarnation is still around to restart.
        let script = format!(
            "printf '%s\\n%s\\n%s\\n' \"$CLEO_SESSION_ID\" \"$CLEO_AGENT_ID\" \"$CLEO_PARENT_SESSION_ID\" > {}; sleep 30",
            out.display()
        );
        let req = SpawnRequest {
            child_id: "restartable".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script],
            env: vec![EnvPair {
                key: "CLEO_SESSION_ID".into(),
                value: "ses_worker".into(),
            }],
            cwd: None,
        };
        registry.spawn(&req).await.expect("spawn");
        let (_s1, _a1, parent1) = read_dumped_env(&out).await;
        assert_eq!(parent1, root);

        // Restart and re-read the (overwritten) dump file.
        std::fs::remove_file(&out).ok();
        let restarted = registry.restart("restartable").await.expect("restart");
        let (_s2, _a2, parent2) = read_dumped_env(&out).await;
        assert_eq!(
            parent2, root,
            "restarted incarnation must still carry the fork-tree parent"
        );
        let _ = process::force_kill(restarted.pid);
    }
}

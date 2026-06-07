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
}

impl ChildRegistry {
    /// Create an empty registry that publishes lifecycle events on `events`.
    #[must_use]
    pub fn new(events: UnboundedSender<LifecycleEvent>) -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
            events,
            started_at: std::time::Instant::now(),
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

        let spec = ChildSpec::from(req);
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
                program: "/bin/true".into(),
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
        // /bin/true exits immediately — expect a child_exited event.
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
}

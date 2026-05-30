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
//! it dies when the supervisor exits. SIGCHLD-driven zombie reaping is wired in
//! the binary's signal loop ([`crate::run`]); this module exposes
//! [`Supervisor::reap`] for it to call.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::backoff::Backoff;
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

    /// Reap any zombie children (Unix). No-op on Windows. Returns the count.
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
                // Best-effort final reap.
                let _ = self.reap();
            }
        }
        Ok(())
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
}

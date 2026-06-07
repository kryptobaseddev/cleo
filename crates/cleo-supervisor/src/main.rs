// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! `cleo-supervisor` binary entrypoint.
//!
//! Parses the minimal R1 CLI surface (`--version` / `--help`, T11337 AC5) and,
//! when run with no flags, boots the supervisor runtime: acquire the pidfile
//! under the CLEO home, initialize rolling-file logging, bind the IPC listener +
//! accept loop feeding the multi-child registry (R2, T11253), and install the
//! SIGTERM/SIGINT graceful-shutdown signal loop (T11338 AC3).
//!
//! NOTE (T11626): every supervised child is a [`tokio::process::Child`] whose
//! exit is observed via `Child::wait()` (registry monitor tasks + the stop
//! cascade). tokio's process driver installs its own `SIGCHLD` handler and owns
//! reaping for those pids. Running an additional global `waitpid(-1, WNOHANG)`
//! reaper here would race tokio's driver and steal exit statuses, surfacing as
//! spurious `ECHILD` from `Child::wait()` (lost exit codes, false stop
//! failures). The signal loop therefore does NOT reap; tokio owns it.

// Tests in this binary may freely unwrap/expect/panic (matches the lib crate).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::process::ExitCode;

use cleo_supervisor::{HELP_TEXT, pidfile::Pidfile, version_line};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_cli(&args) {
        CliAction::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        CliAction::Help => {
            print!("{HELP_TEXT}");
            ExitCode::SUCCESS
        }
        CliAction::Unknown(opt) => {
            eprintln!("cleo-supervisor: unknown option '{opt}'");
            eprint!("{HELP_TEXT}");
            ExitCode::from(2)
        }
        CliAction::Run => match run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("cleo-supervisor: {e:#}");
                ExitCode::FAILURE
            }
        },
    }
}

/// The action the CLI resolves to from its arguments.
#[derive(Debug, PartialEq, Eq)]
enum CliAction {
    /// Print version + platform and exit.
    Version,
    /// Print help and exit.
    Help,
    /// An unrecognized option was supplied.
    Unknown(String),
    /// No (recognized) flags — boot the supervisor runtime.
    Run,
}

/// Resolve the CLI action from arguments.
///
/// The R1 surface is single-flag: the first argument decides the action
/// (`--version` / `--help` / unknown); no arguments boots the runtime. Pure so
/// it is unit-tested.
fn parse_cli(args: &[String]) -> CliAction {
    match args.first().map(String::as_str) {
        None => CliAction::Run,
        Some("-V" | "--version") => CliAction::Version,
        Some("-h" | "--help") => CliAction::Help,
        Some(other) => CliAction::Unknown(other.to_string()),
    }
}

/// Boot the supervisor runtime: pidfile, logging, IPC accept loop, signal loop.
///
/// R1 stood up the lifecycle primitives; R2 (T11253) finishes the IPC loop. After
/// the pidfile + logging are in place this binds the IPC listener and runs its
/// accept loop concurrently with the shutdown-signal loop: clients drive the
/// multi-child registry over the supervisor-ipc fan-out channel until a
/// SIGTERM/SIGINT (or Ctrl-C) requests a graceful stop.
fn run() -> anyhow::Result<()> {
    // Acquire the pidfile before doing anything else — refuse double-launch.
    let pidfile_path = cleo_supervisor::paths::pidfile_path()?;
    let pidfile = Pidfile::acquire(&pidfile_path)
        .map_err(|e| anyhow::anyhow!("cannot acquire supervisor pidfile: {e}"))?;

    // Initialize rolling-file logging under <cleo_home>/logs.
    let log_dir = cleo_supervisor::paths::log_dir()?;
    let _log_guard = cleo_supervisor::logging::init(&log_dir)?;

    tracing::info!(
        version = cleo_supervisor::VERSION,
        triple = cleo_supervisor::platform_triple(),
        pid = pidfile.pid(),
        pidfile = %pidfile_path.display(),
        log_dir = %log_dir.display(),
        "cleo-supervisor started"
    );

    // Run the IPC accept loop + signal loop on a current-thread tokio runtime.
    // The supervisor is I/O-bound and a single reactor is sufficient.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let socket_path = cleo_supervisor::paths::socket_path()?;
    runtime.block_on(serve_until_shutdown(&socket_path))?;

    tracing::info!("cleo-supervisor shutting down");
    // Best-effort: remove the IPC socket file so the next launch binds cleanly.
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&socket_path);
    }
    // Dropping `pidfile` removes the pidfile; dropping `_log_guard` flushes logs.
    drop(pidfile);
    Ok(())
}

/// Bind the IPC listener + accept loop and run it concurrently with the
/// shutdown-signal loop, returning when a shutdown signal is received (or the
/// accept loop fails irrecoverably).
async fn serve_until_shutdown(socket_path: &std::path::Path) -> anyhow::Result<()> {
    use cleo_supervisor::ipc_server;
    use cleo_supervisor::supervisor::ChildRegistry;

    // Lifecycle events flow registry -> IPC fan-out over this channel.
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    let registry = ChildRegistry::new(event_tx);

    tokio::select! {
        // The accept loop only returns on an unrecoverable transport error;
        // surface it so the process exits non-zero.
        res = ipc_server::serve(socket_path, registry, event_rx) => {
            res.map_err(|e| anyhow::anyhow!("supervisor IPC serve loop failed: {e}"))?;
        }
        // Graceful shutdown wins the race on SIGTERM/SIGINT/Ctrl-C.
        res = signal_loop() => {
            res?;
        }
    }
    Ok(())
}

/// Wait for a shutdown signal (SIGTERM/SIGINT on Unix, Ctrl-C on Windows).
///
/// This loop deliberately does NOT install a `SIGCHLD` reaper (T11626). Every
/// supervised child is a [`tokio::process::Child`] reaped by tokio's own
/// process driver; a competing global `waitpid(-1, WNOHANG)` would steal those
/// exit statuses and make `Child::wait()` fail with `ECHILD`. Letting tokio own
/// reaping keeps exit codes intact and the stop cascade correct.
async fn signal_loop() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sigint = signal(SignalKind::interrupt())?;
        tokio::select! {
            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM");
            }
            _ = sigint.recv() => {
                tracing::info!("received SIGINT");
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        tracing::info!("received Ctrl-C");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_args_runs() {
        assert_eq!(parse_cli(&[]), CliAction::Run);
    }

    #[test]
    fn version_and_help_flags_are_recognized() {
        for flag in ["-V", "--version"] {
            assert_eq!(parse_cli(&[flag.to_string()]), CliAction::Version);
        }
        for flag in ["-h", "--help"] {
            assert_eq!(parse_cli(&[flag.to_string()]), CliAction::Help);
        }
    }

    #[test]
    fn unknown_flag_is_reported() {
        assert_eq!(
            parse_cli(&["--bogus".to_string()]),
            CliAction::Unknown("--bogus".to_string())
        );
    }
}

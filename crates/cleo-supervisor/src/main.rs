// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! `cleo-supervisor` binary entrypoint.
//!
//! Parses the minimal R1 CLI surface (`--version` / `--help`, T11337 AC5) and,
//! when run with no flags, boots the supervisor runtime: acquire the pidfile
//! under the CLEO home, initialize rolling-file logging, and install the
//! SIGTERM/SIGINT graceful-shutdown + SIGCHLD reaping signal loop (T11338 AC3).

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

/// Boot the supervisor runtime: pidfile, logging, signal loop.
///
/// R1 stands up the lifecycle primitives. The IPC command surface (spawning
/// children on request) is consumed by R2 (T11253); here the process simply
/// holds the pidfile and waits for a shutdown signal, demonstrating the
/// pidfile + logging + graceful-shutdown integration end-to-end.
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

    // Run the signal loop on a current-thread tokio runtime. The supervisor is
    // I/O-bound and a single reactor is sufficient for R1.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(signal_loop())?;

    tracing::info!("cleo-supervisor shutting down");
    // Dropping `pidfile` removes the pidfile; dropping `_log_guard` flushes logs.
    drop(pidfile);
    Ok(())
}

/// Wait for a shutdown signal (SIGTERM/SIGINT on Unix, Ctrl-C on Windows),
/// reaping any zombie children on SIGCHLD in the meantime (Unix).
async fn signal_loop() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sigint = signal(SignalKind::interrupt())?;
        let mut sigchld = signal(SignalKind::child())?;
        loop {
            tokio::select! {
                _ = sigterm.recv() => {
                    tracing::info!("received SIGTERM");
                    break;
                }
                _ = sigint.recv() => {
                    tracing::info!("received SIGINT");
                    break;
                }
                _ = sigchld.recv() => {
                    let reaped = cleo_supervisor::process::reap_zombies();
                    if reaped > 0 {
                        tracing::debug!(reaped, "reaped zombie children on SIGCHLD");
                    }
                }
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

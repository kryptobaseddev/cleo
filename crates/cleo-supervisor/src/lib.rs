// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! `cleo-supervisor` — native Rust process supervisor for CLEO.
//!
//! This crate is the R1 foundation of the SG-RUNTIME-UNIFICATION saga (T11243 /
//! epic T11252). It ports the proven `StudioSupervisor` shape from
//! `packages/core/src/sentient/daemon.ts` to tokio/Rust:
//!
//!   * [`pidfile`]    — atomic tmp-then-rename pidfile + stale-pid detection.
//!   * [`backoff`]    — exponential restart backoff capped at 30s.
//!   * [`process`]    — SIGTERM/SIGKILL + SIGCHLD reaping (Unix) / liveness (all).
//!   * [`jobobject`]  — Windows Job Object child containment.
//!   * [`supervisor`] — spawn/monitor/crash-restart + SIGTERM→grace→SIGKILL.
//!   * [`logging`]    — `tracing-appender` rolling file logs under the cleo log dir.
//!   * [`ipc`]        — FROZEN v1.0 supervisor-ipc contract (mirror of the Zod schemas).
//!   * [`ipc_transport`] — Unix-socket / Windows-pipe NDJSON fan-out.
//!
//! The binary ([`main`](../main.rs)) is distributed as a standalone executable via
//! the worktree-napi-style cross-compile + GitHub-Release packaging (T11340),
//! NOT as a napi `.node` addon and NOT as a Bun process (decision D8').

// Tests may freely unwrap/expect/panic — the workspace denies these in
// non-test code (see root Cargo.toml `[workspace.lints.clippy]`), mirroring the
// `#![cfg_attr(test, …)]` pattern used by the other workspace crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod backoff;
pub mod ipc;
pub mod ipc_transport;
pub mod jobobject;
pub mod logging;
pub mod paths;
pub mod pidfile;
pub mod process;
pub mod supervisor;

/// Crate version, sourced from `Cargo.toml` at build time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A stable platform identifier string.
///
/// Examples: `linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`. Matches the
/// triple naming used by the worktree-napi loader so the napi distribution
/// picker (T11340) and `--version` output agree.
#[must_use]
pub fn platform_triple() -> &'static str {
    // os.
    #[cfg(target_os = "linux")]
    let os = "linux";
    #[cfg(target_os = "macos")]
    let os = "darwin";
    #[cfg(target_os = "windows")]
    let os = "win32";
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let os = "unknown";

    // arch.
    #[cfg(target_arch = "x86_64")]
    let arch = "x64";
    #[cfg(target_arch = "aarch64")]
    let arch = "arm64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let arch = "unknown";

    match (os, arch) {
        ("linux", "x64") => "linux-x64-gnu",
        ("linux", "arm64") => "linux-arm64-gnu",
        ("darwin", "x64") => "darwin-x64",
        ("darwin", "arm64") => "darwin-arm64",
        ("win32", "x64") => "win32-x64-msvc",
        _ => "unknown",
    }
}

/// Format the `--version` line: name, semver, and platform triple.
#[must_use]
pub fn version_line() -> String {
    format!(
        "cleo-supervisor {VERSION} ({} / {})",
        platform_triple(),
        ipc::IPC_PROTOCOL_VERSION
    )
}

/// The help text printed for `--help`. Intentionally minimal for R1 (T11337
/// AC5: a no-op help); subcommands land in later epics.
pub const HELP_TEXT: &str = "\
cleo-supervisor — native Rust process supervisor for CLEO

USAGE:
    cleo-supervisor [OPTIONS]

OPTIONS:
    -V, --version    Print version and platform, then exit
    -h, --help       Print this help, then exit

When run with no options the supervisor acquires its pidfile under the CLEO
home directory, initializes rolling-file logging, and (in later epics) hosts the
supervisor-ipc fan-out channel. R1 wires the lifecycle primitives; the IPC
command surface is consumed by R2 (T11253).
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_contains_triple_and_protocol() {
        let line = version_line();
        assert!(line.contains(VERSION));
        assert!(line.contains(platform_triple()));
        assert!(line.contains(ipc::IPC_PROTOCOL_VERSION));
    }

    #[test]
    fn platform_triple_is_known_on_supported_targets() {
        // On the supported CI targets this must never be "unknown".
        let t = platform_triple();
        if cfg!(any(target_os = "linux", target_os = "macos", target_os = "windows"))
            && cfg!(any(target_arch = "x86_64", target_arch = "aarch64"))
        {
            assert_ne!(t, "unknown", "supported target should map to a triple");
        }
    }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Idle-RSS measurement harness (T11341 AC1).
//!
//! Starts the `cleo-supervisor` binary with NO clients connected, waits 60
//! seconds, and asserts steady-state resident set size (RSS) is <= 15 MB. The
//! daemon is a long-lived host singleton; a leaking idle footprint would
//! accumulate across every machine running CLEO, so this is a hard CI budget.
//!
//! Because the 60s settle makes this expensive, the full-duration test is
//! marked `#[ignore]` so a normal `cargo test` stays fast. CI runs it
//! explicitly via `cargo test -p cleo-supervisor --test idle_rss -- --ignored`
//! on Linux x64, Linux arm64, and macOS arm64. A fast variant
//! (`idle_rss_smoke`) runs unconditionally with a short settle to catch gross
//! regressions in the default test command.
//!
//! Local run:
//! ```bash
//! cargo test -p cleo-supervisor --test idle_rss -- --ignored --nocapture
//! ```

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// The committed idle-RSS budget: 15 MB at steady state with no clients.
const MAX_IDLE_RSS_BYTES: u64 = 15 * 1024 * 1024;

/// Path to the freshly-built supervisor binary for this test run.
fn supervisor_bin() -> &'static str {
    env!("CARGO_BIN_EXE_cleo-supervisor")
}

/// Read a process's RSS (bytes) cross-platform.
///
/// Linux: parse `VmRSS` from `/proc/<pid>/status` (kB). macOS: `ps -o rss= -p`
/// (kB). Returns `None` if the process is gone or RSS can't be read.
fn read_rss_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("VmRSS:") {
                let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kb * 1024);
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        Some(kb * 1024)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Spawn the supervisor in an isolated `CLEO_HOME`, wait `settle`, measure RSS,
/// then SIGTERM it. Returns the measured RSS in bytes.
fn measure_idle_rss(settle: Duration, home: &Path) -> u64 {
    let mut child = Command::new(supervisor_bin())
        .env("CLEO_HOME", home)
        // Quiet logs; the daemon writes to <home>/logs regardless.
        .env("CLEO_LOG", "warn")
        .spawn()
        .expect("spawn supervisor");
    let pid = child.id();

    // Let the process reach steady state with no clients connected.
    std::thread::sleep(settle);

    let rss = read_rss_bytes(pid).unwrap_or_else(|| {
        // If the process died, that is a failure to report distinctly.
        panic!("could not read RSS for supervisor pid {pid} — did it exit early?");
    });

    // Graceful shutdown.
    #[cfg(unix)]
    {
        // SIGTERM via kill(2) through the same primitive the supervisor honours.
        let _ = cleo_supervisor::process::request_terminate(pid);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
    rss
}

/// Fast smoke variant — short settle so the default `cargo test` catches gross
/// idle-footprint regressions without the full 60s wait.
#[test]
fn idle_rss_smoke() {
    let dir = tempfile::tempdir().expect("tempdir");
    let rss = measure_idle_rss(Duration::from_secs(2), dir.path());
    println!("idle RSS (2s settle): {} bytes ({} KB)", rss, rss / 1024);
    assert!(
        rss <= MAX_IDLE_RSS_BYTES,
        "idle RSS {rss} bytes exceeds the {MAX_IDLE_RSS_BYTES}-byte budget after a short settle"
    );
}

/// Full T11341 AC1 budget: 60s settle, no clients, RSS <= 15 MB. `#[ignore]`d so
/// it only runs when explicitly requested (CI runs it on the 3-target matrix).
#[test]
#[ignore = "60s settle — run explicitly via `-- --ignored` (CI matrix)"]
fn idle_rss_60s_under_15mb() {
    let dir = tempfile::tempdir().expect("tempdir");
    let rss = measure_idle_rss(Duration::from_secs(60), dir.path());
    println!("idle RSS (60s settle): {} bytes ({} KB)", rss, rss / 1024);
    assert!(
        rss <= MAX_IDLE_RSS_BYTES,
        "idle RSS {rss} bytes exceeds the {MAX_IDLE_RSS_BYTES}-byte (15 MB) budget at 60s"
    );
}

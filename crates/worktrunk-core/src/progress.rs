// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Progress reporting surface for long-running file-walk operations.
//!
//! This SDK ships a zero-cost stub by default — every `record` call is a no-op,
//! no thread is spawned, and no allocation is performed. Consumers that want a
//! live TTY spinner should wrap [`Progress`] in their own renderer (the
//! `CleoCode` CLI does this in `packages/cleo`; the napi binding [E4 / T9981]
//! exposes a callback hook).
//!
//! The donor's crossterm-driven spinner was intentionally dropped from the
//! SDK to keep dependencies CLI-free and to make the type safe to construct
//! from non-TTY contexts (CI runners, napi worker threads, embedded calls
//! inside `cleo orchestrate spawn`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// Live progress reporter for a directory walk.
///
/// Internally aggregates per-leaf byte counts using lock-free atomics so
/// [`Progress::record`] is safe to call from any thread. Use
/// [`Progress::disabled`] for the zero-cost no-op variant (recommended for
/// non-interactive callers).
#[derive(Clone)]
pub struct Progress(Option<Arc<Shared>>);

struct Shared {
    files: AtomicUsize,
    bytes: AtomicU64,
}

impl Progress {
    /// Construct a disabled reporter — every `record` call is a no-op and no
    /// counters are kept. This is the default for napi consumers and for
    /// background callers in `cleo orchestrate spawn`.
    #[must_use]
    pub fn disabled() -> Self {
        Self(None)
    }

    /// Construct an enabled reporter that aggregates files-and-bytes counters
    /// for later inspection via [`Progress::snapshot`].
    ///
    /// This does NOT render to a TTY — it just tracks counters. CLI consumers
    /// that want a spinner should layer their own renderer over this surface.
    #[must_use]
    pub fn counting() -> Self {
        Self(Some(Arc::new(Shared {
            files: AtomicUsize::new(0),
            bytes: AtomicU64::new(0),
        })))
    }

    /// Record one processed leaf. Safe to call from any thread.
    pub fn record(&self, bytes: u64) {
        if let Some(shared) = &self.0 {
            shared.files.fetch_add(1, Ordering::Relaxed);
            shared.bytes.fetch_add(bytes, Ordering::Relaxed);
        }
    }

    /// Snapshot the current counters as `(files, bytes)`. Returns `(0, 0)`
    /// when this reporter is [`Progress::disabled`].
    #[must_use]
    pub fn snapshot(&self) -> (usize, u64) {
        match &self.0 {
            Some(shared) => (
                shared.files.load(Ordering::Relaxed),
                shared.bytes.load(Ordering::Relaxed),
            ),
            None => (0, 0),
        }
    }

    /// Stop tracking — currently a no-op; kept as the surface the donor API
    /// exposed so downstream calls stay source-compatible if/when a renderer
    /// is layered on top.
    pub fn finish(self) {
        drop(self);
    }
}

impl Default for Progress {
    fn default() -> Self {
        Self::disabled()
    }
}

/// Format a byte count using IEC binary prefixes (KiB, MiB, GiB, TiB).
///
/// Uses 1024 as the divisor so the rendering matches the units the donor
/// reports in summary lines and tests.
#[must_use]
pub fn format_bytes(n: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB", "TiB"];
    let mut size = n as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} {}", UNITS[unit])
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// Format a `(N files · X MiB)` parenthetical for summary output.
///
/// Returns an empty string when `files == 0` so callers can unconditionally
/// concatenate it to a success message.
#[must_use]
pub fn format_stats_paren(files: usize, bytes: u64) -> String {
    if files == 0 {
        return String::new();
    }
    let word = if files == 1 { "file" } else { "files" };
    format!(
        " ({} {word} · {})",
        format_count(files),
        format_bytes(bytes)
    )
}

/// Render an integer with thousands separators (`1234567` → `1,234,567`).
#[must_use]
pub fn format_count(n: usize) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_record_is_noop() {
        let p = Progress::disabled();
        p.record(1_000_000);
        p.record(2_000_000);
        assert_eq!(p.snapshot(), (0, 0));
    }

    #[test]
    fn counting_aggregates_across_records() {
        let p = Progress::counting();
        p.record(1024);
        p.record(2048);
        p.record(0);
        assert_eq!(p.snapshot(), (3, 3072));
    }

    #[test]
    fn counting_is_clone_share_safe() {
        let p = Progress::counting();
        let p2 = p.clone();
        std::thread::scope(|s| {
            s.spawn(|| p.record(100));
            s.spawn(|| p2.record(200));
        });
        let (files, bytes) = p.snapshot();
        assert_eq!(files, 2);
        assert_eq!(bytes, 300);
    }

    #[test]
    fn test_format_count() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(42), "42");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000), "1,000");
        assert_eq!(format_count(12_345), "12,345");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KiB");
        assert_eq!(format_bytes(1_536), "1.5 KiB");
        assert_eq!(format_bytes(1_048_576), "1.0 MiB");
        assert_eq!(format_bytes(1_610_612_736), "1.5 GiB");
    }

    #[test]
    fn test_format_stats_paren_empty_is_blank() {
        assert_eq!(format_stats_paren(0, 0), "");
    }

    #[test]
    fn test_format_stats_paren_singular() {
        let s = format_stats_paren(1, 42);
        assert!(s.contains("1 file"));
        assert!(s.contains("42 B"));
    }

    #[test]
    fn test_format_stats_paren_plural() {
        let s = format_stats_paren(2_500, 5 * 1024 * 1024);
        assert!(s.contains("2,500 files"));
        assert!(s.contains("5.0 MiB"));
    }
}

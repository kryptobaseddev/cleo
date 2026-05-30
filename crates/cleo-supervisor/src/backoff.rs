// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Exponential restart-backoff schedule.
//!
//! Ports the `StudioSupervisor` backoff shape from
//! `packages/core/src/sentient/daemon.ts`:
//!
//! ```text
//! STUDIO_INITIAL_RESTART_DELAY_MS = 1_000
//! STUDIO_MAX_RESTART_DELAY_MS     = 30_000
//! // on each crash: delay = min(delay * 2, max)
//! ```
//!
//! The schedule is intentionally a pure value type with no I/O so it can be
//! unit-tested deterministically (T11338 AC5, T11341 AC5 assert the delays).

use std::time::Duration;

/// Initial restart delay after the first crash (1 second).
///
/// Matches `STUDIO_INITIAL_RESTART_DELAY_MS` in the TS reference.
pub const INITIAL_RESTART_DELAY_MS: u64 = 1_000;

/// Maximum restart delay — caps the exponential backoff at 30 seconds.
///
/// Matches `STUDIO_MAX_RESTART_DELAY_MS` in the TS reference. Prevents a
/// tight-looping crash from consuming resources.
pub const MAX_RESTART_DELAY_MS: u64 = 30_000;

/// A deterministic exponential-backoff schedule for crash restarts.
///
/// The current delay starts at [`INITIAL_RESTART_DELAY_MS`] and doubles on each
/// [`Backoff::next_delay`] call, saturating at [`MAX_RESTART_DELAY_MS`]. After a
/// child has run long enough to be considered healthy, the supervisor calls
/// [`Backoff::reset`] to return the schedule to its initial delay (mirroring the
/// TS supervisor's intent to reset after a stable long-run uptime).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    initial_ms: u64,
    max_ms: u64,
    current_ms: u64,
}

impl Backoff {
    /// Construct a backoff schedule with explicit initial and max delays.
    ///
    /// `initial_ms` is clamped to be at least 1 so the schedule always makes
    /// progress; `max_ms` is clamped to be at least `initial_ms`.
    #[must_use]
    pub fn new(initial_ms: u64, max_ms: u64) -> Self {
        let initial = initial_ms.max(1);
        let max = max_ms.max(initial);
        Self {
            initial_ms: initial,
            max_ms: max,
            current_ms: initial,
        }
    }

    /// Construct a backoff schedule using the canonical CLEO defaults
    /// ([`INITIAL_RESTART_DELAY_MS`] → [`MAX_RESTART_DELAY_MS`]).
    #[must_use]
    pub fn with_defaults() -> Self {
        Self::new(INITIAL_RESTART_DELAY_MS, MAX_RESTART_DELAY_MS)
    }

    /// Return the delay to wait before the next restart, then advance the
    /// schedule (double the delay, saturating at the configured maximum).
    ///
    /// The returned value is the delay for *this* restart; the internal state is
    /// updated for the subsequent call. This matches the TS supervisor, which
    /// schedules a restart at `currentDelay` and then sets
    /// `currentDelay = min(currentDelay * 2, maxDelay)`.
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.current_ms;
        self.current_ms = self.current_ms.saturating_mul(2).min(self.max_ms);
        Duration::from_millis(delay)
    }

    /// Peek at the delay that the next [`Backoff::next_delay`] call will return,
    /// without advancing the schedule.
    #[must_use]
    pub fn peek_delay(&self) -> Duration {
        Duration::from_millis(self.current_ms)
    }

    /// Reset the schedule back to its initial delay after a healthy run.
    pub fn reset(&mut self) {
        self.current_ms = self.initial_ms;
    }

    /// The configured maximum delay in milliseconds.
    #[must_use]
    pub fn max_ms(&self) -> u64 {
        self.max_ms
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_schedule_doubles_and_caps_at_30s() {
        let mut b = Backoff::with_defaults();
        // 1s, 2s, 4s, 8s, 16s, then cap at 30s (32s would exceed the cap).
        let expected_ms = [1_000u64, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
        for want in expected_ms {
            assert_eq!(b.next_delay(), Duration::from_millis(want));
        }
    }

    #[test]
    fn reset_returns_to_initial() {
        let mut b = Backoff::with_defaults();
        let _ = b.next_delay(); // -> 1s, current becomes 2s
        let _ = b.next_delay(); // -> 2s, current becomes 4s
        b.reset();
        assert_eq!(b.peek_delay(), Duration::from_millis(INITIAL_RESTART_DELAY_MS));
        assert_eq!(b.next_delay(), Duration::from_millis(1_000));
    }

    #[test]
    fn custom_schedule_respects_clamping() {
        // initial=0 clamps to 1; max below initial clamps up to initial.
        let mut b = Backoff::new(0, 0);
        assert_eq!(b.max_ms(), 1);
        assert_eq!(b.next_delay(), Duration::from_millis(1));
        assert_eq!(b.next_delay(), Duration::from_millis(1));
    }

    #[test]
    fn peek_does_not_advance() {
        let mut b = Backoff::with_defaults();
        assert_eq!(b.peek_delay(), Duration::from_millis(1_000));
        assert_eq!(b.peek_delay(), Duration::from_millis(1_000));
        assert_eq!(b.next_delay(), Duration::from_millis(1_000));
        assert_eq!(b.peek_delay(), Duration::from_millis(2_000));
    }

    #[test]
    fn never_exceeds_max_across_many_crashes() {
        let mut b = Backoff::with_defaults();
        for _ in 0..100 {
            assert!(b.next_delay() <= Duration::from_millis(MAX_RESTART_DELAY_MS));
        }
    }
}

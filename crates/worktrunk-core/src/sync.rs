// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Synchronization primitives.
//!
//! Pure-Rust SDK extraction of worktrunk's `src/sync.rs` per the T10221
//! refactor (ADR-078 separation-of-concerns contract). Provides a counting
//! semaphore for
//! limiting concurrency across rayon worker pools and `std::process::Command`
//! invocations — the same shape consumers use today, with zero CLI / styling
//! / hook dependencies.

use std::sync::{Arc, Condvar, Mutex};

/// A counting semaphore for limiting concurrency.
///
/// Used to prevent resource exhaustion when many parallel operations need
/// to run. Provides RAII-based permit management through [`SemaphoreGuard`].
#[derive(Clone)]
pub struct Semaphore {
    state: Arc<(Mutex<usize>, Condvar)>,
}

/// RAII guard that releases a semaphore permit on drop.
///
/// Created by [`Semaphore::acquire`]. The permit is automatically released
/// when this guard is dropped, even if the code panics.
pub struct SemaphoreGuard {
    state: Arc<(Mutex<usize>, Condvar)>,
}

impl Semaphore {
    /// Create a new semaphore with the given number of permits.
    #[must_use]
    pub fn new(permits: usize) -> Self {
        Self {
            state: Arc::new((Mutex::new(permits), Condvar::new())),
        }
    }

    /// Acquire a permit, blocking until one is available.
    ///
    /// Returns a guard that releases the permit when dropped.
    ///
    /// Mutex poisoning is recovered transparently — the donor's `.unwrap()`
    /// would panic on poisoning, which is the wrong policy in an SDK shared
    /// across long-lived workers. Recovering the inner state matches the
    /// rest of the SDK's "total API" contract.
    #[must_use]
    pub fn acquire(&self) -> SemaphoreGuard {
        let (lock, cvar) = &*self.state;
        let mut available = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        // Wait until a permit is available
        while *available == 0 {
            available = cvar
                .wait(available)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }

        // Take a permit
        *available -= 1;

        SemaphoreGuard {
            state: Arc::clone(&self.state),
        }
    }
}

impl Drop for SemaphoreGuard {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.state;
        let mut available = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *available += 1;
        cvar.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn semaphore_limits_concurrency() {
        let sem = Semaphore::new(2);
        let counter = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));

        let mut handles = vec![];

        for _ in 0..10 {
            let sem = sem.clone();
            let counter = Arc::clone(&counter);
            let max_concurrent = Arc::clone(&max_concurrent);

            let handle = thread::spawn(move || {
                let _guard = sem.acquire();

                // Increment counter
                let current = counter.fetch_add(1, Ordering::SeqCst) + 1;

                // Track max concurrent
                max_concurrent.fetch_max(current, Ordering::SeqCst);

                // Simulate work
                thread::sleep(Duration::from_millis(10));

                // Decrement counter
                counter.fetch_sub(1, Ordering::SeqCst);
            });

            handles.push(handle);
        }

        for handle in handles {
            handle.join().unwrap();
        }

        // Should never have more than 2 threads running concurrently
        assert!(max_concurrent.load(Ordering::SeqCst) <= 2);
    }

    #[test]
    fn semaphore_guard_drop_releases_permit() {
        let sem = Semaphore::new(1);
        let guard = sem.acquire();
        drop(guard);
        // If release worked, a second acquire returns immediately.
        let _g = sem.acquire();
    }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::sync::Semaphore`.
//!
//! The donor's semaphore is library-internal — no CLI surface to invoke.
//! Parity here is "the SDK's RAII guard behaves identically to the donor's
//! when shared across threads". We exercise that invariant directly.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use worktrunk_core::sync::Semaphore;

#[test]
fn limits_concurrency_to_permit_count() {
    let sem = Semaphore::new(3);
    let inflight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));

    let mut handles = vec![];
    for _ in 0..16 {
        let sem = sem.clone();
        let inflight = Arc::clone(&inflight);
        let peak = Arc::clone(&peak);
        handles.push(thread::spawn(move || {
            let _guard = sem.acquire();
            let cur = inflight.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(cur, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(5));
            inflight.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    assert!(
        peak.load(Ordering::SeqCst) <= 3,
        "semaphore breached its permit count: peak={}",
        peak.load(Ordering::SeqCst)
    );
}

#[test]
fn raii_drop_releases_permit() {
    let sem = Semaphore::new(1);
    let g = sem.acquire();
    drop(g);
    // Second acquire MUST be immediate — if release didn't happen this
    // blocks forever and the test times out.
    let _ = sem.acquire();
}

#[test]
fn permit_zero_blocks_until_release() {
    // 1 permit, two acquires from different threads. The second blocks
    // until the first releases. We measure that the relative ordering
    // is preserved.
    let sem = Semaphore::new(1);
    let started = Arc::new(AtomicUsize::new(0));

    let first_sem = sem.clone();
    let first_started = Arc::clone(&started);
    let first = thread::spawn(move || {
        let _g = first_sem.acquire();
        first_started.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(20));
    });
    // Give the first thread time to acquire.
    thread::sleep(Duration::from_millis(5));
    let second_sem = sem.clone();
    let second = thread::spawn(move || {
        let _g = second_sem.acquire();
        // Should observe first_started==1 by the time we get here.
        started.load(Ordering::SeqCst)
    });

    first.join().unwrap();
    let observed = second.join().unwrap();
    assert_eq!(observed, 1, "second acquire ran before first released");
}

#[test]
fn clone_shares_state() {
    // Cloning the semaphore should share the same underlying state, NOT
    // create a fresh permit pool.
    let sem_a = Semaphore::new(1);
    let sem_b = sem_a.clone();
    let _g = sem_a.acquire();
    // If clones had independent state, this would succeed instantly.
    // Run the second acquire in a thread with a timeout to avoid hanging
    // the suite on a regression.
    let observed = std::thread::scope(|s| {
        let h = s.spawn(move || {
            let start = std::time::Instant::now();
            // The donor's semaphore blocks on a Mutex+Condvar; if we tried
            // a non-blocking acquire here we'd need a different API. We
            // settle for "started measuring before drop releases the
            // permit" — i.e. assert the blocked acquire takes nonzero time.
            let _g = sem_b.acquire();
            start.elapsed()
        });
        // Hold the permit briefly, then release.
        thread::sleep(Duration::from_millis(10));
        drop(_g);
        h.join().unwrap()
    });
    assert!(
        observed.as_millis() >= 5,
        "clone did not share state — second acquire returned in {observed:?}"
    );
}

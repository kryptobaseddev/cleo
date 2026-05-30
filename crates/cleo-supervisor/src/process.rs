// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Cross-platform process primitives: pid liveness, graceful termination, and
//! zombie reaping (Unix) / Job-Object containment (Windows).
//!
//! These are the OS-specific building blocks the supervisor uses to implement
//! the SIGTERM→grace→SIGKILL cascade (AC3 of T11338) and to refuse a
//! double-launch when a live pid already owns the pidfile (AC1).
//!
//! On Unix, `is_alive` uses `kill(pid, 0)` (the same liveness probe the TS lock
//! uses via `process.kill(pid, 0)`); termination uses `SIGTERM`/`SIGKILL` and
//! zombies are reaped with a non-blocking `waitpid`.
//!
//! On Windows there is no signal model: the supervisor instead places every
//! child in a **Job Object** configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so the children are torn down when the
//! supervisor's handle to the job closes (i.e. when the supervisor dies),
//! which is the closest analogue to the Unix process-group cascade.

/// Return the current process's pid.
#[must_use]
pub fn current_pid() -> u32 {
    std::process::id()
}

#[cfg(unix)]
mod imp {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, kill};
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    use nix::unistd::Pid;

    /// Probe whether `pid` refers to a live process via `kill(pid, 0)`.
    #[must_use]
    pub fn is_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let target = Pid::from_raw(pid as i32);
        match kill(target, None) {
            Ok(()) => true,
            // EPERM means the process exists but we may not signal it — still alive.
            Err(Errno::EPERM) => true,
            Err(_) => false,
        }
    }

    /// Send `SIGTERM` to `pid` requesting a graceful shutdown.
    ///
    /// Returns `true` if the signal was delivered (or the process was already
    /// gone), `false` on an unexpected error.
    #[must_use]
    pub fn request_terminate(pid: u32) -> bool {
        signal(pid, Signal::SIGTERM)
    }

    /// Send `SIGKILL` to `pid`, forcibly terminating it.
    ///
    /// Returns `true` if the signal was delivered (or the process was already
    /// gone), `false` on an unexpected error.
    #[must_use]
    pub fn force_kill(pid: u32) -> bool {
        signal(pid, Signal::SIGKILL)
    }

    fn signal(pid: u32, sig: Signal) -> bool {
        if pid == 0 {
            return false;
        }
        match kill(Pid::from_raw(pid as i32), sig) {
            Ok(()) => true,
            // ESRCH: process already gone — treat as success for our purposes.
            Err(Errno::ESRCH) => true,
            Err(_) => false,
        }
    }

    /// Reap any pending zombie children without blocking.
    ///
    /// Called on `SIGCHLD` and during shutdown so terminated grandchildren that
    /// the supervisor inadvertently inherited do not linger as zombies. Returns
    /// the number of children reaped.
    pub fn reap_zombies() -> usize {
        let mut reaped = 0usize;
        loop {
            match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) => break,
                Ok(WaitStatus::Exited(..)) | Ok(WaitStatus::Signaled(..)) => {
                    reaped += 1;
                }
                Ok(_) => {
                    // Other transient statuses (stopped/continued) — keep going.
                }
                // ECHILD: no children left to reap.
                Err(_) => break,
            }
        }
        reaped
    }
}

#[cfg(windows)]
mod imp {
    #![allow(unsafe_code)] // Win32 process APIs require FFI.

    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    };

    /// Probe whether `pid` refers to a live process by attempting to open a
    /// query handle. A successful open (closed immediately) implies the process
    /// exists.
    #[must_use]
    pub fn is_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        // SAFETY: OpenProcess with a valid access mask; handle is closed if non-null.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if handle.is_null() {
                false
            } else {
                let _ = CloseHandle(handle);
                true
            }
        }
    }

    /// Windows has no SIGTERM; the supervisor relies on the Job Object to tear
    /// children down. For an explicit best-effort graceful request we simply
    /// report the process liveness — the actual termination is forced by
    /// [`force_kill`] after the grace window elapses.
    #[must_use]
    pub fn request_terminate(pid: u32) -> bool {
        // No cooperative-signal channel on Windows for arbitrary children.
        is_alive(pid)
    }

    /// Forcibly terminate `pid` via `TerminateProcess`.
    #[must_use]
    pub fn force_kill(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        // SAFETY: open with terminate rights, terminate, close.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
            if handle.is_null() {
                // Already gone or inaccessible — treat absent as success.
                return !is_alive(pid);
            }
            let ok = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
            ok != 0
        }
    }

    /// Windows reaps process state automatically once all handles close; there
    /// are no Unix-style zombies to harvest, so this is a no-op returning 0.
    pub fn reap_zombies() -> usize {
        0
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    /// Liveness probe unavailable on unknown targets — assume not alive.
    #[must_use]
    pub fn is_alive(_pid: u32) -> bool {
        false
    }
    /// No-op terminate on unknown targets.
    #[must_use]
    pub fn request_terminate(_pid: u32) -> bool {
        false
    }
    /// No-op force-kill on unknown targets.
    #[must_use]
    pub fn force_kill(_pid: u32) -> bool {
        false
    }
    /// No zombies to reap on unknown targets.
    pub fn reap_zombies() -> usize {
        0
    }
}

pub use imp::{force_kill, is_alive, reap_zombies, request_terminate};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(is_alive(current_pid()));
    }

    #[test]
    fn pid_zero_is_never_alive() {
        assert!(!is_alive(0));
    }
}

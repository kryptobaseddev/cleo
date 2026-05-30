// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Windows Job Object containment for supervised children (T11338 AC3).
//!
//! On Windows a [`JobObject`] is created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every spawned child is assigned to the
//! job; when the supervisor process exits (and its handle to the job closes),
//! the OS terminates every process still in the job. This is the Windows
//! analogue of the Unix process-group SIGTERM cascade.
//!
//! On Unix this module is a zero-cost no-op: children are contained via the
//! supervisor's own process group + the SIGTERM→SIGKILL cascade in
//! [`crate::supervisor`], so [`JobObject::new`] succeeds and `assign` does
//! nothing.

/// A handle to the platform child-containment mechanism.
///
/// Construct once at supervisor startup and call [`JobObject::assign`] for each
/// spawned child pid.
#[derive(Debug)]
pub struct JobObject {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
mod windows_impl {
    #![allow(unsafe_code)] // Win32 Job Object APIs require FFI.

    use super::JobObject;
    use std::io;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    impl JobObject {
        /// Create a Job Object that kills all assigned children when its last
        /// handle (held by the supervisor) closes.
        ///
        /// # Errors
        ///
        /// Returns the OS error when the job cannot be created or configured.
        pub fn new() -> io::Result<Self> {
            // SAFETY: create an unnamed job object; null name + null security.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: zeroed POD struct, then set the kill-on-close flag.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: pass the struct + its size for the documented info class.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                // SAFETY: close the handle we just created before returning.
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(err);
            }
            Ok(Self { handle })
        }

        /// Assign a child pid to the job so it dies with the supervisor.
        ///
        /// # Errors
        ///
        /// Returns the OS error when the process cannot be opened or assigned.
        pub fn assign(&self, pid: u32) -> io::Result<()> {
            // SAFETY: open with the rights AssignProcessToJobObject requires.
            let proc = unsafe {
                OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid)
            };
            if proc.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: assign the opened process handle to our job.
            let ok = unsafe { AssignProcessToJobObject(self.handle, proc) };
            // SAFETY: always close the transient process handle.
            unsafe {
                let _ = CloseHandle(proc);
            }
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // Closing the last handle triggers KILL_ON_JOB_CLOSE.
            // SAFETY: handle was created by CreateJobObjectW and not yet closed.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(not(windows))]
impl JobObject {
    /// Construct the no-op containment handle on non-Windows platforms.
    ///
    /// # Errors
    ///
    /// Never fails on Unix; the `Result` keeps the API identical across
    /// platforms so callers do not need `cfg` at the call site.
    pub fn new() -> std::io::Result<Self> {
        Ok(Self {})
    }

    /// No-op on Unix — containment is via the process group + SIGTERM cascade.
    ///
    /// # Errors
    ///
    /// Never fails on Unix.
    pub fn assign(&self, _pid: u32) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::JobObject;

    #[test]
    fn job_object_constructs() {
        // On Unix this is a no-op; on Windows it creates a real job object.
        let job = JobObject::new().expect("job object should construct");
        // assign of a non-existent pid is a no-op on Unix; on Windows it would
        // error, so only assert the no-op path on non-windows.
        #[cfg(not(windows))]
        {
            job.assign(999_999).expect("assign is a no-op on unix");
        }
        let _ = job;
    }
}

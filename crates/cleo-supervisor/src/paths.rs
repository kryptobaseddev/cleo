// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Canonical CLEO home/log/cache path resolution for the native supervisor.
//!
//! This mirrors the TypeScript `@cleocode/paths` resolver
//! (`packages/paths/src/cleo-paths.ts` → `getCleoHome`) which is itself a thin
//! wrapper over the `env-paths` package invoked as `envPaths('cleo', { suffix: '' })`
//! with a `CLEO_HOME` override. The supervisor cannot import the TS package, so
//! the same resolution is replicated here so that the pidfile and logs land in
//! exactly the directory the rest of CLEO expects.
//!
//! Resolution of the CLEO home directory (highest precedence first):
//!   1. `CLEO_HOME` env var (tilde / relative values resolved against `$HOME`).
//!   2. Platform default, matching `env-paths('cleo', { suffix: '' }).data`:
//!      - Linux:   `$XDG_DATA_HOME/cleo`  or  `~/.local/share/cleo`
//!      - macOS:   `~/Library/Application Support/cleo`
//!      - Windows: `%LOCALAPPDATA%\cleo\Data`
//!
//! The cache directory (used by the napi binary picker, T11340) follows
//! `env-paths('cleo', { suffix: '' }).cache`:
//!      - Linux:   `$XDG_CACHE_HOME/cleo`  or  `~/.cache/cleo`
//!      - macOS:   `~/Library/Caches/cleo`
//!      - Windows: `%LOCALAPPDATA%\cleo\Cache`

use std::path::PathBuf;

/// App name passed to the `env-paths` equivalent. Kept as a single constant so
/// it matches the TS resolver (`createPlatformPathsResolver('cleo', …)`).
const APP_NAME: &str = "cleo";

/// Subdirectory under the CLEO home where supervisor logs are rotated.
///
/// Matches the per-project `.cleo/logs` convention used by the sentient daemon
/// (`SENTIENT_LOG_DIR`) but rooted at the global CLEO home because the
/// supervisor is a host-level singleton, not a per-project sidecar.
pub const LOG_SUBDIR: &str = "logs";

/// Filename of the supervisor pidfile written under the CLEO home.
pub const PIDFILE_NAME: &str = "cleo-supervisor.pid";

/// Filename of the supervisor IPC Unix-domain socket written under the CLEO home.
///
/// On Unix the supervisor binds a `UnixListener` here (see
/// [`crate::ipc_server`]); on Windows a named pipe derived from
/// [`crate::ipc::IPC_CHANNEL_BASENAME`] is used instead and this path is unused.
pub const SOCKET_NAME: &str = "cleo-supervisor.sock";

/// Resolve the user's home directory in an OS-appropriate way.
///
/// Returns `None` only when neither `$HOME` (Unix) nor the Windows user-profile
/// variables are set — an environment so degraded that path resolution cannot
/// proceed.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(profile));
        }
        match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            (Some(drive), Some(path)) => {
                let mut joined = PathBuf::from(drive);
                joined.push(path);
                Some(joined)
            }
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Expand a `CLEO_HOME` override value the same way the TS `resolveHomeOverride`
/// helper does: `~`, `~/foo`, absolute, and relative (against `$HOME`).
///
/// Returns `None` for blank values so callers fall back to the platform default.
fn resolve_home_override(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" {
        return home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir().map(|h| h.join(rest));
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return Some(candidate);
    }
    home_dir().map(|h| h.join(trimmed))
}

/// Resolve the canonical CLEO data home directory.
///
/// See the module docs for the full precedence rules. Falls back to the current
/// directory only in the pathological case where no home directory can be found
/// — callers should treat that as a hard error rather than silently writing to
/// the CWD, which is why [`cleo_home`] is preferred in production paths.
fn platform_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let xdg = PathBuf::from(xdg);
            if xdg.is_absolute() {
                return Some(xdg.join(APP_NAME));
            }
        }
        home_dir().map(|h| h.join(".local").join("share").join(APP_NAME))
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().map(|h| {
            h.join("Library")
                .join("Application Support")
                .join(APP_NAME)
        })
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join(APP_NAME).join("Data"));
        }
        home_dir().map(|h| h.join("AppData").join("Local").join(APP_NAME).join("Data"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        home_dir().map(|h| h.join(".local").join("share").join(APP_NAME))
    }
}

/// Resolve the platform cache directory used by the napi binary picker (T11340).
fn platform_cache_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
            let xdg = PathBuf::from(xdg);
            if xdg.is_absolute() {
                return Some(xdg.join(APP_NAME));
            }
        }
        home_dir().map(|h| h.join(".cache").join(APP_NAME))
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().map(|h| h.join("Library").join("Caches").join(APP_NAME))
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join(APP_NAME).join("Cache"));
        }
        home_dir().map(|h| h.join("AppData").join("Local").join(APP_NAME).join("Cache"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        home_dir().map(|h| h.join(".cache").join(APP_NAME))
    }
}

/// Returns the canonical CLEO data home directory, honouring `CLEO_HOME`.
///
/// # Errors
///
/// Returns an error when no home directory can be resolved (no `$HOME` /
/// `%USERPROFILE%`) and no usable `CLEO_HOME` override is set.
pub fn cleo_home() -> anyhow::Result<PathBuf> {
    let override_raw = std::env::var_os("CLEO_HOME").and_then(|v| v.to_str().map(str::to_owned));
    cleo_home_with_override(override_raw.as_deref())
}

/// Resolve the CLEO home from an explicit `CLEO_HOME` override value.
///
/// Pure seam (no env reads) so it can be unit-tested without mutating process
/// environment — `std::env::set_var` is `unsafe` in edition 2024 and the
/// workspace denies `unsafe_code`, including in tests.
///
/// # Errors
///
/// Returns an error when neither a usable override nor a platform default can
/// be resolved.
pub fn cleo_home_with_override(override_raw: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(raw) = override_raw
        && let Some(resolved) = resolve_home_override(raw)
    {
        return Ok(resolved);
    }
    platform_data_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot resolve CLEO home: no HOME/USERPROFILE in environment"))
}

/// Returns the supervisor log directory: `<cleo_home>/logs`.
///
/// # Errors
///
/// Propagates the error from [`cleo_home`].
pub fn log_dir() -> anyhow::Result<PathBuf> {
    Ok(cleo_home()?.join(LOG_SUBDIR))
}

/// Returns the absolute supervisor pidfile path: `<cleo_home>/cleo-supervisor.pid`.
///
/// # Errors
///
/// Propagates the error from [`cleo_home`].
pub fn pidfile_path() -> anyhow::Result<PathBuf> {
    Ok(cleo_home()?.join(PIDFILE_NAME))
}

/// Returns the absolute supervisor IPC socket path: `<cleo_home>/cleo-supervisor.sock`.
///
/// This is the Unix-domain socket the supervisor binds for the IPC fan-out
/// channel (T11253). On Windows the transport is a named pipe and this path is
/// not used.
///
/// # Errors
///
/// Propagates the error from [`cleo_home`].
pub fn socket_path() -> anyhow::Result<PathBuf> {
    Ok(cleo_home()?.join(SOCKET_NAME))
}

/// Returns the napi binary cache directory: `<cache>/napi-bin`.
///
/// Mirrors the picker target documented in T11340 AC4
/// (`~/.cache/cleo/napi-bin/<version>/`). The version segment is appended by
/// the picker, not here.
///
/// # Errors
///
/// Returns an error when no cache directory can be resolved.
pub fn napi_cache_dir() -> anyhow::Result<PathBuf> {
    platform_cache_dir()
        .map(|c| c.join("napi-bin"))
        .ok_or_else(|| anyhow::anyhow!("cannot resolve CLEO cache dir: no HOME/USERPROFILE in environment"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleo_home_override_is_honoured() {
        // Use the pure override seam — no env mutation (set_var is unsafe in
        // edition 2024 and the workspace denies unsafe_code).
        let tmp = std::env::temp_dir().join("cleo-supervisor-test-home");
        let raw = tmp.to_string_lossy().into_owned();
        let resolved = cleo_home_with_override(Some(&raw)).expect("override should resolve");
        assert_eq!(resolved, tmp);
    }

    #[test]
    fn log_and_pidfile_nest_under_home() {
        // Derive the log/pidfile paths from an explicit home and assert nesting,
        // independent of the ambient environment.
        let tmp = std::env::temp_dir().join("cleo-supervisor-test-home2");
        let raw = tmp.to_string_lossy().into_owned();
        let home = cleo_home_with_override(Some(&raw)).expect("home");
        assert_eq!(home.join(LOG_SUBDIR), tmp.join(LOG_SUBDIR));
        assert_eq!(home.join(PIDFILE_NAME), tmp.join(PIDFILE_NAME));
        assert_eq!(home.join(SOCKET_NAME), tmp.join(SOCKET_NAME));
    }

    #[test]
    fn blank_override_falls_back_to_platform_default() {
        // An empty override must not be honoured; resolution falls through.
        if home_dir().is_some() {
            let resolved = cleo_home_with_override(Some("   ")).expect("fallback resolves");
            assert!(resolved.ends_with(APP_NAME));
        }
    }

    #[test]
    fn relative_override_resolves_against_home() {
        // A relative override is joined onto $HOME; just assert non-empty and
        // that it is absolute on platforms where $HOME is set.
        if home_dir().is_some() {
            let resolved = resolve_home_override("relative-cleo").expect("relative resolves");
            assert!(resolved.is_absolute());
            assert!(resolved.ends_with("relative-cleo"));
        }
    }
}

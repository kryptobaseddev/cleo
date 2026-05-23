// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! `UserConfigDto` — the field-only SDK projection of worktrunk's
//! [`UserConfig`].
//!
//! Per the T10219 audit, the only field on `worktrunk::config::UserConfig`
//! that step/* and worktree/* consumers actually READ from the SDK boundary
//! is `copy_ignored` (resolved via `repo.user_config().copy_ignored(...)`).
//!
//! The full `UserConfig` apparatus (TOML I/O, env-var precedence, `JsonSchema`
//! generation, per-project merges, persistence) is **CLI-shaped** and stays
//! in the worktrunk CLI binary — not the SDK.
//!
//! ## Why a DTO and not the full `UserConfig`?
//!
//! The original `UserConfig` (a) derives `JsonSchema` (schemars dep),
//! (b) loads from TOML via XDG-aware paths, (c) layers env-var overrides
//! with `WORKTRUNK_*__*` precedence, (d) round-trips per-project sections
//! via `serde(flatten)`, and (e) carries `HooksConfig` + `CommandConfig`
//! sub-trees. None of those concerns are relevant to a downstream SDK
//! consumer that only wants "give me the resolved `CopyIgnoredConfig` for
//! project X". The DTO is therefore field-only, ~10 LOC of data, plus a
//! `from_copy_ignored` constructor so SDK callers can build one
//! programmatically without going through the TOML loader.

use serde::{Deserialize, Serialize};

use crate::config::copy_ignored::CopyIgnoredConfig;

/// Field-only SDK projection of `worktrunk::config::UserConfig`.
///
/// See module docs for why this is a DTO, not the full loader.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserConfigDto {
    /// Resolved copy-ignored configuration for the current project.
    #[serde(default, skip_serializing_if = "is_default_copy_ignored")]
    pub copy_ignored: CopyIgnoredConfig,
}

impl UserConfigDto {
    /// Construct a DTO from a [`CopyIgnoredConfig`].
    ///
    /// Used by SDK consumers that already have a resolved config (e.g.
    /// from a hand-written test fixture) and want a `UserConfigDto` to
    /// pass to a SDK function.
    pub fn from_copy_ignored(copy_ignored: CopyIgnoredConfig) -> Self {
        Self { copy_ignored }
    }
}

fn is_default_copy_ignored(c: &CopyIgnoredConfig) -> bool {
    c.exclude.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_empty() {
        let d = UserConfigDto::default();
        assert!(d.copy_ignored.exclude.is_empty());
    }

    #[test]
    fn from_copy_ignored_round_trip() {
        let ci = CopyIgnoredConfig::new(vec!["**/*.log".into()]);
        let dto = UserConfigDto::from_copy_ignored(ci.clone());
        assert_eq!(dto.copy_ignored, ci);
    }

    #[test]
    fn serde_round_trip() {
        let dto = UserConfigDto::from_copy_ignored(CopyIgnoredConfig::new(vec![
            "**/*.log".into(),
            "tmp/".into(),
        ]));
        let j = serde_json::to_string(&dto).unwrap();
        let back: UserConfigDto = serde_json::from_str(&j).unwrap();
        assert_eq!(dto, back);
    }

    #[test]
    fn serde_skips_empty_copy_ignored() {
        let dto = UserConfigDto::default();
        let j = serde_json::to_string(&dto).unwrap();
        // empty config should serialize to `{}`
        assert_eq!(j, "{}");
    }
}

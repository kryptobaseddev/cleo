// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Config-domain SDK types — substituted shapes for worktrunk's `config::*`
//! surface.
//!
//! Per the T10219 audit, the SDK only needs a field-only `UserConfigDto`
//! plus the underlying `CopyIgnoredConfig` data struct. The full
//! `UserConfig` loader (TOML I/O, env-var precedence, persistence) lives
//! in the worktrunk CLI binary, not here.

pub mod copy_ignored;
pub mod user;

pub use copy_ignored::CopyIgnoredConfig;
pub use user::UserConfigDto;

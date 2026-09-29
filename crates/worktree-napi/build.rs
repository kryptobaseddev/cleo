// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktree-napi in the CleoCode monorepo.

//! Build script for `worktree-napi`: links the napi-build setup required by
//! napi-rs to configure the native addon link flags for the Node.js bindings,
//! and stamps the native SOURCE hash into the binary.

use std::env;

fn main() {
    napi_build::setup();

    // Every release binary carries the literal
    // `worktree-napi-source-rev:<hash>`, where `<hash>` is the native source
    // hash of `scripts/native-source-hash.mjs worktree`. The release recomputes
    // that hash from the tagged commit and refuses a binary that lacks it, so a
    // cached binary can only be reused when its source is byte-identical. CI
    // sets the value; local builds are stamped `unversioned`.
    let rev = env::var("WORKTREE_NAPI_SOURCE_REV").unwrap_or_else(|_| "unversioned".to_string());
    println!("cargo:rerun-if-env-changed=WORKTREE_NAPI_SOURCE_REV");
    println!("cargo:rustc-env=WORKTREE_NAPI_SOURCE_REV={rev}");
}

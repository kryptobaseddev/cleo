// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktree-napi in the CleoCode monorepo.

//! Build script for `worktree-napi`: links the napi-build setup required by
//! napi-rs to configure the native addon link flags for the Node.js bindings.

fn main() {
    napi_build::setup();
}

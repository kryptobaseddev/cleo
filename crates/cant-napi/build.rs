//! Build script for cant-napi: links the napi-build setup required by napi-rs
//! to configure the native addon link flags for the Node.js bindings, and
//! stamps the source revision into the binary (T12382).

extern crate napi_build;

use std::env;

fn main() {
    napi_build::setup();

    // T12382: every binary carries the literal `cant-napi-source-rev:<rev>`,
    // so the release can prove each packed `.node`/`.wasm` was built from the
    // commit being released and is not a stale leftover
    // (`scripts/lint-no-committed-native-binaries.mjs --packed`). CI sets the
    // revision; local builds are stamped `unversioned`.
    let rev = env::var("CANT_NAPI_SOURCE_REV").unwrap_or_else(|_| "unversioned".to_string());
    println!("cargo:rerun-if-env-changed=CANT_NAPI_SOURCE_REV");
    println!("cargo:rustc-env=CANT_NAPI_SOURCE_REV={rev}");
}

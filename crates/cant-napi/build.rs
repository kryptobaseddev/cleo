//! Build script for cant-napi: links the napi-build setup required by napi-rs
//! to configure the native addon link flags for the Node.js bindings.

extern crate napi_build;

fn main() {
    napi_build::setup();
}

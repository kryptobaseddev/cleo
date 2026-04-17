//! Build script for lafs-napi: links the napi-build setup required by napi-rs
//! to configure the native addon link flags for the Node.js bindings.

fn main() {
    napi_build::setup();
}

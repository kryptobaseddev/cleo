//! Minimal Rust crate fixture for the CLEO release-pipeline integration
//! tests (T9543, T9544). Declares the `single-rust-crate` archetype path
//! defined in SPEC-T9345 §9.1 and exposes a single `hello()` function plus
//! one unit test so the test pipeline can exercise `cargo test` on a
//! representative crate without pulling external dependencies.

/// Returns the canonical fixture greeting.
pub fn hello() -> &'static str {
    "hello"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_returns_hello() {
        assert_eq!(hello(), "hello");
    }
}

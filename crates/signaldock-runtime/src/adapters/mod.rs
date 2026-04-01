//! Platform adapters for SignalDock Runtime.
//!
//! Architecture:
//! - `base.rs` defines the `PlatformAdapter` trait (interface contract)
//! - Each adapter in its own file implements the trait
//! - This module re-exports everything and provides the factory
//!
//! To add a new adapter:
//! 1. Create `src/adapters/my_platform.rs`
//! 2. Implement `PlatformAdapter` for your struct
//! 3. Add `pub mod my_platform;` below
//! 4. Add a match arm in `create()` below

// Base trait — all adapters implement this
pub mod base;

// Adapter implementations (barrel export)
pub mod openclaw;
pub mod webhook;
pub mod stdout;
pub mod file_output;

// Re-export the trait and types so consumers use `adapters::PlatformAdapter`
pub use base::{PlatformAdapter, Message, DeliveryResult};

// Re-export concrete adapters for direct construction
pub use openclaw::OpenClawAdapter;
pub use webhook::WebhookAdapter;
pub use stdout::StdoutAdapter;
pub use file_output::FileAdapter;

mod detect;
mod factory;

pub use detect::detect_platform;
pub use factory::create;

//! SignalDock Runtime — Universal agent connector daemon.
//!
//! Connects any agent to SignalDock via hybrid SSE+poll receiver
//! with platform-specific adapters (OpenClaw, Claude Code, etc.).
mod config;
mod receiver;
mod adapter;
mod sender;
mod cli;

use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Init logging — respect RUST_LOG, default to info
    let filter = std::env::var("RUST_LOG")
        .unwrap_or_else(|_| "signaldock_runtime=info".to_string());
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_target(false)
        .with_thread_ids(false)
        .init();

    let args = cli::Cli::parse();
    cli::run(args).await
}

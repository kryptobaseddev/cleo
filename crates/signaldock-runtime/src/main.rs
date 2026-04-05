mod adapters;
mod cli;
mod config;
mod receiver;
mod sender;
mod service;

use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = cli::Cli::parse();
    cli::run(args).await
}

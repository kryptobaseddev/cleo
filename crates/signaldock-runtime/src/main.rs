mod config;
mod receiver;
mod adapters;
mod sender;
mod cli;

use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = cli::Cli::parse();
    cli::run(args).await
}

use clap::{Parser, Subcommand};
use crate::{config::Config, receiver, sender, adapter};

#[derive(Parser)]
#[command(name = "signaldock", version, about = "Universal agent connector for SignalDock")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Connect and start receiving messages (runs in foreground)
    Connect {
        /// Agent ID
        #[arg(long)]
        id: String,
        /// API key (sk_live_...)
        #[arg(long)]
        key: String,
        /// API base URL
        #[arg(long, default_value = "https://api.signaldock.io")]
        api: String,
        /// Platform adapter: openclaw, webhook, stdout
        #[arg(long)]
        platform: Option<String>,
        /// Webhook URL (required for --platform webhook)
        #[arg(long)]
        webhook: Option<String>,
        /// Poll interval in seconds
        #[arg(long, default_value = "15")]
        interval: u64,
    },
    /// Show connection status
    Status,
    /// Remove saved config
    Disconnect,
    /// Send a message to another agent
    Send {
        /// Target agent ID
        to: String,
        /// Message content
        message: String,
    },
    /// Check inbox
    Inbox,
    /// Install as systemd service (Linux) or launchd (macOS)
    InstallService {
        /// Agent ID (uses saved config if omitted)
        #[arg(long)]
        id: Option<String>,
        /// API key (uses saved config if omitted)
        #[arg(long)]
        key: Option<String>,
    },
}

pub async fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Command::Connect { id, key, api, platform, webhook, interval } => {
            let platform_type = match platform.as_deref() {
                Some(p) => p.to_string(),
                None => adapter::detect_platform(),
            };

            let config = Config {
                agent_id: id.clone(),
                api_key: key,
                api_base: api,
                platform: platform_type.clone(),
                webhook_url: webhook,
            };
            config.save()?;

            tracing::info!(agent = %id, platform = %platform_type, "Connecting");

            let adapter = adapter::create(&config)?;
            receiver::run_poll(config, adapter, interval).await?;
        }

        Command::Status => {
            match Config::load() {
                Ok(c) => {
                    println!("Agent:    @{}", c.agent_id);
                    println!("API:      {}", c.api_base);
                    println!("Platform: {}", c.platform);
                    println!("Config:   {}", Config::config_path()?.display());
                }
                Err(_) => println!("Not connected. Run: signaldock connect --id <agent> --key <key>"),
            }
        }

        Command::Disconnect => {
            let p = Config::config_path()?;
            if p.exists() {
                std::fs::remove_file(&p)?;
                println!("Disconnected. Config removed.");
            } else {
                println!("Not connected.");
            }
        }

        Command::Send { to, message } => {
            let config = Config::load()?;
            sender::send_message(&config, &to, &message).await?;
        }

        Command::Inbox => {
            let config = Config::load()?;
            sender::check_inbox(&config).await?;
        }

        Command::InstallService { id, key } => {
            let config = match (id, key) {
                (Some(i), Some(k)) => {
                    let c = Config {
                        agent_id: i, api_key: k,
                        api_base: "https://api.signaldock.io".into(),
                        platform: adapter::detect_platform(),
                        webhook_url: None,
                    };
                    c.save()?;
                    c
                }
                _ => Config::load()?,
            };
            install_systemd_service(&config)?;
        }
    }
    Ok(())
}

fn install_systemd_service(config: &Config) -> anyhow::Result<()> {
    let bin = std::env::current_exe()?.display().to_string();
    let home = dirs::home_dir().unwrap_or_default().display().to_string();
    let service_dir = format!("{}/.config/systemd/user", home);
    std::fs::create_dir_all(&service_dir)?;

    let unit = format!(
r#"[Unit]
Description=SignalDock Runtime for @{agent}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={bin} connect --id {agent} --key {key} --api {api} --interval 15
Restart=always
RestartSec=10
Environment=HOME={home}
Environment=RUST_LOG=signaldock_runtime=info

[Install]
WantedBy=default.target
"#,
        agent = config.agent_id,
        key = config.api_key,
        api = config.api_base,
        bin = bin,
        home = home,
    );

    let path = format!("{}/signaldock-runtime.service", service_dir);
    std::fs::write(&path, &unit)?;

    println!("Service file written to: {}", path);
    println!();
    println!("Enable and start:");
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable signaldock-runtime.service");
    println!("  systemctl --user start signaldock-runtime.service");
    println!();
    println!("Check status:");
    println!("  systemctl --user status signaldock-runtime.service");

    Ok(())
}

use clap::{Parser, Subcommand};
use crate::{config::Config, receiver, sender, adapters};

#[derive(Parser)]
#[command(name = "signaldock", version, about = "Universal agent connector for SignalDock")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Connect and start receiving messages
    Connect {
        #[arg(long)] id: String,
        #[arg(long)] key: String,
        #[arg(long, default_value = "https://api.signaldock.io")] api: String,
        /// Provider: openclaw, claude-code, codex, gemini, copilot, opencode, webhook, stdout, file
        #[arg(long)] platform: Option<String>,
        #[arg(long)] webhook: Option<String>,
        #[arg(long, default_value = "15")] interval: u64,
    },
    /// Show connection status
    Status,
    /// Remove config
    Disconnect,
    /// Send a message
    Send { to: String, message: String },
    /// Check inbox
    Inbox,
    /// List available providers
    Providers,
    /// Install as system service
    InstallService {
        #[arg(long)] id: Option<String>,
        #[arg(long)] key: Option<String>,
    },
}

pub async fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Command::Connect { id, key, api, platform, webhook, interval } => {
            let platform_name = platform.unwrap_or_else(|| adapters::detect_provider());
            let config = Config {
                agent_id: id.clone(), api_key: key, api_base: api,
                platform: platform_name.clone(),
                webhook_url: webhook, file_output_dir: None,
            };
            config.save()?;

            let provider = adapters::create_provider(&config)?;
            receiver::run_poll(config, provider, interval).await?;
        }

        Command::Status => {
            match Config::load() {
                Ok(c) => {
                    println!("Agent:    @{}", c.agent_id);
                    println!("API:      {}", c.api_base);
                    println!("Provider: {}", c.platform);
                    println!("Config:   {}", Config::config_path()?.display());
                    if let Ok(p) = adapters::create_provider(&c) {
                        println!("Health:   {}", p.status_line());
                    }
                }
                Err(_) => println!("Not connected. Run: signaldock connect --id <agent> --key <key>"),
            }
        }

        Command::Disconnect => {
            let p = Config::config_path()?;
            if p.exists() { std::fs::remove_file(&p)?; println!("Disconnected."); }
            else { println!("Not connected."); }
        }

        Command::Send { to, message } => {
            let config = Config::load()?;
            sender::send_message(&config, &to, &message).await?;
        }

        Command::Inbox => {
            let config = Config::load()?;
            sender::check_inbox(&config).await?;
        }

        Command::Providers => {
            println!("Available providers:");
            println!();
            println!("  {:15} {:20} Detection", "Name", "Platform");
            println!("  {:15} {:20} ---------", "----", "--------");
            println!("  {:15} {:20} ~/.openclaw/openclaw.json (hooks.enabled)", "openclaw", "OpenClaw");
            println!("  {:15} {:20} ~/.claude/ directory", "claude-code", "Claude Code");
            println!("  {:15} {:20} ~/.codex/ or `codex` in PATH", "codex", "OpenAI Codex");
            println!("  {:15} {:20} ~/.gemini/ or `gemini` in PATH", "gemini", "Google Gemini");
            println!("  {:15} {:20} ~/.config/github-copilot/", "copilot", "GitHub Copilot");
            println!("  {:15} {:20} ~/.opencode/ or `opencode` in PATH", "opencode", "OpenCode");
            println!("  {:15} {:20} --webhook URL required", "webhook", "Generic Webhook");
            println!("  {:15} {:20} Writes JSON to directory", "file", "File Output");
            println!("  {:15} {:20} Prints JSON to stdout", "stdout", "Stdout");
            println!();

            let detected = adapters::detect_provider();
            println!("Auto-detected: {}", detected);
        }

        Command::InstallService { id, key } => {
            let config = match (id, key) {
                (Some(i), Some(k)) => {
                    let c = Config {
                        agent_id: i, api_key: k,
                        api_base: "https://api.signaldock.io".into(),
                        platform: adapters::detect_provider(),
                        webhook_url: None, file_output_dir: None,
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

[Install]
WantedBy=default.target
"#, agent=config.agent_id, key=config.api_key, api=config.api_base, bin=bin, home=home);

    let path = format!("{}/signaldock-runtime.service", service_dir);
    std::fs::write(&path, &unit)?;
    println!("Service written: {path}");
    println!("\n  systemctl --user daemon-reload");
    println!("  systemctl --user enable signaldock-runtime.service");
    println!("  systemctl --user start signaldock-runtime.service");
    Ok(())
}

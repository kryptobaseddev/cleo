//! Cross-platform service installation.
//!
//! Detects the OS and generates the appropriate service configuration:
//! - Linux: systemd user service
//! - macOS: launchd plist (~/Library/LaunchAgents/)
//! - Windows: NSSM wrapper or Windows Service (future)

use crate::config::Config;
use anyhow::{Context, Result};

/// Detected operating system for service installation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ServicePlatform {
    Linux,
    MacOS,
    Windows,
    Unknown,
}

impl ServicePlatform {
    pub fn detect() -> Self {
        if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::MacOS
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Unknown
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Linux => "systemd",
            Self::MacOS => "launchd",
            Self::Windows => "windows-service",
            Self::Unknown => "unknown",
        }
    }
}

/// Install the runtime as a system service.
pub fn install_service(config: &Config) -> Result<()> {
    let platform = ServicePlatform::detect();
    let bin = std::env::current_exe()?.display().to_string();

    eprintln!(
        "[signaldock] Detected OS: {} ({})",
        std::env::consts::OS,
        platform.name()
    );

    match platform {
        ServicePlatform::Linux => install_systemd(config, &bin),
        ServicePlatform::MacOS => install_launchd(config, &bin),
        ServicePlatform::Windows => install_windows(config, &bin),
        ServicePlatform::Unknown => {
            eprintln!(
                "[signaldock] Unknown OS: {}. Generating systemd config as default.",
                std::env::consts::OS
            );
            install_systemd(config, &bin)
        }
    }
}

// ============================================================
// Linux: systemd
// ============================================================

fn install_systemd(config: &Config, bin: &str) -> Result<()> {
    let home = dirs::home_dir().context("No HOME")?.display().to_string();
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
"#,
        agent = config.agent_id,
        key = config.api_key,
        api = config.api_base,
        bin = bin,
        home = home
    );

    let path = format!("{}/signaldock-runtime.service", service_dir);
    std::fs::write(&path, &unit)?;

    println!("✅ systemd service written: {}", path);
    println!();
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable signaldock-runtime.service");
    println!("  systemctl --user start signaldock-runtime.service");
    println!();
    println!("Check: systemctl --user status signaldock-runtime.service");
    Ok(())
}

// ============================================================
// macOS: launchd
// ============================================================

fn install_launchd(config: &Config, bin: &str) -> Result<()> {
    let home = dirs::home_dir().context("No HOME")?.display().to_string();
    let agents_dir = format!("{}/Library/LaunchAgents", home);
    std::fs::create_dir_all(&agents_dir)?;

    let label = format!("io.signaldock.runtime.{}", config.agent_id);
    let log_dir = format!("{}/Library/Logs/signaldock", home);
    std::fs::create_dir_all(&log_dir)?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
        <string>connect</string>
        <string>--id</string>
        <string>{agent}</string>
        <string>--key</string>
        <string>{key}</string>
        <string>--api</string>
        <string>{api}</string>
        <string>--interval</string>
        <string>15</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log_dir}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{home}</string>
    </dict>
</dict>
</plist>
"#,
        label = label,
        bin = bin,
        agent = config.agent_id,
        key = config.api_key,
        api = config.api_base,
        home = home,
        log_dir = log_dir
    );

    let path = format!("{}/{}.plist", agents_dir, label);
    std::fs::write(&path, &plist)?;

    println!("✅ launchd plist written: {}", path);
    println!();
    println!("  launchctl load {}", path);
    println!("  launchctl start {}", label);
    println!();
    println!("Check: launchctl list | grep signaldock");
    println!("Logs:  tail -f {}/stderr.log", log_dir);
    println!();
    println!("To uninstall:");
    println!("  launchctl unload {}", path);
    println!("  rm {}", path);
    Ok(())
}

// ============================================================
// Windows: Service stub
// ============================================================

fn install_windows(config: &Config, bin: &str) -> Result<()> {
    // Windows service requires either:
    // 1. windows-service crate (native Windows Service API)
    // 2. NSSM (Non-Sucking Service Manager) wrapper
    // 3. Task Scheduler as alternative

    let home = dirs::home_dir().context("No HOME")?.display().to_string();

    // Generate a batch script + Task Scheduler XML as a practical solution
    let bat_path = format!("{}\\signaldock-runtime.bat", home);
    let bat = format!(
        r#"@echo off
"{bin}" connect --id {agent} --key {key} --api {api} --interval 15
"#,
        bin = bin,
        agent = config.agent_id,
        key = config.api_key,
        api = config.api_base
    );

    std::fs::write(&bat_path, &bat)?;

    // Task Scheduler XML
    let xml_path = format!("{}\\signaldock-runtime-task.xml", home);
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  </Settings>
  <Actions>
    <Exec>
      <Command>{bin}</Command>
      <Arguments>connect --id {agent} --key {key} --api {api} --interval 15</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        bin = bin,
        agent = config.agent_id,
        key = config.api_key,
        api = config.api_base
    );

    std::fs::write(&xml_path, &xml)?;

    println!("✅ Windows service files written:");
    println!("   Batch: {}", bat_path);
    println!("   Task XML: {}", xml_path);
    println!();
    println!("Option A — Task Scheduler (recommended):");
    println!(
        "  schtasks /create /tn \"SignalDock Runtime\" /xml \"{}\"",
        xml_path
    );
    println!();
    println!("Option B — NSSM (if installed):");
    println!("  nssm install SignalDockRuntime \"{}\"", bat_path);
    println!("  nssm start SignalDockRuntime");
    println!();
    println!("Option C — Manual:");
    println!("  Run \"{}\" in a terminal", bat_path);
    Ok(())
}

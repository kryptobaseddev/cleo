use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub agent_id: String,
    pub api_key: String,
    pub api_base: String,
    pub platform: String,
    pub webhook_url: Option<String>,
}

impl Config {
    pub fn config_dir() -> Result<PathBuf> {
        let dir = dirs::home_dir()
            .context("No home directory")?
            .join(".signaldock");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn config_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("config.json"))
    }

    pub fn state_dir(&self) -> Result<PathBuf> {
        let dir = Self::config_dir()?.join(&self.agent_id);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json)?;
        tracing::info!(path = %path.display(), "Config saved");
        Ok(())
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;
        let json = std::fs::read_to_string(&path)
            .context("No config found. Run: signaldock connect --id <agent> --key <key>")?;
        Ok(serde_json::from_str(&json)?)
    }
}

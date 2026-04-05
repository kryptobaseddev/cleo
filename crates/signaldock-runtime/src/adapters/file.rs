//! File adapter — write JSON to a directory.
//! Each payload creates a new .json file. Useful for inotify/fswatch triggers.

use super::base::{Adapter, TransportResult};
use anyhow::Result;

pub struct FileAdapter {
    dir: String,
}

impl FileAdapter {
    pub fn new(dir: String) -> Self {
        Self { dir }
    }
}

impl Adapter for FileAdapter {
    fn name(&self) -> &str {
        "file"
    }

    fn send(&self, payload: &serde_json::Value) -> Result<TransportResult> {
        std::fs::create_dir_all(&self.dir)?;
        let id = payload
            .get("messageId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let path = std::path::Path::new(&self.dir).join(format!("{}.json", id));
        std::fs::write(&path, serde_json::to_string_pretty(payload)?)?;
        eprintln!("[signaldock] Written to {}", path.display());
        Ok(TransportResult::Ok)
    }
}

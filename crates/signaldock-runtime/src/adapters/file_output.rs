//! File adapter — writes each message as a JSON file to a directory.
//!
//! Useful for platforms that watch a directory (inotify, fswatch).
//! Each message creates: {output_dir}/{message_id}.json

use anyhow::Result;
use super::base::{PlatformAdapter, Message, DeliveryResult};

pub struct FileAdapter {
    output_dir: String,
}

impl FileAdapter {
    pub fn new(output_dir: String) -> Self {
        Self { output_dir }
    }
}

impl PlatformAdapter for FileAdapter {
    fn name(&self) -> &str { "file" }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        std::fs::create_dir_all(&self.output_dir)?;

        let filename = format!("{}.json", msg.id);
        let path = std::path::Path::new(&self.output_dir).join(&filename);

        let output = serde_json::json!({
            "from": msg.from,
            "content": msg.content,
            "messageId": msg.id,
            "conversationId": msg.conversation_id,
            "contentType": msg.content_type,
            "createdAt": msg.created_at,
            "metadata": msg.metadata,
        });

        std::fs::write(&path, serde_json::to_string_pretty(&output)?)?;
        eprintln!("[signaldock] Written to {}", path.display());
        Ok(DeliveryResult::Delivered)
    }
}

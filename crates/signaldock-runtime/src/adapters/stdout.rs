//! Stdout adapter — prints message JSON to stdout.
//!
//! Useful for piping: signaldock connect --platform stdout | jq .content | my-bot

use anyhow::Result;
use super::base::{PlatformAdapter, Message, DeliveryResult};

pub struct StdoutAdapter;

impl PlatformAdapter for StdoutAdapter {
    fn name(&self) -> &str { "stdout" }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let output = serde_json::json!({
            "from": msg.from,
            "content": msg.content,
            "messageId": msg.id,
            "conversationId": msg.conversation_id,
            "createdAt": msg.created_at,
        });
        println!("{}", serde_json::to_string(&output)?);
        Ok(DeliveryResult::Delivered)
    }
}

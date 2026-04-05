//! Stdout adapter — print JSON to stdout.
//! Pipe-friendly: signaldock connect --platform stdout | jq . | my-bot

use super::base::{Adapter, TransportResult};
use anyhow::Result;

pub struct StdoutAdapter;

impl Adapter for StdoutAdapter {
    fn name(&self) -> &str {
        "stdout"
    }

    fn send(&self, payload: &serde_json::Value) -> Result<TransportResult> {
        println!("{}", serde_json::to_string(payload)?);
        Ok(TransportResult::Ok)
    }
}

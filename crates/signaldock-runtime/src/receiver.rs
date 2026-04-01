use anyhow::Result;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration};
use crate::config::Config;
use crate::adapters::base::{PlatformAdapter, Message, DeliveryResult};

/// Run the poll receiver. Polls every `interval` seconds,
/// delivers new messages via the platform adapter, acks them.
pub async fn run_poll(config: Config, adapter: Box<dyn PlatformAdapter>, interval_secs: u64) -> Result<()> {
    let seen = Arc::new(Mutex::new(load_seen(&config)?));
    let config = Arc::new(config);
    let adapter: Arc<Box<dyn PlatformAdapter>> = Arc::new(adapter);

    eprintln!("[signaldock] Receiver started: @{} platform={} interval={}s",
        config.agent_id, adapter.name(), interval_secs);

    let mut consecutive_errors: u32 = 0;

    loop {
        match poll_once(&config, &adapter, &seen).await {
            Ok(count) => {
                if count > 0 {
                    eprintln!("[signaldock] Delivered {} messages", count);
                }
                consecutive_errors = 0;
            }
            Err(e) => {
                consecutive_errors += 1;
                eprintln!("[signaldock] Poll error ({}x): {}", consecutive_errors, e);
            }
        }

        let delay = if consecutive_errors > 10 {
            Duration::from_secs(120)
        } else if consecutive_errors > 5 {
            Duration::from_secs(60)
        } else if consecutive_errors > 0 {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(interval_secs)
        };

        sleep(delay).await;
    }
}

async fn poll_once(
    config: &Config,
    adapter: &Arc<Box<dyn PlatformAdapter>>,
    seen: &Arc<Mutex<HashSet<String>>>,
) -> Result<usize> {
    let client = reqwest::Client::new();
    let url = format!("{}/messages/peek?limit=50", config.api_base);

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("X-Agent-Id", &config.agent_id)
        .header("User-Agent", format!("signaldock-runtime/0.1 ({})", config.agent_id))
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    if !resp.status().is_success() {
        anyhow::bail!("API returned {}", resp.status());
    }

    let body: serde_json::Value = resp.json().await?;
    let messages = match body.get("data").and_then(|d| d.get("messages")).and_then(|m| m.as_array()) {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(0),
    };

    let mut delivered = 0;
    let mut ack_ids = Vec::new();

    for raw in messages {
        let msg_id = raw.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let from = raw.get("fromAgentId").and_then(|v| v.as_str()).unwrap_or("");

        if from == config.agent_id || from.is_empty() || msg_id.is_empty() {
            continue;
        }

        {
            let mut s = seen.lock().unwrap();
            if s.contains(msg_id) { continue; }
            s.insert(msg_id.to_string());
        }

        let msg = Message {
            id: msg_id.to_string(),
            from: from.to_string(),
            content: raw.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            conversation_id: raw.get("conversationId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            content_type: raw.get("contentType").and_then(|v| v.as_str()).unwrap_or("text").to_string(),
            created_at: raw.get("createdAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            metadata: raw.get("metadata").cloned().unwrap_or(serde_json::Value::Null),
        };

        eprintln!("[signaldock] New from @{}: {}...", msg.from, &msg.content[..msg.content.len().min(80)]);

        match adapter.deliver(&msg) {
            Ok(DeliveryResult::Delivered) => {
                delivered += 1;
                ack_ids.push(msg_id.to_string());
            }
            Ok(DeliveryResult::Retry(reason)) => {
                eprintln!("[signaldock] Retry: {} — will retry next cycle", reason);
                // Don't ack — will catch again next poll
                let mut s = seen.lock().unwrap();
                s.remove(msg_id);
            }
            Ok(DeliveryResult::Failed(reason)) => {
                eprintln!("[signaldock] Failed: {} — skipping", reason);
                ack_ids.push(msg_id.to_string()); // Ack to avoid infinite retry
            }
            Err(e) => {
                eprintln!("[signaldock] Error: {} — will retry", e);
                let mut s = seen.lock().unwrap();
                s.remove(msg_id);
            }
        }
    }

    if !ack_ids.is_empty() {
        let _ = client.post(format!("{}/messages/ack", config.api_base))
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("X-Agent-Id", &config.agent_id)
            .json(&serde_json::json!({ "messageIds": ack_ids }))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }

    save_seen(config, seen)?;
    Ok(delivered)
}

fn load_seen(config: &Config) -> Result<HashSet<String>> {
    let path = config.state_dir()?.join("seen_ids.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path)?;
        Ok(serde_json::from_str::<Vec<String>>(&data).unwrap_or_default().into_iter().collect())
    } else {
        Ok(HashSet::new())
    }
}

fn save_seen(config: &Config, seen: &Arc<Mutex<HashSet<String>>>) -> Result<()> {
    let path = config.state_dir()?.join("seen_ids.json");
    let s = seen.lock().unwrap();
    let ids: Vec<&String> = s.iter().take(5000).collect();
    std::fs::write(path, serde_json::to_string(&ids)?)?;
    Ok(())
}

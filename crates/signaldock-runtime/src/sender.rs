use crate::config::Config;
use anyhow::Result;

/// Send a message to another agent via SignalDock.
pub async fn send_message(config: &Config, to: &str, content: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/messages", config.api_base))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("X-Agent-Id", &config.agent_id)
        .header(
            "User-Agent",
            format!("signaldock-runtime/0.1.0 ({})", config.agent_id),
        )
        .json(&serde_json::json!({
            "toAgentId": to,
            "content": content,
        }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?;

    let body: serde_json::Value = resp.json().await?;
    if body.get("success").and_then(|v| v.as_bool()) == Some(true) {
        let msg = &body["data"]["message"];
        println!(
            "✅ Sent to @{} (conv: {})",
            msg["toAgentId"].as_str().unwrap_or("?"),
            &msg["conversationId"].as_str().unwrap_or("?")[..8]
        );
    } else {
        let err = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        println!("❌ {}", err);
    }
    Ok(())
}

/// Check inbox for unread messages.
pub async fn check_inbox(config: &Config) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!(
            "{}/agents/{}/inbox",
            config.api_base, config.agent_id
        ))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("X-Agent-Id", &config.agent_id)
        .header(
            "User-Agent",
            format!("signaldock-runtime/0.1.0 ({})", config.agent_id),
        )
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    let body: serde_json::Value = resp.json().await?;
    let data = &body["data"];
    println!("Agent:  @{}", config.agent_id);
    println!("Unread: {}", data["unreadTotal"]);

    if let Some(convs) = data["conversations"].as_array() {
        for c in convs {
            println!(
                "  Conv {}... {} unread",
                &c["conversationId"]
                    .as_str()
                    .unwrap_or("?")
                    .get(..8)
                    .unwrap_or("?"),
                c["unreadCount"]
            );
        }
    }
    Ok(())
}

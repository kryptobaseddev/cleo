//! Hover information provider for the CANT DSL LSP.
//!
//! Returns documentation and type information when the user hovers over
//! a symbol in a `.cant` file.

use cant_core::dsl::ast::{CanonicalEvent, CantDocument, Section};

/// The result of a hover lookup: a markdown-formatted documentation string.
pub struct HoverInfo {
    /// Markdown content to display in the hover tooltip.
    pub contents: String,
}

/// Looks up hover info for the word at the cursor position.
///
/// Performs a simple word-based lookup. The `word` parameter is the token
/// under the cursor, and `line_text` provides the full line for additional
/// context (e.g., detecting `model:` property key position).
pub fn hover_for_word(
    word: &str,
    line_text: &str,
    doc: Option<&CantDocument>,
) -> Option<HoverInfo> {
    // Directive verb (stripped of leading `/`)
    let directive_word = word.strip_prefix('/').unwrap_or(word);
    if word.starts_with('/') || (line_text.trim_start().starts_with('/') && !word.is_empty()) {
        if let Some(info) = directive_hover(directive_word) {
            return Some(info);
        }
    }

    // Canonical event name (provider + domain)
    if let Some(info) = event_hover(word) {
        return Some(info);
    }

    // Agent property key (word appears before `:` on the line)
    if let Some(info) = property_key_hover(word) {
        return Some(info);
    }

    // Top-level keyword
    if let Some(info) = keyword_hover(word) {
        return Some(info);
    }

    // Agent name reference (with or without @)
    let agent_name = word.strip_prefix('@').unwrap_or(word);
    if let Some(doc) = doc {
        if let Some(info) = agent_ref_hover(agent_name, doc) {
            return Some(info);
        }
    }

    None
}

/// Hover info for directive verbs.
fn directive_hover(verb: &str) -> Option<HoverInfo> {
    let desc = match verb {
        "claim" => {
            "**`/claim`** -- Actionable directive\n\nMaps to `tasks.claim`. Claims a task for the current agent."
        }
        "done" => {
            "**`/done`** -- Actionable directive\n\nMaps to `tasks.complete`. Marks a task as completed."
        }
        "blocked" => {
            "**`/blocked`** -- Actionable directive\n\nMarks a task as blocked by a dependency or issue."
        }
        "approve" => {
            "**`/approve`** -- Actionable directive\n\nApproves an approval gate or review request."
        }
        "decision" => {
            "**`/decision`** -- Actionable directive\n\nRecords a formal decision in the session."
        }
        "checkin" => "**`/checkin`** -- Actionable directive\n\nAgent check-in at session start.",
        "action" => {
            "**`/action`** -- Routing directive\n\nSignals that the addressed agent should take action."
        }
        "review" => {
            "**`/review`** -- Routing directive\n\nRequests a review from the addressed agent."
        }
        "proposal" => {
            "**`/proposal`** -- Routing directive\n\nProposes a change for consideration."
        }
        "ack" => "**`/ack`** -- Informational directive\n\nAcknowledges receipt of a message.",
        "response" => {
            "**`/response`** -- Informational directive\n\nResponds to a previous request."
        }
        "info" => "**`/info`** -- Informational directive\n\nProvides a status update or context.",
        "status" => "**`/status`** -- Informational directive\n\nReports current status.",
        _ => return None,
    };
    Some(HoverInfo {
        contents: desc.to_string(),
    })
}

/// Hover info for canonical event names (provider + domain). No hardcoded match arms.
fn event_hover(name: &str) -> Option<HoverInfo> {
    let event = CanonicalEvent::from_str(name)?;
    let block_text = if event.can_block() {
        "**Can block execution.**"
    } else {
        "Cannot block."
    };
    let source_label = match event.source().as_str() {
        "provider" => "Provider event",
        "domain" => "Domain event",
        _ => "Event",
    };
    Some(HoverInfo {
        contents: format!(
            "**{}** -- `{}` category ({})\n\n{}. {}",
            event.as_str(),
            event.category().as_str(),
            source_label,
            event.description(),
            block_text
        ),
    })
}

/// Hover info for agent block property keys.
fn property_key_hover(key: &str) -> Option<HoverInfo> {
    let desc = match key {
        "model" => {
            "**model**: `string`\n\nThe LLM model identifier. Values: `opus`, `sonnet`, `haiku`."
        }
        "prompt" => {
            "**prompt**: `string`\n\nThe system prompt for this agent. Supports `${...}` interpolation."
        }
        "persist" => {
            "**persist**: `string`\n\nPersistence scope. Values: `project`, `global`, `session`."
        }
        "skills" => "**skills**: `string[]`\n\nArray of skill identifiers this agent can use.",
        "permissions" => {
            "**permissions**: `block`\n\nPermission declarations for domain access (tasks, session, memory, etc.)."
        }
        "context" => "**context**: `string[]`\n\nContext sources to wire into sessions.",
        "description" => {
            "**description**: `string`\n\nHuman-readable description of this agent or skill."
        }
        "command" => "**command**: `string`\n\nThe command to execute in a pipeline step.",
        "args" => "**args**: `string[]`\n\nArgument vector for the pipeline step command.",
        "timeout" => "**timeout**: `duration`\n\nMaximum execution time (e.g., `30s`, `5m`).",
        "stdin" => {
            "**stdin**: `string`\n\nName of the previous step whose stdout pipes into this step."
        }
        "message" => "**message**: `string`\n\nHuman-readable message for an approval gate.",
        "tier" => "**tier**: `string`\n\nSkill tier classification (`core`, `optional`, `custom`).",
        _ => return None,
    };
    Some(HoverInfo {
        contents: desc.to_string(),
    })
}

/// Hover info for top-level and body keywords.
fn keyword_hover(word: &str) -> Option<HoverInfo> {
    let desc = match word {
        "agent" => {
            "**agent** `name:`\n\nDeclares an agent definition block with properties, permissions, and hooks."
        }
        "skill" => "**skill** `name:`\n\nDeclares a skill definition block with properties.",
        "on" => {
            "**on** `EventName:`\n\nDeclares a hook triggered by one of the 16 CAAMP canonical events."
        }
        "workflow" => {
            "**workflow** `name(params):`\n\nDeclares a workflow that may use LLM sessions, discretion, and approval gates."
        }
        "pipeline" => {
            "**pipeline** `name(params):`\n\nDeclares a deterministic pipeline. No sessions, discretion, or LLM calls allowed."
        }
        "parallel" => {
            "**parallel:**\n\nExecutes named arms concurrently. Supports `race` and `settle` join strategies."
        }
        "session" => {
            "**session** `\"prompt\"` | **session:** `agent`\n\nInvokes an LLM session. The ONLY place prose enters a workflow."
        }
        "if" => {
            "**if** `condition:`\n\nConditional branch. Condition may be an expression or discretion (`**...**`)."
        }
        "elif" => "**elif** `condition:`\n\nAdditional conditional branch after an `if` block.",
        "else" => "**else:**\n\nFallback branch when no `if`/`elif` conditions match.",
        "for" => "**for** `var` **in** `collection:`\n\nIterates over a collection.",
        "loop" => {
            "**loop:**\n\nRepeats until a termination condition. Use `until` to set the exit condition."
        }
        "repeat" => "**repeat** `N:`\n\nExecutes the body a fixed number of times.",
        "try" => {
            "**try:**\n\nBegins an error-handling block. Must be followed by `catch` and/or `finally`."
        }
        "catch" => "**catch** `err:`\n\nHandles errors from the preceding `try` block.",
        "finally" => {
            "**finally:**\n\nExecutes after `try`/`catch` regardless of success or failure."
        }
        "let" => "**let** `name` = `expr`\n\nBinds a value to a name. Immutable.",
        "const" => "**const** `name` = `expr`\n\nBinds a constant value. Must be a literal.",
        "output" => "**output** `name` = `expr`\n\nDeclares a workflow output binding.",
        "step" => "**step** `name:`\n\nDeclares a pipeline step with command, args, and timeout.",
        _ => return None,
    };
    Some(HoverInfo {
        contents: desc.to_string(),
    })
}

/// Hover info for agent name references.
fn agent_ref_hover(name: &str, doc: &CantDocument) -> Option<HoverInfo> {
    for section in &doc.sections {
        if let Section::Agent(agent) = section {
            if agent.name.value == name {
                let mut desc = format!("**@{name}** -- Agent definition");

                // Add model info if present
                for prop in &agent.properties {
                    if prop.key.value == "model" {
                        desc.push_str(&format!("\n\nModel: `{}`", prop_value_preview(&prop.value)));
                    }
                    if prop.key.value == "prompt" {
                        let preview = prop_value_preview(&prop.value);
                        let truncated = if preview.len() > 80 {
                            format!("{}...", &preview[..77])
                        } else {
                            preview
                        };
                        desc.push_str(&format!("\n\nPrompt: \"{truncated}\""));
                    }
                }

                return Some(HoverInfo { contents: desc });
            }
        }
    }
    None
}

/// Extracts a preview string from a property value.
fn prop_value_preview(value: &cant_core::dsl::ast::Value) -> String {
    match value {
        cant_core::dsl::ast::Value::String(s) => s.raw.clone(),
        cant_core::dsl::ast::Value::Identifier(id) => id.clone(),
        cant_core::dsl::ast::Value::Boolean(b) => b.to_string(),
        cant_core::dsl::ast::Value::Number(n) => n.to_string(),
        cant_core::dsl::ast::Value::Array(_) => "[...]".to_string(),
        cant_core::dsl::ast::Value::Duration(d) => {
            let unit = match d.unit {
                cant_core::dsl::ast::DurationUnit::Seconds => "s",
                cant_core::dsl::ast::DurationUnit::Minutes => "m",
                cant_core::dsl::ast::DurationUnit::Hours => "h",
                cant_core::dsl::ast::DurationUnit::Days => "d",
            };
            format!("{}{unit}", d.amount)
        }
        cant_core::dsl::ast::Value::ProseBlock(p) => {
            // Join the first line of the prose block as a preview.
            p.lines
                .first()
                .cloned()
                .unwrap_or_else(|| "|...".to_string())
        }
        cant_core::dsl::ast::Value::_Span(_) => "...".to_string(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn directive_hover_done() {
        let info = hover_for_word("/done", "/done @all", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("Actionable"));
    }

    #[test]
    fn directive_hover_review() {
        let info = hover_for_word("/review", "/review", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("Routing"));
    }

    #[test]
    fn event_hover_session_start() {
        let info = hover_for_word("SessionStart", "on SessionStart:", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("session"));
    }

    #[test]
    fn event_hover_pre_tool_use_shows_can_block() {
        let info = hover_for_word("PreToolUse", "on PreToolUse:", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("Can block"));
    }

    #[test]
    fn property_key_hover_model() {
        let info = hover_for_word("model", "  model: opus", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("string"));
    }

    #[test]
    fn keyword_hover_agent() {
        let info = hover_for_word("agent", "agent ops-lead:", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("agent"));
    }

    #[test]
    fn keyword_hover_workflow() {
        let info = hover_for_word("workflow", "workflow review:", None);
        assert!(info.is_some());
        assert!(info.unwrap().contents.contains("LLM"));
    }

    #[test]
    fn unknown_word_returns_none() {
        let info = hover_for_word("xyzzy_unknown", "xyzzy_unknown", None);
        assert!(info.is_none());
    }
}

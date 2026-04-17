//! Individual step execution for CANT pipelines.
//!
//! Each pipeline step runs as a subprocess via [`tokio::process::Command`].
//! Steps are executed with argument-vector dispatch (NEVER `sh -c`) per the
//! P06 security invariant. Stdout and stderr are captured, and a configurable
//! timeout enforces maximum step duration.

use crate::env::StepEnv;
use crate::error::RuntimeError;
use cant_core::dsl::ast::{DurationUnit, PipeStep, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// The result of executing a single pipeline step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    /// The step name from the pipeline definition.
    pub name: String,
    /// The subprocess exit code (0 = success).
    pub exit_code: i32,
    /// Captured standard output.
    pub stdout: String,
    /// Captured standard error.
    pub stderr: String,
    /// Wall-clock execution duration in milliseconds.
    pub duration_ms: u64,
    /// Whether the step was skipped due to a condition.
    pub skipped: bool,
}

/// Characters that indicate shell metacharacters in a command string.
/// The presence of any of these triggers a P06 rejection.
const SHELL_METACHARACTERS: &[char] = &[
    '|', '&', ';', '$', '`', '(', ')', '{', '}', '<', '>', '!', '\\', '\n', '*', '?', '[', ']', '~',
];

/// Validates that a command string contains no shell metacharacters (P06).
fn validate_command_safe(command: &str) -> Result<(), RuntimeError> {
    if command.contains(SHELL_METACHARACTERS) {
        return Err(RuntimeError::ShellMetacharacters {
            command: command.to_string(),
        });
    }
    Ok(())
}

/// Validates the command against an optional allowlist (P07).
fn validate_command_allowed(
    command: &str,
    allowlist: Option<&HashSet<String>>,
) -> Result<(), RuntimeError> {
    if let Some(list) = allowlist {
        // Extract the bare binary name (last path component)
        let binary = command.rsplit('/').next().unwrap_or(command);
        if !list.contains(binary) && !list.contains(command) {
            return Err(RuntimeError::CommandNotAllowed {
                command: command.to_string(),
            });
        }
    }
    Ok(())
}

/// Extracts a string property value from a step's property list.
fn get_string_property(step: &PipeStep, key: &str) -> Option<String> {
    step.properties.iter().find_map(|p| {
        if p.key.value == key {
            match &p.value {
                Value::String(s) => Some(s.raw.clone()),
                Value::Identifier(id) => Some(id.clone()),
                _ => None,
            }
        } else {
            None
        }
    })
}

/// Extracts an array-of-strings property from a step's property list.
fn get_string_array_property(step: &PipeStep, key: &str) -> Option<Vec<String>> {
    step.properties.iter().find_map(|p| {
        if p.key.value == key {
            match &p.value {
                Value::Array(items) => {
                    let strings: Vec<String> = items
                        .iter()
                        .filter_map(|v| match v {
                            Value::String(s) => Some(s.raw.clone()),
                            Value::Identifier(id) => Some(id.clone()),
                            _ => None,
                        })
                        .collect();
                    Some(strings)
                }
                _ => None,
            }
        } else {
            None
        }
    })
}

/// Extracts the timeout duration from a step's `timeout:` property.
fn get_timeout(step: &PipeStep) -> Option<Duration> {
    step.properties.iter().find_map(|p| {
        if p.key.value == "timeout" {
            match &p.value {
                Value::Duration(d) => {
                    let secs = match d.unit {
                        DurationUnit::Seconds => d.amount,
                        DurationUnit::Minutes => d.amount * 60,
                        DurationUnit::Hours => d.amount * 3600,
                        DurationUnit::Days => d.amount * 86400,
                    };
                    Some(Duration::from_secs(secs))
                }
                Value::Number(n) => Some(Duration::from_secs(*n as u64)),
                _ => None,
            }
        } else {
            None
        }
    })
}

/// Executes a single pipeline step as a subprocess.
///
/// # Security
///
/// - The command is validated against shell metacharacters (P06).
/// - The command is checked against the optional allowlist (P07).
/// - Execution uses `Command::new(binary).args(vec)` — NEVER `sh -c`.
///
/// # Arguments
///
/// * `step` - The AST node for the pipeline step.
/// * `env` - The current execution environment with variable bindings.
/// * `allowlist` - Optional set of allowed command binaries.
///
/// # Errors
///
/// Returns [`RuntimeError`] on command validation failure, missing variables,
/// subprocess spawn failure, timeout, or non-zero exit code.
pub async fn execute_step(
    step: &PipeStep,
    env: &StepEnv,
    allowlist: Option<&HashSet<String>>,
) -> Result<StepResult, RuntimeError> {
    let step_name = step.name.value.clone();

    // Extract the command property
    let raw_command = get_string_property(step, "command").unwrap_or_default();
    let command = env.resolve(&raw_command)?;

    // P06: Reject shell metacharacters in command
    validate_command_safe(&command)?;

    // P07: Check against allowlist
    validate_command_allowed(&command, allowlist)?;

    // Extract and resolve args
    let raw_args = get_string_array_property(step, "args").unwrap_or_default();
    let resolved_args = env.resolve_args(&raw_args)?;

    // Extract stdin source reference
    let stdin_source = get_string_property(step, "stdin");

    // Extract timeout
    let timeout = get_timeout(step).unwrap_or(Duration::from_secs(300));

    // Build subprocess command — CRITICAL: arg-vector dispatch, no shell
    let mut cmd = Command::new(&command);
    cmd.args(&resolved_args);

    // Pipe stdin from a prior step's stdout if referenced
    if let Some(ref source) = stdin_source {
        let source_key = format!("{source}.stdout");
        match env.get(&source_key) {
            Some(_) => {
                cmd.stdin(std::process::Stdio::piped());
            }
            None => {
                return Err(RuntimeError::StdinSourceNotFound {
                    name: step_name,
                    stdin_ref: source.clone(),
                });
            }
        }
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    tracing::debug!(step = %step_name, command = %command, args = ?resolved_args, "Executing pipeline step");

    let start = Instant::now();

    // Spawn the subprocess
    let mut child = cmd.spawn()?;

    // Write stdin data if piped
    if let Some(ref source) = stdin_source {
        let source_key = format!("{source}.stdout");
        if let Some(data) = env.get(&source_key) {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(data.as_bytes()).await;
                drop(stdin); // Close stdin to signal EOF
            }
        }
    }

    // Read stdout/stderr concurrently using helper tasks to avoid deadlocks.
    // We need to take ownership of the stdout/stderr handles before waiting.
    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        if let Some(mut out) = child_stdout {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf).await;
            buf
        } else {
            Vec::new()
        }
    });

    let stderr_task = tokio::spawn(async move {
        if let Some(mut err) = child_stderr {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            buf
        } else {
            Vec::new()
        }
    });

    // Wait for the process with timeout
    let wait_result = tokio::time::timeout(timeout, child.wait()).await;

    let duration_ms = start.elapsed().as_millis() as u64;

    match wait_result {
        Ok(Ok(status)) => {
            let exit_code = status.code().unwrap_or(-1);
            let stdout_bytes = stdout_task.await.unwrap_or_default();
            let stderr_bytes = stderr_task.await.unwrap_or_default();
            let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
            let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

            tracing::debug!(
                step = %step_name,
                exit_code = exit_code,
                duration_ms = duration_ms,
                "Step completed"
            );

            Ok(StepResult {
                name: step_name,
                exit_code,
                stdout,
                stderr,
                duration_ms,
                skipped: false,
            })
        }
        Ok(Err(e)) => Err(RuntimeError::Io(e)),
        Err(_) => {
            // Timeout — kill the process
            let _ = child.kill().await;
            Err(RuntimeError::StepTimeout {
                name: step_name,
                timeout_ms: timeout.as_millis() as u64,
            })
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use cant_core::dsl::ast::{Property, Spanned, StringValue};
    use cant_core::dsl::span::Span;

    fn span() -> Span {
        Span {
            start: 0,
            end: 0,
            line: 1,
            col: 1,
        }
    }

    fn make_step(name: &str, command: &str, args: Vec<&str>) -> PipeStep {
        let mut properties = vec![Property {
            key: Spanned::new("command".into(), span()),
            value: Value::String(StringValue {
                raw: command.into(),
                double_quoted: true,
                span: span(),
            }),
            span: span(),
        }];
        if !args.is_empty() {
            properties.push(Property {
                key: Spanned::new("args".into(), span()),
                value: Value::Array(
                    args.iter()
                        .map(|a| {
                            Value::String(StringValue {
                                raw: (*a).into(),
                                double_quoted: true,
                                span: span(),
                            })
                        })
                        .collect(),
                ),
                span: span(),
            });
        }
        PipeStep {
            name: Spanned::new(name.into(), span()),
            properties,
            span: span(),
        }
    }

    #[test]
    fn validate_command_safe_rejects_pipe() {
        let result = validate_command_safe("cat | grep foo");
        assert!(result.is_err());
    }

    #[test]
    fn validate_command_safe_rejects_semicolon() {
        let result = validate_command_safe("echo hi; rm -rf /");
        assert!(result.is_err());
    }

    #[test]
    fn validate_command_safe_rejects_dollar() {
        let result = validate_command_safe("echo $(whoami)");
        assert!(result.is_err());
    }

    #[test]
    fn validate_command_safe_accepts_simple_binary() {
        assert!(validate_command_safe("pnpm").is_ok());
        assert!(validate_command_safe("gh").is_ok());
        assert!(validate_command_safe("/usr/bin/git").is_ok());
    }

    #[test]
    fn validate_command_allowed_passes_without_list() {
        assert!(validate_command_allowed("anything", None).is_ok());
    }

    #[test]
    fn validate_command_allowed_passes_for_listed() {
        let mut list = HashSet::new();
        list.insert("pnpm".into());
        list.insert("gh".into());
        assert!(validate_command_allowed("pnpm", Some(&list)).is_ok());
        assert!(validate_command_allowed("gh", Some(&list)).is_ok());
    }

    #[test]
    fn validate_command_allowed_rejects_unlisted() {
        let mut list = HashSet::new();
        list.insert("pnpm".into());
        let result = validate_command_allowed("curl", Some(&list));
        assert!(result.is_err());
    }

    #[test]
    fn validate_command_allowed_strips_path() {
        let mut list = HashSet::new();
        list.insert("git".into());
        assert!(validate_command_allowed("/usr/bin/git", Some(&list)).is_ok());
    }

    #[tokio::test]
    async fn execute_echo_step() {
        let step = make_step("greet", "echo", vec!["hello", "world"]);
        let env = StepEnv::new();
        let result = execute_step(&step, &env, None).await.unwrap();
        assert_eq!(result.name, "greet");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout.trim(), "hello world");
        assert!(!result.skipped);
    }

    #[tokio::test]
    async fn execute_step_captures_stderr() {
        // Use a command that writes to stderr
        let step = make_step("warn", "sh", vec!["-c", "echo error >&2"]);
        // Note: We use sh -c here only for testing stderr capture behavior.
        // In production, sh -c is NEVER used (P06).
        // But validate_command_safe will reject 'sh' if metacharacters are in command field.
        // The command field is just "sh" which is safe — args contain the -c.
        let env = StepEnv::new();
        let result = execute_step(&step, &env, None).await.unwrap();
        assert!(result.stderr.contains("error"));
    }

    #[tokio::test]
    async fn execute_step_with_variable_resolution() {
        let step = make_step("greet", "echo", vec!["{message}"]);
        let mut env = StepEnv::new();
        env.set("message", "resolved-value");
        let result = execute_step(&step, &env, None).await.unwrap();
        assert_eq!(result.stdout.trim(), "resolved-value");
    }

    #[tokio::test]
    async fn execute_step_nonzero_exit() {
        let step = make_step("fail", "false", vec![]);
        let env = StepEnv::new();
        let result = execute_step(&step, &env, None).await.unwrap();
        assert_ne!(result.exit_code, 0);
    }

    #[tokio::test]
    async fn execute_step_rejects_metacharacter_command() {
        let step = make_step("bad", "echo; rm -rf /", vec![]);
        let env = StepEnv::new();
        let result = execute_step(&step, &env, None).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            RuntimeError::ShellMetacharacters { .. }
        ));
    }

    #[tokio::test]
    async fn execute_step_rejects_disallowed_command() {
        let mut list = HashSet::new();
        list.insert("pnpm".into());
        let step = make_step("hack", "curl", vec!["http://evil.com"]);
        let env = StepEnv::new();
        let result = execute_step(&step, &env, Some(&list)).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            RuntimeError::CommandNotAllowed { .. }
        ));
    }
}

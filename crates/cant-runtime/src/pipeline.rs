//! Pipeline executor for CANT DSL.
//!
//! Takes a validated [`PipelineDef`] AST node and executes each step
//! sequentially as a subprocess. Output is piped between steps when
//! `stdin: <prev_step>` is declared. All execution uses argument-vector
//! dispatch — shell interpolation is NEVER used (P06).

use crate::env::StepEnv;
use crate::error::RuntimeError;
use crate::step::{self, StepResult};
use cant_core::dsl::ast::PipelineDef;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Instant;

/// The aggregate result of executing an entire pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineResult {
    /// The pipeline name from the definition.
    pub name: String,
    /// Results for each step in execution order.
    pub steps: Vec<StepResult>,
    /// Whether the entire pipeline completed successfully (all steps exit 0).
    pub success: bool,
    /// Total wall-clock duration in milliseconds.
    pub duration_ms: u64,
}

/// Configuration options for pipeline execution.
#[derive(Debug, Clone, Default)]
pub struct PipelineConfig {
    /// Optional allowlist of permitted command binaries (P07).
    /// When `Some`, commands not in the list are rejected.
    /// When `None`, all commands are permitted.
    pub command_allowlist: Option<HashSet<String>>,
}

/// Executes a validated CANT pipeline definition.
///
/// Processes each step in sequence, resolving variable bindings and piping
/// stdout between steps where `stdin:` references are declared.
///
/// # Security
///
/// - Commands are validated against shell metacharacters (P06).
/// - Commands are optionally checked against an allowlist (P07).
/// - All subprocess invocations use `Command::new(binary).args(vec)`.
///
/// # Arguments
///
/// * `pipeline` - The parsed and validated `PipelineDef` AST node.
/// * `initial_env` - Initial variable bindings (workflow params, etc.).
/// * `config` - Execution configuration (allowlist, etc.).
///
/// # Errors
///
/// Returns [`RuntimeError`] on the first step failure. Prior successful
/// step results are included in the returned [`PipelineResult`] within
/// the error context (via the `StepFailed` variant).
pub async fn execute_pipeline(
    pipeline: &PipelineDef,
    initial_env: StepEnv,
    config: &PipelineConfig,
) -> Result<PipelineResult, RuntimeError> {
    let pipeline_name = pipeline.name.value.clone();
    let start = Instant::now();
    let mut env = initial_env;
    let mut step_results: Vec<StepResult> = Vec::with_capacity(pipeline.steps.len());
    let allowlist = config.command_allowlist.as_ref();

    tracing::info!(
        pipeline = %pipeline_name,
        step_count = pipeline.steps.len(),
        "Starting pipeline execution"
    );

    for pipe_step in &pipeline.steps {
        let step_name = pipe_step.name.value.clone();

        tracing::debug!(pipeline = %pipeline_name, step = %step_name, "Executing step");

        let result = step::execute_step(pipe_step, &env, allowlist).await?;

        // Record step output into environment for subsequent steps
        env.record_step_output(
            &result.name,
            &result.stdout,
            &result.stderr,
            result.exit_code,
        );

        let step_failed = result.exit_code != 0;
        step_results.push(result);

        if step_failed {
            let duration_ms = start.elapsed().as_millis() as u64;
            tracing::warn!(
                pipeline = %pipeline_name,
                step = %step_name,
                duration_ms = duration_ms,
                "Pipeline failed at step"
            );

            return Ok(PipelineResult {
                name: pipeline_name,
                steps: step_results,
                success: false,
                duration_ms,
            });
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    tracing::info!(
        pipeline = %pipeline_name,
        duration_ms = duration_ms,
        "Pipeline completed successfully"
    );

    Ok(PipelineResult {
        name: pipeline_name,
        steps: step_results,
        success: true,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cant_core::dsl::ast::{Property, Spanned, StringValue, Value};
    use cant_core::dsl::span::Span;

    fn span() -> Span {
        Span {
            start: 0,
            end: 0,
            line: 1,
            col: 1,
        }
    }

    fn str_val(s: &str) -> Value {
        Value::String(StringValue {
            raw: s.into(),
            double_quoted: true,
            span: span(),
        })
    }

    fn prop(key: &str, value: Value) -> Property {
        Property {
            key: Spanned::new(key.into(), span()),
            value,
            span: span(),
        }
    }

    fn make_echo_step(name: &str, message: &str) -> cant_core::dsl::ast::PipeStep {
        cant_core::dsl::ast::PipeStep {
            name: Spanned::new(name.into(), span()),
            properties: vec![
                prop("command", str_val("echo")),
                prop("args", Value::Array(vec![str_val(message)])),
            ],
            span: span(),
        }
    }

    fn make_pipeline(name: &str, steps: Vec<cant_core::dsl::ast::PipeStep>) -> PipelineDef {
        PipelineDef {
            name: Spanned::new(name.into(), span()),
            params: vec![],
            steps,
            span: span(),
        }
    }

    #[tokio::test]
    async fn execute_single_step_pipeline() {
        let pipeline = make_pipeline("simple", vec![make_echo_step("greet", "hello")]);
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert_eq!(result.name, "simple");
        assert!(result.success);
        assert_eq!(result.steps.len(), 1);
        assert_eq!(result.steps[0].name, "greet");
        assert_eq!(result.steps[0].exit_code, 0);
        assert_eq!(result.steps[0].stdout.trim(), "hello");
    }

    #[tokio::test]
    async fn execute_multi_step_pipeline() {
        let pipeline = make_pipeline(
            "multi",
            vec![
                make_echo_step("first", "step-1"),
                make_echo_step("second", "step-2"),
                make_echo_step("third", "step-3"),
            ],
        );
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert!(result.success);
        assert_eq!(result.steps.len(), 3);
        assert_eq!(result.steps[0].stdout.trim(), "step-1");
        assert_eq!(result.steps[1].stdout.trim(), "step-2");
        assert_eq!(result.steps[2].stdout.trim(), "step-3");
    }

    #[tokio::test]
    async fn pipeline_fails_on_nonzero_exit() {
        let fail_step = cant_core::dsl::ast::PipeStep {
            name: Spanned::new("fail".into(), span()),
            properties: vec![prop("command", str_val("false"))],
            span: span(),
        };
        let pipeline = make_pipeline(
            "failing",
            vec![
                make_echo_step("ok", "fine"),
                fail_step,
                make_echo_step("unreachable", "nope"),
            ],
        );
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert!(!result.success);
        // Only 2 steps executed (ok + fail), third was not reached
        assert_eq!(result.steps.len(), 2);
        assert_eq!(result.steps[0].exit_code, 0);
        assert_ne!(result.steps[1].exit_code, 0);
    }

    #[tokio::test]
    async fn pipeline_with_variable_resolution() {
        let step = cant_core::dsl::ast::PipeStep {
            name: Spanned::new("greet".into(), span()),
            properties: vec![
                prop("command", str_val("echo")),
                prop("args", Value::Array(vec![str_val("{name}")])),
            ],
            span: span(),
        };
        let pipeline = make_pipeline("vars", vec![step]);
        let mut env = StepEnv::new();
        env.set("name", "world");
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert!(result.success);
        assert_eq!(result.steps[0].stdout.trim(), "world");
    }

    #[tokio::test]
    async fn pipeline_step_output_available_to_next_step() {
        // Step 1: echo "data"
        // Step 2: echo the previous step's stdout via variable
        let step1 = make_echo_step("producer", "produced-value");
        let step2 = cant_core::dsl::ast::PipeStep {
            name: Spanned::new("consumer".into(), span()),
            properties: vec![
                prop("command", str_val("echo")),
                prop("args", Value::Array(vec![str_val("{producer.stdout}")])),
            ],
            span: span(),
        };
        let pipeline = make_pipeline("chain", vec![step1, step2]);
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert!(result.success);
        assert_eq!(result.steps.len(), 2);
        // The consumer echoed the producer's stdout (which includes a trailing newline)
        assert!(result.steps[1].stdout.contains("produced-value"));
    }

    #[tokio::test]
    async fn pipeline_rejects_disallowed_command() {
        let step = cant_core::dsl::ast::PipeStep {
            name: Spanned::new("hack".into(), span()),
            properties: vec![prop("command", str_val("curl"))],
            span: span(),
        };
        let pipeline = make_pipeline("restricted", vec![step]);
        let env = StepEnv::new();
        let mut allowlist = HashSet::new();
        allowlist.insert("echo".into());
        let config = PipelineConfig {
            command_allowlist: Some(allowlist),
        };

        let result = execute_pipeline(&pipeline, env, &config).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            RuntimeError::CommandNotAllowed { .. }
        ));
    }

    #[tokio::test]
    async fn empty_pipeline_succeeds() {
        let pipeline = make_pipeline("empty", vec![]);
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        assert!(result.success);
        assert!(result.steps.is_empty());
        assert_eq!(result.name, "empty");
    }

    #[tokio::test]
    async fn pipeline_result_has_duration() {
        let pipeline = make_pipeline("timed", vec![make_echo_step("a", "x")]);
        let env = StepEnv::new();
        let config = PipelineConfig::default();

        let result = execute_pipeline(&pipeline, env, &config).await.unwrap();

        // Duration should be non-negative (it's u64, so always >= 0)
        assert!(result.duration_ms < 10_000); // Sanity: should complete in < 10s
    }
}

//! CANT DSL Runtime — pipeline executor.
//!
//! This crate provides the Rust-native pipeline execution engine for the
//! CANT DSL. Pipelines are deterministic subprocess orchestration units:
//! no LLM calls, no discretion conditions, no approval gates.
//!
//! The primary entry point is [`pipeline::execute_pipeline`], which takes
//! a validated [`cant_core::dsl::ast::PipelineDef`] and executes each step
//! as a subprocess via `tokio::process::Command`.
//!
//! # Security Invariants
//!
//! - **P06**: All commands use argument-vector dispatch (`Command::new(binary).args(vec)`).
//!   Shell interpolation (`sh -c`) is NEVER used.
//! - **P07**: An optional command allowlist restricts which binaries may be executed.
//! - **T07**: Variable interpolation is single-pass — no nested expansion.
//!
//! # Architecture
//!
//! ```text
//! WorkflowExecutor (TypeScript)
//!   |
//!   |  PipelineDef from AST
//!   v
//! execute_pipeline() (Rust, this crate)
//!   |
//!   +-- execute_step() per PipeStep
//!   |     +-- Command::new(binary).args(vec)
//!   |     +-- capture stdout/stderr
//!   |     +-- enforce timeout
//!   |
//!   +-- StepEnv: variable resolution between steps
//!   |
//!   v
//! PipelineResult { steps, success, duration_ms }
//! ```
//!
//! # Usage
//!
//! ```no_run
//! use cant_runtime::pipeline::{execute_pipeline, PipelineConfig};
//! use cant_runtime::env::StepEnv;
//!
//! # async fn example(pipeline_def: &cant_core::dsl::ast::PipelineDef) {
//! let env = StepEnv::new();
//! let config = PipelineConfig::default();
//! let result = execute_pipeline(pipeline_def, env, &config).await;
//! match result {
//!     Ok(res) => println!("Pipeline {}: success={}", res.name, res.success),
//!     Err(e) => eprintln!("Pipeline error: {e}"),
//! }
//! # }
//! ```

pub mod env;
pub mod error;
pub mod pipeline;
pub mod step;

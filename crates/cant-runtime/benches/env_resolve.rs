//! Criterion benches for cant-runtime canonical variable resolution.
//!
//! Captures the perf-budget floor declared in the SG-BOUNDARY-REGISTRY
//! `boundary.ts` entry for cant-runtime (ADR-078, Saga T10176).
//!
//! Two benches are exposed:
//!
//! - `cant_runtime_resolve_simple_arg` — single `{var}` placeholder in a
//!   command argument. Establishes the per-arg variable resolution floor.
//! - `cant_runtime_resolve_full_pipeline_args` — full step argument
//!   vector with multiple placeholders mixing prior step outputs
//!   (`<step>.stdout`, `<step>.exitCode`) and workflow inputs. Mirrors
//!   the canonical pipeline-step hot path executed on every pipeline
//!   step invocation by [`cant_runtime::pipeline::execute_pipeline`].
//!
//! Variable resolution is the security-critical T07 invariant boundary:
//! single-pass, no nested expansion. The bench locks the per-call cost
//! so regressions on this hot path are caught before merge.

#![allow(missing_docs)]

use cant_runtime::env::StepEnv;
use criterion::{Criterion, black_box, criterion_group, criterion_main};

fn make_simple_env() -> (StepEnv, Vec<String>) {
    let mut env = StepEnv::new();
    env.set("target_branch", "main");
    (env, vec!["--branch".to_string(), "{target_branch}".to_string()])
}

fn make_full_pipeline_env() -> (StepEnv, Vec<String>) {
    let mut env = StepEnv::new();
    env.set("owner", "kryptobaseddev");
    env.set("repo", "cleo");
    env.set("pr_number", "504");
    env.set("target_branch", "main");
    env.record_step_output(
        "fetch_diff",
        "diff --git a/foo b/foo\nindex abc..def 100644\n--- a/foo\n+++ b/foo\n",
        "",
        0,
    );
    env.record_step_output("checkout", "Switched to branch 'main'\n", "", 0);
    let args = vec![
        "--repo".to_string(),
        "{owner}/{repo}".to_string(),
        "--pr".to_string(),
        "{pr_number}".to_string(),
        "--base".to_string(),
        "{target_branch}".to_string(),
        "--diff".to_string(),
        "{fetch_diff.stdout}".to_string(),
        "--last-checkout".to_string(),
        "{checkout.stdout}".to_string(),
        "--exit-code".to_string(),
        "{checkout.exitCode}".to_string(),
    ];
    (env, args)
}

fn bench_resolve_simple(c: &mut Criterion) {
    let (env, args) = make_simple_env();
    c.bench_function("cant_runtime_resolve_simple_arg", |b| {
        b.iter(|| {
            let resolved = env
                .resolve_args(black_box(&args))
                .expect("simple resolve must succeed");
            black_box(resolved);
        });
    });
}

fn bench_resolve_full(c: &mut Criterion) {
    let (env, args) = make_full_pipeline_env();
    c.bench_function("cant_runtime_resolve_full_pipeline_args", |b| {
        b.iter(|| {
            let resolved = env
                .resolve_args(black_box(&args))
                .expect("full resolve must succeed");
            black_box(resolved);
        });
    });
}

criterion_group!(benches, bench_resolve_simple, bench_resolve_full);
criterion_main!(benches);

/**
 * Pipeline Domain Operations — wire-format contracts.
 *
 * All pipeline *Params/*Result types were removed in T1446 (T1435-W2).
 * The canonical source of truth is `OpsFromCore<typeof coreOps>` inside
 * `packages/cleo/src/dispatch/domains/pipeline.ts`, which infers all
 * operation param/result shapes directly from Core function signatures
 * without requiring per-op type aliases in contracts.
 *
 * @task T1441 — OpsFromCore inference migration
 * @task T1435 — Wave 1 dispatch refactor
 * @task T1446 — strip redundant Params/Result aliases (T1435-W2)
 */

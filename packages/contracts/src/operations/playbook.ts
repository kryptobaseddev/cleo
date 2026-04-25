/**
 * Playbook Domain Operations (T1435 Wave 1)
 *
 * Typed operation contracts for the `playbook` dispatch domain are INFERRED
 * from Core function signatures via `OpsFromCore<typeof coreOps>` in the
 * dispatch layer. Per-op Params/Result types live in the dispatch domain
 * handler (packages/cleo/src/dispatch/domains/playbook.ts) as wrapper
 * function signatures, making them the single source of truth.
 *
 * This file is minimal and contains only shared wire types.
 *
 * @task T1435 Wave 1 — playbook dispatch refactor to OpsFromCore
 */

// Wire-format types are provided by @cleocode/playbooks and contracts.
// No per-op operation types are exported here (drift prevention via inference).

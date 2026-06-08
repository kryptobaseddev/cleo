/**
 * Pi in-process embed — public barrel (T11761 · S2 · T11898).
 *
 * The Pi agent loop runs in-process inside the Cleo daemon as the body of the
 * `SkillRunner` strategy slot, with ZERO authority — resolving its LLM only
 * through the E9 chokepoint, touching the filesystem/shell only through the
 * deny-first guarded `ExecutionEnv`, and running under `process.exit`
 * containment. See {@link ./pi-agent-adapter.js}.
 *
 * ## Public surface (intentionally minimal — Gate-4 Contracts Fan-Out)
 *
 * Only the SkillRunner factory + the default-OFF flag are exported. The adapter
 * internals (`PiAgentAdapter`, the streamFn, the session storage, the run-context
 * types) are core-internal and NOT re-exported here, so they cannot become a
 * cross-package contract by accident. When a second consumer ever needs one,
 * promote it to `@cleocode/contracts` then (YAGNI).
 *
 * The whole embed is gated by {@link isPiRunnerEnabled} (default-OFF): when the
 * flag is off, {@link createPiSkillRunner} is never wired into the dispatcher and
 * `defaultSkillRunner` runs instead.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

export type { PiAgentAdapterDeps } from './pi-agent-adapter.js';
export { createPiSkillRunner, isPiRunnerEnabled } from './pi-agent-adapter.js';

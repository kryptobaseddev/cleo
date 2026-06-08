/**
 * Core-internal Pi adapter types (T11761 · S2 · T11898).
 *
 * These types are the in-process contract between {@link createPiStreamFn} and
 * {@link PiAgentAdapter}. They are deliberately **core-internal** — NOT promoted
 * to `@cleocode/contracts` (Gate-4 Contracts Fan-Out: a type imported by >2
 * packages must move to contracts; these are imported only within
 * `core/src/llm/pi/`, so they stay here per YAGNI). The package barrel re-exports
 * ONLY `createPiSkillRunner` (everything else, including these types, is internal).
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import type { SystemOfUseLabel } from '@cleocode/contracts';

/**
 * Run context handed to the Pi adapter + streamFn for a single agent run.
 *
 * Carries the resolution chokepoint key ({@link system}) and the daemon-stamped
 * identity (NEVER minted by the adapter — read from env via the session-id
 * resolvers). The adapter runs with ZERO authority: it resolves its LLM through
 * `system`, never opens a DB writer, and never self-mints a session id.
 */
export interface PiAgentRunContext {
  /**
   * Semantic system-of-use label → role → resolved LLM, via the E9
   * {@link import('../system-resolver.js').resolveLLMForSystem} chokepoint
   * (e.g. `'task-executor'`).
   */
  readonly system: SystemOfUseLabel;
  /** Daemon-stamped session identity (read from `CLEO_SESSION_ID`, NEVER minted). */
  readonly sessionId: string;
  /** Daemon-stamped agent id (`CLEO_AGENT_ID`), or `null` when un-stamped. */
  readonly agentId: string | null;
  /** Parent session id (`CLEO_PARENT_SESSION_ID`), or `null` at the fork root. */
  readonly parentSessionId: string | null;
  /** Project root for config + credential resolution. Defaults to `process.cwd()`. */
  readonly projectRoot?: string;
  /** Abort propagation into Pi's agent loop. */
  readonly signal?: AbortSignal;
}

/**
 * Terminal result of a single {@link PiAgentAdapter.run}.
 *
 * `output` carries the aggregated assistant text + any structured bindings, in
 * the shape the `SkillRunner` slot projects onto a `SkillExecuteResult`.
 */
export interface PiAgentResult {
  /** Whether the agent run succeeded or failed. */
  readonly status: 'success' | 'failure';
  /** Aggregated terminal output (assistant text + structured bindings). */
  readonly output: Readonly<Record<string, unknown>>;
  /** Human-readable failure reason; present iff `status === 'failure'`. */
  readonly error?: string;
}

/**
 * Agent admission — Never-OOM wave/spawn gating (T12000, Epic T11992).
 *
 * Two surfaces share the {@link ResourceGovernor} `agent-session` class:
 *
 * 1. **Advisory annotation** ({@link computeAgentAdmission}) — `orchestrate ready`
 *    and `orchestrate waves` annotate which ready tasks are admittable NOW
 *    versus deferred, so an orchestrator sizes its parallel fan-out to host
 *    capacity and retries the remainder on a later pull instead of spawning a
 *    swarm that OOMs the box. Non-destructive: the full ready set is preserved;
 *    only an additive `admission` breakdown is attached.
 * 2. **Hard enforcement** (the spawn-execute gate in `spawn-ops.ts`) — acquires
 *    an `agent-session` grant BEFORE any worktree or process is provisioned, so
 *    a denial returns a retryable {@link RESOURCE_DEFERRED_CODE} with no partial
 *    artifacts left behind.
 *
 * The annotation guides; the gate enforces. In `off` mode (and on idle hosts
 * with ample memory) both are pass-through and today's behaviour is unchanged.
 *
 * @task T12000
 * @epic T11992
 * @adr resource-governor-never-oom-architecture §3.4 (admission #1/#2)
 */

import type { ResourceSample } from '../resources/backend.js';
import { governor } from '../resources/governor.js';

/**
 * Additive admission breakdown attached to `ready`/`waves` envelopes. Legacy
 * consumers ignore it; admission-aware orchestrators spawn only {@link admitted}
 * and re-query for {@link deferred} as slots free.
 */
export interface AgentAdmission {
  /**
   * Currently-grantable `agent-session` slots (budget − held). A finite count
   * in `local`/`supervisor` mode; equals the candidate count when ungated
   * (`off` mode / unbounded budget) so the field always serializes as a number.
   */
  readonly agentBudget: number;
  /** Candidate task IDs admitted to spawn now (the first {@link agentBudget}). */
  readonly admitted: string[];
  /** Candidate task IDs deferred — retry on a later query as slots free. */
  readonly deferred: string[];
}

/** Options for {@link computeAgentAdmission}. */
export interface AgentAdmissionOptions {
  /** Inject a pre-taken pressure sample (tests). */
  readonly sample?: ResourceSample;
  /** Override CPU count (tests). */
  readonly cpuCount?: number;
  /** Override total RAM bytes (tests). */
  readonly totalMemBytes?: number;
}

/**
 * Split an ordered list of candidate (ready) task IDs into the set admittable
 * under the current `agent-session` budget and the deferred remainder.
 *
 * Ordering is preserved, so priority-sorted ready sets admit highest-priority
 * tasks first. When the governor is ungated (`off` mode / unbounded), every
 * candidate is admitted and `agentBudget` reflects the full count. A budget of
 * `0` (all slots held) defers everything — the caller re-queries; the spawn
 * gate is the hard backstop, so an over-eager retry is bounded there too.
 *
 * @param taskIds - Ready task IDs in the order they should be admitted.
 * @param opts - Optional pressure/host overrides (tests).
 */
export async function computeAgentAdmission(
  taskIds: readonly string[],
  opts: AgentAdmissionOptions = {},
): Promise<AgentAdmission> {
  const budget = await governor.available('agent-session', {
    ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
    ...(opts.cpuCount !== undefined ? { cpuCount: opts.cpuCount } : {}),
    ...(opts.totalMemBytes !== undefined ? { totalMemBytes: opts.totalMemBytes } : {}),
  });

  if (!Number.isFinite(budget)) {
    return { agentBudget: taskIds.length, admitted: [...taskIds], deferred: [] };
  }

  const cap = Math.max(0, Math.floor(budget));
  return {
    agentBudget: cap,
    admitted: taskIds.slice(0, cap),
    deferred: taskIds.slice(cap),
  };
}

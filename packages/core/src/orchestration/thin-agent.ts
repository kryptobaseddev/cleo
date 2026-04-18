/**
 * Thin-agent runtime enforcer — the spawn-time half of the T931 guard.
 *
 * Workers MUST NOT spawn subagents. The CANT parser strips `Agent` and `Task`
 * tool names from worker-role tool lists at parse time
 * ({@link @cleocode/cant.stripSpawnToolsForWorker}). This module adds a
 * defense-in-depth check at the dispatch boundary: immediately before
 * {@link composeSpawnPayload} emits a prompt, it calls
 * {@link enforceThinAgent} to confirm no spawn-capable tool survived into the
 * resolved payload.
 *
 * The check is purely structural — it accepts a role and a flat tool list and
 * returns a discriminated result. Callers choose how to react:
 *
 *  - Strict (default): throw {@link ThinAgentViolationError}. Aligns with
 *    {@link ExitCode.THIN_AGENT_VIOLATION} (exit 68).
 *  - Soft (`'strip'`): drop the offending tools and continue, surfacing the
 *    strip in the spawn payload `meta` for audit.
 *  - Off (`'off'`): escape hatch for owner-approved dogfood scenarios (e.g.
 *    an orchestrator-of-orchestrators prototype). Audited via `.cleo/audit/`
 *    when used.
 *
 * @module orchestration/thin-agent
 * @task T931 Thin-agent runtime enforcer
 * @task T907 Thin-agent enforcement
 * @task T889 Orchestration Coherence v3
 */

import type { AgentSpawnCapability } from '@cleocode/contracts';

// ============================================================================
// Constants
// ============================================================================

/**
 * Tool names that grant subagent-spawn capability in the Claude Code runtime.
 * Workers MUST NOT carry these names at dispatch time. Mirrors the parse-time
 * `WORKER_FORBIDDEN_SPAWN_TOOLS` constant in `@cleocode/cant/hierarchy`.
 *
 * Kept in sync with the CANT package rather than re-exported because the core
 * package does not depend on `@cleocode/cant` (cant depends on core, not the
 * other way around).
 */
export const THIN_AGENT_SPAWN_TOOLS: readonly string[] = ['Agent', 'Task'] as const;

/**
 * Stable LAFS error code emitted when {@link enforceThinAgent} rejects a spawn.
 * Aligns with {@link ExitCode.THIN_AGENT_VIOLATION} (exit 68).
 */
export const E_THIN_AGENT_VIOLATION = 'E_THIN_AGENT_VIOLATION' as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Enforcement mode for {@link enforceThinAgent}.
 *
 *  - `'strict'` — return `{ ok: false, code: 'E_THIN_AGENT_VIOLATION' }` when
 *    any spawn-capable tool remains on a worker. Caller is expected to throw
 *    {@link @cleocode/contracts.ThinAgentViolationError}. Default.
 *  - `'strip'` — silently drop the offending tools and return
 *    `{ ok: true, tools: stripped, stripped: [...] }`. Useful when callers
 *    want to continue with a sanitized tool list (e.g. ad-hoc owner dispatch).
 *  - `'off'`   — fully disable the check. Returns `{ ok: true, tools }` with
 *    no filtering. Reserved for audited owner overrides; emits `bypassed:
 *    true` in the result so callers can log the escape.
 */
export type ThinAgentEnforcementMode = 'strict' | 'strip' | 'off';

/**
 * Success result from {@link enforceThinAgent}.
 *
 * `tools` is the (possibly stripped) tool list the caller should use
 * downstream. `stripped` is populated only in `'strip'` mode — it lists the
 * tools that were removed. `bypassed` is `true` only in `'off'` mode.
 */
export interface ThinAgentOk {
  readonly ok: true;
  readonly tools: readonly string[];
  readonly stripped: readonly string[];
  readonly bypassed: boolean;
}

/**
 * Rejection result from {@link enforceThinAgent} in `'strict'` mode.
 *
 * Carries the offending tools so callers can construct a
 * {@link @cleocode/contracts.ThinAgentViolationError} with full diagnostic
 * context.
 */
export interface ThinAgentFail {
  readonly ok: false;
  readonly code: typeof E_THIN_AGENT_VIOLATION;
  readonly role: AgentSpawnCapability;
  readonly violatingTools: readonly string[];
  readonly message: string;
}

/**
 * Discriminated union for {@link enforceThinAgent}. Narrow on `ok` before
 * using `.tools` vs `.violatingTools`.
 */
export type ThinAgentResult = ThinAgentOk | ThinAgentFail;

// ============================================================================
// Public API
// ============================================================================

/**
 * Enforce the thin-agent inversion-of-control rule at dispatch time.
 *
 * Returns `{ ok: true }` when no enforcement is required:
 *
 *  - `role` is `'orchestrator'` or `'lead'` (spawn is explicitly permitted).
 *  - `role` is `'worker'` but no spawn-capable tool is present in `tools`.
 *
 * Returns `{ ok: false, code: 'E_THIN_AGENT_VIOLATION', ... }` when:
 *
 *  - `role` is `'worker'` and `tools` contains one or more of
 *    {@link THIN_AGENT_SPAWN_TOOLS} (`Agent`, `Task`).
 *  - AND `mode` is `'strict'` (the default).
 *
 * Under `mode: 'strip'` the offending tools are silently removed and the
 * result is `{ ok: true, stripped: [...] }`. Under `mode: 'off'` the check
 * is bypassed entirely and the result is `{ ok: true, bypassed: true }`.
 *
 * @param role  - The role the agent will execute as.
 * @param tools - The flat tool allowlist resolved for the agent. Non-array
 *                inputs are treated as empty lists.
 * @param mode  - Enforcement mode. Defaults to `'strict'`.
 * @returns A discriminated {@link ThinAgentResult}.
 *
 * @example
 * ```typescript
 * const result = enforceThinAgent('worker', ['Agent', 'Read']);
 * if (!result.ok) {
 *   throw new ThinAgentViolationError('worker-42', 'worker', 'spawn');
 * }
 * // result.tools is safe to pass to the runtime.
 * ```
 *
 * @task T931 Thin-agent runtime enforcer
 */
export function enforceThinAgent(
  role: AgentSpawnCapability,
  tools: readonly string[] | undefined,
  mode: ThinAgentEnforcementMode = 'strict',
): ThinAgentResult {
  const safeTools: readonly string[] = Array.isArray(tools) ? tools : [];

  if (mode === 'off') {
    return { ok: true, tools: safeTools, stripped: [], bypassed: true };
  }

  if (role !== 'worker') {
    return { ok: true, tools: safeTools, stripped: [], bypassed: false };
  }

  const blocked: readonly string[] = THIN_AGENT_SPAWN_TOOLS;
  const violating: string[] = [];
  const kept: string[] = [];
  for (const tool of safeTools) {
    if (blocked.includes(tool)) {
      violating.push(tool);
    } else {
      kept.push(tool);
    }
  }

  if (violating.length === 0) {
    return { ok: true, tools: safeTools, stripped: [], bypassed: false };
  }

  if (mode === 'strip') {
    return { ok: true, tools: kept, stripped: violating, bypassed: false };
  }

  // Strict mode — caller must throw. Provide enough context for a
  // ThinAgentViolationError without forcing the core package to depend on
  // @cleocode/contracts' error classes at module top-level.
  return {
    ok: false,
    code: E_THIN_AGENT_VIOLATION,
    role,
    violatingTools: violating,
    message: `E_THIN_AGENT_VIOLATION: worker role carries spawn-capable tool(s) ${violating
      .map((t) => `'${t}'`)
      .join(
        ', ',
      )}. Workers MUST NOT spawn subagents (ORC-012). Fix the .cant source or pass thinAgentEnforcement: 'off' with an audited reason.`,
  };
}

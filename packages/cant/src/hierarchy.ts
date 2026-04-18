/**
 * 3-tier hierarchy enforcement module — Wave 7.
 *
 * Enforces the CLEO agent hierarchy at spawn time per ULTRAPLAN section 10.
 * Three roles (orchestrator, lead, worker) have strictly defined routing
 * rules and tool restrictions:
 *
 *   - Orchestrators dispatch to leads only; cannot use Edit/Write/Bash.
 *   - Leads dispatch to own-group workers only; cannot use Edit/Write/Bash.
 *   - Workers cannot dispatch agents; may only query peers.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent role within the 3-tier hierarchy. */
export type Role = 'orchestrator' | 'lead' | 'worker';

/**
 * Routing rules for a team definition.
 *
 * Controls which agents each role tier may communicate with. The
 * `orchestratorCanCall` and `leadCanCall` fields accept either a keyword
 * shorthand (`'leads'` / `'own_group_workers'`) or an explicit list of
 * agent names for fine-grained control.
 */
export interface TeamRouting {
  /** The human-in-the-loop target agent name. */
  hitlTarget: string;
  /** Who the orchestrator may dispatch to: all leads or a named subset. */
  orchestratorCanCall: 'leads' | string[];
  /** Who a lead may dispatch to: own group workers or a named subset. */
  leadCanCall: 'own_group_workers' | string[];
  /** Explicit list of agents a worker may dispatch (typically empty). */
  workerCanCall: string[];
  /** Who workers may query: all peers or a named subset. */
  workerCanQuery: 'peers' | string[];
}

/**
 * Full team definition describing the hierarchy, group membership, and
 * routing rules for an agent team.
 */
export interface TeamDefinition {
  /** Human-readable team name. */
  name: string;
  /** Name of the orchestrator agent. */
  orchestrator: string;
  /** Map of group name to lead agent name. */
  leads: Record<string, string>;
  /** Map of group name to worker agent names. */
  workers: Record<string, string[]>;
  /** Routing rules governing inter-agent dispatch. */
  routing: TeamRouting;
  /** Enforcement mode: strict rejects violations, permissive logs warnings. */
  enforcement: 'strict' | 'permissive';
}

/** Forbidden tools for lead-role agents (ULTRAPLAN section 10.4 LEAD-001). */
export const LEAD_FORBIDDEN_TOOLS = ['Edit', 'Write', 'Bash'] as const;

/** Forbidden tools for orchestrator-role agents (ULTRAPLAN section 10.5 ORCH-001). */
export const ORCHESTRATOR_FORBIDDEN_TOOLS = ['Edit', 'Write', 'Bash'] as const;

/**
 * Forbidden tools for worker-role agents per the thin-agent inversion-of-control
 * rule (ORC-012, T931). Workers MUST NOT spawn subagents; these tool names are
 * the canonical Claude Code spawn surfaces and are stripped at parse time.
 *
 * @task T931 Thin-agent runtime enforcer
 * @task T907 Thin-agent enforcement
 */
export const WORKER_FORBIDDEN_SPAWN_TOOLS = ['Agent', 'Task'] as const;

/**
 * Diagnostic code emitted when {@link stripSpawnToolsForWorker} removed one or
 * more tools from a worker-role tool list. Callers that want to surface the
 * strip to audit logs should inspect the `removed` array on the warning.
 */
export const THIN_AGENT_TOOLS_STRIPPED = 'THIN_AGENT_TOOLS_STRIPPED' as const;

/**
 * Structured warning returned by {@link stripSpawnToolsForWorker} when any
 * spawn-capable tool was removed from a worker-role tool list. Surfaced by the
 * parser so downstream layers (bundle compiler, composer, registry install)
 * can attach the warning to their own diagnostic channels.
 *
 * @task T931 Thin-agent runtime enforcer
 */
export interface ThinAgentToolsStrippedWarning {
  /** Stable diagnostic code — `'THIN_AGENT_TOOLS_STRIPPED'`. */
  readonly code: typeof THIN_AGENT_TOOLS_STRIPPED;
  /** Human-readable message explaining the strip. */
  readonly message: string;
  /** The exact tool names that were removed. */
  readonly removed: readonly string[];
}

/**
 * Result returned by {@link stripSpawnToolsForWorker}. Always carries the
 * (possibly unchanged) `tools` list; `warning` is only populated when at least
 * one tool was stripped.
 */
export interface StripSpawnToolsResult {
  /** Final tool list after thin-agent enforcement. */
  readonly tools: readonly string[];
  /** Structured warning iff any tool was removed. */
  readonly warning: ThinAgentToolsStrippedWarning | null;
}

/**
 * Result of a spawn validation check.
 */
export interface SpawnValidation {
  /** Whether the spawn is allowed. */
  allowed: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Spawn validation
// ---------------------------------------------------------------------------

/**
 * Validate whether a caller agent is allowed to spawn a target agent
 * per the team's routing rules.
 *
 * Routing constraints (ULTRAPLAN section 10.2):
 *   - Orchestrator may only dispatch to leads.
 *   - Lead may only dispatch to workers within their own group.
 *   - Workers may never dispatch agents (peer queries only).
 *
 * @param callerName - Name of the agent requesting the spawn.
 * @param callerRole - Role of the calling agent.
 * @param targetName - Name of the agent to be spawned.
 * @param targetRole - Role of the target agent.
 * @param team       - The team definition containing routing rules.
 * @returns A {@link SpawnValidation} indicating whether the spawn is allowed.
 */
export function validateSpawnRequest(
  callerName: string,
  callerRole: Role,
  targetName: string,
  _targetRole: Role,
  team: TeamDefinition,
): SpawnValidation {
  // Orchestrator can call leads
  if (callerRole === 'orchestrator') {
    const isLead = Object.values(team.leads).includes(targetName);
    if (!isLead) {
      return {
        allowed: false,
        reason: `Orchestrator ${callerName} can only dispatch to leads. ${targetName} is not a lead.`,
      };
    }
    return { allowed: true, reason: 'Orchestrator dispatching to lead' };
  }

  // Lead can call own-group workers
  if (callerRole === 'lead') {
    const callerGroup = Object.entries(team.leads).find(([, name]) => name === callerName)?.[0];
    if (!callerGroup) {
      return {
        allowed: false,
        reason: `Lead ${callerName} not found in any team group`,
      };
    }
    const groupWorkers = team.workers[callerGroup] ?? [];
    if (!groupWorkers.includes(targetName)) {
      return {
        allowed: false,
        reason: `Lead ${callerName} (group: ${callerGroup}) cannot dispatch to ${targetName} — not in own worker group`,
      };
    }
    return {
      allowed: true,
      reason: `Lead dispatching to own-group worker (${callerGroup})`,
    };
  }

  // Workers cannot dispatch
  if (callerRole === 'worker') {
    return {
      allowed: false,
      reason: `Worker ${callerName} cannot dispatch agents. Workers may only query peers.`,
    };
  }

  return { allowed: false, reason: 'Unknown caller role' };
}

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

/**
 * Filter a tool list based on role constraints.
 *
 * Leads and orchestrators have Edit, Write, and Bash stripped per
 * ULTRAPLAN sections 10.4 (LEAD-001) and 10.5 (ORCH-001). Workers have
 * `Agent` and `Task` stripped per the thin-agent inversion-of-control rule
 * (ORC-012, T931) — workers MUST NOT spawn subagents.
 *
 * @param tools - The full list of tool names available to the agent.
 * @param role  - The agent's role in the hierarchy.
 * @returns The filtered tool list with forbidden tools removed.
 */
export function filterToolsForRole(tools: string[], role: Role): string[] {
  if (role === 'worker') {
    return stripSpawnToolsForWorker(tools).tools.slice();
  }
  const forbidden: readonly string[] =
    role === 'lead' ? LEAD_FORBIDDEN_TOOLS : ORCHESTRATOR_FORBIDDEN_TOOLS;
  return tools.filter((t) => !forbidden.includes(t));
}

/**
 * Strip spawn-capable tools (`Agent`, `Task`) from a worker-role tool list at
 * parse time. This is the parse-time half of the T931 thin-agent runtime
 * enforcer — workers MUST NOT carry the Claude Code `Agent`/`Task` surfaces
 * because doing so would let them spawn subagents and break the worker
 * inversion-of-control contract (ORC-012).
 *
 * The runtime half (`enforceThinAgent` in `@cleocode/core/orchestration`)
 * performs the same check immediately before dispatch as a defense-in-depth
 * guard against misconfigured `.cant` sources or hand-written payloads that
 * bypass the parser.
 *
 * @param tools - The flat tool allowlist declared on a worker agent. Missing
 *                or non-array inputs are coerced to an empty result for safety.
 * @returns A {@link StripSpawnToolsResult} that always carries `tools` and
 *          carries a `warning` iff any tool was removed.
 *
 * @example
 * ```typescript
 * const result = stripSpawnToolsForWorker(['Agent', 'Read', 'Edit']);
 * // result.tools   → ['Read', 'Edit']
 * // result.warning → { code: 'THIN_AGENT_TOOLS_STRIPPED', removed: ['Agent'] }
 * ```
 *
 * @task T931 Thin-agent runtime enforcer
 */
export function stripSpawnToolsForWorker(tools: readonly string[]): StripSpawnToolsResult {
  if (!Array.isArray(tools)) {
    return { tools: [], warning: null };
  }
  const blocked: readonly string[] = WORKER_FORBIDDEN_SPAWN_TOOLS;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const tool of tools) {
    if (blocked.includes(tool)) {
      removed.push(tool);
    } else {
      kept.push(tool);
    }
  }
  if (removed.length === 0) {
    return { tools: kept, warning: null };
  }
  return {
    tools: kept,
    warning: {
      code: THIN_AGENT_TOOLS_STRIPPED,
      message: `Removed ${removed.length} spawn-capable tool(s) from worker role: ${removed.join(', ')}. Workers cannot spawn subagents (ORC-012).`,
      removed,
    },
  };
}

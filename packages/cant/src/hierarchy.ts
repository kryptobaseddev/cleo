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
    const callerGroup = Object.entries(team.leads).find(
      ([, name]) => name === callerName,
    )?.[0];
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
 * ULTRAPLAN sections 10.4 (LEAD-001) and 10.5 (ORCH-001). Workers
 * retain all tools.
 *
 * @param tools - The full list of tool names available to the agent.
 * @param role  - The agent's role in the hierarchy.
 * @returns The filtered tool list with forbidden tools removed.
 */
export function filterToolsForRole(tools: string[], role: Role): string[] {
  if (role === 'worker') return tools;
  const forbidden: readonly string[] =
    role === 'lead' ? LEAD_FORBIDDEN_TOOLS : ORCHESTRATOR_FORBIDDEN_TOOLS;
  return tools.filter((t) => !forbidden.includes(t));
}

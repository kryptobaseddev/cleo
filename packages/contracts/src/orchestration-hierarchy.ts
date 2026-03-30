/**
 * Orchestration Hierarchy — 5-level agent hierarchy types.
 *
 * Codifies the agent authority chain from ORCH-PLAN.md:
 *   Level 0: HITL (Human-In-The-Loop) — Owner, final authority
 *   Level 1: Prime Orchestrator — Cross-project coordination
 *   Level 2: Project Lead — Project-level architecture decisions
 *   Level 3: Team Lead — Team-level task management, can spawn ephemeral agents
 *   Level 4: Ephemeral — Task-scoped agents spawned by Team Leads
 *
 * @see docs/specs/CLEO-ORCH-PLAN.md
 * @task T217
 */

// ============================================================================
// Hierarchy levels
// ============================================================================

/** The 5 orchestration levels in order of authority. */
export enum OrchestrationLevel {
  /** Level 0: Human owner. Final authority. Never contacted by agents directly. */
  HITL = 0,
  /** Level 1: Prime Orchestrator. Cross-project coordination. Breaks ties. */
  Prime = 1,
  /** Level 2: Project Lead. Architecture decisions within a project. */
  ProjectLead = 2,
  /** Level 3: Team Lead. Task management. Can spawn ephemeral agents. */
  TeamLead = 3,
  /** Level 4: Ephemeral agent. Task-scoped, short-lived. */
  Ephemeral = 4,
}

// ============================================================================
// Agent hierarchy membership
// ============================================================================

/** An agent's position in the orchestration hierarchy. */
export interface AgentHierarchyEntry {
  /** The agent's unique ID (e.g. 'cleo-rust-lead'). */
  agentId: string;
  /** Display name for human-readable output. */
  displayName: string;
  /** The agent's orchestration level. */
  level: OrchestrationLevel;
  /** The agent's direct superior (null for HITL). */
  reportsTo: string | null;
  /** Agents this agent directly manages (empty for Ephemeral). */
  manages: string[];
  /** Project scope (null for cross-project agents like Prime). */
  projectId: string | null;
  /** Team scope within a project (e.g. 'cleocode', 'signaldock'). */
  teamId: string | null;
  /** Whether this agent can spawn ephemeral sub-agents. */
  canSpawn: boolean;
}

/** The full agent hierarchy tree. */
export interface AgentHierarchy {
  /** All agents in the hierarchy, keyed by agentId. */
  agents: Record<string, AgentHierarchyEntry>;
  /** The Prime Orchestrator agent ID. */
  primeId: string;
  /** Project IDs in this hierarchy. */
  projectIds: string[];
}

// ============================================================================
// Escalation chain
// ============================================================================

/** An escalation path from an agent to its authority chain. */
export interface EscalationChain {
  /** The requesting agent. */
  fromAgentId: string;
  /** Ordered list of agents to escalate to (nearest first). */
  chain: string[];
  /** The final authority (PRIME or HITL). */
  finalAuthority: string;
}

// ============================================================================
// Hierarchy API
// ============================================================================

/** API for querying and managing the agent hierarchy. */
export interface OrchestrationHierarchyAPI {
  /** Get the full hierarchy. */
  getHierarchy(): AgentHierarchy;

  /** Get a single agent's hierarchy entry. */
  getAgent(agentId: string): AgentHierarchyEntry | null;

  /** Get all agents at a specific level. */
  getAgentsAtLevel(level: OrchestrationLevel): AgentHierarchyEntry[];

  /** Get the escalation chain for an agent. */
  getEscalationChain(agentId: string): EscalationChain;

  /** Get all agents managed by a specific agent (direct reports). */
  getDirectReports(agentId: string): AgentHierarchyEntry[];

  /** Check if agent A has authority over agent B. */
  hasAuthority(agentIdA: string, agentIdB: string): boolean;

  /** Get all agents scoped to a project. */
  getProjectAgents(projectId: string): AgentHierarchyEntry[];
}

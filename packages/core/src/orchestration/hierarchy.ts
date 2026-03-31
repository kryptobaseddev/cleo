/**
 * OrchestrationHierarchyImpl — Concrete implementation of the 5-level hierarchy.
 *
 * Loads the agent matrix from agent-matrix.json (if available) or uses
 * the built-in default matrix. Provides escalation chain resolution,
 * authority checks, and project scoping.
 *
 * @see docs/specs/CLEO-ORCH-PLAN.md
 * @task T217
 */

import type {
  AgentHierarchy,
  AgentHierarchyEntry,
  EscalationChain,
  OrchestrationHierarchyAPI,
} from '@cleocode/contracts';
import { OrchestrationLevel } from '@cleocode/contracts';

/**
 * Default agent hierarchy matching PRIME's agent matrix (Agenda 10).
 *
 * This is the canonical hierarchy as of 2026-03-30:
 *   Owner (HITL)
 *     └── cleoos-opus-orchestrator (PRIME)
 *           ├── cleo-rust-lead → cleo-dev
 *           ├── cleo-db-lead → signaldock-backend
 *           ├── cleo-historian
 *           └── signaldock-core-agent → signaldock-backend, signaldock-dev, signaldock-frontend
 */
function buildDefaultHierarchy(): AgentHierarchy {
  const agents: Record<string, AgentHierarchyEntry> = {
    owner: {
      agentId: 'owner',
      displayName: 'Owner (HITL)',
      level: OrchestrationLevel.HITL,
      reportsTo: null,
      manages: ['cleoos-opus-orchestrator'],
      projectId: null,
      teamId: null,
      canSpawn: false,
    },
    'cleoos-opus-orchestrator': {
      agentId: 'cleoos-opus-orchestrator',
      displayName: 'PRIME Orchestrator',
      level: OrchestrationLevel.Prime,
      reportsTo: 'owner',
      manages: ['cleo-rust-lead', 'cleo-db-lead', 'cleo-historian', 'signaldock-core-agent'],
      projectId: null,
      teamId: null,
      canSpawn: true,
    },
    'cleo-rust-lead': {
      agentId: 'cleo-rust-lead',
      displayName: 'Cleo Rust Lead',
      level: OrchestrationLevel.ProjectLead,
      reportsTo: 'cleoos-opus-orchestrator',
      manages: ['cleo-dev'],
      projectId: 'cleocode',
      teamId: 'cleocode',
      canSpawn: true,
    },
    'cleo-db-lead': {
      agentId: 'cleo-db-lead',
      displayName: 'Cleo DB Lead',
      level: OrchestrationLevel.ProjectLead,
      reportsTo: 'cleoos-opus-orchestrator',
      manages: ['signaldock-backend'],
      projectId: 'cleocode',
      teamId: 'cleocode',
      canSpawn: true,
    },
    'cleo-historian': {
      agentId: 'cleo-historian',
      displayName: 'Cleo Historian',
      level: OrchestrationLevel.TeamLead,
      reportsTo: 'cleoos-opus-orchestrator',
      manages: [],
      projectId: 'cleocode',
      teamId: 'cleocode',
      canSpawn: false,
    },
    'cleo-dev': {
      agentId: 'cleo-dev',
      displayName: 'Cleo Dev',
      level: OrchestrationLevel.TeamLead,
      reportsTo: 'cleo-rust-lead',
      manages: [],
      projectId: 'cleocode',
      teamId: 'cleocode',
      canSpawn: true,
    },
    'signaldock-core-agent': {
      agentId: 'signaldock-core-agent',
      displayName: 'SignalDock Core Agent',
      level: OrchestrationLevel.ProjectLead,
      reportsTo: 'cleoos-opus-orchestrator',
      manages: ['signaldock-backend', 'signaldock-dev', 'signaldock-frontend'],
      projectId: 'signaldock',
      teamId: 'signaldock',
      canSpawn: true,
    },
    'signaldock-backend': {
      agentId: 'signaldock-backend',
      displayName: 'SignalDock Backend',
      level: OrchestrationLevel.TeamLead,
      reportsTo: 'signaldock-core-agent',
      manages: [],
      projectId: 'signaldock',
      teamId: 'signaldock',
      canSpawn: false,
    },
    'signaldock-dev': {
      agentId: 'signaldock-dev',
      displayName: 'SignalDock Dev',
      level: OrchestrationLevel.TeamLead,
      reportsTo: 'signaldock-core-agent',
      manages: [],
      projectId: 'signaldock',
      teamId: 'signaldock',
      canSpawn: false,
    },
    'signaldock-frontend': {
      agentId: 'signaldock-frontend',
      displayName: 'SignalDock Frontend',
      level: OrchestrationLevel.TeamLead,
      reportsTo: 'signaldock-core-agent',
      manages: [],
      projectId: 'signaldock',
      teamId: 'signaldock',
      canSpawn: false,
    },
  };

  return {
    agents,
    primeId: 'cleoos-opus-orchestrator',
    projectIds: ['cleocode', 'signaldock'],
  };
}

/** Concrete implementation of OrchestrationHierarchyAPI. */
export class OrchestrationHierarchyImpl implements OrchestrationHierarchyAPI {
  private hierarchy: AgentHierarchy;

  constructor(hierarchy?: AgentHierarchy) {
    this.hierarchy = hierarchy ?? buildDefaultHierarchy();
  }

  /** Get the full hierarchy. */
  getHierarchy(): AgentHierarchy {
    return this.hierarchy;
  }

  /** Get a single agent's hierarchy entry. */
  getAgent(agentId: string): AgentHierarchyEntry | null {
    return this.hierarchy.agents[agentId] ?? null;
  }

  /** Get all agents at a specific level. */
  getAgentsAtLevel(level: OrchestrationLevel): AgentHierarchyEntry[] {
    return Object.values(this.hierarchy.agents).filter((a) => a.level === level);
  }

  /** Get the escalation chain for an agent (nearest authority first). */
  getEscalationChain(agentId: string): EscalationChain {
    const chain: string[] = [];
    let current = this.hierarchy.agents[agentId];

    while (current?.reportsTo) {
      chain.push(current.reportsTo);
      current = this.hierarchy.agents[current.reportsTo];
    }

    return {
      fromAgentId: agentId,
      chain,
      finalAuthority: chain.length > 0 ? chain[chain.length - 1]! : agentId,
    };
  }

  /** Get all agents directly managed by a specific agent. */
  getDirectReports(agentId: string): AgentHierarchyEntry[] {
    const agent = this.hierarchy.agents[agentId];
    if (!agent) return [];

    return agent.manages
      .map((id) => this.hierarchy.agents[id])
      .filter((a): a is AgentHierarchyEntry => a !== undefined);
  }

  /** Check if agent A has authority over agent B (A is in B's escalation chain). */
  hasAuthority(agentIdA: string, agentIdB: string): boolean {
    const chain = this.getEscalationChain(agentIdB);
    return chain.chain.includes(agentIdA);
  }

  /** Get all agents scoped to a project. */
  getProjectAgents(projectId: string): AgentHierarchyEntry[] {
    return Object.values(this.hierarchy.agents).filter((a) => a.projectId === projectId);
  }
}

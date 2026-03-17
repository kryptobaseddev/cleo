/**
 * Dynamic Skill Routing Table
 *
 * Token-efficiency routing table that determines whether each operation
 * is more efficient via MCP (lower overhead) or CLI (more flexible).
 *
 * MCP operations avoid CLI process startup overhead (~200ms + ~50 tokens)
 * and are preferred for rapid, repeated queries. CLI is preferred for
 * operations that benefit from human-readable output or shell integration.
 *
 * @task T5240
 * @epic T5149
 */

/**
 * Routing entry describing the preferred channel for an operation.
 */
export interface RoutingEntry {
  /** Domain name (e.g. 'tasks', 'memory', 'session') */
  domain: string;
  /** Operation name (e.g. 'brain.search', 'show') */
  operation: string;
  /** Preferred channel for token efficiency */
  preferredChannel: 'mcp' | 'cli' | 'either';
  /** Reason for the channel preference */
  reason: string;
}

/**
 * Static routing table for all canonical operations.
 *
 * Operations are grouped by domain with channel preferences based on:
 * - MCP: lower overhead (no CLI startup), direct DB access, structured JSON
 * - CLI: human-readable output, shell integration, interactive prompts
 * - Either: no significant difference or context-dependent
 */
export const ROUTING_TABLE: RoutingEntry[] = [
  // === Memory domain -- MCP strongly preferred (direct DB, no CLI startup) ===
  {
    domain: 'memory',
    operation: 'brain.search',
    preferredChannel: 'mcp',
    reason: 'Low overhead search, direct DB access',
  },
  {
    domain: 'memory',
    operation: 'brain.fetch',
    preferredChannel: 'mcp',
    reason: 'Direct DB access, structured response',
  },
  {
    domain: 'memory',
    operation: 'brain.timeline',
    preferredChannel: 'mcp',
    reason: 'Complex multi-table query, direct DB',
  },
  {
    domain: 'memory',
    operation: 'brain.observe',
    preferredChannel: 'mcp',
    reason: 'Direct DB write, no CLI overhead',
  },
  {
    domain: 'memory',
    operation: 'find',
    preferredChannel: 'mcp',
    reason: 'Alias for brain.search',
  },
  { domain: 'memory', operation: 'show', preferredChannel: 'mcp', reason: 'Alias for brain.fetch' },
  {
    domain: 'memory',
    operation: 'decision.store',
    preferredChannel: 'mcp',
    reason: 'Direct DB write',
  },
  {
    domain: 'memory',
    operation: 'decision.find',
    preferredChannel: 'mcp',
    reason: 'Direct DB query',
  },
  {
    domain: 'memory',
    operation: 'learning.store',
    preferredChannel: 'mcp',
    reason: 'Direct DB write',
  },
  {
    domain: 'memory',
    operation: 'learning.find',
    preferredChannel: 'mcp',
    reason: 'Direct DB query',
  },
  {
    domain: 'memory',
    operation: 'pattern.store',
    preferredChannel: 'mcp',
    reason: 'Direct DB write',
  },
  {
    domain: 'memory',
    operation: 'pattern.find',
    preferredChannel: 'mcp',
    reason: 'Direct DB query',
  },

  // === Tasks domain -- MCP preferred for queries, CLI for complex ops ===
  {
    domain: 'tasks',
    operation: 'show',
    preferredChannel: 'mcp',
    reason: 'Structured JSON response',
  },
  { domain: 'tasks', operation: 'find', preferredChannel: 'mcp', reason: 'Low overhead search' },
  { domain: 'tasks', operation: 'list', preferredChannel: 'mcp', reason: 'Paginated response' },
  {
    domain: 'tasks',
    operation: 'next',
    preferredChannel: 'mcp',
    reason: 'Algorithm runs in-process',
  },
  { domain: 'tasks', operation: 'current', preferredChannel: 'mcp', reason: 'Simple DB lookup' },
  {
    domain: 'tasks',
    operation: 'plan',
    preferredChannel: 'mcp',
    reason: 'Composite view, in-process',
  },
  { domain: 'tasks', operation: 'add', preferredChannel: 'mcp', reason: 'Atomic DB write' },
  { domain: 'tasks', operation: 'update', preferredChannel: 'mcp', reason: 'Atomic DB write' },
  {
    domain: 'tasks',
    operation: 'complete',
    preferredChannel: 'mcp',
    reason: 'Atomic DB write with hooks',
  },
  { domain: 'tasks', operation: 'start', preferredChannel: 'mcp', reason: 'Atomic DB write' },
  { domain: 'tasks', operation: 'stop', preferredChannel: 'mcp', reason: 'Atomic DB write' },

  // === Session domain -- MCP preferred (stateful, in-process) ===
  { domain: 'session', operation: 'status', preferredChannel: 'mcp', reason: 'Quick state lookup' },
  { domain: 'session', operation: 'start', preferredChannel: 'mcp', reason: 'State transition' },
  {
    domain: 'session',
    operation: 'end',
    preferredChannel: 'mcp',
    reason: 'State transition with hooks',
  },
  {
    domain: 'session',
    operation: 'handoff.show',
    preferredChannel: 'mcp',
    reason: 'Structured handoff data',
  },
  {
    domain: 'session',
    operation: 'briefing.show',
    preferredChannel: 'mcp',
    reason: 'Composite cold-start',
  },

  // === Admin domain -- either (human interaction common) ===
  { domain: 'admin', operation: 'version', preferredChannel: 'either', reason: 'Simple lookup' },
  { domain: 'admin', operation: 'health', preferredChannel: 'either', reason: 'Diagnostics' },
  { domain: 'admin', operation: 'dash', preferredChannel: 'mcp', reason: 'Composite view' },
  { domain: 'admin', operation: 'help', preferredChannel: 'mcp', reason: 'Operation discovery' },
  {
    domain: 'admin',
    operation: 'map',
    preferredChannel: 'mcp',
    reason: 'Structured codebase analysis',
  },

  // === Tools domain -- MCP preferred (structured responses) ===
  {
    domain: 'tools',
    operation: 'skill.list',
    preferredChannel: 'mcp',
    reason: 'Structured catalog',
  },
  {
    domain: 'tools',
    operation: 'skill.show',
    preferredChannel: 'mcp',
    reason: 'Structured skill data',
  },
  { domain: 'tools', operation: 'skill.find', preferredChannel: 'mcp', reason: 'Search response' },
  {
    domain: 'tools',
    operation: 'skill.install',
    preferredChannel: 'either',
    reason: 'May need shell access',
  },
  {
    domain: 'tools',
    operation: 'provider.list',
    preferredChannel: 'mcp',
    reason: 'Structured list',
  },
  {
    domain: 'tools',
    operation: 'provider.detect',
    preferredChannel: 'mcp',
    reason: 'Detection result',
  },
  {
    domain: 'tools',
    operation: 'adapter.list',
    preferredChannel: 'mcp',
    reason: 'Structured list',
  },
  {
    domain: 'tools',
    operation: 'adapter.show',
    preferredChannel: 'mcp',
    reason: 'Structured manifest',
  },
  {
    domain: 'tools',
    operation: 'adapter.activate',
    preferredChannel: 'mcp',
    reason: 'State transition',
  },

  // === Check domain -- MCP preferred (validation results) ===
  {
    domain: 'check',
    operation: 'validate',
    preferredChannel: 'mcp',
    reason: 'Structured validation',
  },
  {
    domain: 'check',
    operation: 'compliance',
    preferredChannel: 'mcp',
    reason: 'Compliance report',
  },

  // === Pipeline domain -- MCP preferred (lifecycle gates) ===
  {
    domain: 'pipeline',
    operation: 'lifecycle.status',
    preferredChannel: 'mcp',
    reason: 'Gate status',
  },
  {
    domain: 'pipeline',
    operation: 'release.ship',
    preferredChannel: 'cli',
    reason: 'Complex multi-step with git ops',
  },

  // === Orchestrate domain -- MCP preferred (agent coordination) ===
  { domain: 'orchestrate', operation: 'spawn', preferredChannel: 'mcp', reason: 'Agent spawning' },
  { domain: 'orchestrate', operation: 'plan', preferredChannel: 'mcp', reason: 'Decomposition' },

  // === Nexus domain -- either (cross-project queries) ===
  {
    domain: 'nexus',
    operation: 'search',
    preferredChannel: 'either',
    reason: 'Cross-project search',
  },
  { domain: 'nexus', operation: 'sync', preferredChannel: 'either', reason: 'Cross-project sync' },

  // === Sticky domain -- MCP preferred (quick ephemeral notes) ===
  { domain: 'sticky', operation: 'add', preferredChannel: 'mcp', reason: 'Quick DB write' },
  { domain: 'sticky', operation: 'list', preferredChannel: 'mcp', reason: 'Quick DB read' },
  { domain: 'sticky', operation: 'show', preferredChannel: 'mcp', reason: 'Quick DB read' },
];

/**
 * Look up the preferred channel for a given domain + operation.
 *
 * @param domain - Domain name
 * @param operation - Operation name
 * @returns Preferred channel ('mcp', 'cli', or 'either' as fallback)
 */
export function getPreferredChannel(domain: string, operation: string): 'mcp' | 'cli' | 'either' {
  const entry = ROUTING_TABLE.find((e) => e.domain === domain && e.operation === operation);
  return entry?.preferredChannel ?? 'either';
}

/**
 * Get routing entries for a specific domain.
 *
 * @param domain - Domain name
 * @returns All routing entries for the domain
 */
export function getRoutingForDomain(domain: string): RoutingEntry[] {
  return ROUTING_TABLE.filter((e) => e.domain === domain);
}

/**
 * Get all operations that prefer a specific channel.
 *
 * @param channel - Channel preference to filter by
 * @returns Matching routing entries
 */
export function getOperationsByChannel(channel: 'mcp' | 'cli' | 'either'): RoutingEntry[] {
  return ROUTING_TABLE.filter((e) => e.preferredChannel === channel);
}

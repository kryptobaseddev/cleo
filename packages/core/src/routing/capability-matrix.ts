/**
 * Capability Matrix (Core)
 *
 * Defines which operations can run natively in TypeScript vs requiring
 * the CLEO CLI (bash). Used by dual-mode routing to determine execution path.
 *
 * Each operation is tagged as:
 * - native: Runs in TypeScript, works cross-platform (no bash needed)
 * - cli: Requires CLEO CLI subprocess (Unix-only)
 * - hybrid: Can run either way (prefers CLI when available)
 *
 * preferredChannel encodes token-efficiency routing (from routing-table.ts):
 * - mcp: Lower overhead (no CLI startup), direct DB access, structured JSON
 * - cli: Human-readable output, shell integration, interactive prompts
 * - either: No significant difference or context-dependent
 *
 * Canonical location: src/core/routing/capability-matrix.ts
 * Re-exported from: src/dispatch/lib/capability-matrix.ts (backward compat)
 *
 * @task T5706
 */

/**
 * Execution mode for an operation
 */
export type ExecutionMode = 'native' | 'cli' | 'hybrid';

/**
 * Gateway type
 */
export type GatewayType = 'query' | 'mutate';

/**
 * Preferred communication channel for token efficiency.
 * Added for provider-agnostic skill routing (@task T5240).
 */
export type PreferredChannel = 'mcp' | 'cli' | 'either';

export interface OperationCapability {
  domain: string;
  operation: string;
  gateway: GatewayType;
  mode: ExecutionMode;
  preferredChannel: PreferredChannel;
}

/**
 * Capability report returned by system.doctor
 */
export interface CapabilityReport {
  totalOperations: number;
  native: number;
  cli: number;
  hybrid: number;
  domains: Record<
    string,
    {
      native: string[];
      cli: string[];
      hybrid: string[];
    }
  >;
}

/**
 * The capability matrix - single source of truth for operation routing.
 *
 * Gateway registries (query.ts + mutate.ts) define the canonical MCP API surface.
 * This matrix defines the full routing table including CLI-only paths.
 * All verb aliases have been removed — only canonical operation names remain.
 *
 * native: TypeScript engine handles directly (cross-platform)
 * cli: Requires CLEO CLI (bash, Unix-only)
 * hybrid: Can use either path (prefers CLI when available for richer output)
 *
 * preferredChannel values are sourced from the former routing-table.ts (T5240)
 * and merged here as the single SSoT structure.
 */
const CAPABILITY_MATRIX: OperationCapability[] = [
  // === Tasks Domain ===
  // Query operations
  { domain: 'tasks', operation: 'show', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  { domain: 'tasks', operation: 'list', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  { domain: 'tasks', operation: 'find', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  {
    domain: 'tasks',
    operation: 'tree',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'blockers',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'depends',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'analyze',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  { domain: 'tasks', operation: 'next', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  { domain: 'tasks', operation: 'plan', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  {
    domain: 'tasks',
    operation: 'relates',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'complexity.estimate',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'history',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'current',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tasks',
    operation: 'label.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  { domain: 'tasks', operation: 'add', gateway: 'mutate', mode: 'native', preferredChannel: 'mcp' },
  {
    domain: 'tasks',
    operation: 'update',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tasks',
    operation: 'complete',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tasks',
    operation: 'cancel',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'delete',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'archive',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'restore',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'reparent',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'reorder',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'relates.add',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'start',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tasks',
    operation: 'stop',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  // Sync sub-domain (provider-agnostic task reconciliation)
  {
    domain: 'tasks',
    operation: 'sync.reconcile',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'sync.links',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tasks',
    operation: 'sync.links.remove',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Session Domain ===
  // Query operations
  {
    domain: 'session',
    operation: 'status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'session',
    operation: 'list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'decision.log',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'context.drift',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'handoff.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'session',
    operation: 'briefing.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'session',
    operation: 'find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  {
    domain: 'session',
    operation: 'start',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'session',
    operation: 'end',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'session',
    operation: 'resume',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'suspend',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'gc',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'record.decision',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'session',
    operation: 'record.assumption',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Admin Domain ===
  // Query operations
  {
    domain: 'admin',
    operation: 'version',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'health',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'config.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'stats',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'context',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'runtime',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'job',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  { domain: 'admin', operation: 'dash', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  {
    domain: 'admin',
    operation: 'log',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'sequence',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  { domain: 'admin', operation: 'help', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  {
    domain: 'admin',
    operation: 'token',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'export',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'adr.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'adr.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  { domain: 'admin', operation: 'map', gateway: 'query', mode: 'native', preferredChannel: 'mcp' },
  // Mutate operations
  {
    domain: 'admin',
    operation: 'init',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'config.set',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'backup',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'backup',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'migrate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'cleanup',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'safestop',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'inject.generate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'job.cancel',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'install.global',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'token',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'health',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'detect',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'import',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'context.inject',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'adr.sync',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'admin',
    operation: 'map',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Check Domain ===
  // Query operations
  {
    domain: 'check',
    operation: 'schema',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'protocol',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'task',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'manifest',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'output',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'compliance.summary',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'check',
    operation: 'test',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'coherence',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'gate.status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'archive.stats',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'grade',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'grade.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'chain.validate',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  {
    domain: 'check',
    operation: 'compliance.record',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'check',
    operation: 'test.run',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'gate.set',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'check',
    operation: 'compliance.sync',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Orchestrate Domain ===
  // Query operations
  {
    domain: 'orchestrate',
    operation: 'status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'next',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'ready',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'analyze',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'context',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'waves',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'bootstrap',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'unblock.opportunities',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'tessera.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  {
    domain: 'orchestrate',
    operation: 'start',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'spawn',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'orchestrate',
    operation: 'handoff',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'spawn.execute',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'validate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'parallel',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'orchestrate',
    operation: 'tessera.instantiate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Memory Domain (brain.db cognitive memory -- T5241) ===
  // Query operations
  {
    domain: 'memory',
    operation: 'find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'timeline',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'fetch',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'decision.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'pattern.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'learning.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'graph.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'graph.neighbors',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'reason.why',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'reason.similar',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'search.hybrid',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  {
    domain: 'memory',
    operation: 'observe',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'decision.store',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'pattern.store',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'learning.store',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'memory',
    operation: 'link',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'graph.add',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'memory',
    operation: 'graph.remove',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Pipeline Domain ===
  // Stage sub-domain (RCASD lifecycle)
  {
    domain: 'pipeline',
    operation: 'stage.validate',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'pipeline',
    operation: 'stage.status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'pipeline',
    operation: 'stage.history',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'stage.record',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'stage.skip',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'stage.reset',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'stage.gate.pass',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'stage.gate.fail',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Manifest sub-domain (T5241)
  {
    domain: 'pipeline',
    operation: 'manifest.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'manifest.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'manifest.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'manifest.stats',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'manifest.append',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'manifest.archive',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Phase sub-domain (T5326)
  {
    domain: 'pipeline',
    operation: 'phase.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'phase.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'phase.set',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'phase.advance',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'phase.rename',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'phase.delete',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Chain sub-domain (T5405)
  {
    domain: 'pipeline',
    operation: 'chain.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'chain.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'chain.add',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'chain.instantiate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'chain.advance',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Release sub-domain (T5615 consolidated)
  {
    domain: 'pipeline',
    operation: 'release.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'release.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'release.channel.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'release.ship',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'cli',
  },
  {
    domain: 'pipeline',
    operation: 'release.cancel',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'pipeline',
    operation: 'release.rollback',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Tools Domain ===
  // Issue operations
  {
    domain: 'tools',
    operation: 'issue.diagnostics',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Skill operations
  {
    domain: 'tools',
    operation: 'skill.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'skill.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'skill.find',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'skill.dispatch',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.verify',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.dependencies',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.spawn.providers',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.catalog',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.precedence',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.install',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.uninstall',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'skill.refresh',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Provider operations
  {
    domain: 'tools',
    operation: 'provider.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'provider.detect',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'provider.inject.status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'provider.supports',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'provider.hooks',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'provider.inject',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Adapter sub-domain (T5240)
  {
    domain: 'tools',
    operation: 'adapter.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'adapter.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'adapter.detect',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'adapter.health',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'tools',
    operation: 'adapter.activate',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'tools',
    operation: 'adapter.dispose',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Nexus Domain ===
  // Query operations
  {
    domain: 'nexus',
    operation: 'status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'search',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'graph',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'deps',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'resolve',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'discover',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'orphans.list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'blockers.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'path.show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'share.status',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'transfer.preview',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'either',
  },
  // Mutate operations
  {
    domain: 'nexus',
    operation: 'init',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'register',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'unregister',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'sync',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'reconcile',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'permission.set',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'share.snapshot.export',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'share.snapshot.import',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'nexus',
    operation: 'transfer',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },

  // === Sticky Domain ===
  // Query operations
  {
    domain: 'sticky',
    operation: 'list',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'sticky',
    operation: 'show',
    gateway: 'query',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  // Mutate operations
  {
    domain: 'sticky',
    operation: 'add',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'mcp',
  },
  {
    domain: 'sticky',
    operation: 'archive',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'sticky',
    operation: 'convert',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
  {
    domain: 'sticky',
    operation: 'purge',
    gateway: 'mutate',
    mode: 'native',
    preferredChannel: 'either',
  },
];

/**
 * Lookup the execution mode for a specific operation
 */
export function getOperationMode(
  domain: string,
  operation: string,
  gateway: GatewayType,
): ExecutionMode | undefined {
  const entry = CAPABILITY_MATRIX.find(
    (cap) => cap.domain === domain && cap.operation === operation && cap.gateway === gateway,
  );
  return entry?.mode;
}

/**
 * Check if an operation can run natively (without CLI)
 */
export function canRunNatively(domain: string, operation: string, gateway: GatewayType): boolean {
  const mode = getOperationMode(domain, operation, gateway);
  return mode === 'native' || mode === 'hybrid';
}

/**
 * Check if an operation requires CLI
 */
export function requiresCLI(domain: string, operation: string, gateway: GatewayType): boolean {
  const mode = getOperationMode(domain, operation, gateway);
  return mode === 'cli';
}

/**
 * Get all native-capable operations for a domain
 */
export function getNativeOperations(domain: string): OperationCapability[] {
  return CAPABILITY_MATRIX.filter(
    (cap) => cap.domain === domain && (cap.mode === 'native' || cap.mode === 'hybrid'),
  );
}

/**
 * Generate a capability report for system.doctor
 */
export function generateCapabilityReport(): CapabilityReport {
  const domains: CapabilityReport['domains'] = {};

  for (const cap of CAPABILITY_MATRIX) {
    if (!domains[cap.domain]) {
      domains[cap.domain] = { native: [], cli: [], hybrid: [] };
    }
    const key = `${cap.gateway}:${cap.operation}`;
    domains[cap.domain][cap.mode].push(key);
  }

  return {
    totalOperations: CAPABILITY_MATRIX.length,
    native: CAPABILITY_MATRIX.filter((c) => c.mode === 'native').length,
    cli: CAPABILITY_MATRIX.filter((c) => c.mode === 'cli').length,
    hybrid: CAPABILITY_MATRIX.filter((c) => c.mode === 'hybrid').length,
    domains,
  };
}

/**
 * Get the full capability matrix (for testing/introspection)
 */
export function getCapabilityMatrix(): ReadonlyArray<OperationCapability> {
  return CAPABILITY_MATRIX;
}

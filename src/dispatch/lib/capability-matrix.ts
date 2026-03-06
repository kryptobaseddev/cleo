/**
 * Capability Matrix
 *
 * Defines which operations can run natively in TypeScript vs requiring
 * the CLEO CLI (bash). Used by dual-mode routing to determine execution path.
 *
 * Each operation is tagged as:
 * - native: Runs in TypeScript, works cross-platform (no bash needed)
 * - cli: Requires CLEO CLI subprocess (Unix-only)
 * - hybrid: Can run either way (prefers CLI when available)
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
 * Single operation capability entry
 */
export interface OperationCapability {
  domain: string;
  operation: string;
  gateway: GatewayType;
  mode: ExecutionMode;
}

/**
 * Capability report returned by system.doctor
 */
export interface CapabilityReport {
  totalOperations: number;
  native: number;
  cli: number;
  hybrid: number;
  domains: Record<string, {
    native: string[];
    cli: string[];
    hybrid: string[];
  }>;
}

/**
 * The capability matrix - source of truth for operation routing.
 *
 * Gateway registries (query.ts + mutate.ts) define the canonical MCP API surface.
 * This matrix defines the full routing table including CLI-only paths.
 * All verb aliases have been removed — only canonical operation names remain.
 *
 * native: TypeScript engine handles directly (cross-platform)
 * cli: Requires CLEO CLI (bash, Unix-only)
 * hybrid: Can use either path (prefers CLI when available for richer output)
 */
const CAPABILITY_MATRIX: OperationCapability[] = [
  // === Tasks Domain ===
  // Native query operations (core CRUD reads)
  { domain: 'tasks', operation: 'show', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'list', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'find', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'exists', gateway: 'query', mode: 'native' },
  // Native query operations (analysis)
  { domain: 'tasks', operation: 'next', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'depends', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'stats', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'export', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'history', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'lint', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'batch.validate', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'manifest', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'tree', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'blockers', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'analyze', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'relates', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'complexity.estimate', gateway: 'query', mode: 'native' },
  // Native mutate operations (core CRUD writes)
  { domain: 'tasks', operation: 'add', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'update', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'complete', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'delete', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'archive', gateway: 'mutate', mode: 'native' },
  // Native mutate operations (hierarchy, status, relations)
  { domain: 'tasks', operation: 'restore', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'import', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'reorder', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'reparent', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'promote', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'relates.add', gateway: 'mutate', mode: 'native' },
  // Native query operations (active task)
  { domain: 'tasks', operation: 'current', gateway: 'query', mode: 'native' },
  // Native mutate operations (active task)
  { domain: 'tasks', operation: 'start', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'stop', gateway: 'mutate', mode: 'native' },

  // === Session Domain ===
  // Native query operations
  { domain: 'session', operation: 'status', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'list', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'show', gateway: 'query', mode: 'native' },
  // Native query operations
  { domain: 'session', operation: 'history', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'stats', gateway: 'query', mode: 'native' },
  // Native mutate operations
  { domain: 'session', operation: 'start', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'end', gateway: 'mutate', mode: 'native' },
  // Native/CLI mutate operations
  { domain: 'session', operation: 'resume', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'switch', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'archive', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'cleanup', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'suspend', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'gc', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'record.decision', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'decision.log', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'context.drift', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'record.assumption', gateway: 'mutate', mode: 'native' },

  // === Admin Domain ===
  { domain: 'admin', operation: 'version', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'config.show', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'context', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'metrics', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'health', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'diagnostics', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'stats', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'help', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'dash', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'roadmap', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'labels', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'compliance', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'log', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'archive.stats', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'sequence', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'job.status', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'job.list', gateway: 'query', mode: 'native' },
  { domain: 'admin', operation: 'init', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'config.set', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'backup', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'restore', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'migrate', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'cleanup', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'audit', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'sync', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'job.cancel', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'safestop', gateway: 'mutate', mode: 'native' },
  { domain: 'admin', operation: 'inject.generate', gateway: 'mutate', mode: 'native' },

  // === Check Domain ===
  { domain: 'check', operation: 'schema', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'protocol', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'task', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'manifest', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'output', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'compliance.summary', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'compliance.violations', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'compliance.record', gateway: 'mutate', mode: 'native' },
  { domain: 'check', operation: 'test.run', gateway: 'mutate', mode: 'native' },
  { domain: 'check', operation: 'test.status', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'test.coverage', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'coherence.check', gateway: 'query', mode: 'native' },
  { domain: 'check', operation: 'batch.validate', gateway: 'mutate', mode: 'native' },

  // === Orchestrate Domain ===
  { domain: 'orchestrate', operation: 'status', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'next', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'ready', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'analyze', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'context', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'waves', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'skill.list', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'bootstrap', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'start', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'spawn', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'validate', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'parallel.start', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'parallel.end', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'check', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'skill.inject', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'unblock.opportunities', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'critical.path', gateway: 'query', mode: 'native' },

  // === Memory Domain ===
  // Memory query operations (brain.db cognitive memory — T5241)
  { domain: 'memory', operation: 'show', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'find', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'timeline', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'fetch', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'stats', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'contradictions', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'superseded', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'decision.find', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'pattern.find', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'pattern.stats', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'learning.find', gateway: 'query', mode: 'native' },
  { domain: 'memory', operation: 'learning.stats', gateway: 'query', mode: 'native' },
  // Memory mutate operations (brain.db cognitive memory — T5241)
  { domain: 'memory', operation: 'observe', gateway: 'mutate', mode: 'native' },
  { domain: 'memory', operation: 'decision.store', gateway: 'mutate', mode: 'native' },
  { domain: 'memory', operation: 'pattern.store', gateway: 'mutate', mode: 'native' },
  { domain: 'memory', operation: 'learning.store', gateway: 'mutate', mode: 'native' },
  { domain: 'memory', operation: 'link', gateway: 'mutate', mode: 'native' },

  // === Pipeline Manifest Operations (T5241 — moved from research/memory) ===
  { domain: 'pipeline', operation: 'manifest.show', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.list', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.find', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.pending', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.stats', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.append', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'manifest.archive', gateway: 'mutate', mode: 'native' },

  // === Session Context Injection (T5241 — moved from research/memory) ===
  { domain: 'session', operation: 'context.inject', gateway: 'mutate', mode: 'native' },

  // === Pipeline Domain (lifecycle operations) ===
  { domain: 'pipeline', operation: 'lifecycle.validate', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.status', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.history', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.gates', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.prerequisites', gateway: 'query', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.record', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.skip', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.reset', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.gate.pass', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'lifecycle.gate.fail', gateway: 'mutate', mode: 'native' },

  // === Tools Domain (issues operations) ===
  // Native query operations (template parsing)
  { domain: 'tools', operation: 'issues.templates',       gateway: 'query',  mode: 'native' },
  { domain: 'tools', operation: 'issues.validate.labels',  gateway: 'query',  mode: 'native' },
  // Native mutate operations (config generation)
  { domain: 'tools', operation: 'issues.generate.config',  gateway: 'mutate', mode: 'native' },

  // === Pipeline Domain (release operations) ===
  { domain: 'pipeline', operation: 'release.prepare', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.changelog', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.commit', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.tag', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.push', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.gates.run', gateway: 'mutate', mode: 'native' },
  { domain: 'pipeline', operation: 'release.rollback', gateway: 'mutate', mode: 'native' },
];

/**
 * Lookup the execution mode for a specific operation
 */
export function getOperationMode(
  domain: string,
  operation: string,
  gateway: GatewayType
): ExecutionMode | undefined {
  const entry = CAPABILITY_MATRIX.find(
    (cap) =>
      cap.domain === domain &&
      cap.operation === operation &&
      cap.gateway === gateway
  );
  return entry?.mode;
}

/**
 * Check if an operation can run natively (without CLI)
 */
export function canRunNatively(
  domain: string,
  operation: string,
  gateway: GatewayType
): boolean {
  const mode = getOperationMode(domain, operation, gateway);
  return mode === 'native' || mode === 'hybrid';
}

/**
 * Check if an operation requires CLI
 */
export function requiresCLI(
  domain: string,
  operation: string,
  gateway: GatewayType
): boolean {
  const mode = getOperationMode(domain, operation, gateway);
  return mode === 'cli';
}

/**
 * Get all native-capable operations for a domain
 */
export function getNativeOperations(domain: string): OperationCapability[] {
  return CAPABILITY_MATRIX.filter(
    (cap) => cap.domain === domain && (cap.mode === 'native' || cap.mode === 'hybrid')
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

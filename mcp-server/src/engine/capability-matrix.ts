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
 * This matrix is a SUPERSET of gateway operations (138 entries vs 123 gateway routes).
 * The 15-entry gap consists of:
 * - CLI-specific aliases (show/get, add/create, focus-set/focus.set, etc.)
 * - CLI-only operations not exposed via MCP gateways (stats, export, import, etc.)
 * - Legacy operations preserved for backward compatibility
 *
 * Gateway registries (query.ts + mutate.ts) define the canonical MCP API surface (123 ops).
 * This matrix defines the full routing table including CLI-only paths.
 *
 * native: TypeScript engine handles directly (cross-platform)
 * cli: Requires CLEO CLI (bash, Unix-only)
 * hybrid: Can use either path (prefers CLI when available for richer output)
 */
const CAPABILITY_MATRIX: OperationCapability[] = [
  // === Tasks Domain ===
  // Native query operations (core CRUD reads)
  { domain: 'tasks', operation: 'show', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'get', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'list', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'find', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'exists', gateway: 'query', mode: 'native' },
  // CLI-only query operations (complex analysis)
  { domain: 'tasks', operation: 'next', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'depends', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'deps', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'stats', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'export', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'history', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'lint', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'batch-validate', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'manifest', gateway: 'query', mode: 'native' },
  { domain: 'tasks', operation: 'tree', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'blockers', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'analyze', gateway: 'query', mode: 'cli' },
  { domain: 'tasks', operation: 'relates', gateway: 'query', mode: 'cli' },
  // Native mutate operations (core CRUD writes)
  { domain: 'tasks', operation: 'add', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'create', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'update', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'complete', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'delete', gateway: 'mutate', mode: 'native' },
  { domain: 'tasks', operation: 'archive', gateway: 'mutate', mode: 'native' },
  // CLI-only mutate operations
  { domain: 'tasks', operation: 'restore', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'unarchive', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'import', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'reorder', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'reparent', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'promote', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'reopen', gateway: 'mutate', mode: 'cli' },
  { domain: 'tasks', operation: 'relates.add', gateway: 'mutate', mode: 'cli' },

  // === Session Domain ===
  // Native query operations
  { domain: 'session', operation: 'status', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'list', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'show', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'focus-show', gateway: 'query', mode: 'native' },
  { domain: 'session', operation: 'focus.get', gateway: 'query', mode: 'native' },
  // CLI-only query operations
  { domain: 'session', operation: 'history', gateway: 'query', mode: 'cli' },
  { domain: 'session', operation: 'stats', gateway: 'query', mode: 'cli' },
  // Native mutate operations
  { domain: 'session', operation: 'start', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'end', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'focus-set', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'focus.set', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'focus-clear', gateway: 'mutate', mode: 'native' },
  { domain: 'session', operation: 'focus.clear', gateway: 'mutate', mode: 'native' },
  // CLI-only mutate operations
  { domain: 'session', operation: 'resume', gateway: 'mutate', mode: 'cli' },
  { domain: 'session', operation: 'switch', gateway: 'mutate', mode: 'cli' },
  { domain: 'session', operation: 'archive', gateway: 'mutate', mode: 'cli' },
  { domain: 'session', operation: 'cleanup', gateway: 'mutate', mode: 'cli' },
  { domain: 'session', operation: 'suspend', gateway: 'mutate', mode: 'cli' },
  { domain: 'session', operation: 'gc', gateway: 'mutate', mode: 'cli' },

  // === System Domain ===
  { domain: 'system', operation: 'version', gateway: 'query', mode: 'native' },
  { domain: 'system', operation: 'doctor', gateway: 'query', mode: 'hybrid' },
  { domain: 'system', operation: 'config', gateway: 'query', mode: 'native' },
  { domain: 'system', operation: 'config.get', gateway: 'query', mode: 'native' },
  { domain: 'system', operation: 'context', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'metrics', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'health', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'diagnostics', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'stats', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'help', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'dash', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'roadmap', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'labels', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'compliance', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'log', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'archive-stats', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'sequence', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'job.status', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'job.list', gateway: 'query', mode: 'cli' },
  { domain: 'system', operation: 'init', gateway: 'mutate', mode: 'native' },
  { domain: 'system', operation: 'config.set', gateway: 'mutate', mode: 'native' },
  { domain: 'system', operation: 'backup', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'restore', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'migrate', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'cleanup', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'audit', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'sync', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'job.cancel', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'safestop', gateway: 'mutate', mode: 'cli' },
  { domain: 'system', operation: 'uncancel', gateway: 'mutate', mode: 'cli' },

  // === Validate Domain ===
  { domain: 'validate', operation: 'schema', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'protocol', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'task', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'manifest', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'output', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'compliance.summary', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'compliance.violations', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'compliance.record', gateway: 'mutate', mode: 'native' },
  { domain: 'validate', operation: 'test.run', gateway: 'mutate', mode: 'cli' },
  { domain: 'validate', operation: 'test.status', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'test.coverage', gateway: 'query', mode: 'native' },
  { domain: 'validate', operation: 'batch-validate', gateway: 'mutate', mode: 'cli' },

  // === Orchestrate Domain ===
  { domain: 'orchestrate', operation: 'status', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'next', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'ready', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'analyze', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'context', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'waves', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'skill.list', gateway: 'query', mode: 'native' },
  { domain: 'orchestrate', operation: 'startup', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'spawn', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'validate', gateway: 'mutate', mode: 'native' },
  { domain: 'orchestrate', operation: 'parallel.start', gateway: 'mutate', mode: 'cli' },
  { domain: 'orchestrate', operation: 'parallel.end', gateway: 'mutate', mode: 'cli' },
  { domain: 'orchestrate', operation: 'check', gateway: 'mutate', mode: 'cli' },
  { domain: 'orchestrate', operation: 'skill.inject', gateway: 'mutate', mode: 'cli' },

  // === Research Domain ===
  { domain: 'research', operation: 'show', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'list', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'query', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'pending', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'stats', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'manifest.read', gateway: 'query', mode: 'native' },
  { domain: 'research', operation: 'inject', gateway: 'mutate', mode: 'cli' },
  { domain: 'research', operation: 'link', gateway: 'mutate', mode: 'native' },
  { domain: 'research', operation: 'manifest.append', gateway: 'mutate', mode: 'native' },
  { domain: 'research', operation: 'manifest.archive', gateway: 'mutate', mode: 'native' },
  { domain: 'research', operation: 'compact', gateway: 'mutate', mode: 'cli' },
  { domain: 'research', operation: 'validate', gateway: 'mutate', mode: 'cli' },

  // === Lifecycle Domain ===
  { domain: 'lifecycle', operation: 'check', gateway: 'query', mode: 'native' },
  { domain: 'lifecycle', operation: 'status', gateway: 'query', mode: 'native' },
  { domain: 'lifecycle', operation: 'history', gateway: 'query', mode: 'native' },
  { domain: 'lifecycle', operation: 'gates', gateway: 'query', mode: 'native' },
  { domain: 'lifecycle', operation: 'prerequisites', gateway: 'query', mode: 'native' },
  { domain: 'lifecycle', operation: 'progress', gateway: 'mutate', mode: 'native' },
  { domain: 'lifecycle', operation: 'skip', gateway: 'mutate', mode: 'native' },
  { domain: 'lifecycle', operation: 'reset', gateway: 'mutate', mode: 'native' },
  { domain: 'lifecycle', operation: 'gate.pass', gateway: 'mutate', mode: 'native' },
  { domain: 'lifecycle', operation: 'gate.fail', gateway: 'mutate', mode: 'native' },

  // === Issues Domain ===
  // Native query operations (template parsing)
  { domain: 'issues', operation: 'templates',       gateway: 'query',  mode: 'native' },
  { domain: 'issues', operation: 'validate_labels',  gateway: 'query',  mode: 'native' },
  // Native mutate operations (config generation)
  { domain: 'issues', operation: 'generate_config',  gateway: 'mutate', mode: 'native' },

  // === Release Domain ===
  { domain: 'release', operation: 'prepare', gateway: 'mutate', mode: 'native' },
  { domain: 'release', operation: 'changelog', gateway: 'mutate', mode: 'native' },
  { domain: 'release', operation: 'commit', gateway: 'mutate', mode: 'native' },
  { domain: 'release', operation: 'tag', gateway: 'mutate', mode: 'native' },
  { domain: 'release', operation: 'push', gateway: 'mutate', mode: 'cli' },
  { domain: 'release', operation: 'gates.run', gateway: 'mutate', mode: 'native' },
  { domain: 'release', operation: 'rollback', gateway: 'mutate', mode: 'native' },
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

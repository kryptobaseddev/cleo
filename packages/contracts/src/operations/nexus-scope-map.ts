/**
 * NEXUS_SCOPE_MAP — Single Source of Truth for Nexus operation metadata.
 *
 * Maps every key of {@link NexusOps} to a {@link NexusOperationDescriptor},
 * enabling compile-time exhaustiveness checking (via `_ExhaustivenessCheck`)
 * and runtime helpers (`getNexusDescriptor`, `listOpsByScope`).
 *
 * To add a new Nexus operation:
 * 1. Add the key to `NexusOps` in `nexus.ts`.
 * 2. Add the corresponding entry here — the build will fail until both are present.
 *
 * @task T9145
 * @module operations/nexus-scope-map
 */

import type { NexusOps } from './nexus.js';
import type { NexusOperationDescriptor } from './nexus-scope.js';

// ---------------------------------------------------------------------------
// SSoT map
// ---------------------------------------------------------------------------

/**
 * Single Source of Truth mapping every NexusOps key to its descriptor.
 *
 * `satisfies Record<keyof NexusOps, NexusOperationDescriptor>` enforces
 * exhaustiveness at compile time — adding a new key to NexusOps without a
 * corresponding entry here is a type error.
 */
export const NEXUS_SCOPE_MAP = {
  // ── Query / read ops ──────────────────────────────────────────────────────

  status: {
    op: 'status',
    description: 'Check whether nexus.db is open and accessible.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  list: {
    op: 'list',
    description: 'List all registered Nexus projects.',
    scope: 'global',
    effect: 'read',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  show: {
    op: 'show',
    description: 'Show details for a registered project.',
    scope: 'global',
    effect: 'read',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  resolve: {
    op: 'resolve',
    description: 'Resolve a symbol name to its graph node(s).',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  deps: {
    op: 'deps',
    description: 'List dependencies of a symbol (callers or callees).',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  graph: {
    op: 'graph',
    description: 'Return the raw graph (nodes + relations) for a project.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'path.show': {
    op: 'path.show',
    description: 'Show the shortest graph path between two symbols.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'blockers.show': {
    op: 'blockers.show',
    description: 'Show symbols that block a given symbol from being resolved.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'orphans.list': {
    op: 'orphans.list',
    description: 'List graph nodes with no incoming or outgoing edges.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  discover: {
    op: 'discover',
    description: 'Discover the codebase structure (file tree + symbol counts).',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  search: {
    op: 'search',
    description: 'Full-text / semantic search over symbol names and docstrings.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  augment: {
    op: 'augment',
    description: 'Augment the graph with enriched metadata (embeddings, docs).',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'share.status': {
    op: 'share.status',
    description: 'Check snapshot sharing status for a project.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'transfer.preview': {
    op: 'transfer.preview',
    description: 'Preview a graph transfer (dry-run diff).',
    scope: 'cross',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'top-entries': {
    op: 'top-entries',
    description: 'Return the top-N highest-centrality nodes.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  impact: {
    op: 'impact',
    description: 'Compute the blast radius (upstream/downstream) of a change.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'full-context': {
    op: 'full-context',
    description: 'Return the full 360-degree context for a symbol.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'task-footprint': {
    op: 'task-footprint',
    description: 'Return graph nodes touched by a given task ID.',
    scope: 'hybrid',
    effect: 'read',
    stores: ['nexus-graph', 'tasks'],
    requiresProject: true,
  },
  'brain-anchors': {
    op: 'brain-anchors',
    description: 'Return BRAIN memory entries anchored to graph nodes.',
    scope: 'hybrid',
    effect: 'read',
    stores: ['nexus-graph', 'brain'],
    requiresProject: true,
  },
  why: {
    op: 'why',
    description: 'Explain why a symbol exists (provenance + context).',
    scope: 'hybrid',
    effect: 'read',
    stores: ['nexus-graph', 'brain'],
    requiresProject: true,
  },
  'impact-full': {
    op: 'impact-full',
    description: 'Full multi-hop impact analysis with community context.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'route-map': {
    op: 'route-map',
    description: 'Generate a route map for execution flow tracing.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'shape-check': {
    op: 'shape-check',
    description: 'Validate that a symbol conforms to a declared contract shape.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'search-code': {
    op: 'search-code',
    description: 'Search code by pattern across the project graph.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  wiki: {
    op: 'wiki',
    description: 'Generate a wiki-style description for a symbol or module.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'contracts-show': {
    op: 'contracts-show',
    description: 'Show the contract compliance record for a symbol.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'task-symbols': {
    op: 'task-symbols',
    description: 'List graph symbols associated with a task.',
    scope: 'hybrid',
    effect: 'read',
    stores: ['nexus-graph', 'tasks'],
    requiresProject: true,
  },

  // ── Profile ops ───────────────────────────────────────────────────────────

  'profile.view': {
    op: 'profile.view',
    description: 'View all user profile traits from the living-brain.',
    scope: 'living-brain',
    effect: 'read',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.get': {
    op: 'profile.get',
    description: 'Get a single user profile trait.',
    scope: 'living-brain',
    effect: 'read',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.import': {
    op: 'profile.import',
    description: 'Import user profile traits from a JSON file.',
    scope: 'living-brain',
    effect: 'write',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.export': {
    op: 'profile.export',
    description: 'Export user profile traits to JSON.',
    scope: 'living-brain',
    effect: 'read',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.reinforce': {
    op: 'profile.reinforce',
    description: 'Reinforce a user profile trait (increase confidence).',
    scope: 'living-brain',
    effect: 'write',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.upsert': {
    op: 'profile.upsert',
    description: 'Upsert a user profile trait.',
    scope: 'living-brain',
    effect: 'write',
    stores: ['brain'],
    requiresProject: false,
  },
  'profile.supersede': {
    op: 'profile.supersede',
    description: 'Mark a user profile trait as superseded by another.',
    scope: 'living-brain',
    effect: 'write',
    stores: ['brain'],
    requiresProject: false,
  },

  // ── Sigil ops ─────────────────────────────────────────────────────────────

  'sigil.list': {
    op: 'sigil.list',
    description: 'List code sigils (bookmarks / anchors) in a project.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'sigil.sync': {
    op: 'sigil.sync',
    description: 'Sync sigils with the current graph state.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },

  // ── Registry / admin ops ──────────────────────────────────────────────────

  init: {
    op: 'init',
    description: 'Initialize a new Nexus project database.',
    scope: 'project',
    effect: 'admin',
    stores: ['nexus-graph', 'nexus-registry'],
    requiresProject: true,
  },
  register: {
    op: 'register',
    description: 'Register a project with the global Nexus registry.',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  unregister: {
    op: 'unregister',
    description: 'Remove a project from the global Nexus registry.',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  sync: {
    op: 'sync',
    description: 'Re-analyze and sync the project graph with the codebase.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  'permission.set': {
    op: 'permission.set',
    description: 'Set access permissions for a Nexus project.',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  reconcile: {
    op: 'reconcile',
    description: 'Reconcile graph state with on-disk source files.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  'share.snapshot.export': {
    op: 'share.snapshot.export',
    description: 'Export a shareable snapshot of the project graph.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  'share.snapshot.import': {
    op: 'share.snapshot.import',
    description: 'Import a shared project graph snapshot.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  transfer: {
    op: 'transfer',
    description: 'Transfer graph data between projects.',
    scope: 'cross',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'contracts-sync': {
    op: 'contracts-sync',
    description: 'Sync contract compliance records with the graph.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'contracts-link-tasks': {
    op: 'contracts-link-tasks',
    description: 'Link contract compliance records to task IDs.',
    scope: 'hybrid',
    effect: 'write',
    stores: ['nexus-graph', 'tasks'],
    requiresProject: true,
  },
  'conduit-scan': {
    op: 'conduit-scan',
    description: 'Scan Conduit messaging patterns into the graph.',
    scope: 'project',
    effect: 'write',
    stores: ['nexus-graph'],
    requiresProject: true,
  },

  // ── Analytics ops ─────────────────────────────────────────────────────────

  clusters: {
    op: 'clusters',
    description: 'Return detected community clusters in the graph.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  flows: {
    op: 'flows',
    description: 'Return detected execution flows (process traces).',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  context: {
    op: 'context',
    description: 'Return project context summary (node/relation counts, freshness).',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'projects.list': {
    op: 'projects.list',
    description: 'List all registered projects (alias: list).',
    scope: 'global',
    effect: 'read',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  'projects.register': {
    op: 'projects.register',
    description: 'Register a project (alias: register).',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  'projects.remove': {
    op: 'projects.remove',
    description: 'Remove a project (alias: unregister).',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  'projects.scan': {
    op: 'projects.scan',
    description: 'Scan a project directory and update the registry.',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry', 'fs'],
    requiresProject: false,
  },
  'projects.clean': {
    op: 'projects.clean',
    description: 'Remove stale project entries from the registry.',
    scope: 'global',
    effect: 'admin',
    stores: ['nexus-registry'],
    requiresProject: false,
  },
  'refresh-bridge': {
    op: 'refresh-bridge',
    description: 'Refresh the Nexus → BRAIN cross-store bridge.',
    scope: 'hybrid',
    effect: 'write',
    stores: ['nexus-graph', 'brain'],
    requiresProject: true,
  },
  diff: {
    op: 'diff',
    description: 'Diff the graph between two commits or snapshots.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph', 'fs'],
    requiresProject: true,
  },
  'query-cte': {
    op: 'query-cte',
    description: 'Execute a raw CTE query against the Nexus graph DB.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'hot-paths': {
    op: 'hot-paths',
    description: 'Return the most frequently traversed call paths.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'hot-nodes': {
    op: 'hot-nodes',
    description: 'Return the highest-degree (most connected) nodes.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
  'cold-symbols': {
    op: 'cold-symbols',
    description: 'Return low-usage symbols that may be candidates for removal.',
    scope: 'project',
    effect: 'read',
    stores: ['nexus-graph'],
    requiresProject: true,
  },
} as const satisfies Record<keyof NexusOps, NexusOperationDescriptor>;

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check
// ---------------------------------------------------------------------------

/**
 * Fails the build if any key in {@link NexusOps} is missing from
 * {@link NEXUS_SCOPE_MAP}.
 *
 * TypeScript will produce an error like:
 * `Type 'keyof NexusOps' is not assignable to 'keyof typeof NEXUS_SCOPE_MAP'`
 * when a new NexusOps key is added without a corresponding map entry.
 *
 * @internal
 */
type _ExhaustivenessCheck = keyof typeof NEXUS_SCOPE_MAP extends keyof NexusOps
  ? keyof NexusOps extends keyof typeof NEXUS_SCOPE_MAP
    ? true
    : never
  : never;

// This assignment triggers the exhaustiveness check at compile time.
const _check: _ExhaustivenessCheck = true;
void _check;

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/**
 * Return the {@link NexusOperationDescriptor} for a given Nexus operation key.
 *
 * @param op - Any key of {@link NexusOps}
 * @returns The corresponding descriptor
 */
export function getNexusDescriptor(op: keyof NexusOps): NexusOperationDescriptor {
  return NEXUS_SCOPE_MAP[op];
}

/**
 * Return all Nexus operation keys that match a given {@link NexusScope}.
 *
 * @param scope - The scope to filter by
 * @returns Array of matching operation keys
 */
export function listOpsByScope(
  scope: import('./nexus-scope.js').NexusScope,
): Array<keyof NexusOps> {
  return (Object.keys(NEXUS_SCOPE_MAP) as Array<keyof NexusOps>).filter(
    (k) => NEXUS_SCOPE_MAP[k].scope === scope,
  );
}

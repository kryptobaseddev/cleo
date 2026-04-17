/**
 * CLI nexus command group - Cross-project NEXUS operations.
 *
 * Thin CLI wrappers routing through the dispatch layer.
 * All business logic lives in src/dispatch/domains/nexus.ts.
 *
 * `nexus analyze` is implemented directly here because it requires
 * `@cleocode/nexus` pipeline access and `@cleocode/core` DB access together,
 * and routing through the dispatch layer would create awkward coupling.
 *
 * @task T4554, T5323, T5330, T481, T534
 * @epic T4545
 */

import path from 'node:path';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Priority score for nexus node kinds when ranking symbol search results.
 *
 * Callable symbols (function, method) rank highest so that `nexus context`
 * and `nexus impact` return meaningful callers/callees instead of
 * file/folder structural nodes which have zero `calls` relations.
 *
 * Lower score = higher priority (sort ascending).
 */
const NODE_KIND_PRIORITY: Record<string, number> = {
  function: 0,
  method: 1,
  constructor: 2,
  class: 3,
  interface: 4,
  type_alias: 5,
  enum: 6,
  constant: 7,
  property: 8,
  variable: 9,
  static: 10,
  struct: 11,
  trait: 12,
  impl: 13,
  macro: 14,
  // Structural/module nodes come last — they have no `calls` relations
  module: 20,
  namespace: 21,
  record: 22,
  delegate: 23,
  union: 24,
  typedef: 25,
  annotation: 26,
  template: 27,
  route: 28,
  tool: 29,
  section: 30,
  import: 31,
  export: 32,
  type: 33,
  file: 40,
  folder: 41,
};

/**
 * Generate GEXF (Gephi Graph Exchange XML Format) from nodes and relations.
 *
 * GEXF is a standard format for graph visualization. Supports node attributes,
 * edge weights (confidence), and color coding by node kind.
 *
 * @param nodes - Array of nexus nodes
 * @param relations - Array of nexus relations
 * @returns GEXF XML string
 */
function generateGexf(
  nodes: Array<Record<string, unknown>>,
  relations: Array<Record<string, unknown>>,
): string {
  // Build node by ID map for edge resolution
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    nodeById.set(String(n['id']), n);
  }

  // Color map for node kinds (hex colors for visualization)
  const kindColors: Record<string, string> = {
    function: '#3498db', // blue
    method: '#2980b9', // darker blue
    class: '#e74c3c', // red
    interface: '#e67e22', // orange
    file: '#95a5a6', // gray
    folder: '#34495e', // dark gray
    community: '#9b59b6', // purple
    process: '#1abc9c', // teal
    import: '#f39c12', // amber
    default: '#7f8c8d', // medium gray
  };

  const getNodeColor = (kind: string): string => {
    return kindColors[kind] ?? kindColors['default'];
  };

  // GEXF XML header
  let gexf = '<?xml version="1.0" encoding="UTF-8"?>\n';
  gexf +=
    '<gexf xmlns="http://www.gexf.net/1.2draft" xmlns:viz="http://www.gexf.net/1.2draft/viz" version="1.2">\n';
  gexf += '  <meta lastmodifieddate="' + new Date().toISOString().split('T')[0] + '">\n';
  gexf += '    <creator>CLEO nexus export</creator>\n';
  gexf += '    <description>Code intelligence graph from CLEO nexus</description>\n';
  gexf += '  </meta>\n';
  gexf += '  <graph mode="static" defaultedgetype="directed">\n';

  // Attributes
  gexf += '    <attributes class="node">\n';
  gexf += '      <attribute id="kind" title="Node Kind" type="string" />\n';
  gexf += '      <attribute id="filePath" title="File Path" type="string" />\n';
  gexf += '      <attribute id="language" title="Language" type="string" />\n';
  gexf += '      <attribute id="startLine" title="Start Line" type="integer" />\n';
  gexf += '      <attribute id="endLine" title="End Line" type="integer" />\n';
  gexf += '      <attribute id="isExported" title="Is Exported" type="boolean" />\n';
  gexf += '      <attribute id="projectId" title="Project ID" type="string" />\n';
  gexf += '    </attributes>\n';
  gexf += '    <attributes class="edge">\n';
  gexf += '      <attribute id="relationType" title="Relation Type" type="string" />\n';
  gexf += '      <attribute id="confidence" title="Confidence" type="double" />\n';
  gexf += '      <attribute id="reason" title="Reason" type="string" />\n';
  gexf += '    </attributes>\n';

  // Nodes
  gexf += '    <nodes>\n';
  for (const node of nodes) {
    const nodeId = String(node['id']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });
    const label = String(node['label'] ?? node['id']);
    const kind = String(node['kind'] ?? 'unknown');
    const color = getNodeColor(kind);

    gexf += `      <node id="${nodeId}" label="${escapeXml(label)}">\n`;
    gexf += `        <viz:color r="${hexToRgb(color).r}" g="${hexToRgb(color).g}" b="${hexToRgb(color).b}" />\n`;
    gexf += '        <attvalues>\n';
    gexf += `          <attvalue id="kind" value="${escapeXml(kind)}" />\n`;
    if (node['filePath']) {
      gexf += `          <attvalue id="filePath" value="${escapeXml(String(node['filePath']))}" />\n`;
    }
    if (node['language']) {
      gexf += `          <attvalue id="language" value="${escapeXml(String(node['language']))}" />\n`;
    }
    if (node['startLine'] != null) {
      gexf += `          <attvalue id="startLine" value="${node['startLine']}" />\n`;
    }
    if (node['endLine'] != null) {
      gexf += `          <attvalue id="endLine" value="${node['endLine']}" />\n`;
    }
    if (node['isExported'] != null) {
      gexf += `          <attvalue id="isExported" value="${node['isExported'] ? 'true' : 'false'}" />\n`;
    }
    if (node['projectId']) {
      gexf += `          <attvalue id="projectId" value="${escapeXml(String(node['projectId']))}" />\n`;
    }
    gexf += '        </attvalues>\n';
    gexf += '      </node>\n';
  }
  gexf += '    </nodes>\n';

  // Edges
  gexf += '    <edges>\n';
  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i];
    const sourceId = String(rel['sourceId']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });
    const targetId = String(rel['targetId']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });

    // Skip edges where source or target don't exist in our node set
    // (external references or unresolved imports)
    if (!nodeById.has(String(rel['sourceId'])) || !nodeById.has(String(rel['targetId']))) {
      continue;
    }

    const confidence = typeof rel['confidence'] === 'number' ? rel['confidence'] : 1.0;
    const relationType = String(rel['type'] ?? 'unknown');
    const reason = rel['reason'] ? String(rel['reason']) : '';

    gexf += `      <edge id="e${i}" source="${sourceId}" target="${targetId}" weight="${confidence}">\n`;
    gexf += '        <attvalues>\n';
    gexf += `          <attvalue id="relationType" value="${escapeXml(relationType)}" />\n`;
    gexf += `          <attvalue id="confidence" value="${confidence}" />\n`;
    if (reason) {
      gexf += `          <attvalue id="reason" value="${escapeXml(reason)}" />\n`;
    }
    gexf += '        </attvalues>\n';
    gexf += '      </edge>\n';
  }
  gexf += '    </edges>\n';

  gexf += '  </graph>\n';
  gexf += '</gexf>\n';

  return gexf;
}

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return String(str).replace(/[<>"'&]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
      '&': '&amp;',
    };
    return map[c];
  });
}

/**
 * Convert hex color to RGB object.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 127, g: 140, b: 141 };
}

/**
 * Sort symbol search results so that callable nodes (function, method, class)
 * appear before structural nodes (file, folder). Within the same kind, prefer
 * exact name matches over partial matches.
 */
function sortMatchingNodes(
  nodes: Array<Record<string, unknown>>,
  symbolName: string,
): Array<Record<string, unknown>> {
  const lowerSymbol = symbolName.toLowerCase();
  return [...nodes].sort((a, b) => {
    const kindA = String(a['kind'] ?? '');
    const kindB = String(b['kind'] ?? '');
    const prioA = NODE_KIND_PRIORITY[kindA] ?? 15;
    const prioB = NODE_KIND_PRIORITY[kindB] ?? 15;
    if (prioA !== prioB) return prioA - prioB;
    // Within same kind: exact name matches before partial matches
    const nameA = String(a['name'] ?? '').toLowerCase();
    const nameB = String(b['name'] ?? '').toLowerCase();
    const exactA = nameA === lowerSymbol ? 0 : 1;
    const exactB = nameB === lowerSymbol ? 0 : 1;
    return exactA - exactB;
  });
}

// ── Subcommand definitions ───────────────────────────────────────────────────

/** cleo nexus init — initialize NEXUS directory structure and registry */
const initCommand = defineCommand({
  meta: { name: 'init', description: 'Initialize NEXUS directory structure and registry' },
  async run() {
    await dispatchFromCli('mutate', 'nexus', 'init', {}, { command: 'nexus' });
  },
});

/** cleo nexus register — register a project in the global registry */
const registerCommand = defineCommand({
  meta: { name: 'register', description: 'Register a project in the global registry' },
  args: {
    path: {
      type: 'positional',
      description: 'Path to the project directory',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Custom project name (default: directory name)',
    },
    permissions: {
      type: 'string',
      description: 'Permissions: read|write|execute',
      default: 'read',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'register',
      {
        path: args.path,
        name: args.name as string | undefined,
        permission: args.permissions as string,
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus unregister — remove a project from the registry */
const unregisterCommand = defineCommand({
  meta: { name: 'unregister', description: 'Remove a project from the registry' },
  args: {
    nameOrHash: {
      type: 'positional',
      description: 'Project name or hash to unregister',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'unregister',
      { name: args.nameOrHash },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus list — list all registered projects */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all registered projects' },
  async run() {
    await dispatchFromCli('query', 'nexus', 'list', {}, { command: 'nexus' });
  },
});

/** cleo nexus status — show code intelligence index freshness */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show code intelligence index freshness: file count, node/relation counts, last indexed time, stale files. Falls back to NEXUS registry status if code-intelligence index is unavailable.',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to the project directory (default: cwd)',
      required: false,
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const startTime = Date.now();

    try {
      const [{ getNexusDb, nexusSchema }, { getIndexStats }] = await Promise.all([
        import('@cleocode/core/store/nexus-sqlite' as string),
        import('@cleocode/nexus/pipeline' as string),
      ]);

      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
      const db = await getNexusDb();
      const tables = {
        nexusNodes: nexusSchema.nexusNodes,
        nexusRelations: nexusSchema.nexusRelations,
      };

      const stats = await getIndexStats(projectId, repoPath, db, tables);
      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        const envelope = {
          success: true,
          data: { projectId, repoPath, ...stats },
          meta: {
            operation: 'nexus.status',
            duration_ms: durationMs,
            timestamp: new Date().toISOString(),
          },
        };
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else if (!stats.indexed) {
        process.stdout.write(
          `[nexus] Index status for: ${repoPath}\n` +
            `  Status:     NOT INDEXED\n` +
            `  Run 'cleo nexus analyze' to build the index.\n`,
        );
      } else {
        const staleLabel =
          stats.staleFileCount < 0
            ? 'unknown'
            : stats.staleFileCount === 0
              ? 'up to date'
              : `${stats.staleFileCount} stale`;
        process.stdout.write(
          `[nexus] Index status for: ${repoPath}\n` +
            `  Project ID:   ${projectId}\n` +
            `  Nodes:        ${stats.nodeCount}\n` +
            `  Relations:    ${stats.relationCount}\n` +
            `  Files:        ${stats.fileCount}\n` +
            `  Last indexed: ${stats.lastIndexedAt ?? 'never'}\n` +
            `  Staleness:    ${staleLabel}\n`,
        );
      }
    } catch (err) {
      // Fall back to NEXUS registry status on error
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_STATUS_FAILED', message: msg },
              meta: {
                operation: 'nexus.status',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
        await dispatchFromCli('query', 'nexus', 'status', {}, { command: 'nexus' });
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus show — show details for a registered project by name */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show details for a registered project by name' },
  args: {
    name: {
      type: 'positional',
      description: 'Project name',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli('query', 'nexus', 'show', { name: args.name }, { command: 'nexus' });
  },
});

/** cleo nexus resolve — resolve a task reference across projects */
const resolveCommand = defineCommand({
  meta: {
    name: 'resolve',
    description: 'Resolve a task reference across projects (project:T### or T###)',
  },
  args: {
    taskRef: {
      type: 'positional',
      description: 'Task reference to resolve',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'resolve',
      { query: args.taskRef },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus discover — find related tasks across projects */
const discoverCommand = defineCommand({
  meta: { name: 'discover', description: 'Find related tasks across projects' },
  args: {
    taskQuery: {
      type: 'positional',
      description: 'Task query string',
      required: true,
    },
    method: {
      type: 'string',
      description: 'Discovery method: labels|description|files|auto',
      default: 'auto',
    },
    limit: {
      type: 'string',
      description: 'Max results',
      default: '10',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'discover',
      {
        query: args.taskQuery,
        method: args.method as string,
        limit: parseInt(args.limit as string, 10),
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus search — search tasks across projects by pattern */
const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Search tasks across projects by pattern' },
  args: {
    pattern: {
      type: 'positional',
      description: 'Search pattern',
      required: true,
    },
    project: {
      type: 'string',
      description: 'Limit search to specific project',
    },
    limit: {
      type: 'string',
      description: 'Max results',
      default: '20',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'search',
      {
        pattern: args.pattern,
        project: args.project as string | undefined,
        limit: parseInt(args.limit as string, 10),
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus deps — show cross-project dependencies */
const depsCommand = defineCommand({
  meta: { name: 'deps', description: 'Show cross-project dependencies' },
  args: {
    taskQuery: {
      type: 'positional',
      description: 'Task query string',
      required: true,
    },
    reverse: {
      type: 'boolean',
      description: 'Show reverse dependencies (what depends on this)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'deps',
      {
        query: args.taskQuery,
        direction: args.reverse ? 'reverse' : 'forward',
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus critical-path — show global critical path across all registered projects */
const criticalPathCommand = defineCommand({
  meta: {
    name: 'critical-path',
    description: 'Show global critical path across all registered projects',
  },
  async run() {
    await dispatchFromCli('query', 'nexus', 'path.show', {}, { command: 'nexus' });
  },
});

/** cleo nexus blocking — show blocking impact analysis for a task */
const blockingCommand = defineCommand({
  meta: { name: 'blocking', description: 'Show blocking impact analysis for a task' },
  args: {
    taskQuery: {
      type: 'positional',
      description: 'Task query string',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'blockers.show',
      { query: args.taskQuery },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus orphans — detect broken cross-project dependency references */
const orphansCommand = defineCommand({
  meta: { name: 'orphans', description: 'Detect broken cross-project dependency references' },
  async run() {
    await dispatchFromCli('query', 'nexus', 'orphans.list', {}, { command: 'nexus' });
  },
});

/** cleo nexus sync — sync project metadata (task count, labels) */
const syncCommand = defineCommand({
  meta: { name: 'sync', description: 'Sync project metadata (task count, labels)' },
  args: {
    project: {
      type: 'positional',
      description: 'Project name to sync (default: all)',
      required: false,
    },
  },
  async run({ args }) {
    if (args.project) {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'sync',
        { name: args.project },
        { command: 'nexus' },
      );
    } else {
      await dispatchFromCli('mutate', 'nexus', 'sync', {}, { command: 'nexus' });
    }
  },
});

/** cleo nexus reconcile — reconcile current project with NEXUS registry */
const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description:
      'Reconcile current project with NEXUS registry (auto-register if new, update path if moved)',
  },
  args: {
    path: {
      type: 'string',
      description: 'Project path (default: current directory)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'reconcile',
      { projectRoot: args.path as string | undefined },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus graph — show full dependency graph across all registered projects */
const graphCommand = defineCommand({
  meta: { name: 'graph', description: 'Show full dependency graph across all registered projects' },
  async run() {
    await dispatchFromCli('query', 'nexus', 'graph', {}, { command: 'nexus' });
  },
});

/** cleo nexus share-status — show multi-contributor sharing status */
const shareStatusCommand = defineCommand({
  meta: {
    name: 'share-status',
    description: 'Show multi-contributor sharing status for the current project',
  },
  async run() {
    await dispatchFromCli('query', 'nexus', 'share.status', {}, { command: 'nexus' });
  },
});

/** cleo nexus transfer-preview — preview a task transfer between projects */
const transferPreviewCommand = defineCommand({
  meta: {
    name: 'transfer-preview',
    description: 'Preview a task transfer between projects (dry-run, no changes made)',
  },
  args: {
    taskIds: {
      type: 'positional',
      description: 'Task IDs to preview transfer for',
      required: true,
    },
    from: {
      type: 'string',
      description: 'Source project name',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target project name',
      required: true,
    },
    mode: {
      type: 'string',
      description: 'Transfer mode: copy|move',
      default: 'copy',
    },
    scope: {
      type: 'string',
      description: 'Transfer scope: single|subtree',
      default: 'subtree',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'transfer.preview',
      {
        taskIds: (args.taskIds as string).split(',').map((s) => s.trim()),
        sourceProject: args.from as string,
        targetProject: args.to as string,
        mode: args.mode as string,
        scope: args.scope as string,
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus transfer — transfer tasks from one project to another */
const transferCommand = defineCommand({
  meta: { name: 'transfer', description: 'Transfer tasks from one project to another' },
  args: {
    taskIds: {
      type: 'positional',
      description: 'Task IDs to transfer',
      required: true,
    },
    from: {
      type: 'string',
      description: 'Source project name',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target project name',
      required: true,
    },
    mode: {
      type: 'string',
      description: 'Transfer mode: copy|move',
      default: 'copy',
    },
    scope: {
      type: 'string',
      description: 'Transfer scope: single|subtree',
      default: 'subtree',
    },
    'on-conflict': {
      type: 'string',
      description: 'Conflict strategy: rename|skip|duplicate|fail',
      default: 'rename',
    },
    'transfer-brain': {
      type: 'boolean',
      description: 'Also transfer associated brain memory entries',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'transfer',
      {
        taskIds: (args.taskIds as string).split(',').map((s) => s.trim()),
        sourceProject: args.from as string,
        targetProject: args.to as string,
        mode: args.mode as string,
        scope: args.scope as string,
        onConflict: args['on-conflict'] as string,
        transferBrain: args['transfer-brain'] as boolean,
      },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus permission set — set permission level for a registered project */
const permissionSetCommand = defineCommand({
  meta: {
    name: 'set',
    description: 'Set permission level for a registered project (read|write|execute)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Project name',
      required: true,
    },
    level: {
      type: 'positional',
      description: 'Permission level: read|write|execute',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'permission.set',
      { name: args.name, level: args.level },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus permission — manage permissions for registered projects */
const permissionCommand = defineCommand({
  meta: { name: 'permission', description: 'Manage permissions for registered projects' },
  subCommands: {
    set: permissionSetCommand,
  },
});

/** cleo nexus share export — export a snapshot of current project state */
const shareExportCommand = defineCommand({
  meta: { name: 'export', description: 'Export a snapshot of current project state for sharing' },
  args: {
    output: {
      type: 'string',
      description: 'Output file path (default: auto-generated in current directory)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'share.snapshot.export',
      { outputPath: args.output as string | undefined },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus share import — import a shared project snapshot */
const shareImportCommand = defineCommand({
  meta: { name: 'import', description: 'Import a shared project snapshot' },
  args: {
    file: {
      type: 'positional',
      description: 'Path to snapshot file',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'share.snapshot.import',
      { inputPath: args.file },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus share — multi-contributor sharing operations */
const shareCommand = defineCommand({
  meta: { name: 'share', description: 'Multi-contributor sharing operations' },
  subCommands: {
    export: shareExportCommand,
    import: shareImportCommand,
  },
});

/** cleo nexus clusters — list all detected communities from the last analysis */
const clustersCommand = defineCommand({
  meta: {
    name: 'clusters',
    description: 'List all detected communities (Louvain clusters) from the last analysis',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to project directory (default: cwd)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

    try {
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      // Query all nodes for this project, filter to community kind in-memory
      // (avoids complex Drizzle where clause on an enum column).
      // NodeSQLiteDatabase uses sync Drizzle — .all() returns a plain array,
      // not a Promise, so wrap in try-catch rather than using .catch().
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
      } catch {
        rows = [];
      }

      const communities = rows.filter(
        (r) => r['kind'] === 'community' && r['projectId'] === projectId,
      );

      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                projectId,
                repoPath,
                count: communities.length,
                communities: communities.map((c) => {
                  const meta =
                    typeof c['metaJson'] === 'string'
                      ? (JSON.parse(c['metaJson'] as string) as Record<string, unknown>)
                      : {};
                  return {
                    id: c['id'],
                    label: c['label'],
                    symbolCount: meta['symbolCount'] ?? 0,
                    cohesion: meta['cohesion'] ?? 0,
                  };
                }),
              },
              meta: {
                operation: 'nexus.clusters',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        if (communities.length === 0) {
          process.stdout.write(
            `[nexus] No communities found for project ${projectId}.\n` +
              `  Run 'cleo nexus analyze' first.\n`,
          );
        } else {
          process.stdout.write(
            `[nexus] Communities for project ${projectId} (${communities.length} total):\n`,
          );
          for (const c of communities) {
            const meta =
              typeof c['metaJson'] === 'string'
                ? (JSON.parse(c['metaJson'] as string) as Record<string, unknown>)
                : {};
            const symbolCount = meta['symbolCount'] ?? 0;
            const cohesion =
              typeof meta['cohesion'] === 'number'
                ? (meta['cohesion'] as number).toFixed(3)
                : '0.000';
            process.stdout.write(
              `  ${String(c['id']).padEnd(16)}  label=${String(c['label']).padEnd(24)}  symbols=${String(symbolCount).padStart(5)}  cohesion=${cohesion}\n`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_CLUSTERS_FAILED', message: msg },
              meta: {
                operation: 'nexus.clusters',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus flows — list all detected execution flows from the last analysis */
const flowsCommand = defineCommand({
  meta: {
    name: 'flows',
    description: 'List all detected execution flows (processes) from the last analysis',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to project directory (default: cwd)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

    try {
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      // NodeSQLiteDatabase uses sync Drizzle — .all() returns a plain array,
      // not a Promise, so wrap in try-catch rather than using .catch().
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
      } catch {
        rows = [];
      }

      const processes = rows.filter((r) => r['kind'] === 'process' && r['projectId'] === projectId);

      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                projectId,
                repoPath,
                count: processes.length,
                flows: processes.map((p) => {
                  const meta =
                    typeof p['metaJson'] === 'string'
                      ? (JSON.parse(p['metaJson'] as string) as Record<string, unknown>)
                      : {};
                  return {
                    id: p['id'],
                    label: p['label'],
                    stepCount: meta['stepCount'] ?? 0,
                    processType: meta['processType'] ?? 'intra_community',
                    entryPointId: meta['entryPointId'] ?? null,
                  };
                }),
              },
              meta: {
                operation: 'nexus.flows',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        if (processes.length === 0) {
          process.stdout.write(
            `[nexus] No execution flows found for project ${projectId}.\n` +
              `  Run 'cleo nexus analyze' first.\n`,
          );
        } else {
          process.stdout.write(
            `[nexus] Execution flows for project ${projectId} (${processes.length} total):\n`,
          );
          for (const p of processes) {
            const meta =
              typeof p['metaJson'] === 'string'
                ? (JSON.parse(p['metaJson'] as string) as Record<string, unknown>)
                : {};
            const stepCount = meta['stepCount'] ?? 0;
            const processType = String(meta['processType'] ?? 'intra').replace('_community', '');
            process.stdout.write(
              `  ${String(p['id']).padEnd(30)}  steps=${String(stepCount).padStart(3)}  type=${processType.padEnd(12)}  ${String(p['label'])}\n`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_FLOWS_FAILED', message: msg },
              meta: {
                operation: 'nexus.flows',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus context — show callers, callees, community membership, and process participation */
const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description:
      'Show callers, callees, community membership, and process participation for a code symbol',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name to look up',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from cwd)',
    },
    limit: {
      type: 'string',
      description: 'Max callers/callees to show per side',
      default: '20',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const limit = parseInt(args.limit as string, 10);
    const symbolName = args.symbol as string;

    try {
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      // Find nodes matching the symbol name (case-insensitive partial match).
      // NodeSQLiteDatabase uses sync Drizzle — .all() returns a plain array.
      let allNodes: Array<Record<string, unknown>> = [];
      try {
        allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
      } catch {
        allNodes = [];
      }

      const lowerSymbol = symbolName.toLowerCase();
      const rawMatchingNodes = allNodes.filter(
        (n) =>
          n['projectId'] === projectId &&
          n['name'] != null &&
          String(n['name']).toLowerCase().includes(lowerSymbol) &&
          // Exclude synthetic graph-level nodes from symbol search
          n['kind'] !== 'community' &&
          n['kind'] !== 'process',
      );
      // Sort so callable symbols (function, method, class) rank before
      // structural nodes (file, folder) — structural nodes have no `calls`
      // relations and would produce empty callers/callees lists.
      const matchingNodes = sortMatchingNodes(rawMatchingNodes, symbolName);

      if (matchingNodes.length === 0) {
        const durationMs = Date.now() - startTime;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: false,
                error: {
                  code: 'E_NOT_FOUND',
                  message: `No symbol found matching '${symbolName}' in project ${projectId}`,
                },
                meta: {
                  operation: 'nexus.context',
                  duration_ms: durationMs,
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `[nexus] No symbol found matching '${symbolName}'.\n` +
              `  Run 'cleo nexus analyze' first, or check the symbol name.\n`,
          );
        }
        process.exitCode = 4;
        return;
      }

      // Load all relations once — cheaper than N queries per node.
      let allRelations: Array<Record<string, unknown>> = [];
      try {
        allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
          Record<string, unknown>
        >;
      } catch {
        allRelations = [];
      }

      // Build a node-by-id index for fast lookups.
      const nodeById = new Map<string, Record<string, unknown>>();
      for (const n of allNodes) {
        nodeById.set(String(n['id']), n);
      }

      // Build context for each matching node.
      const results = matchingNodes.slice(0, 5).map((node) => {
        const nodeId = String(node['id']);

        // Incoming: who calls/imports/references THIS node (target = nodeId)
        const incoming = allRelations
          .filter(
            (r) =>
              r['targetId'] === nodeId &&
              r['projectId'] === projectId &&
              (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses'),
          )
          .slice(0, limit)
          .map((r) => {
            const src = nodeById.get(String(r['sourceId']));
            return {
              relationType: r['type'],
              nodeId: r['sourceId'],
              name: src?.['name'] ?? r['sourceId'],
              kind: src?.['kind'] ?? 'unknown',
              filePath: src?.['filePath'] ?? null,
            };
          });

        // Outgoing: what THIS node calls/imports/accesses (source = nodeId)
        const outgoing = allRelations
          .filter(
            (r) =>
              r['sourceId'] === nodeId &&
              r['projectId'] === projectId &&
              (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses'),
          )
          .slice(0, limit)
          .map((r) => {
            const tgt = nodeById.get(String(r['targetId']));
            return {
              relationType: r['type'],
              nodeId: r['targetId'],
              name: tgt?.['name'] ?? r['targetId'],
              kind: tgt?.['kind'] ?? 'unknown',
              filePath: tgt?.['filePath'] ?? null,
            };
          });

        // Community membership
        const communityId = node['communityId'] as string | null;
        const community = communityId ? nodeById.get(communityId) : null;

        // Process participation (step_in_process or entry_point_of relations)
        const processRelations = allRelations.filter(
          (r) =>
            r['sourceId'] === nodeId &&
            r['projectId'] === projectId &&
            (r['type'] === 'step_in_process' || r['type'] === 'entry_point_of'),
        );
        const processes = processRelations
          .map((r) => {
            const proc = nodeById.get(String(r['targetId']));
            return {
              processId: r['targetId'],
              label: proc?.['label'] ?? r['targetId'],
              role: r['type'] === 'entry_point_of' ? 'entry_point' : 'step',
              step: r['step'] ?? null,
            };
          })
          .filter((p) => p.label !== p.processId); // filter unresolved

        return {
          nodeId,
          name: node['name'],
          kind: node['kind'],
          filePath: node['filePath'],
          startLine: node['startLine'],
          endLine: node['endLine'],
          isExported: node['isExported'],
          docSummary: node['docSummary'],
          community: community
            ? { id: communityId, label: community['label'] }
            : communityId
              ? { id: communityId, label: null }
              : null,
          callers: incoming,
          callees: outgoing,
          processes,
        };
      });

      const durationMs = Date.now() - startTime;
      const primary = results[0];

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                query: symbolName,
                projectId,
                matchCount: matchingNodes.length,
                results,
              },
              meta: {
                operation: 'nexus.context',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          `[nexus] Context for symbol '${symbolName}' (${matchingNodes.length} match${matchingNodes.length !== 1 ? 'es' : ''}):\n`,
        );
        for (const r of results) {
          process.stdout.write(
            `\n  Symbol:   ${String(r.name)}  (${String(r.kind)})\n` +
              `  File:     ${r.filePath ? String(r.filePath) : 'n/a'}` +
              (r.startLine ? `:${String(r.startLine)}` : '') +
              '\n' +
              (r.docSummary ? `  Doc:      ${String(r.docSummary)}\n` : '') +
              (r.community ? `  Community: ${String(r.community.label ?? r.community.id)}\n` : '') +
              `  Callers (${r.callers.length}): ${
                r.callers.length === 0
                  ? 'none'
                  : r.callers.map((c) => `${String(c.name)}[${String(c.kind)}]`).join(', ')
              }\n` +
              `  Callees (${r.callees.length}): ${
                r.callees.length === 0
                  ? 'none'
                  : r.callees.map((c) => `${String(c.name)}[${String(c.kind)}]`).join(', ')
              }\n` +
              (r.processes.length > 0
                ? `  Processes: ${r.processes.map((p) => `${String(p.label)}(${String(p.role)})`).join(', ')}\n`
                : ''),
          );
        }
        if (matchingNodes.length > 5) {
          process.stdout.write(
            `\n  (Showing 5 of ${matchingNodes.length} matches — use --json for full list)\n`,
          );
        }
      }
      void primary; // referenced to satisfy lint
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_CONTEXT_FAILED', message: msg },
              meta: {
                operation: 'nexus.context',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus impact — show blast radius for a code symbol */
const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description:
      'Show blast radius for a code symbol — direct callers (d=1), indirect callers (d=2), transitive (d=3)',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name to analyze',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from cwd)',
    },
    depth: {
      type: 'string',
      description: 'Maximum traversal depth (default: 3)',
      default: '3',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const maxDepth = Math.min(parseInt(args.depth as string, 10), 5);
    const symbolName = args.symbol as string;

    try {
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      // Load all nodes and relations for this project once.
      let allNodes: Array<Record<string, unknown>> = [];
      try {
        allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
      } catch {
        allNodes = [];
      }

      const lowerSymbol = symbolName.toLowerCase();
      const rawMatchingNodes = allNodes.filter(
        (n) =>
          n['projectId'] === projectId &&
          n['name'] != null &&
          String(n['name']).toLowerCase().includes(lowerSymbol) &&
          n['kind'] !== 'community' &&
          n['kind'] !== 'process',
      );
      // Sort so callable symbols (function, method, class) rank before
      // structural nodes (file, folder) — structural nodes have no `calls`
      // relations and would produce zero impact.
      const matchingNodes = sortMatchingNodes(rawMatchingNodes, symbolName);

      if (matchingNodes.length === 0) {
        const durationMs = Date.now() - startTime;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: false,
                error: {
                  code: 'E_NOT_FOUND',
                  message: `No symbol found matching '${symbolName}' in project ${projectId}`,
                },
                meta: {
                  operation: 'nexus.impact',
                  duration_ms: durationMs,
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `[nexus] No symbol found matching '${symbolName}'.\n` +
              `  Run 'cleo nexus analyze' first, or check the symbol name.\n`,
          );
        }
        process.exitCode = 4;
        return;
      }

      let allRelations: Array<Record<string, unknown>> = [];
      try {
        allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
          Record<string, unknown>
        >;
      } catch {
        allRelations = [];
      }

      // Build a node-by-id index for fast lookups.
      const nodeById = new Map<string, Record<string, unknown>>();
      for (const n of allNodes) {
        nodeById.set(String(n['id']), n);
      }

      // BFS upstream: find all nodes that (transitively) call/import the target.
      const targetNode = matchingNodes[0];
      const targetId = String(targetNode['id']);

      // Build reverse adjacency: targetId → [sourceIds that call it]
      const reverseAdj = new Map<string, string[]>();
      for (const r of allRelations) {
        if (
          r['projectId'] === projectId &&
          (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses')
        ) {
          const tid = String(r['targetId']);
          const sid = String(r['sourceId']);
          if (!reverseAdj.has(tid)) reverseAdj.set(tid, []);
          reverseAdj.get(tid)!.push(sid);
        }
      }

      // BFS traversal up to maxDepth levels.
      const visited = new Set<string>([targetId]);
      const depthMap = new Map<string, number>(); // nodeId → depth
      const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
      const impactByDepth: Array<
        Array<{ nodeId: string; name: string; kind: string; filePath: string | null }>
      > = [];

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.depth >= maxDepth) continue;

        const callers = reverseAdj.get(item.id) ?? [];
        for (const callerId of callers) {
          if (visited.has(callerId)) continue;
          visited.add(callerId);
          const depth = item.depth + 1;
          depthMap.set(callerId, depth);
          const callerNode = nodeById.get(callerId);
          if (!impactByDepth[depth - 1]) impactByDepth[depth - 1] = [];
          impactByDepth[depth - 1].push({
            nodeId: callerId,
            name: String(callerNode?.['name'] ?? callerId),
            kind: String(callerNode?.['kind'] ?? 'unknown'),
            filePath: callerNode?.['filePath'] ? String(callerNode['filePath']) : null,
          });
          queue.push({ id: callerId, depth });
        }
      }

      const totalImpact = visited.size - 1; // exclude the target itself
      const riskLevel =
        totalImpact === 0
          ? 'NONE'
          : totalImpact <= 3
            ? 'LOW'
            : totalImpact <= 10
              ? 'MEDIUM'
              : totalImpact <= 25
                ? 'HIGH'
                : 'CRITICAL';

      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                query: symbolName,
                projectId,
                targetNodeId: targetId,
                targetName: targetNode['name'],
                targetKind: targetNode['kind'],
                targetFilePath: targetNode['filePath'],
                riskLevel,
                totalImpactedNodes: totalImpact,
                maxDepth,
                impactByDepth: impactByDepth.map((layer, i) => ({
                  depth: i + 1,
                  label:
                    i === 0
                      ? 'WILL BREAK (direct callers)'
                      : i === 1
                        ? 'LIKELY AFFECTED'
                        : 'MAY NEED TESTING',
                  nodes: layer,
                })),
              },
              meta: {
                operation: 'nexus.impact',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          `[nexus] Impact analysis for '${symbolName}'\n` +
            `  Target:  ${String(targetNode['name'])}  (${String(targetNode['kind'])})\n` +
            `  File:    ${targetNode['filePath'] ? String(targetNode['filePath']) : 'n/a'}\n` +
            `  Risk:    ${riskLevel}  (${totalImpact} impacted node${totalImpact !== 1 ? 's' : ''})\n`,
        );
        if (totalImpact === 0) {
          process.stdout.write('  No callers found — safe to modify.\n');
        } else {
          for (let i = 0; i < impactByDepth.length; i++) {
            const layer = impactByDepth[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'WILL BREAK' : i === 1 ? 'LIKELY AFFECTED' : 'MAY NEED TESTING';
            process.stdout.write(`\n  d=${i + 1} ${label} (${layer.length}):\n`);
            for (const node of layer.slice(0, 15)) {
              process.stdout.write(
                `    ${String(node.name).padEnd(36)}  ${String(node.kind).padEnd(12)}  ${node.filePath ?? ''}\n`,
              );
            }
            if (layer.length > 15) {
              process.stdout.write(`    ... and ${layer.length - 15} more\n`);
            }
          }
        }
        if (matchingNodes.length > 1) {
          process.stdout.write(
            `\n  (Showing analysis for first match — ${matchingNodes.length} total matches for '${symbolName}')\n`,
          );
        }
      }
      void depthMap; // referenced to satisfy lint
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_IMPACT_FAILED', message: msg },
              meta: {
                operation: 'nexus.impact',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus analyze — run code intelligence pipeline on a repository directory */
const analyzeCommand = defineCommand({
  meta: {
    name: 'analyze',
    description: 'Run code intelligence pipeline on a repository directory',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to repository directory (default: cwd)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected)',
    },
    incremental: {
      type: 'boolean',
      description: 'Only re-index files that have changed since the last run (faster)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const isIncremental = !!args.incremental;

    // Resolve target path
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();

    if (!jsonOutput) {
      process.stderr.write(
        `[nexus] Analyzing: ${repoPath}${isIncremental ? ' (incremental)' : ''}\n`,
      );
    }

    try {
      // Lazy imports to avoid loading heavy dependencies until needed
      const [{ getNexusDb, nexusSchema }, { runPipeline }, { getProjectRoot }, { eq }] =
        await Promise.all([
          import('@cleocode/core/store/nexus-sqlite' as string),
          import('@cleocode/nexus/pipeline' as string),
          import('@cleocode/core/internal' as string),
          import('drizzle-orm' as string),
        ]);

      // Determine project ID — use override or derive from path
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

      // Get DB and table references
      const db = await getNexusDb();
      const tables = {
        nexusNodes: nexusSchema.nexusNodes,
        nexusRelations: nexusSchema.nexusRelations,
      };

      // For full (non-incremental) runs: delete existing index first.
      // NodeSQLiteDatabase uses sync Drizzle — no await, wrap in try-catch.
      if (!isIncremental) {
        if (!jsonOutput) {
          process.stderr.write('[nexus] Clearing existing index for project...\n');
        }
        try {
          db.delete(nexusSchema.nexusNodes)
            .where(eq(nexusSchema.nexusNodes.projectId, projectId))
            .run();
        } catch {
          // Table may not have rows — ignore
        }
        try {
          db.delete(nexusSchema.nexusRelations)
            .where(eq(nexusSchema.nexusRelations.projectId, projectId))
            .run();
        } catch {
          // Table may not have rows — ignore
        }
      }

      // Run the pipeline (full or incremental)
      const result = await runPipeline(
        repoPath,
        projectId,
        db,
        tables,
        jsonOutput
          ? undefined
          : (current: number, total: number, filePath: string) => {
              if (current % 50 === 0 || current === total) {
                const pct = total > 0 ? Math.round((current / total) * 100) : 100;
                process.stderr.write(
                  `[nexus] Progress: ${current}/${total} files (${pct}%) — ${filePath}\n`,
                );
              }
            },
        { incremental: isIncremental },
      );

      const durationMs = Date.now() - startTime;

      // Write nexus-bridge.md after a successful pipeline run (best-effort)
      try {
        const { refreshNexusBridge } = await import('@cleocode/core/internal' as string);
        await refreshNexusBridge(repoPath, projectId);
        if (!jsonOutput) {
          process.stderr.write(
            `[nexus] nexus-bridge.md refreshed at ${repoPath}/.cleo/nexus-bridge.md\n`,
          );
        }
      } catch {
        // Non-fatal — bridge refresh failure should not fail the analyze command
      }

      // Auto-register project and update index stats in the multi-project registry (best-effort)
      try {
        const { nexusUpdateIndexStats } = await import('@cleocode/core/internal' as string);
        await nexusUpdateIndexStats(repoPath, {
          nodeCount: result.nodeCount,
          relationCount: result.relationCount,
          fileCount: result.fileCount,
        });
        if (!jsonOutput) {
          process.stderr.write('[nexus] Project registered/updated in multi-project registry.\n');
        }
      } catch {
        // Non-fatal — registry update must never fail the analyze command
      }

      if (jsonOutput) {
        const envelope = {
          success: true,
          data: {
            projectId,
            repoPath,
            incremental: isIncremental,
            nodeCount: result.nodeCount,
            relationCount: result.relationCount,
            fileCount: result.fileCount,
            durationMs,
          },
          meta: {
            operation: 'nexus.analyze',
            duration_ms: durationMs,
            timestamp: new Date().toISOString(),
          },
        };
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        process.stdout.write(
          `[nexus] Analysis complete${isIncremental ? ' (incremental)' : ''}:\n` +
            `  Project ID: ${projectId}\n` +
            `  Files:      ${result.fileCount}\n` +
            `  Nodes:      ${result.nodeCount}\n` +
            `  Relations:  ${result.relationCount}\n` +
            `  Duration:   ${durationMs}ms\n`,
        );
      }

      void getProjectRoot; // referenced to satisfy import
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        const envelope = {
          success: false,
          error: { code: 'E_PIPELINE_FAILED', message: msg },
          meta: {
            operation: 'nexus.analyze',
            duration_ms: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          },
        };
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

// ── nexus projects subcommand group ──────────────────────────────────────────

/** cleo nexus projects list — list all projects registered in the global nexus registry */
const projectsListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all projects registered in the global nexus registry',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    try {
      const { nexusList } = await import('@cleocode/core/internal' as string);
      const list = (await nexusList()) as Array<{
        name: string;
        path: string;
        projectId: string;
        hash: string;
        brainDbPath?: string | null;
        tasksDbPath?: string | null;
        lastIndexed?: string | null;
        stats?: { nodeCount?: number; relationCount?: number; fileCount?: number };
        taskCount: number;
        lastSeen: string;
        healthStatus: string;
      }>;
      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: { projects: list, count: list.length },
              meta: {
                operation: 'nexus.projects.list',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else if (list.length === 0) {
        process.stdout.write('[nexus] No projects registered. Run: cleo nexus projects register\n');
      } else {
        process.stdout.write(`[nexus] Registered projects (${list.length}):\n\n`);
        for (const p of list) {
          const nodes = p.stats?.nodeCount ?? 0;
          const rels = p.stats?.relationCount ?? 0;
          const indexed = p.lastIndexed ? p.lastIndexed.slice(0, 10) : 'never';
          process.stdout.write(
            `  ${p.name.padEnd(28)}  tasks=${String(p.taskCount).padStart(5)}  nodes=${String(nodes).padStart(6)}  relations=${String(rels).padStart(7)}  indexed=${indexed}\n` +
              `  ${''.padEnd(28)}  path=${p.path}\n`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] Error: ${msg}\n`);
      process.exitCode = 1;
    }
  },
});

/** cleo nexus projects register — register a project in the global nexus registry */
const projectsRegisterCommand = defineCommand({
  meta: {
    name: 'register',
    description: 'Register a project in the global nexus registry (default: current directory)',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to the project directory (default: cwd)',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Custom project name (default: directory name)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const name = args.name as string | undefined;

    try {
      const { nexusRegister } = await import('@cleocode/core/internal' as string);
      const hash = await (nexusRegister as (p: string, n?: string) => Promise<string>)(
        repoPath,
        name,
      );
      const durationMs = Date.now() - startTime;
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: { hash, path: repoPath },
              meta: {
                operation: 'nexus.projects.register',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(`[nexus] Registered: ${repoPath} (hash: ${hash})\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_REGISTER_FAILED', message: msg },
              meta: {
                operation: 'nexus.projects.register',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus projects remove — remove a project from the global nexus registry */
const projectsRemoveCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a project from the global nexus registry',
  },
  args: {
    nameOrHash: {
      type: 'positional',
      description: 'Project name or hash to remove',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    try {
      const { nexusUnregister } = await import('@cleocode/core/internal' as string);
      await nexusUnregister(args.nameOrHash);
      const durationMs = Date.now() - startTime;
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: { removed: args.nameOrHash },
              meta: {
                operation: 'nexus.projects.remove',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(`[nexus] Removed: ${args.nameOrHash}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_REMOVE_FAILED', message: msg },
              meta: {
                operation: 'nexus.projects.remove',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus projects scan — walk filesystem roots to discover .cleo/ directories */
const projectsScanCommand = defineCommand({
  meta: {
    name: 'scan',
    description:
      'Walk filesystem roots to discover .cleo/ directories not registered in the global nexus registry',
  },
  args: {
    roots: {
      type: 'string',
      description: 'Comma-separated search roots (default: ~/code,~/projects,/mnt/projects)',
    },
    'max-depth': {
      type: 'string',
      description: 'Maximum directory traversal depth (default: 4)',
      default: '4',
    },
    'auto-register': {
      type: 'boolean',
      description: 'Register all discovered unregistered projects automatically',
    },
    'include-existing': {
      type: 'boolean',
      description: 'Also report projects that are already registered',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const autoRegister = !!args['auto-register'];
    const includeExisting = !!args['include-existing'];
    const maxDepth = Math.max(1, Math.min(parseInt(args['max-depth'] as string, 10), 20));

    // Resolve search roots
    const { homedir } = await import('node:os');
    const home = homedir();
    const defaultRoots = [path.join(home, 'code'), path.join(home, 'projects'), '/mnt/projects'];
    const rawRoots: string[] =
      typeof args.roots === 'string' && (args.roots as string).trim().length > 0
        ? (args.roots as string)
            .split(',')
            .map((r: string) => r.trim())
            .filter((r: string) => r.length > 0)
            .map((r: string) => (r.startsWith('~') ? path.join(home, r.slice(1)) : path.resolve(r)))
        : defaultRoots;

    // Filter to roots that actually exist
    const { existsSync, readdirSync, statSync } = await import('node:fs');
    const { Dirent } = await import('node:fs');
    type DirentString = InstanceType<typeof Dirent<string>>;
    const roots = rawRoots.filter((r) => {
      try {
        return existsSync(r) && statSync(r).isDirectory();
      } catch {
        return false;
      }
    });

    if (!jsonOutput) {
      process.stdout.write(
        `[nexus] Scanning ${roots.length} root(s) up to depth ${maxDepth}:\n` +
          roots.map((r) => `  ${r}`).join('\n') +
          '\n',
      );
    }

    // ── Filesystem walker ──────────────────────────────────────────────
    // Walk recursively up to maxDepth. Skip common build/cache directories.
    // Does NOT follow symlinks. Does NOT cross mount points.
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'target', // Rust build
      'dist',
      'build',
      '.svelte-kit',
      '.next',
      '.cache',
      'coverage',
      '.turbo',
      '.nx',
      '__pycache__',
      '.venv',
      'venv',
      '.tox',
      'vendor',
    ]);

    /**
     * Return the device number for a path, or -1 on error.
     * Used to detect filesystem boundary crossings.
     */
    function getDevice(p: string): number {
      try {
        return statSync(p).dev;
      } catch {
        return -1;
      }
    }

    /**
     * Walk a directory tree looking for directories named `.cleo/`.
     * Candidates are returned as absolute parent directory paths (the project root).
     *
     * @param dir     - Absolute directory path to walk.
     * @param depth   - Current recursion depth (0 = root).
     * @param rootDev - Device number of the search root for boundary checks.
     */
    function walkForCleo(dir: string, depth: number, rootDev: number): string[] {
      if (depth > maxDepth) return [];

      let entries: DirentString[];
      try {
        // withFileTypes:true + default encoding returns Dirent<string>[]
        entries = readdirSync(dir, { withFileTypes: true }) as DirentString[];
      } catch {
        return [];
      }

      const found: string[] = [];

      for (const entry of entries) {
        // Only process directories; skip symlinks (security requirement).
        if (!entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.name === '.cleo') {
          // Parent dir is a CLEO project root
          found.push(dir);
          // Do not recurse into .cleo/ itself
          continue;
        }

        if (SKIP_DIRS.has(entry.name)) continue;

        // Filesystem boundary check — don't traverse into different mount points.
        const childDev = getDevice(fullPath);
        if (childDev !== rootDev && childDev !== -1) continue;

        const nested = walkForCleo(fullPath, depth + 1, rootDev);
        for (const n of nested) found.push(n);
      }

      return found;
    }

    // Collect all candidates
    const allCandidates: string[] = [];
    for (const root of roots) {
      const rootDev = getDevice(root);
      const found = walkForCleo(root, 0, rootDev);
      for (const f of found) allCandidates.push(f);
    }

    // Deduplicate (a root could itself be a .cleo parent)
    const candidates = [...new Set(allCandidates)];

    // ── Cross-reference with registry ─────────────────────────────────
    let registeredPaths = new Set<string>();
    try {
      const { nexusList: listProjects } = await import('@cleocode/core/internal' as string);
      const projectsList = await listProjects();
      for (const p of projectsList) {
        registeredPaths.add(path.resolve(p.path));
      }
    } catch {
      // Registry unavailable — treat all as unregistered
      registeredPaths = new Set();
    }

    const unregistered: string[] = [];
    const registered: string[] = [];

    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (registeredPaths.has(resolved)) {
        registered.push(resolved);
      } else {
        unregistered.push(resolved);
      }
    }

    const tally = {
      total: candidates.length,
      unregistered: unregistered.length,
      registered: registered.length,
    };

    // ── Auto-register ─────────────────────────────────────────────────
    const autoRegistered: string[] = [];
    const autoRegisterErrors: Array<{ path: string; error: string }> = [];

    if (autoRegister && unregistered.length > 0) {
      const { nexusRegister: doRegister } = await import('@cleocode/core/internal' as string);
      for (const projectPath of unregistered) {
        try {
          await (doRegister as (p: string) => Promise<string>)(projectPath);
          autoRegistered.push(projectPath);
        } catch (err) {
          autoRegisterErrors.push({
            path: projectPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Audit log ─────────────────────────────────────────────────────
    // Best-effort: never let audit failure surface to the user.
    try {
      const { getNexusDb } = await import('@cleocode/core/store/nexus-sqlite' as string);
      const { nexusAuditLog: auditTable } = await import(
        '@cleocode/core/store/nexus-schema' as string
      );
      const { randomUUID } = await import('node:crypto');
      const db = await getNexusDb();
      await db.insert(auditTable).values({
        id: randomUUID(),
        action: 'projects.scan',
        domain: 'nexus',
        operation: 'projects.scan',
        success: 1,
        detailsJson: JSON.stringify({
          roots,
          found: candidates.length,
          unregistered: unregistered.length,
          registered: registered.length,
          autoRegistered: autoRegistered.length,
        }),
      });
    } catch {
      // Audit failure is non-fatal
    }

    const durationMs = Date.now() - startTime;

    // ── Output ────────────────────────────────────────────────────────
    if (jsonOutput) {
      const data: Record<string, unknown> = {
        roots,
        unregistered,
        tally,
      };
      if (includeExisting) data['registered'] = registered;
      if (autoRegister) {
        data['autoRegistered'] = autoRegistered;
        data['autoRegisterErrors'] = autoRegisterErrors;
      }
      process.stdout.write(
        JSON.stringify(
          {
            success: true,
            data,
            meta: {
              operation: 'nexus.projects.scan',
              duration_ms: durationMs,
              timestamp: new Date().toISOString(),
            },
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      // Human-readable output
      process.stdout.write(
        `\n[nexus] Scan complete — ${tally.total} project(s) found ` +
          `(${tally.unregistered} unregistered, ${tally.registered} registered)\n`,
      );

      if (unregistered.length > 0) {
        process.stdout.write('\n  Unregistered:\n');
        for (const p of unregistered) {
          process.stdout.write(`    ${p}\n`);
        }
        if (!autoRegister) {
          process.stdout.write('\n  Tip: run with --auto-register to register all of the above.\n');
        }
      }

      if (includeExisting && registered.length > 0) {
        process.stdout.write('\n  Already registered:\n');
        for (const p of registered) {
          process.stdout.write(`    ${p}\n`);
        }
      }

      if (autoRegister) {
        process.stdout.write(
          `\n  Auto-registered: ${autoRegistered.length} project(s)` +
            (autoRegisterErrors.length > 0 ? `, ${autoRegisterErrors.length} failed` : '') +
            '\n',
        );
        for (const e of autoRegisterErrors) {
          process.stdout.write(`    FAILED ${e.path}: ${e.error}\n`);
        }
      }
    }
  },
});

/** cleo nexus projects clean — bulk purge project_registry rows matching path criteria */
const projectsCleanCommand = defineCommand({
  meta: {
    name: 'clean',
    description:
      'Bulk purge project_registry rows matching path criteria (requires at least one filter flag)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'List matching projects without deleting anything',
    },
    pattern: {
      type: 'string',
      description: 'JS regex matched against project_path',
    },
    'include-temp': {
      type: 'boolean',
      description: 'Preset: match paths containing a .temp/ segment',
    },
    'include-tests': {
      type: 'boolean',
      description: 'Preset: match paths containing tmp/test/fixture/scratch/sandbox segments',
    },
    unhealthy: {
      type: 'boolean',
      description: 'Also match rows where health_status is "unhealthy"',
    },
    'never-indexed': {
      type: 'boolean',
      description: 'Also match rows where last_indexed IS NULL',
    },
    yes: {
      type: 'boolean',
      description: 'Skip confirmation prompt (still shows preview)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const dryRun = !!args['dry-run'];
    const skipPrompt = !!args.yes;
    const patternRaw = args.pattern as string | undefined;
    const includeTemp = !!args['include-temp'];
    const includeTests = !!args['include-tests'];
    const matchUnhealthy = !!args.unhealthy;
    const matchNeverIndexed = !!args['never-indexed'];

    // Require at least one real criteria flag (not just --dry-run / --yes / --json)
    const hasCriteria =
      patternRaw !== undefined ||
      includeTemp ||
      includeTests ||
      matchUnhealthy ||
      matchNeverIndexed;

    if (!hasCriteria) {
      const errMsg =
        'No filter criteria provided. Refusing to purge all projects without explicit criteria.\n' +
        'Use at least one of: --pattern <regex>, --include-temp, --include-tests, --unhealthy, --never-indexed';
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_NO_CRITERIA', message: errMsg },
              meta: {
                operation: 'nexus.projects.clean',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${errMsg}\n`);
      }
      process.exitCode = 6;
      return;
    }

    // Compile user-supplied regex (if any)
    let patternRegex: RegExp | null = null;
    if (patternRaw !== undefined) {
      try {
        patternRegex = new RegExp(patternRaw);
      } catch (err) {
        const msg = `Invalid --pattern regex: ${err instanceof Error ? err.message : String(err)}`;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: false,
                error: { code: 'E_INVALID_PATTERN', message: msg },
                meta: {
                  operation: 'nexus.projects.clean',
                  duration_ms: Date.now() - startTime,
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stderr.write(`[nexus] Error: ${msg}\n`);
        }
        process.exitCode = 6;
        return;
      }
    }

    // Preset regexes
    const TEMP_RE = /(^|\/)\.temp(\/|$)/;
    const TESTS_RE = /(^|\/)(tmp|test|fixture|scratch|sandbox)(\/|$)/;

    /**
     * Return true if a project_path matches any of the active criteria.
     */
    function matchesCriteria(
      projectPath: string,
      healthStatus: string,
      lastIndexed: string | null,
    ): boolean {
      if (patternRegex?.test(projectPath)) return true;
      if (includeTemp && TEMP_RE.test(projectPath)) return true;
      if (includeTests && TESTS_RE.test(projectPath)) return true;
      if (matchUnhealthy && healthStatus === 'unhealthy') return true;
      if (matchNeverIndexed && lastIndexed === null) return true;
      return false;
    }

    try {
      const { getNexusDb } = await import('@cleocode/core/store/nexus-sqlite' as string);
      const { projectRegistry: regTable, nexusAuditLog: auditTable } = await import(
        '@cleocode/core/store/nexus-schema' as string
      );
      const { randomUUID } = await import('node:crypto');
      const { inArray } = await import('drizzle-orm');
      const db = await getNexusDb();

      /** Minimal shape we need from each registry row. */
      type RegistryRow = {
        projectId: string;
        projectPath: string;
        healthStatus: string;
        lastIndexed: string | null;
      };

      // Fetch all registry rows in one query — avoid N+1.
      // Cast is required because dynamic imports with `as string` suppress
      // the real module types; the actual schema column types match this shape.
      const allRows = (await db
        .select({
          projectId: regTable.projectId,
          projectPath: regTable.projectPath,
          healthStatus: regTable.healthStatus,
          lastIndexed: regTable.lastIndexed,
        })
        .from(regTable)) as RegistryRow[];

      const matches = allRows.filter((row) =>
        matchesCriteria(row.projectPath, row.healthStatus, row.lastIndexed),
      );

      const totalCount = allRows.length;
      const matchCount = matches.length;
      const samplePaths = matches.slice(0, 10).map((r) => r.projectPath);

      // Always show preview
      if (!jsonOutput) {
        process.stdout.write(
          `[nexus] Clean preview — ${matchCount} project(s) of ${totalCount} total match criteria:\n`,
        );
        if (matchCount === 0) {
          process.stdout.write('  (no matches)\n');
        } else {
          for (const p of samplePaths) {
            process.stdout.write(`  ${p}\n`);
          }
          if (matchCount > 10) {
            process.stdout.write(`  ... and ${matchCount - 10} more\n`);
          }
        }
      }

      if (matchCount === 0) {
        const durationMs = Date.now() - startTime;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: true,
                data: {
                  dryRun,
                  matched: 0,
                  purged: 0,
                  remaining: totalCount,
                  sample: [],
                },
                meta: {
                  operation: 'nexus.projects.clean',
                  duration_ms: durationMs,
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ) + '\n',
          );
        }
        return;
      }

      // Dry-run: stop here
      if (dryRun) {
        const durationMs = Date.now() - startTime;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: true,
                data: {
                  dryRun: true,
                  matched: matchCount,
                  purged: 0,
                  remaining: totalCount,
                  sample: samplePaths,
                },
                meta: {
                  operation: 'nexus.projects.clean',
                  duration_ms: durationMs,
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `[nexus] Dry-run — ${matchCount} project(s) would be purged. Rerun without --dry-run to delete.\n`,
          );
        }
        return;
      }

      // Confirmation prompt (skip with --yes)
      if (!skipPrompt) {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const confirmed = await new Promise<boolean>((resolve) => {
          rl.question(
            `\n[nexus] Delete ${matchCount} project(s) from the registry? [y/N] `,
            (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase() === 'y');
            },
          );
        });
        if (!confirmed) {
          process.stdout.write('[nexus] Aborted — no projects deleted.\n');
          return;
        }
      }

      // Delete in a single transaction
      const idsToDelete = matches.map((r) => r.projectId);
      await db.delete(regTable).where(inArray(regTable.projectId, idsToDelete));

      const remaining = totalCount - matchCount;

      // Audit log (best-effort)
      try {
        await db.insert(auditTable).values({
          id: randomUUID(),
          action: 'projects.clean',
          domain: 'nexus',
          operation: 'projects.clean',
          success: 1,
          detailsJson: JSON.stringify({
            pattern: patternRaw ?? null,
            presets: {
              includeTemp,
              includeTests,
              matchUnhealthy,
              matchNeverIndexed,
            },
            count: matchCount,
            sample: samplePaths,
          }),
        });
      } catch {
        // Audit failure is non-fatal
      }

      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                dryRun: false,
                matched: matchCount,
                purged: matchCount,
                remaining,
                sample: samplePaths,
              },
              meta: {
                operation: 'nexus.projects.clean',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          `[nexus] Purged ${matchCount} project(s). ${remaining} project(s) remaining in registry.\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_CLEAN_FAILED', message: msg },
              meta: {
                operation: 'nexus.projects.clean',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/** cleo nexus projects — multi-project registry management */
const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'Multi-project registry management' },
  subCommands: {
    list: projectsListCommand,
    register: projectsRegisterCommand,
    remove: projectsRemoveCommand,
    scan: projectsScanCommand,
    clean: projectsCleanCommand,
  },
});

/** cleo nexus refresh-bridge — regenerate .cleo/nexus-bridge.md from existing index */
const refreshBridgeCommand = defineCommand({
  meta: {
    name: 'refresh-bridge',
    description:
      'Regenerate .cleo/nexus-bridge.md from the existing nexus.db index (does not re-index)',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to project directory (default: cwd)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

    try {
      const { writeNexusBridge } = await import('@cleocode/core/internal' as string);
      const result = await writeNexusBridge(repoPath, projectId);
      const durationMs = Date.now() - startTime;

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: { path: result.path, written: result.written, projectId, repoPath },
              meta: {
                operation: 'nexus.refresh-bridge',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else if (result.written) {
        process.stdout.write(`[nexus] nexus-bridge.md refreshed at ${result.path}\n`);
      } else {
        process.stdout.write(`[nexus] nexus-bridge.md unchanged at ${result.path}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_BRIDGE_FAILED', message: msg },
              meta: {
                operation: 'nexus.refresh-bridge',
                duration_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error refreshing bridge: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/**
 * Export nexus graph to GEXF (Gephi) or JSON format.
 *
 * Queries graph_nodes and graph_edges from nexus.db and emits GEXF format
 * suitable for visualization in Gephi. Supports optional project filtering.
 *
 * @task T626-M7
 */
const exportCommand = defineCommand({
  meta: { name: 'export', description: 'Export nexus graph to GEXF (Gephi) or JSON format' },
  args: {
    format: {
      type: 'string',
      description: 'Output format: gexf, json',
      default: 'gexf',
    },
    output: {
      type: 'string',
      description: 'Output file path (stdout if omitted)',
    },
    project: {
      type: 'string',
      description: 'Filter by project ID (exports all projects if omitted)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const format = (args.format as string) ?? 'gexf';
    const outputFile = args.output as string | undefined;
    const projectFilter = args.project as string | undefined;

    try {
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      // Load all nodes and relations
      let allNodes: Array<Record<string, unknown>> = [];
      let allRelations: Array<Record<string, unknown>> = [];
      try {
        allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
        allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
          Record<string, unknown>
        >;
      } catch {
        // DB may be empty
      }

      // Filter by project if specified
      const nodes = projectFilter
        ? allNodes.filter((n) => n['projectId'] === projectFilter)
        : allNodes;
      const relations = projectFilter
        ? allRelations.filter((r) => r['projectId'] === projectFilter)
        : allRelations;

      let output = '';

      if (format === 'json') {
        output = JSON.stringify(
          {
            nodes: nodes.map((n) => ({
              id: n['id'],
              kind: n['kind'],
              label: n['label'],
              name: n['name'],
              filePath: n['filePath'],
              language: n['language'],
              isExported: n['isExported'],
              startLine: n['startLine'],
              endLine: n['endLine'],
              projectId: n['projectId'],
            })),
            edges: relations.map((r) => ({
              id: r['id'],
              source: r['sourceId'],
              target: r['targetId'],
              type: r['type'],
              confidence: r['confidence'],
              reason: r['reason'],
            })),
          },
          null,
          2,
        );
      } else if (format === 'gexf') {
        // GEXF format (Gephi standard)
        output = generateGexf(nodes, relations);
      } else {
        process.stderr.write(`[nexus] Error: Unknown format '${format}'. Supported: gexf, json\n`);
        process.exitCode = 1;
        return;
      }

      if (outputFile) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(outputFile, output, 'utf-8');
        process.stdout.write(
          `[nexus] Exported to ${outputFile} (${nodes.length} nodes, ${relations.length} edges)\n`,
        );
      } else {
        process.stdout.write(output);
        if (!output.endsWith('\n')) process.stdout.write('\n');
      }

      const durationMs = Date.now() - startTime;
      if (outputFile) {
        process.stderr.write(`[nexus] Export completed in ${durationMs}ms\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] Error: ${msg}\n`);
      process.exitCode = 1;
    }
  },
});

/**
 * Compare NEXUS index state between two git commits.
 *
 * Runs an incremental re-analysis against the current working tree state
 * (representing the "after" snapshot) and compares relation/node counts
 * against the pre-analysis snapshot. Reports new relations, removed
 * relations, and any regressions detected.
 *
 * @task T625
 */
const diffCommand = defineCommand({
  meta: {
    name: 'diff',
    description:
      'Compare NEXUS index state between two git commits — shows new/removed relations and broken call chains',
  },
  args: {
    before: {
      type: 'string',
      description: 'Git SHA or ref for the "before" snapshot (default: HEAD~1)',
    },
    after: {
      type: 'string',
      description: 'Git SHA or ref for the "after" snapshot (default: HEAD)',
      default: 'HEAD',
    },
    path: {
      type: 'string',
      description: 'Repository directory to analyze (default: cwd)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    const startTime = Date.now();
    const jsonOutput = !!args.json;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectIdOverride = args['project-id'] as string | undefined;
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const beforeRef = (args.before as string | undefined) ?? 'HEAD~1';
    const afterRef = (args.after as string | undefined) ?? 'HEAD';

    if (!jsonOutput) {
      process.stderr.write(`[nexus] Diffing relations: ${beforeRef}..${afterRef} in ${repoPath}\n`);
    }

    try {
      const { execFile: execFileNode } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFileNode);

      /** Resolve a git ref to a short SHA. Falls back to the ref itself on failure. */
      const resolveSha = async (ref: string): Promise<string> => {
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--short', ref], {
            timeout: 5_000,
            cwd: repoPath,
          });
          return stdout.trim();
        } catch {
          return ref;
        }
      };

      const [beforeSha, afterSha] = await Promise.all([
        resolveSha(beforeRef),
        resolveSha(afterRef),
      ]);

      // Get files changed between the two refs (TypeScript/JavaScript/Rust only)
      let changedFiles: string[] = [];
      try {
        const { stdout: diffOutput } = await execFileAsync(
          'git',
          ['diff', '--name-only', beforeSha, afterSha],
          { timeout: 10_000, cwd: repoPath },
        );
        changedFiles = diffOutput
          .split('\n')
          .map((f) => f.trim())
          .filter(
            (f) => f.length > 0 && (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.rs')),
          );
      } catch {
        // git diff failed — proceed with full status comparison
      }

      // Load nexus DB and snapshot relation/node counts before incremental analysis
      const { getNexusDb, nexusSchema } = await import(
        '@cleocode/core/store/nexus-sqlite' as string
      );
      const db = await getNexusDb();

      let relationsBefore = 0;
      let nodesBefore = 0;
      try {
        const allRelsBefore = db.select().from(nexusSchema.nexusRelations).all() as Array<
          Record<string, unknown>
        >;
        const allNodesBefore = db.select().from(nexusSchema.nexusNodes).all() as Array<
          Record<string, unknown>
        >;
        relationsBefore = allRelsBefore.filter((r) => r['projectId'] === projectId).length;
        nodesBefore = allNodesBefore.filter((n) => n['projectId'] === projectId).length;
      } catch {
        // DB not yet initialized — start from zero
      }

      // Run incremental pipeline to reflect the afterRef state
      const { runPipeline } = await import('@cleocode/nexus/pipeline' as string);
      const pipelineResult = await runPipeline(
        repoPath,
        projectId,
        db,
        {
          nexusNodes: nexusSchema.nexusNodes,
          nexusRelations: nexusSchema.nexusRelations,
        },
        undefined, // no progress callback in diff mode
        { incremental: true },
      );

      // Snapshot counts after incremental analysis
      let relationsAfter = 0;
      let nodesAfter = 0;
      try {
        const allRelsAfter = db.select().from(nexusSchema.nexusRelations).all() as Array<
          Record<string, unknown>
        >;
        const allNodesAfter = db.select().from(nexusSchema.nexusNodes).all() as Array<
          Record<string, unknown>
        >;
        relationsAfter = allRelsAfter.filter((r) => r['projectId'] === projectId).length;
        nodesAfter = allNodesAfter.filter((n) => n['projectId'] === projectId).length;
      } catch {
        // Fallback: use pipeline result counts directly
        relationsAfter = pipelineResult.relationCount;
        nodesAfter = pipelineResult.nodeCount;
      }

      const newRelations = Math.max(0, relationsAfter - relationsBefore);
      const removedRelations = Math.max(0, relationsBefore - relationsAfter);
      const newNodes = Math.max(0, nodesAfter - nodesBefore);
      const removedNodes = Math.max(0, nodesBefore - nodesAfter);
      const durationMs = Date.now() - startTime;

      // Classify regressions: significant relation or node loss
      const regressions: string[] = [];
      if (removedRelations > 5) {
        regressions.push(`${removedRelations} relations removed — verify no broken call chains`);
      }
      if (removedNodes > 0) {
        regressions.push(`${removedNodes} symbols removed — callers may be broken`);
      }

      const diffHealthStatus =
        regressions.length > 0
          ? 'REGRESSIONS_DETECTED'
          : removedRelations > 0
            ? 'RELATIONS_REDUCED'
            : newRelations > 0
              ? 'RELATIONS_ADDED'
              : 'STABLE';

      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: true,
              data: {
                beforeRef,
                afterRef,
                beforeSha,
                afterSha,
                projectId,
                repoPath,
                changedFiles,
                nodesBefore,
                nodesAfter,
                newNodes,
                removedNodes,
                relationsBefore,
                relationsAfter,
                newRelations,
                removedRelations,
                healthStatus: diffHealthStatus,
                regressions,
              },
              meta: {
                operation: 'nexus.diff',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(
          `[nexus] Diff: ${beforeSha}..${afterSha}\n` +
            `  Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'n/a'}\n` +
            `  Nodes:     before=${nodesBefore}  after=${nodesAfter}  new=+${newNodes}  removed=-${removedNodes}\n` +
            `  Relations: before=${relationsBefore}  after=${relationsAfter}  new=+${newRelations}  removed=-${removedRelations}\n` +
            `  Health:    ${diffHealthStatus}\n`,
        );
        if (regressions.length > 0) {
          process.stdout.write('\n  REGRESSIONS:\n');
          for (const reg of regressions) {
            process.stdout.write(`    - ${reg}\n`);
          }
        } else {
          process.stdout.write('  No regressions detected.\n');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify(
            {
              success: false,
              error: { code: 'E_DIFF_FAILED', message: msg },
              meta: {
                operation: 'nexus.diff',
                duration_ms: durationMs,
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(`[nexus] Error running diff: ${msg}\n`);
      }
      process.exitCode = 1;
    }
  },
});

/**
 * Root nexus command group — registers all nexus subcommands.
 *
 * Dispatches to nexus domain registry operations.
 * @task T4554
 */
export const nexusCommand = defineCommand({
  meta: { name: 'nexus', description: 'Cross-project NEXUS operations' },
  subCommands: {
    init: initCommand,
    register: registerCommand,
    unregister: unregisterCommand,
    list: listCommand,
    status: statusCommand,
    show: showCommand,
    resolve: resolveCommand,
    discover: discoverCommand,
    search: searchCommand,
    deps: depsCommand,
    'critical-path': criticalPathCommand,
    blocking: blockingCommand,
    orphans: orphansCommand,
    sync: syncCommand,
    reconcile: reconcileCommand,
    graph: graphCommand,
    'share-status': shareStatusCommand,
    'transfer-preview': transferPreviewCommand,
    transfer: transferCommand,
    permission: permissionCommand,
    share: shareCommand,
    clusters: clustersCommand,
    flows: flowsCommand,
    context: contextCommand,
    impact: impactCommand,
    analyze: analyzeCommand,
    projects: projectsCommand,
    'refresh-bridge': refreshBridgeCommand,
    export: exportCommand,
    diff: diffCommand,
  },
});

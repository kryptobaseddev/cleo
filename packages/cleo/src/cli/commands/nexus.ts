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
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

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

/**
 * Register the nexus command group.
 * @task T4554
 */
export function registerNexusCommand(program: Command): void {
  const nexus = program.command('nexus').description('Cross-project NEXUS operations');

  // ── nexus init ──────────────────────────────────────────────────────

  nexus
    .command('init')
    .description('Initialize NEXUS directory structure and registry')
    .action(async () => {
      await dispatchFromCli('mutate', 'nexus', 'init', {}, { command: 'nexus' });
    });

  // ── nexus register ──────────────────────────────────────────────────

  nexus
    .command('register <path>')
    .description('Register a project in the global registry')
    .option('--name <name>', 'Custom project name (default: directory name)')
    .option('--permissions <perms>', 'Permissions: read|write|execute', 'read')
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'register',
        {
          path: projectPath,
          name: opts['name'] as string | undefined,
          permission: opts['permissions'] as string,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus unregister ────────────────────────────────────────────────

  nexus
    .command('unregister <nameOrHash>')
    .description('Remove a project from the registry')
    .action(async (nameOrHash: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'unregister',
        {
          name: nameOrHash,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus list ──────────────────────────────────────────────────────

  nexus
    .command('list')
    .description('List all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'list', {}, { command: 'nexus' });
    });

  // ── nexus status ────────────────────────────────────────────────────
  // Shows both NEXUS registry status AND code intelligence index freshness.
  // When invoked with a path, shows index freshness for that project.

  nexus
    .command('status [path]')
    .description(
      'Show code intelligence index freshness: file count, node/relation counts, last indexed time, stale files. Falls back to NEXUS registry status if code-intelligence index is unavailable.',
    )
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from path)')
    .option('--json', 'Output as JSON (LAFS envelope format)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
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
    });

  // ── nexus show ─────────────────────────────────────────────────────

  nexus
    .command('show <name>')
    .description('Show details for a registered project by name')
    .action(async (name: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'show',
        {
          name,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus resolve ───────────────────────────────────────────────────

  nexus
    .command('resolve <taskRef>')
    .alias('query')
    .description('Resolve a task reference across projects (project:T### or T###)')
    .action(async (taskRef: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'resolve',
        {
          query: taskRef,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus discover ──────────────────────────────────────────────────

  nexus
    .command('discover <taskQuery>')
    .description('Find related tasks across projects')
    .option('--method <method>', 'Discovery method: labels|description|files|auto', 'auto')
    .option('--limit <n>', 'Max results', parseInt, 10)
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'discover',
        {
          query: taskQuery,
          method: opts['method'] as string,
          limit: opts['limit'] as number,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus search ────────────────────────────────────────────────────

  nexus
    .command('search <pattern>')
    .description('Search tasks across projects by pattern')
    .option('--project <name>', 'Limit search to specific project')
    .option('--limit <n>', 'Max results', parseInt, 20)
    .action(async (pattern: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'search',
        {
          pattern,
          project: opts['project'] as string | undefined,
          limit: opts['limit'] as number,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus deps ──────────────────────────────────────────────────────

  nexus
    .command('deps <taskQuery>')
    .description('Show cross-project dependencies')
    .option('--reverse', 'Show reverse dependencies (what depends on this)')
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'deps',
        {
          query: taskQuery,
          direction: opts['reverse'] ? 'reverse' : 'forward',
        },
        { command: 'nexus' },
      );
    });

  // ── nexus critical-path ───────────────────────────────────────────

  nexus
    .command('critical-path')
    .description('Show global critical path across all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'path.show', {}, { command: 'nexus' });
    });

  // ── nexus blocking ────────────────────────────────────────────────

  nexus
    .command('blocking <taskQuery>')
    .description('Show blocking impact analysis for a task')
    .action(async (taskQuery: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'blockers.show',
        {
          query: taskQuery,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus orphans ─────────────────────────────────────────────────

  nexus
    .command('orphans')
    .description('Detect broken cross-project dependency references')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'orphans.list', {}, { command: 'nexus' });
    });

  // ── nexus sync ──────────────────────────────────────────────────────

  nexus
    .command('sync [project]')
    .description('Sync project metadata (task count, labels)')
    .action(async (project?: string) => {
      if (project) {
        await dispatchFromCli(
          'mutate',
          'nexus',
          'sync',
          {
            name: project,
          },
          { command: 'nexus' },
        );
      } else {
        await dispatchFromCli('mutate', 'nexus', 'sync', {}, { command: 'nexus' });
      }
    });

  // ── nexus reconcile ──────────────────────────────────────────────────

  nexus
    .command('reconcile')
    .description(
      'Reconcile current project with NEXUS registry (auto-register if new, update path if moved)',
    )
    .option('--path <path>', 'Project path (default: current directory)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'reconcile',
        {
          projectRoot: opts['path'] as string | undefined,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus graph ───────────────────────────────────────────────────

  nexus
    .command('graph')
    .description('Show full dependency graph across all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'graph', {}, { command: 'nexus' });
    });

  // ── nexus share-status ────────────────────────────────────────────

  nexus
    .command('share-status')
    .description('Show multi-contributor sharing status for the current project')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'share.status', {}, { command: 'nexus' });
    });

  // ── nexus transfer-preview ────────────────────────────────────────

  nexus
    .command('transfer-preview <taskIds...>')
    .description('Preview a task transfer between projects (dry-run, no changes made)')
    .requiredOption('--from <project>', 'Source project name')
    .requiredOption('--to <project>', 'Target project name')
    .option('--mode <mode>', 'Transfer mode: copy|move', 'copy')
    .option('--scope <scope>', 'Transfer scope: single|subtree', 'subtree')
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'transfer.preview',
        {
          taskIds,
          sourceProject: opts['from'] as string,
          targetProject: opts['to'] as string,
          mode: opts['mode'] as string,
          scope: opts['scope'] as string,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus transfer ────────────────────────────────────────────────

  nexus
    .command('transfer <taskIds...>')
    .description('Transfer tasks from one project to another')
    .requiredOption('--from <project>', 'Source project name')
    .requiredOption('--to <project>', 'Target project name')
    .option('--mode <mode>', 'Transfer mode: copy|move', 'copy')
    .option('--scope <scope>', 'Transfer scope: single|subtree', 'subtree')
    .option('--on-conflict <strategy>', 'Conflict strategy: rename|skip|duplicate|fail', 'rename')
    .option('--transfer-brain', 'Also transfer associated brain memory entries', false)
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'transfer',
        {
          taskIds,
          sourceProject: opts['from'] as string,
          targetProject: opts['to'] as string,
          mode: opts['mode'] as string,
          scope: opts['scope'] as string,
          onConflict: opts['onConflict'] as string,
          transferBrain: opts['transferBrain'] as boolean,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus permission ──────────────────────────────────────────────

  const permission = nexus
    .command('permission')
    .description('Manage permissions for registered projects');

  permission
    .command('set <name> <level>')
    .description('Set permission level for a registered project (read|write|execute)')
    .action(async (name: string, level: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'permission.set',
        {
          name,
          level,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus share ───────────────────────────────────────────────────

  const share = nexus.command('share').description('Multi-contributor sharing operations');

  share
    .command('export')
    .description('Export a snapshot of current project state for sharing')
    .option('--output <path>', 'Output file path (default: auto-generated in current directory)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'share.snapshot.export',
        {
          outputPath: opts['output'] as string | undefined,
        },
        { command: 'nexus' },
      );
    });

  share
    .command('import <file>')
    .description('Import a shared project snapshot')
    .action(async (file: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'share.snapshot.import',
        {
          inputPath: file,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus clusters ────────────────────────────────────────────────────────

  nexus
    .command('clusters [path]')
    .description('List all detected communities (Louvain clusters) from the last analysis')
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from path)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

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
    });

  // ── nexus flows ───────────────────────────────────────────────────────────

  nexus
    .command('flows [path]')
    .description('List all detected execution flows (processes) from the last analysis')
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from path)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

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

        const processes = rows.filter(
          (r) => r['kind'] === 'process' && r['projectId'] === projectId,
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
    });

  // ── nexus context ─────────────────────────────────────────────────────────

  nexus
    .command('context <symbol>')
    .description(
      'Show callers, callees, community membership, and process participation for a code symbol',
    )
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from cwd)')
    .option('--limit <n>', 'Max callers/callees to show per side', parseInt, 20)
    .action(async (symbolName: string, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = process.cwd();
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
      const limit = (opts['limit'] as number) ?? 20;

      try {
        const { getNexusDb, nexusSchema } = await import(
          '@cleocode/core/store/nexus-sqlite' as string
        );
        const db = await getNexusDb();

        // Find nodes matching the symbol name (case-insensitive partial match).
        // NodeSQLiteDatabase uses sync Drizzle — .all() returns a plain array.
        let allNodes: Array<Record<string, unknown>> = [];
        try {
          allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<
            Record<string, unknown>
          >;
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
                (r.community
                  ? `  Community: ${String(r.community.label ?? r.community.id)}\n`
                  : '') +
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
    });

  // ── nexus impact ──────────────────────────────────────────────────────────

  nexus
    .command('impact <symbol>')
    .description(
      'Show blast radius for a code symbol — direct callers (d=1), indirect callers (d=2), transitive (d=3)',
    )
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from cwd)')
    .option('--depth <n>', 'Maximum traversal depth (default: 3)', parseInt, 3)
    .action(async (symbolName: string, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = process.cwd();
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
      const maxDepth = Math.min((opts['depth'] as number) ?? 3, 5);

      try {
        const { getNexusDb, nexusSchema } = await import(
          '@cleocode/core/store/nexus-sqlite' as string
        );
        const db = await getNexusDb();

        // Load all nodes and relations for this project once.
        let allNodes: Array<Record<string, unknown>> = [];
        try {
          allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<
            Record<string, unknown>
          >;
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
              const label =
                i === 0 ? 'WILL BREAK' : i === 1 ? 'LIKELY AFFECTED' : 'MAY NEED TESTING';
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
    });

  // ── nexus analyze ─────────────────────────────────────────────────────────

  nexus
    .command('analyze [path]')
    .description('Run code intelligence pipeline on a repository directory')
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected)')
    .option('--incremental', 'Only re-index files that have changed since the last run (faster)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const isIncremental = !!opts['incremental'];

      // Resolve target path
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();

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
    });

  // ── nexus projects ────────────────────────────────────────────────────────
  // A focused subcommand group for the multi-project registry (T622).
  // Maps to the existing nexus.list / nexus.register / nexus.unregister
  // operations but adds richer output including db paths and index stats.

  const projects = nexus.command('projects').description('Multi-project registry management');

  projects
    .command('list')
    .description('List all projects registered in the global nexus registry')
    .option('--json', 'Output as JSON (LAFS envelope format)')
    .action(async (opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
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
          process.stdout.write(
            '[nexus] No projects registered. Run: cleo nexus projects register\n',
          );
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
    });

  projects
    .command('register [path]')
    .description('Register a project in the global nexus registry (default: current directory)')
    .option('--name <name>', 'Custom project name (default: directory name)')
    .option('--json', 'Output as JSON (LAFS envelope format)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
      const name = opts['name'] as string | undefined;

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
    });

  projects
    .command('remove <nameOrHash>')
    .alias('rm')
    .description('Remove a project from the global nexus registry')
    .option('--json', 'Output as JSON (LAFS envelope format)')
    .action(async (nameOrHash: string, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      try {
        const { nexusUnregister } = await import('@cleocode/core/internal' as string);
        await nexusUnregister(nameOrHash);
        const durationMs = Date.now() - startTime;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify(
              {
                success: true,
                data: { removed: nameOrHash },
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
          process.stdout.write(`[nexus] Removed: ${nameOrHash}\n`);
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
    });

  // ── nexus refresh-bridge ──────────────────────────────────────────────────

  nexus
    .command('refresh-bridge [path]')
    .description(
      'Regenerate .cleo/nexus-bridge.md from the existing nexus.db index (does not re-index)',
    )
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from path)')
    .action(async (targetPath: string | undefined, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const projectIdOverride = opts['projectId'] as string | undefined;
      const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

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
    });

  // ── nexus export ──────────────────────────────────────────────────────────

  /**
   * Export nexus graph to GEXF (Gephi) or JSON format.
   *
   * Queries graph_nodes and graph_edges from nexus.db and emits GEXF format
   * suitable for visualization in Gephi. Supports optional project filtering.
   *
   * @task T626-M7
   */
  nexus
    .command('export')
    .description('Export nexus graph to GEXF (Gephi) or JSON format')
    .option('--format <format>', 'Output format: gexf, json', 'gexf')
    .option('--output <file>', 'Output file path (stdout if omitted)')
    .option('--project <id>', 'Filter by project ID (exports all projects if omitted)')
    .action(async (opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const format = (opts['format'] as string) ?? 'gexf';
      const outputFile = opts['output'] as string | undefined;
      const projectFilter = opts['project'] as string | undefined;

      try {
        const { getNexusDb, nexusSchema } = await import(
          '@cleocode/core/store/nexus-sqlite' as string
        );
        const db = await getNexusDb();

        // Load all nodes and relations
        let allNodes: Array<Record<string, unknown>> = [];
        let allRelations: Array<Record<string, unknown>> = [];
        try {
          allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<
            Record<string, unknown>
          >;
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
          process.stderr.write(
            `[nexus] Error: Unknown format '${format}'. Supported: gexf, json\n`,
          );
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
    });

  // ── nexus diff ────────────────────────────────────────────────────────────

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
  nexus
    .command('diff')
    .description(
      'Compare NEXUS index state between two git commits — shows new/removed relations and broken call chains',
    )
    .option('--before <sha>', 'Git SHA or ref for the "before" snapshot (default: HEAD~1)')
    .option('--after <sha>', 'Git SHA or ref for the "after" snapshot (default: HEAD)', 'HEAD')
    .option('--path <dir>', 'Repository directory to analyze (default: cwd)')
    .option('--json', 'Output result as JSON (LAFS envelope format)')
    .option('--project-id <id>', 'Override the project ID (default: auto-detected from path)')
    .action(async (opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const jsonOutput = !!opts['json'];
      const repoPath = opts['path'] ? path.resolve(opts['path'] as string) : process.cwd();
      const projectIdOverride = opts['projectId'] as string | undefined;
      const projectId =
        projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
      const beforeRef = (opts['before'] as string | undefined) ?? 'HEAD~1';
      const afterRef = (opts['after'] as string | undefined) ?? 'HEAD';

      if (!jsonOutput) {
        process.stderr.write(
          `[nexus] Diffing relations: ${beforeRef}..${afterRef} in ${repoPath}\n`,
        );
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
    });
}

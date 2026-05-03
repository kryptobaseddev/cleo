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
 * All output routes through cliOutput() / cliError() — no raw stdout writes.
 *
 * @task T4554, T5323, T5330, T481, T534, T1720
 * @epic T4545
 */

import path from 'node:path';
import { generateGexf, getSymbolImpact } from '@cleocode/core/nexus';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { getFormatContext, setFormatContext } from '../format-context.js';
import { cliError, cliOutput } from '../renderers/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply per-command --json flag to the global format context.
 * When a command has its own --json flag, honour it by overriding the
 * singleton so that cliOutput() sees the correct format.
 */
function applyJsonFlag(jsonFlag: boolean | undefined): void {
  if (jsonFlag) {
    setFormatContext({ format: 'json', source: 'flag', quiet: false });
  }
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
    applyJsonFlag(args.json as boolean | undefined);
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const startTime = Date.now();

    try {
      // SSoT-EXEMPT:status-index-stats — getIndexStats requires direct pipeline access
      // with db handle + table refs; no dispatch op exposes this level of detail.
      // Dispatch 'nexus.status' is used as fallback on error (see catch block).
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

      cliOutput(
        { projectId, repoPath, ...stats },
        {
          command: 'nexus-status',
          operation: 'nexus.status',
          extensions: { duration_ms: durationMs },
        },
      );
    } catch (err) {
      // Fall back to NEXUS registry status on error
      const msg = err instanceof Error ? err.message : String(err);
      const ctx = getFormatContext();
      if (ctx.format === 'json') {
        cliError(msg, 1, { name: 'E_STATUS_FAILED' }, { operation: 'nexus.status' });
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

/**
 * cleo nexus augment — Symbol context augmentation for PreToolUse hooks.
 *
 * BM25-only search against nexus_nodes for pattern, returns top N symbols
 * with callers/callees/community metadata as plain text suitable for hook injection.
 *
 * @task T1061
 * @epic T1042
 */
const augmentCommand = defineCommand({
  meta: {
    name: 'augment',
    description: 'Augment symbol pattern with code context (for PreToolUse hooks)',
  },
  args: {
    pattern: {
      type: 'positional',
      description: 'Symbol name or file pattern to search',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Max results to return (default: 5)',
      default: '5',
    },
  },
  async run({ args }) {
    const pattern = args.pattern as string;
    const limit = parseInt(args.limit as string, 10) || 5;

    await dispatchFromCli(
      'query',
      'nexus',
      'augment',
      {
        pattern,
        limit,
      },
      { command: 'nexus' },
    );
  },
});

/**
 * cleo nexus setup — Install PreToolUse hook augmenter
 *
 * Writes ~/.cleo/hooks/nexus-augment.sh and registers it in CAAMP config.
 *
 * @task T1061
 * @epic T1042
 */
const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description: 'Install Nexus PreToolUse hook augmenter',
  },
  args: {},
  async run() {
    try {
      // SSoT-EXEMPT:cli-install — installs filesystem hook, not a domain operation.
      // Hook installation writes shell scripts to disk and cannot be a LAFS dispatch op.
      const { homedir } = await import('node:os');
      const { installNexusAugmentHook } = await import('@cleocode/core/internal');

      const homeDir = homedir();
      installNexusAugmentHook(homeDir);

      cliOutput({ homeDir }, { command: 'nexus-setup', operation: 'nexus.setup' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus setup] Error: ${msg}\n`);
      process.exitCode = 1;
    }
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('query', 'nexus', 'clusters', { projectId, repoPath });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CLUSTERS_FAILED' },
        { operation: 'nexus.clusters', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-clusters',
      operation: 'nexus.clusters',
      extensions: { duration_ms: durationMs },
    });
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
    json: { type: 'boolean', description: 'Output result as JSON (LAFS envelope format)' },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('query', 'nexus', 'flows', { projectId, repoPath });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_FLOWS_FAILED' },
        { operation: 'nexus.flows', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-flows',
      operation: 'nexus.flows',
      extensions: { duration_ms: durationMs },
    });
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
    symbol: { type: 'positional', description: 'Symbol name to look up', required: true },
    json: { type: 'boolean', description: 'Output result as JSON (LAFS envelope format)' },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from cwd)',
    },
    limit: { type: 'string', description: 'Max callers/callees to show per side', default: '20' },
    content: { type: 'boolean', description: 'Append source code content for the symbol' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const limit = parseInt(args.limit as string, 10);
    const symbolName = args.symbol as string;
    const showContent = !!args.content;
    const response = await dispatchRaw('query', 'nexus', 'context', {
      symbol: symbolName,
      projectId,
      limit,
      content: showContent,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CONTEXT_FAILED' },
        { operation: 'nexus.context', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    const result = response.data as { matchCount: number; results: unknown[] };
    if (result.matchCount === 0) {
      cliError(
        `No symbol found matching '${symbolName}' in project ${projectId}`,
        4,
        { name: 'E_NOT_FOUND' },
        { operation: 'nexus.context', duration_ms: durationMs },
      );
      process.exitCode = 4;
      return;
    }
    cliOutput({ ...result, _symbolName: symbolName } as Record<string, unknown>, {
      command: 'nexus-context',
      operation: 'nexus.context',
      extensions: { duration_ms: durationMs },
    });
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
    symbol: { type: 'positional', description: 'Symbol name to analyze', required: true },
    json: { type: 'boolean', description: 'Output result as JSON (LAFS envelope format)' },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from cwd)',
    },
    depth: { type: 'string', description: 'Maximum traversal depth (default: 3)', default: '3' },
    why: { type: 'boolean', description: 'Append reasons[] path-strings for each affected symbol' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const whyFlag = !!args.why;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const maxDepth = Math.min(parseInt(args.depth as string, 10), 5);
    const symbolName = args.symbol as string;
    try {
      // SSoT-EXEMPT:shape-mismatch — core NexusImpactResult (targetName/impactByDepth)
      // differs from contracts NexusImpactResult (targetNodeId/affected); routing through
      // dispatch.impact would require changing the output format. Tracked in T1510.
      const result = await getSymbolImpact(symbolName, projectId, repoPath, {
        maxDepth,
        why: whyFlag,
      });
      const durationMs = Date.now() - startTime;
      cliOutput({ ...result, _symbolName: symbolName, _why: whyFlag } as Record<string, unknown>, {
        command: 'nexus-impact',
        operation: 'nexus.impact',
        extensions: { duration_ms: durationMs },
      });
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err ? (err as { code?: string }).code : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      if (code === 'E_NOT_FOUND') {
        cliError(
          msg,
          4,
          { name: 'E_NOT_FOUND' },
          { operation: 'nexus.impact', duration_ms: durationMs },
        );
        process.exitCode = 4;
        return;
      }
      cliError(
        msg,
        1,
        { name: 'E_IMPACT_FAILED' },
        { operation: 'nexus.impact', duration_ms: durationMs },
      );
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const isIncremental = !!args.incremental;
    const ctx = getFormatContext();

    // Resolve target path
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();

    if (ctx.format !== 'json') {
      process.stderr.write(
        `[nexus] Analyzing: ${repoPath}${isIncremental ? ' (incremental)' : ''}\n`,
      );
    }

    try {
      // SSoT-EXEMPT:pipeline-progress — runPipeline requires a progress callback
      // (CLI-only rendering concern) and direct DB handle access. No dispatch op
      // can expose this without introducing CLI rendering concerns into the dispatch
      // layer. The full analyze pipeline is fundamentally CLI-side-orchestrated.
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
        if (ctx.format !== 'json') {
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
        ctx.format === 'json'
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
        if (ctx.format !== 'json') {
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
        if (ctx.format !== 'json') {
          process.stderr.write('[nexus] Project registered/updated in multi-project registry.\n');
        }
      } catch {
        // Non-fatal — registry update must never fail the analyze command
      }

      // Post-hook: sweep git log and link task IDs to symbols (best-effort, idempotent)
      try {
        const { runGitLogTaskLinker } = await import('@cleocode/core/nexus' as string);
        const sweeperResult = await runGitLogTaskLinker(repoPath);
        // Diagnostic stderr message — emit unconditionally regardless of
        // ctx.format. Stderr does NOT pollute --json stdout (separate stream)
        // and sandbox/CI assertions parse the combined stdout+stderr stream.
        // Removing this conditional preserves pre-W4 behavior the
        // living-brain-e2e scenario depends on.
        if (sweeperResult.commitsProcessed > 0) {
          process.stderr.write(
            `[nexus] Task-symbol sweep: ${sweeperResult.commitsProcessed} commit(s), ${sweeperResult.tasksFound} task(s), ${sweeperResult.linked} edge(s) linked.\n`,
          );
        }
      } catch {
        // Non-fatal — task sweeper failure must never fail the analyze command
      }

      cliOutput(
        {
          projectId,
          repoPath,
          incremental: isIncremental,
          nodeCount: result.nodeCount,
          relationCount: result.relationCount,
          fileCount: result.fileCount,
          durationMs,
        },
        {
          command: 'nexus-analyze',
          operation: 'nexus.analyze',
          extensions: { duration_ms: durationMs },
        },
      );

      void getProjectRoot; // referenced to satisfy import
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cliError(
        msg,
        1,
        { name: 'E_PIPELINE_FAILED' },
        { operation: 'nexus.analyze', duration_ms: Date.now() - startTime },
      );
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'projects.list', {});
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      process.stderr.write(`[nexus] Error: ${response.error?.message ?? 'Unknown error'}\n`);
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-projects-list',
      operation: 'nexus.projects.list',
      extensions: { duration_ms: durationMs },
    });
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const name = args.name as string | undefined;

    const response = await dispatchRaw('mutate', 'nexus', 'projects.register', {
      path: repoPath,
      name,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_REGISTER_FAILED' },
        { operation: 'nexus.projects.register', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-projects-register',
      operation: 'nexus.projects.register',
      extensions: { duration_ms: durationMs },
    });
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const response = await dispatchRaw('mutate', 'nexus', 'projects.remove', {
      nameOrHash: args.nameOrHash,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_REMOVE_FAILED' },
        { operation: 'nexus.projects.remove', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), nameOrHash: args.nameOrHash },
      {
        command: 'nexus-projects-remove',
        operation: 'nexus.projects.remove',
        extensions: { duration_ms: durationMs },
      },
    );
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
    json: { type: 'boolean', description: 'Output as JSON (LAFS envelope format)' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const autoRegister = !!args['auto-register'];
    const includeExisting = !!args['include-existing'];
    const maxDepth = Math.max(1, Math.min(parseInt(args['max-depth'] as string, 10), 20));
    const ctx = getFormatContext();
    if (ctx.format !== 'json') {
      process.stderr.write(
        `[nexus] Scanning up to depth ${maxDepth} for .cleo/ project roots...\n`,
      );
    }
    const response = await dispatchRaw('mutate', 'nexus', 'projects.scan', {
      roots: args.roots as string | undefined,
      maxDepth,
      autoRegister,
      includeExisting,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      process.stderr.write(`[nexus] Error: ${response.error?.message ?? 'Unknown error'}\n`);
      process.exitCode = 1;
      return;
    }
    cliOutput(
      {
        ...((response.data as Record<string, unknown>) ?? {}),
        _maxDepth: maxDepth,
        _autoRegister: autoRegister,
        _includeExisting: includeExisting,
      },
      {
        command: 'nexus-projects-scan',
        operation: 'nexus.projects.scan',
        extensions: { duration_ms: durationMs },
      },
    );
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const dryRun = !!args['dry-run'];
    const skipPrompt = !!args.yes;
    const ctx = getFormatContext();

    const cleanOpts = {
      pattern: args.pattern as string | undefined,
      includeTemp: !!args['include-temp'],
      includeTests: !!args['include-tests'],
      matchUnhealthy: !!args.unhealthy,
      matchNeverIndexed: !!args['never-indexed'],
    };

    try {
      // Preview phase via dispatch (always dry-run first to get counts)
      const previewResp = await dispatchRaw('mutate', 'nexus', 'projects.clean', {
        ...cleanOpts,
        dryRun: true,
      });
      if (!previewResp.success) {
        const code = previewResp.error?.code ?? 'E_CLEAN_FAILED';
        const msg = previewResp.error?.message ?? 'Unknown error';
        const exitCode = code === 'E_NO_CRITERIA' || code === 'E_INVALID_PATTERN' ? 6 : 1;
        cliError(
          msg,
          exitCode,
          { name: code },
          { operation: 'nexus.projects.clean', duration_ms: Date.now() - startTime },
        );
        process.exitCode = exitCode;
        return;
      }
      const preview = previewResp.data as { matched: number; totalCount: number; sample: string[] };
      const { matched: matchCount, totalCount, sample: samplePaths } = preview;

      // Show preview in human mode
      if (ctx.format !== 'json') {
        cliOutput(
          { matched: matchCount, totalCount, sample: samplePaths },
          { command: 'nexus-projects-clean', operation: 'nexus.projects.clean' },
        );
      }

      if (matchCount === 0 || dryRun) {
        const durationMs = Date.now() - startTime;
        cliOutput(
          {
            dryRun: true,
            matched: matchCount,
            purged: 0,
            remaining: totalCount,
            sample: samplePaths,
          },
          {
            command: 'nexus-projects-clean',
            operation: 'nexus.projects.clean',
            extensions: { duration_ms: durationMs },
          },
        );
        return;
      }

      // Confirmation prompt (skip with --yes) — CLI-side interactive stdin
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
          cliOutput(
            { aborted: true, message: 'No projects deleted.' },
            { command: 'nexus-projects-clean', operation: 'nexus.projects.clean' },
          );
          return;
        }
      }

      // Actual delete via dispatch
      const deleteResp = await dispatchRaw('mutate', 'nexus', 'projects.clean', {
        ...cleanOpts,
        dryRun: false,
      });
      const durationMs = Date.now() - startTime;
      if (!deleteResp.success) {
        const code = deleteResp.error?.code ?? 'E_CLEAN_FAILED';
        const msg = deleteResp.error?.message ?? 'Unknown error';
        const exitCode = code === 'E_NO_CRITERIA' || code === 'E_INVALID_PATTERN' ? 6 : 1;
        cliError(
          msg,
          exitCode,
          { name: code },
          { operation: 'nexus.projects.clean', duration_ms: durationMs },
        );
        process.exitCode = exitCode;
        return;
      }
      const result = deleteResp.data as {
        matched: number;
        purged: number;
        remaining: number;
        sample: string[];
      };
      cliOutput(
        {
          dryRun: false,
          matched: result.matched,
          purged: result.purged,
          remaining: result.remaining,
          sample: result.sample,
        },
        {
          command: 'nexus-projects-clean',
          operation: 'nexus.projects.clean',
          extensions: { duration_ms: durationMs },
        },
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      cliError(
        msg,
        1,
        { name: 'E_CLEAN_FAILED' },
        { operation: 'nexus.projects.clean', duration_ms: durationMs },
      );
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

    const response = await dispatchRaw('mutate', 'nexus', 'refresh-bridge', {
      repoPath,
      projectId,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_BRIDGE_FAILED' },
        { operation: 'nexus.refresh-bridge', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-refresh-bridge',
      operation: 'nexus.refresh-bridge',
      extensions: { duration_ms: durationMs },
    });
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
      // SSoT-EXEMPT:file-serialization — GEXF/JSON graph export writes raw bytes
      // to stdout/file; requires direct nexus.db access for node/relation queries.
      // Cannot be a standard LAFS dispatch envelope without binary data concerns.
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
        const durationMs = Date.now() - startTime;
        cliOutput(
          { outputFile, nodeCount: nodes.length, edgeCount: relations.length },
          {
            command: 'nexus-export',
            operation: 'nexus.export',
            extensions: { duration_ms: durationMs },
          },
        );
        process.stderr.write(`[nexus] Export completed in ${durationMs}ms\n`);
      } else {
        // Raw file output — write directly to stdout (binary/text graph data)
        process.stdout.write(output);
        if (!output.endsWith('\n')) process.stdout.write('\n');
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
    path: { type: 'string', description: 'Repository directory to analyze (default: cwd)' },
    json: { type: 'boolean', description: 'Output result as JSON (LAFS envelope format)' },
    'project-id': {
      type: 'string',
      description: 'Override the project ID (default: auto-detected from path)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectIdOverride = args['project-id'] as string | undefined;
    const beforeRef = (args.before as string | undefined) ?? 'HEAD~1';
    const afterRef = (args.after as string | undefined) ?? 'HEAD';
    const ctx = getFormatContext();
    if (ctx.format !== 'json') {
      process.stderr.write(`[nexus] Diffing relations: ${beforeRef}..${afterRef} in ${repoPath}\n`);
    }
    const response = await dispatchRaw('query', 'nexus', 'diff', {
      repoPath,
      beforeRef,
      afterRef,
      projectId: projectIdOverride,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_DIFF_FAILED' },
        { operation: 'nexus.diff', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-diff',
      operation: 'nexus.diff',
      extensions: { duration_ms: durationMs },
    });
  },
});

/**
 * cleo nexus query — Execute recursive CTE queries against nexus.db
 *
 * Supports raw CTE syntax and 6 template aliases for common code intelligence patterns.
 * Results returned as markdown table.
 *
 * @task T1057
 */
const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description: 'Execute recursive CTE queries against nexus.db',
  },
  args: {
    cte: {
      type: 'positional',
      description:
        'CTE SQL or template alias (callers-of, callees-of, co-changed, co-cited, path-between, community-members)',
      required: true,
    },
    params: {
      type: 'string',
      description: 'Comma-separated parameters (e.g., "sym-id-1,sym-id-2")',
    },
  },
  async run({ args }) {
    const cteOrAlias = args.cte as string;
    const paramsStr = (args.params as string) || '';
    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'query-cte', {
      cte: cteOrAlias,
      params,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const code = response.error?.code;
      const msg = response.error?.message ?? 'Unknown error';
      const exitCode = code === 'E_INVALID_INPUT' ? 6 : 77;
      process.stderr.write(`[nexus] Error: ${msg}\n`);
      process.exitCode = exitCode;
      return;
    }
    const result = response.data as {
      success: boolean;
      rows: Array<Record<string, unknown>>;
      row_count: number;
      execution_time_ms: number;
      error?: string;
    };
    if (!result.success) {
      process.stderr.write(`[nexus] Query error: ${result.error ?? 'Unknown'}\n`);
      process.exitCode = 77;
      return;
    }
    // Format as markdown table using the DSL formatter
    const { formatCteResultAsMarkdown } = await import(
      '@cleocode/core/nexus/query-dsl.js' as string
    );
    const markdown = (formatCteResultAsMarkdown as (r: typeof result) => string)(result);
    cliOutput(
      { ...result, _markdown: markdown },
      {
        command: 'nexus-query',
        operation: 'nexus.query-cte',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/**
 * cleo nexus route-map — Display all routes with their handlers and dependencies.
 */
const routeMapCommand = defineCommand({
  meta: {
    name: 'route-map',
    description: 'Display all routes with their handlers and dependencies',
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('query', 'nexus', 'route-map', { projectId });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_ROUTE_MAP_FAILED' },
        { operation: 'nexus.route-map', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _projectId: projectId },
      {
        command: 'nexus-route-map',
        operation: 'nexus.route-map',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/**
 * cleo nexus shape-check — Check response shape compatibility for a route.
 */
const shapeCheckCommand = defineCommand({
  meta: {
    name: 'shape-check',
    description: 'Check response shape compatibility for a route handler',
  },
  args: {
    routeSymbol: {
      type: 'positional',
      description: 'Route symbol ID (format: <filePath>::<routeName>)',
      required: true,
    },
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
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const routeSymbol = args.routeSymbol as string;
    const projectIdOverride = args['project-id'] as string | undefined;
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('query', 'nexus', 'shape-check', { routeSymbol, projectId });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_SHAPE_CHECK_FAILED' },
        { operation: 'nexus.shape-check', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _routeSymbol: routeSymbol },
      {
        command: 'nexus-shape-check',
        operation: 'nexus.shape-check',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/**
 * Root nexus command group — registers all nexus subcommands.
 *
 * Dispatches to nexus domain registry operations.
 * @task T4554
 */

// ---------------------------------------------------------------------------
// Living Brain traversal commands (T1068)
// ---------------------------------------------------------------------------

/** cleo nexus full-context — show all 5-substrate context for a code symbol */
const fullContextCommand = defineCommand({
  meta: {
    name: 'full-context',
    description:
      'Show full Living Brain context for a symbol: NEXUS callers/callees, BRAIN memories, TASKS, sentient proposals, conduit threads',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or nexus node ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const symbolId = args.symbol as string;
    const response = await dispatchRaw('query', 'nexus', 'full-context', { symbol: symbolId });
    if (!response.success) {
      process.stderr.write(
        `[nexus] Error running full-context: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-full-context',
        operation: 'nexus.full-context',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo nexus task-footprint — show full code impact for a task */
const taskFootprintCommand = defineCommand({
  meta: {
    name: 'task-footprint',
    description:
      'Show full code impact of a task: files, symbols, blast radius, brain observations, decisions, risk tier',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID (e.g., T001)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const taskId = args.taskId as string;
    const response = await dispatchRaw('query', 'nexus', 'task-footprint', { taskId });
    if (!response.success) {
      process.stderr.write(
        `[nexus] Error running task-footprint: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-task-footprint',
        operation: 'nexus.task-footprint',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo nexus brain-anchors — show code anchors for a brain memory entry */
const brainAnchorsCommand = defineCommand({
  meta: {
    name: 'brain-anchors',
    description:
      'Show code anchors for a brain memory entry: linked nexus nodes, tasks that touched them, plasticity signal',
  },
  args: {
    entryId: {
      type: 'positional',
      description: 'Brain entry node ID (e.g., observation:abc123)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const entryId = args.entryId as string;
    const response = await dispatchRaw('query', 'nexus', 'brain-anchors', { entryId });
    if (!response.success) {
      process.stderr.write(
        `[nexus] Error running brain-anchors: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-brain-anchors',
        operation: 'nexus.brain-anchors',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

// ---------------------------------------------------------------------------
// Extended Code Reasoning commands (T1069)
// ---------------------------------------------------------------------------

/** cleo nexus why <symbol> — trace why a code symbol is structured this way */
const whyCommand = defineCommand({
  meta: {
    name: 'why',
    description:
      'Trace why a code symbol is structured this way: walks BRAIN decisions, observations, and tasks via code_reference+documents+applies_to edges',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or nexus node ID to trace',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const symbolId = args.symbol as string;
    const response = await dispatchRaw('query', 'nexus', 'why', { symbol: symbolId });
    if (!response.success) {
      process.stderr.write(
        `[nexus] Error running why: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      { command: 'nexus-why', operation: 'nexus.why', extensions: { duration_ms: durationMs } },
    );
  },
});

/** cleo nexus impact-full <symbol> — merged structural + task + brain impact report */
const impactFullCommand = defineCommand({
  meta: {
    name: 'impact-full',
    description:
      'Full merged impact report for a code symbol: structural blast radius + open tasks + brain risk notes',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or nexus node ID to analyze',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const symbolId = args.symbol as string;
    const response = await dispatchRaw('query', 'nexus', 'impact-full', { symbol: symbolId });
    if (!response.success) {
      process.stderr.write(
        `[nexus] Error running impact-full: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-impact-full',
        operation: 'nexus.impact-full',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T1071 — conduit-scan: link conduit messages to nexus symbols
// ---------------------------------------------------------------------------

/**
 * cleo nexus conduit-scan — Scan conduit messages and link them to nexus symbols.
 *
 * Writes `conduit_mentions_symbol` edges to brain_page_edges (idempotent).
 * Gracefully no-ops when conduit.db or nexus.db is absent.
 *
 * @task T1071
 * @epic T1042
 */
const conduitScanCommand = defineCommand({
  meta: {
    name: 'conduit-scan',
    description:
      'Scan conduit messages for symbol mentions and link them to nexus nodes (conduit_mentions_symbol edges)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const response = await dispatchRaw('mutate', 'nexus', 'conduit-scan', {});
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CONDUIT_SCAN_FAILED' },
        { operation: 'nexus.conduit-scan', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-conduit-scan',
        operation: 'nexus.conduit-scan',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T1067 — task-symbols: show symbols touched by a task
// ---------------------------------------------------------------------------

/**
 * cleo nexus task-symbols <taskId> — Show code symbols touched by a task.
 *
 * Forward-lookup (task → symbols) via task_touches_symbol edges.
 *
 * @task T1067
 * @epic T1042
 */
const taskSymbolsCommand = defineCommand({
  meta: {
    name: 'task-symbols',
    description: 'Show code symbols touched by a task (task_touches_symbol forward-lookup)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID (e.g., T001)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const taskId = args.taskId as string;
    const response = await dispatchRaw('query', 'nexus', 'task-symbols', { taskId });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_TASK_SYMBOLS_FAILED' },
        { operation: 'nexus.task-symbols', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    const data = response.data as {
      taskId: string;
      count: number;
      symbols: Array<{ kind: string; label: string; weight: number; matchStrategy: string }>;
    };
    cliOutput(
      { taskId, count: data.symbols.length, symbols: data.symbols, _durationMs: durationMs },
      {
        command: 'nexus-task-symbols',
        operation: 'nexus.task-symbols',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T1058 — search-code: BM25 code symbol search against nexus.db
// ---------------------------------------------------------------------------

/**
 * cleo nexus search-code <query> — BM25 search of code symbols in nexus.db.
 *
 * Uses the same BM25 index as the augment hook. Returns symbol names, kinds,
 * file paths, and relevance scores.
 *
 * @task T1058
 * @epic T1042
 */
const searchCodeCommand = defineCommand({
  meta: {
    name: 'search-code',
    description: 'BM25 search of code symbols in nexus.db (augment BM25 index)',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query (symbol name, file pattern, or keyword)',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Max results (default: 10)',
      default: '10',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const query = args.query as string;
    const limit = parseInt(args.limit as string, 10) || 10;

    await dispatchFromCli(
      'query',
      'nexus',
      'augment',
      { pattern: query, limit },
      { command: 'nexus' },
    );

    const durationMs = Date.now() - startTime;
    const ctx = getFormatContext();
    if (ctx.format !== 'json') {
      cliOutput(
        { _durationMs: durationMs },
        { command: 'nexus-search-code', operation: 'nexus.search-code' },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T1065 — contracts: contract extraction and compatibility commands
// ---------------------------------------------------------------------------

/** cleo nexus contracts sync — extract and store contracts from current project */
const contractsSyncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Extract contracts (HTTP/gRPC/topic) from the current project and store them',
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
      description: 'Override the project ID (default: auto-detected)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectIdOverride = args['project-id'] as string | undefined;
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('mutate', 'nexus', 'contracts-sync', {
      projectId,
      repoPath,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CONTRACTS_SYNC_FAILED' },
        { operation: 'nexus.contracts.sync', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-contracts-sync',
        operation: 'nexus.contracts.sync',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo nexus contracts show — show contract compatibility between two projects */
const contractsShowCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show contract compatibility matrix between two registered projects',
  },
  args: {
    'project-a': {
      type: 'string',
      description: 'First project name or ID',
      required: true,
    },
    'project-b': {
      type: 'string',
      description: 'Second project name or ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const projectA = args['project-a'] as string;
    const projectB = args['project-b'] as string;
    const response = await dispatchRaw('query', 'nexus', 'contracts-show', { projectA, projectB });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CONTRACTS_SHOW_FAILED' },
        { operation: 'nexus.contracts.show', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      {
        ...((response.data as Record<string, unknown>) ?? {}),
        _projectA: projectA,
        _projectB: projectB,
        _durationMs: durationMs,
      },
      {
        command: 'nexus-contracts-show',
        operation: 'nexus.contracts.show',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo nexus contracts link-tasks — link contracts to tasks via task_touches_symbol edges */
const contractsLinkTasksCommand = defineCommand({
  meta: {
    name: 'link-tasks',
    description: 'Link extracted contracts to tasks that touch their source symbols',
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
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectId = Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const response = await dispatchRaw('mutate', 'nexus', 'contracts-link-tasks', {
      projectId,
      repoPath,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const msg = response.error?.message ?? 'Unknown error';
      cliError(
        msg,
        1,
        { name: response.error?.code ?? 'E_CONTRACTS_LINK_FAILED' },
        { operation: 'nexus.contracts.link-tasks', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'nexus-contracts-link-tasks',
        operation: 'nexus.contracts.link-tasks',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo nexus contracts — contract extraction and compatibility operations */
const contractsCommand = defineCommand({
  meta: { name: 'contracts', description: 'Contract extraction and compatibility operations' },
  subCommands: {
    sync: contractsSyncCommand,
    show: contractsShowCommand,
    'link-tasks': contractsLinkTasksCommand,
  },
});

/** cleo nexus group — alias for contracts subcommand (spec parity: T1114) */
const groupCommand = defineCommand({
  meta: {
    name: 'group',
    description: 'Contract extraction and compatibility operations (alias for contracts)',
  },
  subCommands: {
    sync: contractsSyncCommand,
    show: contractsShowCommand,
    'link-tasks': contractsLinkTasksCommand,
  },
});

/** cleo nexus wiki — community-grouped wiki index with optional LOOM LLM summaries */
const wikiCommand = defineCommand({
  meta: {
    name: 'wiki',
    description: 'Generate community-grouped wiki index from nexus code graph',
  },
  args: {
    output: {
      type: 'string',
      description: 'Output directory for wiki files (default: .cleo/wiki)',
      alias: 'o',
    },
    community: {
      type: 'string',
      description: 'Filter generation to a single community ID (e.g. "community:3")',
      alias: 'c',
    },
    incremental: {
      type: 'boolean',
      description:
        'Only regenerate communities whose symbols changed since last wiki run (uses .cleo/wiki-state.json)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const outputDir =
      (args.output as string | undefined) ?? path.join(process.cwd(), '.cleo', 'wiki');
    const communityFilter = (args.community as string | undefined) ?? undefined;
    const isIncremental = !!(args.incremental as boolean | undefined);

    // SSoT-EXEMPT:loom-provider — LLM backend resolution for wiki generation requires
    // CLI-side async provider wiring that cannot be passed through the dispatch layer.
    // The dispatch 'wiki' op always uses loomProvider=null (scaffold mode). CLI-side
    // wiring enables real LLM narratives when a backend is available.
    // Resolve LOOM provider via the existing LLM backend resolver (warm tier).
    // Falls back gracefully — null means scaffold mode.
    // The 'ai' package lives in @cleocode/core's deps; we load it transitively.
    let loomProvider: ((prompt: string) => Promise<string>) | null = null;
    try {
      const { resolveLlmBackend } = await import('@cleocode/core/memory/llm-backend-resolver.js');
      const backend = await resolveLlmBackend('warm');
      if (backend !== null && backend.name !== 'transformers') {
        // Wire as a simple text-completion function using the 'ai' package
        // loaded via @cleocode/core's node_modules (avoids duplicate dep in cleo).
        loomProvider = async (prompt: string): Promise<string> => {
          // Dynamic import at call time to avoid top-level resolution in cleo
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const aiMod = await import('ai' as string);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const generateTextFn = aiMod.generateText as (opts: {
            model: unknown;
            prompt: string;
            maxTokens: number;
          }) => Promise<{ text: string }>;
          const { text } = await generateTextFn({
            model: backend.model,
            prompt,
            maxTokens: 256,
          });
          return text;
        };
      }
    } catch {
      // LOOM unavailable — scaffold mode (logged inside generateNexusWikiIndex)
      loomProvider = null;
    }

    try {
      // SSoT-EXEMPT:loom-provider — must call generateNexusWikiIndex directly to pass
      // loomProvider. The dispatch 'wiki' op does not accept a loomProvider param.
      const { generateNexusWikiIndex } = await import(
        '@cleocode/core/nexus/wiki-index.js' as string
      );
      const result = await generateNexusWikiIndex(outputDir, process.cwd(), {
        communityFilter,
        incremental: isIncremental,
        loomProvider,
        projectRoot: process.cwd(),
      });
      const durationMs = Date.now() - startTime;

      if (!result.success) {
        process.stderr.write(`[nexus] wiki generation failed: ${result.error}\n`);
        process.exitCode = 1;
        return;
      }

      cliOutput(
        { ...result, _outputDir: outputDir, _durationMs: durationMs },
        { command: 'nexus-wiki', operation: 'nexus.wiki', extensions: { duration_ms: durationMs } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cliError(
        msg,
        1,
        { name: 'E_WIKI_GENERATION_FAILED' },
        { operation: 'nexus.wiki', duration_ms: Date.now() - startTime },
      );
      process.exitCode = 1;
    }
  },
});

// ---------------------------------------------------------------------------
// T1108 — Plasticity Query Commands (hot-paths, hot-nodes, cold-symbols)
// ---------------------------------------------------------------------------

/**
 * cleo nexus hot-paths — List highest-weight relation edges (Hebbian plasticity).
 *
 * Reads nexus_relations ORDER BY weight DESC, co_accessed_count DESC.
 * If no dream cycle has run yet (all weights 0), prints an informational
 * note and exits cleanly with an empty table.
 *
 * @task T1108
 */
const hotPathsCommand = defineCommand({
  meta: {
    name: 'hot-paths',
    description: 'List highest-weight relation edges by Hebbian plasticity weight',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of edges to return (default: 20)',
      default: '20',
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON',
      default: false,
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const startTime = Date.now();

    const response = await dispatchRaw('query', 'nexus', 'hot-paths', { limit });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      process.stderr.write(
        `[nexus hot-paths] Error: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-hot-paths',
      operation: 'nexus.hot-paths',
      extensions: { duration_ms: durationMs },
    });
  },
});

/**
 * cleo nexus hot-nodes — List nodes with the highest aggregate Hebbian weight.
 *
 * Aggregates SUM(weight) per source node in nexus_relations, then joins
 * nexus_nodes for label/kind/file. If no dream cycle has run yet the table
 * is empty and an informational note is printed.
 *
 * @task T1108
 */
const hotNodesCommand = defineCommand({
  meta: {
    name: 'hot-nodes',
    description: 'List symbols with highest aggregate Hebbian weight',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of nodes to return (default: 20)',
      default: '20',
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON',
      default: false,
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const startTime = Date.now();

    const response = await dispatchRaw('query', 'nexus', 'hot-nodes', { limit });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      process.stderr.write(
        `[nexus hot-nodes] Error: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-hot-nodes',
      operation: 'nexus.hot-nodes',
      extensions: { duration_ms: durationMs },
    });
  },
});

/**
 * cleo nexus cold-symbols — List symbols that have gone cold.
 *
 * Returns symbols whose most-recent access (max last_accessed_at across
 * incident edges) is older than `--days` ago AND max weight < 0.1.
 * If last_accessed_at is NULL for all incident edges (no dream cycle run)
 * those symbols are included as infinitely cold.
 *
 * @task T1108
 */
const coldSymbolsCommand = defineCommand({
  meta: {
    name: 'cold-symbols',
    description: 'List cold symbols (stale access + low weight) for pruning candidates',
  },
  args: {
    days: {
      type: 'string',
      description: 'Age threshold in days (default: 30)',
      default: '30',
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON',
      default: false,
    },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const thresholdDays = Number.parseInt(args.days as string, 10) || 30;
    const startTime = Date.now();

    const response = await dispatchRaw('query', 'nexus', 'cold-symbols', { days: thresholdDays });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      process.stderr.write(
        `[nexus cold-symbols] Error: ${response.error?.message ?? 'Unknown error'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'nexus-cold-symbols',
      operation: 'nexus.cold-symbols',
      extensions: { duration_ms: durationMs },
    });
  },
});

/**
 * cleo nexus top-entries — List top-weighted symbols from nexus_relations.
 *
 * Returns the highest-weighted source nodes from the Hebbian plasticity
 * relation graph (T998). Each entry is aggregated SUM(weight) per source_id
 * joined with nexus_nodes for label / kind / file-path. Supports optional
 * `--kind` filter (e.g. function, method, class) and `--limit` (default 20).
 *
 * Routes through the dispatch layer so all transports (CLI, TUI, agents) see
 * the same LAFS envelope shape (see `handleTopEntries` in
 * `packages/cleo/src/dispatch/domains/nexus.ts`).
 *
 * @task T1013
 * @epic T1006
 */
// ── T1386: sigil sync + list ─────────────────────────────────────────

/** cleo nexus sigil sync — populate sigils table from canonical CANT agents */
const sigilSyncCommand = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Populate the nexus.db sigils table with one row per canonical CANT agent (cleo-subagent + 5 seed roles + 2 meta agents). Idempotent.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON (LAFS envelope format)',
    },
  },
  async run() {
    await dispatchFromCli('mutate', 'nexus', 'sigil.sync', {}, { command: 'nexus' });
  },
});

/** cleo nexus sigil list — list every sigil currently stored in nexus.db */
const sigilListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List every sigil currently stored in nexus.db, optionally filtered by role.',
  },
  args: {
    role: {
      type: 'string',
      description:
        'Filter by role (e.g. "orchestrator", "lead", "worker", "specialist", "subagent")',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'sigil.list',
      { role: args.role as string | undefined },
      { command: 'nexus' },
    );
  },
});

/** cleo nexus sigil — group alias for `sync` and `list`. */
const sigilCommand = defineCommand({
  meta: {
    name: 'sigil',
    description:
      'Sigil (peer-card) operations — sync from canonical CANT agents, list current rows',
  },
  subCommands: {
    sync: sigilSyncCommand,
    list: sigilListCommand,
  },
});

const topEntriesCommand = defineCommand({
  meta: {
    name: 'top-entries',
    description: 'List top-weighted symbols from nexus_relations by weight DESC',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of entries to return (default: 20)',
      default: '20',
    },
    kind: {
      type: 'string',
      description:
        'Filter by nexus_nodes.kind (e.g. function, method, class, interface, type_alias)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope format)',
    },
  },
  async run({ args }) {
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const kind = (args.kind as string | undefined) ?? undefined;
    const jsonOutput = !!args.json;
    const params: Record<string, unknown> = { limit };
    if (kind !== undefined && kind.length > 0) params.kind = kind;
    await dispatchFromCli('query', 'nexus', 'top-entries', params, {
      command: 'nexus',
      operation: 'nexus.top-entries',
      ...(jsonOutput ? { json: true } : {}),
    });
  },
});

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
    augment: augmentCommand,
    setup: setupCommand,
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
    query: queryCommand,
    projects: projectsCommand,
    'refresh-bridge': refreshBridgeCommand,
    export: exportCommand,
    diff: diffCommand,
    'route-map': routeMapCommand,
    'shape-check': shapeCheckCommand,
    'full-context': fullContextCommand,
    'task-footprint': taskFootprintCommand,
    'brain-anchors': brainAnchorsCommand,
    why: whyCommand,
    'impact-full': impactFullCommand,
    // T1071 — conduit scan
    'conduit-scan': conduitScanCommand,
    // T1067 — task symbols
    'task-symbols': taskSymbolsCommand,
    // T1058 — code symbol search
    'search-code': searchCodeCommand,
    // T1065 — contract registry
    contracts: contractsCommand,
    // T1114 — group alias for contracts
    group: groupCommand,
    // T1060 — wiki index
    wiki: wikiCommand,
    // T1108 — plasticity queries
    'hot-paths': hotPathsCommand,
    'hot-nodes': hotNodesCommand,
    'cold-symbols': coldSymbolsCommand,
    // T1013 / T1006 — top-weighted symbols by nexus_relations.weight
    'top-entries': topEntriesCommand,
    // T1386 — sigil sync + list (canonical CANT agent peer cards)
    sigil: sigilCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

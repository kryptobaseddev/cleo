/**
 * CLI `cleo graph` command group — project-scoped code intelligence operations.
 *
 * Wave 3 of the Nexus Restructure (T9147). Introduces `cleo graph` as a new
 * first-class top-level for ~27 project-scoped + 5 living-brain ops, narrowing
 * `cleo nexus` to cross-project / hybrid / global-infra work only.
 *
 * Sub-namespaces:
 *   `cleo graph <op>`         — project-scoped code graph queries and mutations
 *   `cleo graph living <op>`  — ops that bridge the code graph + BRAIN (living-brain)
 *
 * The dispatch layer is unchanged — all ops still route through the `nexus`
 * dispatch domain. The split is purely at the CLI level.
 *
 * Alias shims for old `cleo nexus <project-verb>` commands are registered in
 * nexus.ts and emit `meta.deprecated` + telemetry to the XDG state dir.
 *
 * @task T9147
 * @epic T9144
 */

import path from 'node:path';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { getFormatContext, setFormatContext } from '../format-context.js';
import { cliError, cliOutput, humanWarn } from '../renderers/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Apply per-command --json flag to the global format context. */
function applyJsonFlag(jsonFlag: boolean | undefined): void {
  if (jsonFlag) {
    setFormatContext({ format: 'json', source: 'flag', quiet: false });
  }
}

// ── Project-scoped subcommands ────────────────────────────────────────────────

/** cleo graph status — show code intelligence index freshness */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show code intelligence index freshness: file count, node/relation counts, last indexed time.',
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

      const stats = await (getIndexStats as (...a: unknown[]) => Promise<Record<string, unknown>>)(
        projectId,
        repoPath,
        db,
        tables,
      );
      const durationMs = Date.now() - startTime;

      cliOutput(
        { projectId, repoPath, ...stats },
        {
          command: 'graph-status',
          operation: 'nexus.status',
          extensions: { duration_ms: durationMs },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ctx = getFormatContext();
      if (ctx.format === 'json') {
        cliError(msg, 1, { name: 'E_STATUS_FAILED' }, { operation: 'nexus.status' });
      } else {
        humanWarn(`[graph] Error: ${msg}`);
        await dispatchFromCli('query', 'nexus', 'status', {}, { command: 'graph' });
      }
      process.exitCode = 1;
    }
  },
});

/** cleo graph resolve — resolve a symbol name to graph node(s) */
const resolveCommand = defineCommand({
  meta: { name: 'resolve', description: 'Resolve a symbol name to graph node(s)' },
  args: {
    taskRef: {
      type: 'positional',
      description: 'Symbol or task reference to resolve',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'resolve',
      { query: args.taskRef },
      { command: 'graph' },
    );
  },
});

/** cleo graph deps — list dependencies of a symbol (callers or callees) */
const depsCommand = defineCommand({
  meta: { name: 'deps', description: 'List dependencies of a symbol (callers or callees)' },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name',
      required: true,
    },
    direction: {
      type: 'string',
      description: 'upstream|downstream (default: downstream)',
      default: 'downstream',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'deps',
      { symbol: args.symbol, direction: args.direction },
      { command: 'graph' },
    );
  },
});

/** cleo graph raw — return the raw graph (nodes + relations) */
const rawCommand = defineCommand({
  meta: { name: 'raw', description: 'Return the raw graph (nodes + relations) for a project' },
  args: {
    'project-id': {
      type: 'string',
      description: 'Project ID (default: auto-detected from cwd)',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const projectId = args['project-id'] as string | undefined;
    await dispatchFromCli('query', 'nexus', 'graph', { projectId }, { command: 'graph' });
  },
});

/** cleo graph discover — discover the codebase structure */
const discoverCommand = defineCommand({
  meta: {
    name: 'discover',
    description: 'Discover the codebase structure (file tree + symbol counts)',
  },
  args: {
    taskQuery: {
      type: 'positional',
      description: 'Query string',
      required: true,
    },
    method: {
      type: 'string',
      description: 'Discovery method: labels|description|files|auto',
      default: 'auto',
    },
    limit: { type: 'string', description: 'Max results', default: '10' },
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
      { command: 'graph' },
    );
  },
});

/** cleo graph search — full-text / semantic search over symbol names */
const searchCommand = defineCommand({
  meta: {
    name: 'search',
    description: 'Full-text / semantic search over symbol names and docstrings',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query',
      required: true,
    },
    limit: { type: 'string', description: 'Max results', default: '20' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli(
      'query',
      'nexus',
      'search',
      { query: args.query, limit: parseInt(args.limit as string, 10) },
      { command: 'graph' },
    );
  },
});

/** cleo graph augment — augment symbol pattern with code context */
const augmentCommand = defineCommand({
  meta: {
    name: 'augment',
    description: 'Augment symbol pattern with code context (for PreToolUse hooks)',
  },
  args: {
    pattern: {
      type: 'positional',
      description: 'Symbol name or file pattern',
      required: true,
    },
    limit: { type: 'string', description: 'Max results (default: 5)', default: '5' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'nexus',
      'augment',
      { pattern: args.pattern as string, limit: parseInt(args.limit as string, 10) || 5 },
      { command: 'graph' },
    );
  },
});

/** cleo graph context — return project context summary */
const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: 'Return project context summary (node/relation counts, freshness)',
  },
  args: {
    path: { type: 'positional', description: 'Project path (default: cwd)', required: false },
    'project-id': { type: 'string', description: 'Override project ID' },
    json: { type: 'boolean', description: 'Output as JSON' },
    limit: { type: 'string', description: 'Max symbols', default: '20' },
    kind: { type: 'string', description: 'Filter by node kind' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectIdOverride = args['project-id'] as string | undefined;
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const kind = (args.kind as string | undefined) ?? undefined;
    const params: Record<string, unknown> = { projectId, limit };
    if (kind) params['kind'] = kind;
    await dispatchFromCli('query', 'nexus', 'context', params, { command: 'graph' });
  },
});

/** cleo graph impact — compute blast radius for a change */
const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description: 'Compute the blast radius (upstream/downstream) of a change',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or ID to analyze',
      required: true,
    },
    direction: {
      type: 'string',
      description: 'upstream|downstream (default: upstream)',
      default: 'upstream',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli(
      'query',
      'nexus',
      'impact',
      { symbol: args.symbol, direction: args.direction },
      { command: 'graph' },
    );
  },
});

/** cleo graph impact-full — full merged impact report */
const impactFullCommand = defineCommand({
  meta: {
    name: 'impact-full',
    description:
      'Full merged impact report: structural blast radius + open tasks + brain risk notes',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or nexus node ID',
      required: true,
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'impact-full', { symbol: args.symbol });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_IMPACT_FULL_FAILED' },
        { operation: 'nexus.impact-full', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'graph-impact-full',
        operation: 'nexus.impact-full',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph clusters — return detected community clusters */
const clustersCommand = defineCommand({
  meta: { name: 'clusters', description: 'Return detected community clusters in the graph' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    limit: { type: 'string', description: 'Max clusters', default: '10' },
    'project-id': { type: 'string', description: 'Override project ID' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const projectId = args['project-id'] as string | undefined;
    const limit = Number.parseInt(args.limit as string, 10) || 10;
    await dispatchFromCli('query', 'nexus', 'clusters', { projectId, limit }, { command: 'graph' });
  },
});

/** cleo graph flows — return detected execution flows */
const flowsCommand = defineCommand({
  meta: { name: 'flows', description: 'Return detected execution flows (process traces)' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    'project-id': { type: 'string', description: 'Override project ID' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const projectId = args['project-id'] as string | undefined;
    await dispatchFromCli('query', 'nexus', 'flows', { projectId }, { command: 'graph' });
  },
});

/** cleo graph diff — diff the graph between two commits or snapshots */
const diffCommand = defineCommand({
  meta: { name: 'diff', description: 'Diff the graph between two commits or snapshots' },
  args: {
    from: { type: 'string', description: 'Base commit/ref' },
    to: { type: 'string', description: 'Target commit/ref (default: HEAD)' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli(
      'query',
      'nexus',
      'diff',
      { from: args.from, to: args.to },
      { command: 'graph' },
    );
  },
});

/** cleo graph route-map — display all routes with handlers and dependencies */
const routeMapCommand = defineCommand({
  meta: {
    name: 'route-map',
    description: 'Display all routes with their handlers and dependencies',
  },
  args: {
    path: { type: 'positional', description: 'Project path (default: cwd)', required: false },
    json: { type: 'boolean', description: 'Output as JSON' },
    'project-id': { type: 'string', description: 'Override project ID' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    const projectIdOverride = args['project-id'] as string | undefined;
    const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);
    await dispatchFromCli('query', 'nexus', 'route-map', { projectId }, { command: 'graph' });
  },
});

/** cleo graph shape-check — check response shape for a route */
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
    json: { type: 'boolean', description: 'Output as JSON' },
    'project-id': { type: 'string', description: 'Override project ID' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const projectId = args['project-id'] as string | undefined;
    await dispatchFromCli(
      'query',
      'nexus',
      'shape-check',
      { routeSymbol: args.routeSymbol, projectId },
      { command: 'graph' },
    );
  },
});

/** cleo graph search-code — search code by pattern */
const searchCodeCommand = defineCommand({
  meta: { name: 'search-code', description: 'Search code by pattern across the project graph' },
  args: {
    pattern: {
      type: 'positional',
      description: 'Search pattern',
      required: true,
    },
    limit: { type: 'string', description: 'Max results', default: '20' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli(
      'query',
      'nexus',
      'search-code',
      { pattern: args.pattern, limit: parseInt(args.limit as string, 10) },
      { command: 'graph' },
    );
  },
});

/** cleo graph wiki — generate wiki-style description for a symbol */
const wikiCommand = defineCommand({
  meta: { name: 'wiki', description: 'Generate a wiki-style description for a symbol or module' },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or ID',
      required: true,
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli('query', 'nexus', 'wiki', { symbol: args.symbol }, { command: 'graph' });
  },
});

/** cleo graph hot-paths — list highest-weight relation edges */
const hotPathsCommand = defineCommand({
  meta: {
    name: 'hot-paths',
    description: 'List highest-weight relation edges by Hebbian plasticity weight',
  },
  args: {
    limit: { type: 'string', description: 'Max edges (default: 20)', default: '20' },
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'hot-paths', { limit });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_HOT_PATHS_FAILED' },
        { operation: 'nexus.hot-paths', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'graph-hot-paths',
      operation: 'nexus.hot-paths',
      extensions: { duration_ms: durationMs },
    });
  },
});

/** cleo graph hot-nodes — list symbols with highest Hebbian weight */
const hotNodesCommand = defineCommand({
  meta: { name: 'hot-nodes', description: 'List symbols with highest aggregate Hebbian weight' },
  args: {
    limit: { type: 'string', description: 'Max nodes (default: 20)', default: '20' },
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const limit = Number.parseInt(args.limit as string, 10) || 20;
    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'hot-nodes', { limit });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_HOT_NODES_FAILED' },
        { operation: 'nexus.hot-nodes', duration_ms: durationMs },
      );
      process.exitCode = 1;
      return;
    }
    cliOutput(response.data as Record<string, unknown>, {
      command: 'graph-hot-nodes',
      operation: 'nexus.hot-nodes',
      extensions: { duration_ms: durationMs },
    });
  },
});

/** cleo graph cold-symbols — list cold symbols for pruning */
const coldSymbolsCommand = defineCommand({
  meta: {
    name: 'cold-symbols',
    description: 'List cold symbols (stale access + low weight) for pruning candidates',
  },
  args: {
    days: { type: 'string', description: 'Age threshold in days (default: 30)', default: '30' },
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const days = Number.parseInt(args.days as string, 10) || 30;
    await dispatchFromCli('query', 'nexus', 'cold-symbols', { days }, { command: 'graph' });
  },
});

/** cleo graph orphans — list graph nodes with no edges */
const orphansCommand = defineCommand({
  meta: { name: 'orphans', description: 'List graph nodes with no incoming or outgoing edges' },
  async run() {
    await dispatchFromCli('query', 'nexus', 'orphans.list', {}, { command: 'graph' });
  },
});

/** cleo graph query — execute CTE query against nexus.db */
const queryCommand = defineCommand({
  meta: { name: 'query', description: 'Execute recursive CTE queries against nexus.db' },
  args: {
    cte: {
      type: 'positional',
      description: 'CTE SQL or template alias',
      required: true,
    },
    params: { type: 'string', description: 'Comma-separated parameters' },
  },
  async run({ args }) {
    const cteOrAlias = args.cte as string;
    const paramsStr = (args.params as string) || '';
    const ctParams = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const startTime = Date.now();
    const response = await dispatchRaw('query', 'nexus', 'query-cte', {
      cte: cteOrAlias,
      params: ctParams,
    });
    const durationMs = Date.now() - startTime;
    if (!response.success) {
      const code = response.error?.code;
      const msg = response.error?.message ?? 'Unknown error';
      const exitCode = code === 'E_INVALID_INPUT' ? 6 : 77;
      cliError(
        msg,
        exitCode,
        { name: code ?? 'E_QUERY_FAILED' },
        { operation: 'nexus.query-cte', duration_ms: durationMs },
      );
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
      cliError(
        result.error ?? 'Unknown',
        77,
        { name: 'E_QUERY_FAILED' },
        { operation: 'nexus.query-cte', duration_ms: durationMs },
      );
      process.exitCode = 77;
      return;
    }
    const { formatCteResultAsMarkdown } = await import(
      '@cleocode/core/nexus/query-dsl.js' as string
    );
    const markdown = (formatCteResultAsMarkdown as (r: typeof result) => string)(result);
    cliOutput(
      { ...result, _markdown: markdown },
      {
        command: 'graph-query',
        operation: 'nexus.query-cte',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph init — initialize nexus project database */
const initCommand = defineCommand({
  meta: { name: 'init', description: 'Initialize a new Nexus project database' },
  async run() {
    await dispatchFromCli('mutate', 'nexus', 'init', {}, { command: 'graph' });
  },
});

/** cleo graph sync — re-analyze and sync the project graph */
const syncCommand = defineCommand({
  meta: { name: 'sync', description: 'Re-analyze and sync the project graph with the codebase' },
  args: {
    path: { type: 'positional', description: 'Project path (default: cwd)', required: false },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const repoPath = args.path ? path.resolve(args.path as string) : process.cwd();
    await dispatchFromCli('mutate', 'nexus', 'sync', { path: repoPath }, { command: 'graph' });
  },
});

/** cleo graph reconcile — reconcile graph with on-disk source files */
const reconcileCommand = defineCommand({
  meta: { name: 'reconcile', description: 'Reconcile graph state with on-disk source files' },
  args: {
    'project-id': { type: 'string', description: 'Project ID (default: auto-detected)' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'nexus',
      'reconcile',
      { projectId: args['project-id'] },
      { command: 'graph' },
    );
  },
});

// ── Living Brain subcommands ───────────────────────────────────────────────────

/** cleo graph living full-context — show 5-substrate context for a symbol */
const livingFullContextCommand = defineCommand({
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
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const symbolId = args.symbol as string;
    const response = await dispatchRaw('query', 'nexus', 'full-context', { symbol: symbolId });
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_FULL_CONTEXT_FAILED' },
        { operation: 'nexus.full-context' },
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'graph-living-full-context',
        operation: 'nexus.full-context',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph living task-footprint — show code impact for a task */
const livingTaskFootprintCommand = defineCommand({
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
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const taskId = args.taskId as string;
    const response = await dispatchRaw('query', 'nexus', 'task-footprint', { taskId });
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_TASK_FOOTPRINT_FAILED' },
        { operation: 'nexus.task-footprint' },
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'graph-living-task-footprint',
        operation: 'nexus.task-footprint',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph living brain-anchors — show code anchors for a brain memory entry */
const livingBrainAnchorsCommand = defineCommand({
  meta: {
    name: 'brain-anchors',
    description:
      'Show code anchors for a brain memory entry: linked nexus nodes, tasks, plasticity signal',
  },
  args: {
    entryId: {
      type: 'positional',
      description: 'Brain entry node ID (e.g., observation:abc123)',
      required: true,
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const entryId = args.entryId as string;
    const response = await dispatchRaw('query', 'nexus', 'brain-anchors', { entryId });
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_BRAIN_ANCHORS_FAILED' },
        { operation: 'nexus.brain-anchors' },
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'graph-living-brain-anchors',
        operation: 'nexus.brain-anchors',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph living why — trace why a code symbol is structured this way */
const livingWhyCommand = defineCommand({
  meta: {
    name: 'why',
    description:
      'Trace why a code symbol is structured this way: walks BRAIN decisions, observations, tasks via code_reference edges',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Symbol name or nexus node ID',
      required: true,
    },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    const startTime = Date.now();
    const symbolId = args.symbol as string;
    const response = await dispatchRaw('query', 'nexus', 'why', { symbol: symbolId });
    if (!response.success) {
      cliError(
        response.error?.message ?? 'Unknown error',
        1,
        { name: response.error?.code ?? 'E_WHY_FAILED' },
        { operation: 'nexus.why' },
      );
      process.exitCode = 1;
      return;
    }
    const durationMs = Date.now() - startTime;
    cliOutput(
      { ...((response.data as Record<string, unknown>) ?? {}), _durationMs: durationMs },
      {
        command: 'graph-living-why',
        operation: 'nexus.why',
        extensions: { duration_ms: durationMs },
      },
    );
  },
});

/** cleo graph living conduit-scan — scan Conduit messaging patterns into the graph */
const livingConduitScanCommand = defineCommand({
  meta: {
    name: 'conduit-scan',
    description: 'Scan Conduit messaging patterns into the graph',
  },
  args: {
    'project-id': { type: 'string', description: 'Project ID (default: auto-detected)' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    applyJsonFlag(args.json as boolean | undefined);
    await dispatchFromCli(
      'mutate',
      'nexus',
      'conduit-scan',
      { projectId: args['project-id'] },
      { command: 'graph' },
    );
  },
});

// ── Living subgroup ───────────────────────────────────────────────────────────

/** cleo graph living — living-brain ops that bridge the code graph and BRAIN */
const livingCommand = defineCommand({
  meta: {
    name: 'living',
    description:
      'Living Brain ops — bridge code graph + BRAIN memory (task-footprint, brain-anchors, why, full-context, conduit-scan)',
  },
  subCommands: {
    'full-context': livingFullContextCommand,
    'task-footprint': livingTaskFootprintCommand,
    'brain-anchors': livingBrainAnchorsCommand,
    why: livingWhyCommand,
    'conduit-scan': livingConduitScanCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

// ── Root graph command ────────────────────────────────────────────────────────

/**
 * Root `cleo graph` command — project-scoped code intelligence.
 *
 * Routes all project-scoped nexus ops. Living-brain ops are under `cleo graph living`.
 * The dispatch layer (`nexus` domain) is unchanged — this is a CLI-only split.
 *
 * @task T9147
 * @epic T9144
 */
export const graphCommand = defineCommand({
  meta: {
    name: 'graph',
    description: 'Project-scoped code intelligence: symbol graph, impact analysis, clusters, flows',
  },
  subCommands: {
    status: statusCommand,
    resolve: resolveCommand,
    deps: depsCommand,
    raw: rawCommand,
    discover: discoverCommand,
    search: searchCommand,
    augment: augmentCommand,
    context: contextCommand,
    impact: impactCommand,
    'impact-full': impactFullCommand,
    clusters: clustersCommand,
    flows: flowsCommand,
    diff: diffCommand,
    'route-map': routeMapCommand,
    'shape-check': shapeCheckCommand,
    'search-code': searchCodeCommand,
    wiki: wikiCommand,
    'hot-paths': hotPathsCommand,
    'hot-nodes': hotNodesCommand,
    'cold-symbols': coldSymbolsCommand,
    orphans: orphansCommand,
    query: queryCommand,
    init: initCommand,
    sync: syncCommand,
    reconcile: reconcileCommand,
    living: livingCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

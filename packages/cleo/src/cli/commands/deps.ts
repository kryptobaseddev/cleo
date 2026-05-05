/**
 * CLI deps command for dependency visualization and analysis.
 *
 * Fix #69: The critical-path subcommand calls depsCriticalPath() from core
 * directly instead of dispatching to query:orchestrate.critical.path, which was
 * removed from the registry in T5615 (merged into orchestrate.analyze).
 *
 * @task T4464
 * @epic T4454
 * @task T1857 — deps validate + deps tree subcommands (T1855 guardrails)
 */

import { ExitCode } from '@cleocode/contracts';
import { depsCriticalPath, resolveProjectRoot } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';
import { setTreeContext } from '../tree-context.js';

/** cleo deps overview — overview of all dependencies */
const overviewCommand = defineCommand({
  meta: { name: 'overview', description: 'Overview of all dependencies' },
  async run() {
    await dispatchFromCli(
      'query',
      'tasks',
      'depends',
      { action: 'overview' },
      { command: 'deps', operation: 'tasks.depends' },
    );
  },
});

/** cleo deps show <taskId> — show dependencies for a specific task */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show dependencies for a specific task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to inspect',
      required: true,
    },
    tree: {
      type: 'boolean',
      description: 'Show full transitive dependency tree',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'depends',
      {
        taskId: args.taskId,
        tree: args.tree,
      },
      { command: 'deps', operation: 'tasks.depends' },
    );
  },
});

/** cleo deps waves <epicId> — group tasks into parallelizable execution waves */
const wavesCommand = defineCommand({
  meta: { name: 'waves', description: 'Group tasks into parallelizable execution waves' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to compute waves for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'waves',
      { epicId: args.epicId },
      { command: 'deps', operation: 'orchestrate.waves' },
    );
  },
});

/** cleo deps critical-path <taskId> — find longest dependency chain from task */
const criticalPathCommand = defineCommand({
  meta: { name: 'critical-path', description: 'Find longest dependency chain from task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to trace critical path from',
      required: true,
    },
  },
  async run({ args }) {
    const cwd = resolveProjectRoot();
    try {
      const result = await depsCriticalPath(args.taskId, cwd);
      cliOutput(result, { command: 'deps', operation: 'tasks.criticalPath' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`critical-path: ${msg}`);
      process.exit(ExitCode.NOT_FOUND);
    }
  },
});

/** cleo deps impact <taskId> — find all tasks affected by changes to task */
const impactCommand = defineCommand({
  meta: { name: 'impact', description: 'Find all tasks affected by changes to task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to analyse impact for',
      required: true,
    },
    depth: {
      type: 'string',
      description: 'Maximum depth for impact analysis',
      default: '10',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'depends',
      {
        taskId: args.taskId,
        action: 'impact',
        depth: Number.parseInt(args.depth, 10),
      },
      { command: 'deps', operation: 'tasks.depends' },
    );
  },
});

/** cleo deps cycles — detect circular dependencies */
const cyclesCommand = defineCommand({
  meta: { name: 'cycles', description: 'Detect circular dependencies' },
  async run() {
    await dispatchFromCli(
      'query',
      'tasks',
      'depends',
      { action: 'cycles' },
      { command: 'deps', operation: 'tasks.depends' },
    );
  },
});

/**
 * cleo deps validate [--epic <id>] [--scope all|open|critical]
 *
 * Runs orphan / circular / cross-epic-gap / stale-dep detection.
 * Pure tier-0 (no LLM). Exit code 0 = clean, non-zero = issues found.
 *
 * @task T1857
 * @epic T1855
 */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate dep graph — orphan, circular, cross-epic gap, stale-dep detection',
  },
  args: {
    epic: {
      type: 'string',
      description: 'Scope validation to direct children of this epic ID',
    },
    scope: {
      type: 'string',
      description: 'Which tasks to include: all (default), open, or critical',
      default: 'all',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'deps.validate',
      {
        epicId: args.epic,
        scope: args.scope as 'all' | 'open' | 'critical',
      },
      { command: 'deps', operation: 'tasks.deps.validate' },
    );
  },
});

/**
 * cleo deps tree --epic <id> [--json | --mermaid | --text]
 *
 * Renders the dependency tree for an epic in text (default), Mermaid, or
 * machine-readable JSON format. The critical path is highlighted.
 *
 * @task T1857
 * @epic T1855
 */
const depsTreeCommand = defineCommand({
  meta: {
    name: 'tree',
    description: 'Render the dep-graph tree for an epic (text/mermaid/json)',
  },
  args: {
    epic: {
      type: 'string',
      description: 'Epic ID to visualize',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON tree',
      default: false,
    },
    mermaid: {
      type: 'boolean',
      description: 'Emit Mermaid graph TD block',
      default: false,
    },
  },
  async run({ args }) {
    const format = args.json ? 'json' : args.mermaid ? 'mermaid' : 'text';
    await dispatchFromCli(
      'query',
      'tasks',
      'deps.tree',
      {
        epicId: args.epic,
        format,
      },
      { command: 'deps', operation: 'tasks.deps.tree' },
    );
  },
});

/**
 * Root deps command group — dependency visualization and analysis.
 *
 * Subcommands: overview, show, waves, critical-path, impact, cycles, validate, tree.
 */
export const depsCommand = defineCommand({
  meta: { name: 'deps', description: 'Dependency visualization and analysis' },
  subCommands: {
    overview: overviewCommand,
    show: showCommand,
    waves: wavesCommand,
    'critical-path': criticalPathCommand,
    impact: impactCommand,
    cycles: cyclesCommand,
    validate: validateCommand,
    tree: depsTreeCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

/**
 * Standalone tree command — task hierarchy tree visualization.
 *
 * @remarks
 * Kept as a separate export so that index.ts can wire it to `cleo tree`.
 *
 * Flags:
 * - `--with-deps`  — inline each task's direct dependency chain below the task line.
 * - `--blockers`   — render transitive blocker chain + leaf blockers for every
 *                    blocked task in the tree.
 */
export const treeCommand = defineCommand({
  meta: { name: 'tree', description: 'Task hierarchy tree visualization' },
  args: {
    rootId: {
      type: 'positional',
      description: 'Root task ID (optional)',
      required: false,
    },
    withDeps: {
      type: 'boolean',
      description: 'Inline dependency chain below each task that has deps',
      default: false,
    },
    blockers: {
      type: 'boolean',
      description: 'Render transitive blocker chain and leaf blockers below each blocked task',
      default: false,
    },
  },
  async run({ args }) {
    // Store flags in the tree context so renderTree can read them.
    setTreeContext({ withDeps: args.withDeps, withBlockers: args.blockers });
    await dispatchFromCli(
      'query',
      'tasks',
      'tree',
      { taskId: args.rootId, withBlockers: args.blockers },
      { command: 'tree', operation: 'tasks.tree' },
    );
  },
});

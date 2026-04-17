/**
 * CLI research command group for manifest operations.
 *
 * Subcommands:
 *   cleo research add      — add a research entry to MANIFEST.jsonl
 *   cleo research show     — show a single research entry
 *   cleo research list     — list research entries with optional filters
 *   cleo research pending  — list pending entries
 *   cleo research link     — link a research entry to a task
 *   cleo research update   — update findings on an existing entry
 *   cleo research stats    — show research statistics
 *   cleo research links    — show entries linked to a task
 *   cleo research archive  — archive completed entries
 *   cleo research manifest — query MANIFEST.jsonl directly
 *
 * @task T4465
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a unique research manifest entry ID.
 *
 * Uses a `res_` prefix and the current timestamp to avoid collisions
 * with task or other entity IDs.
 */
function generateResearchId(): string {
  return `res_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** cleo research add — add a new research entry to MANIFEST.jsonl */
const addCommand = defineCommand({
  meta: { name: 'add', description: 'Add a research entry' },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to attach research to',
      required: true,
      alias: 't',
    },
    topic: {
      type: 'string',
      description: 'Research topic',
      required: true,
    },
    findings: {
      type: 'string',
      description: 'Comma-separated findings',
    },
    sources: {
      type: 'string',
      description: 'Comma-separated sources',
    },
    'agent-type': {
      type: 'string',
      description: 'Agent type that produced this entry',
      default: 'researcher',
    },
  },
  async run({ args }) {
    const topic = args.topic;
    const findings = args.findings ? args.findings.split(',').map((s) => s.trim()) : [];
    const taskId = args.task;
    const agentType = args['agent-type'] ?? 'researcher';

    await dispatchFromCli(
      'mutate',
      'pipeline',
      'manifest.append',
      {
        entry: {
          id: generateResearchId(),
          file: `research/${topic.replace(/\s+/g, '-').toLowerCase()}.md`,
          title: topic,
          date: new Date().toISOString().slice(0, 10),
          status: 'partial',
          agent_type: agentType,
          topics: [topic],
          key_findings: findings,
          actionable: findings.length > 0,
          needs_followup: [],
          linked_tasks: [taskId],
        },
      },
      { command: 'research', operation: 'pipeline.manifest.append' },
    );
  },
});

/** cleo research show — show a single research entry by ID */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show a research entry' },
  args: {
    id: {
      type: 'positional',
      description: 'Research entry ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.show',
      { entryId: args.id },
      { command: 'research' },
    );
  },
});

/** cleo research list — list research entries with optional filters */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List research entries' },
  args: {
    task: {
      type: 'string',
      description: 'Filter by task ID',
      alias: 't',
    },
    status: {
      type: 'string',
      description: 'Filter by status',
      alias: 's',
    },
    limit: {
      type: 'string',
      description: 'Limit results',
      alias: 'l',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.list',
      {
        taskId: args.task as string | undefined,
        status: args.status as string | undefined,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
      },
      { command: 'research' },
    );
  },
});

/** cleo research pending — list all pending research entries */
const pendingCommand = defineCommand({
  meta: { name: 'pending', description: 'List pending research entries' },
  async run() {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.list',
      { status: 'pending' },
      { command: 'research' },
    );
  },
});

/** cleo research link — link an existing research entry to a task */
const linkCommand = defineCommand({
  meta: { name: 'link', description: 'Link a research entry to a task' },
  args: {
    researchId: {
      type: 'positional',
      description: 'Research entry ID',
      required: true,
    },
    taskId: {
      type: 'positional',
      description: 'Task ID to link to',
      required: true,
    },
  },
  async run({ args }) {
    const researchId = args.researchId;
    const taskId = args.taskId;

    await dispatchFromCli(
      'mutate',
      'pipeline',
      'manifest.append',
      {
        entry: {
          id: researchId,
          file: `research/link-${researchId}.md`,
          title: `Link: ${researchId} -> ${taskId}`,
          date: new Date().toISOString().slice(0, 10),
          status: 'partial',
          agent_type: 'researcher',
          topics: [],
          key_findings: [],
          actionable: false,
          needs_followup: [],
          linked_tasks: [taskId],
        },
      },
      { command: 'research', operation: 'pipeline.manifest.append' },
    );
  },
});

/** cleo research update — update findings on an existing research entry */
const updateCommand = defineCommand({
  meta: { name: 'update', description: 'Update research findings' },
  args: {
    id: {
      type: 'positional',
      description: 'Research entry ID',
      required: true,
    },
    findings: {
      type: 'string',
      description: 'Comma-separated findings',
    },
    sources: {
      type: 'string',
      description: 'Comma-separated sources',
    },
    status: {
      type: 'string',
      description: 'Set status (completed, partial, blocked)',
      alias: 's',
    },
    topic: {
      type: 'string',
      description: 'Research topic (used as title)',
    },
  },
  async run({ args }) {
    const id = args.id;
    const findings = args.findings ? args.findings.split(',').map((s) => s.trim()) : [];
    const status = args.status ?? 'partial';
    const topic = args.topic ?? `Updated research: ${id}`;

    await dispatchFromCli(
      'mutate',
      'pipeline',
      'manifest.append',
      {
        entry: {
          id,
          file: `research/${id}.md`,
          title: topic,
          date: new Date().toISOString().slice(0, 10),
          status,
          agent_type: 'researcher',
          topics: topic !== `Updated research: ${id}` ? [topic] : [],
          key_findings: findings,
          actionable: findings.length > 0,
          needs_followup: [],
          linked_tasks: [],
        },
      },
      { command: 'research', operation: 'pipeline.manifest.append' },
    );
  },
});

/** cleo research stats — show research statistics */
const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show research statistics' },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'manifest.stats', {}, { command: 'research' });
  },
});

/** cleo research links — show research entries linked to a task */
const linksCommand = defineCommand({
  meta: { name: 'links', description: 'Show research entries linked to a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.find',
      { taskId: args.taskId },
      { command: 'research' },
    );
  },
});

/** cleo research archive — archive completed research entries */
const archiveCommand = defineCommand({
  meta: { name: 'archive', description: 'Archive completed research entries' },
  args: {
    'before-date': {
      type: 'string',
      description: 'Archive entries before this date (YYYY-MM-DD)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'manifest.archive',
      {
        beforeDate: args['before-date'] as string | undefined,
      },
      { command: 'research' },
    );
  },
});

/** cleo research manifest — query MANIFEST.jsonl entries directly */
const manifestCommand = defineCommand({
  meta: { name: 'manifest', description: 'Query MANIFEST.jsonl entries' },
  args: {
    status: {
      type: 'string',
      description: 'Filter by status',
      alias: 's',
    },
    'agent-type': {
      type: 'string',
      description: 'Filter by agent type',
      alias: 'a',
    },
    topic: {
      type: 'string',
      description: 'Filter by topic',
    },
    task: {
      type: 'string',
      description: 'Filter by linked task',
      alias: 't',
    },
    limit: {
      type: 'string',
      description: 'Limit results',
      alias: 'l',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.list',
      {
        status: args.status as string | undefined,
        agentType: args['agent-type'] as string | undefined,
        topic: args.topic as string | undefined,
        taskId: args.task as string | undefined,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
      },
      { command: 'research' },
    );
  },
});

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

/**
 * Root research command group — registers all research subcommands.
 *
 * Dispatches to `pipeline.manifest.*` registry operations.
 */
export const researchCommand = defineCommand({
  meta: { name: 'research', description: 'Research commands and manifest operations' },
  subCommands: {
    add: addCommand,
    show: showCommand,
    list: listCommand,
    pending: pendingCommand,
    link: linkCommand,
    update: updateCommand,
    stats: statsCommand,
    links: linksCommand,
    archive: archiveCommand,
    manifest: manifestCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

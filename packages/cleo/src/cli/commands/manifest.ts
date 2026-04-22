/**
 * CLI manifest command group for pipeline_manifest table operations.
 *
 * Subcommands:
 *   cleo manifest show <id>                  — show a single manifest entry by ID
 *   cleo manifest list [options]             — list manifest entries with filters
 *   cleo manifest find <query>               — full-text search manifest entries
 *   cleo manifest stats [options]            — aggregate statistics
 *   cleo manifest append [options]           — append a new manifest entry
 *   cleo manifest archive <id|--before>     — archive manifest entries
 *
 * Per spec: T1096 — Unified Manifest CLI Surface
 */

import { buildManifestEntryFromShorthand } from '@cleocode/core/memory/manifest-builder.js';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** cleo manifest show <id> — show a single manifest entry */
const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show a manifest entry by ID',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Pipeline manifest entry ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.show',
      { entryId: args.id },
      { command: 'manifest show' },
    );
  },
});

/** cleo manifest list — list manifest entries with optional filters */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List manifest entries with optional filters',
  },
  args: {
    filter: {
      type: 'string',
      description: 'Filter by status: active|archived|distilled|pending',
    },
    task: {
      type: 'string',
      description: 'Filter by task_id',
    },
    epic: {
      type: 'string',
      description: 'Filter by epic_id',
    },
    type: {
      type: 'string',
      description: 'Filter by entry type',
    },
    limit: {
      type: 'string',
      description: 'Maximum rows to return (default: 50, max: 500)',
    },
    offset: {
      type: 'string',
      description: 'Pagination offset (default: 0)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON array (default: table)',
      default: false,
    },
  },
  async run({ args }) {
    const limit = args.limit ? Number.parseInt(args.limit, 10) : 50;
    const offset = args.offset ? Number.parseInt(args.offset, 10) : 0;

    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.list',
      {
        filter: args.filter as string | undefined,
        taskId: args.task as string | undefined,
        epicId: args.epic as string | undefined,
        type: args.type as string | undefined,
        limit,
        offset,
        json: args.json,
      },
      { command: 'manifest list' },
    );
  },
});

/** cleo manifest find <query> — full-text search manifest entries */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Full-text search manifest entries',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Full-text search string',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum rows to return (default: 20)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON array',
      default: false,
    },
  },
  async run({ args }) {
    const limit = args.limit ? Number.parseInt(args.limit, 10) : 20;

    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.find',
      {
        query: args.query,
        limit,
        json: args.json,
      },
      { command: 'manifest find' },
    );
  },
});

/** cleo manifest stats — aggregate statistics */
const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Aggregate manifest statistics',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON object',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'manifest.stats',
      {
        json: args.json,
      },
      { command: 'manifest stats' },
    );
  },
});

/** cleo manifest append — append a new manifest entry */
const appendCommand = defineCommand({
  meta: {
    name: 'append',
    description:
      'Append a new manifest entry (pipeline_manifest table). Accepts either a full ' +
      '--entry JSON blob / --file / stdin, OR the shorthand --task + --type + --content ' +
      'flags which build a valid entry with sensible defaults for id/file/title/date/etc.',
  },
  args: {
    entry: {
      type: 'string',
      description: 'JSON string of entry fields (full ManifestEntry shape)',
    },
    task: {
      type: 'string',
      description: 'Task ID to associate — becomes linked_tasks[0] + id prefix (shorthand)',
    },
    type: {
      type: 'string',
      description:
        'Entry type — becomes agent_type (e.g. research, implementation, decomposition) (shorthand)',
    },
    content: {
      type: 'string',
      description:
        'One-paragraph summary — becomes key_findings[0] and title (first line) (shorthand)',
    },
    title: {
      type: 'string',
      description: 'Explicit title override for shorthand mode',
    },
    status: {
      type: 'string',
      description: 'Entry status: completed (default) | partial | blocked (shorthand)',
    },
    file: {
      type: 'string',
      description: 'Path to JSON file containing entry',
    },
  },
  async run({ args }) {
    let entry: Record<string, unknown>;
    const hasShorthand = Boolean(args.task || args.type || args.content);

    if (args.entry) {
      // Full entry JSON — parse, then allow shorthand to override individual fields.
      try {
        entry = JSON.parse(args.entry);
      } catch (_err) {
        console.error('Error: --entry must be valid JSON');
        process.exit(1);
      }
    } else if (args.file) {
      // Load entry from file
      try {
        const fs = await import('node:fs');
        const fileContent = fs.readFileSync(args.file, 'utf-8');
        entry = JSON.parse(fileContent);
      } catch (_err) {
        console.error(`Error: failed to read or parse ${args.file}`);
        process.exit(1);
      }
    } else if (hasShorthand) {
      // Shorthand-only: defer to the core SDK helper so the CLI stays a thin
      // adapter (AGENTS.md package boundary / T1096). Keeps the defaulting
      // logic reusable by Studio, VS Code extension, API server, and direct
      // SDK callers.
      entry = {
        ...buildManifestEntryFromShorthand({
          task: args.task as string | undefined,
          type: args.type as string | undefined,
          content: args.content as string | undefined,
          title: args.title as string | undefined,
          status: args.status as 'completed' | 'partial' | 'blocked' | undefined,
        }),
      };
    } else {
      // Try to read from stdin
      const stdinData = await readStdin();
      if (!stdinData) {
        console.error(
          'Error: must provide --entry JSON, --file path, stdin, or shorthand ' +
            '(--task + --type + --content)',
        );
        process.exit(1);
      }
      try {
        entry = JSON.parse(stdinData);
      } catch (_err) {
        console.error('Error: stdin must be valid JSON');
        process.exit(1);
      }
    }

    // Shorthand overrides applied ONLY when user provided --entry / --file /
    // stdin — let individual fields be surgically updated. (For pure shorthand
    // mode the entry is already fully built above.)
    if ((args.entry || args.file) && hasShorthand) {
      if (args.task) {
        entry.linked_tasks = Array.isArray(entry.linked_tasks)
          ? [args.task, ...entry.linked_tasks.filter((t) => t !== args.task)]
          : [args.task];
      }
      if (args.type) {
        entry.agent_type = args.type;
      }
      if (args.content && !entry.key_findings) {
        entry.key_findings = [args.content];
      }
      if (args.title) {
        entry.title = args.title;
      }
      if (args.status) {
        entry.status = args.status;
      }
    }

    await dispatchFromCli(
      'mutate',
      'pipeline',
      'manifest.append',
      { entry },
      { command: 'manifest append' },
    );
  },
});

/** cleo manifest archive — archive manifest entries */
const archiveCommand = defineCommand({
  meta: {
    name: 'archive',
    description: 'Archive manifest entries',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Entry ID to archive',
    },
    'before-date': {
      type: 'string',
      description: 'Archive all active entries created before ISO date (YYYY-MM-DD)',
    },
  },
  async run({ args }) {
    // Ensure either id or before-date is provided
    if (!args.id && !args['before-date']) {
      console.error('Error: must provide either <id> positional argument or --before-date flag');
      process.exit(1);
    }

    // Ensure id and before-date are not both provided
    if (args.id && args['before-date']) {
      console.error('Error: --before-date is mutually exclusive with <id> positional argument');
      process.exit(1);
    }

    const dispatchPayload = args.id ? { id: args.id } : { beforeDate: args['before-date'] };

    await dispatchFromCli('mutate', 'pipeline', 'manifest.archive', dispatchPayload, {
      command: 'manifest archive',
    });
  },
});

// ---------------------------------------------------------------------------
// Helper: read stdin
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main manifest command group
// ---------------------------------------------------------------------------

export const manifestCommand = defineCommand({
  meta: {
    name: 'manifest',
    description: 'Manifest operations (pipeline_manifest table)',
  },
  subCommands: {
    show: showCommand,
    list: listCommand,
    find: findCommand,
    stats: statsCommand,
    append: appendCommand,
    archive: archiveCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

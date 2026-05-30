/**
 * CLI attention command group — Tier-2 scope-keyed working-memory jots.
 *
 * The attention buffer is the per-agent working memory that decays and is
 * surfaced as a compact digest in `cleo focus` and spawn prompts. Each jot
 * auto-keys to the narrowest scope the writing agent resolves (agent > task >
 * epic > saga > session > global) from its environment identity (E0) — callers
 * never pass session/agent/task flags, so cross-agent leakage is impossible.
 *
 *   cleo attention add <text>   — record a jot (alias: jot)
 *   cleo attention show         — show open jots for the resolved scope
 *   cleo attention list         — synonym for show (alias: ls)
 *
 * @task T11373
 * @epic T11288 EP-TIER2-ATTENTION
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { ExitCode } from '@cleocode/contracts';
import type { AttentionItem } from '@cleocode/contracts/operations/attention';
import { CleoError } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Parse a comma-separated `--tag` flag into a deduplicated string array. */
function parseTags(rawTag: string | undefined): string[] | undefined {
  if (!rawTag) return undefined;
  const tags = rawTag
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

/** cleo attention add <text> — record a scope-keyed jot (alias: jot). */
const addCommand = defineCommand({
  meta: { name: 'add', description: 'Record a scope-keyed working-memory jot' },
  args: {
    content: {
      type: 'positional',
      description: 'The jot content',
      required: true,
    },
    tag: {
      type: 'string',
      description: 'Comma-separated tags (e.g. "bug,wal")',
    },
    scope: {
      type: 'string',
      description: 'Escalate scope: agent|task|epic|saga|session|global (default: narrowest)',
    },
    ttl: {
      type: 'string',
      description: 'Time-to-live in seconds (optional)',
    },
  },
  async run({ args }) {
    try {
      const ttlRaw = args.ttl as string | undefined;
      const ttlSeconds = ttlRaw ? Number.parseInt(ttlRaw, 10) : undefined;
      await dispatchFromCli(
        'mutate',
        'attention',
        'add',
        {
          content: args.content,
          tags: parseTags(args.tag as string | undefined),
          scope: args.scope as string | undefined,
          ...(ttlSeconds !== undefined && !Number.isNaN(ttlSeconds) ? { ttlSeconds } : {}),
        },
        { command: 'attention', operation: 'attention.add' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'CleoError', fix: err.fix });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo attention show / list — list open jots for the resolved scope. */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show open working-memory jots for the resolved scope' },
  args: {
    scope: {
      type: 'string',
      description: 'Restrict to one scope: agent|task|epic|saga|session|global',
    },
    tag: {
      type: 'string',
      description: 'Filter by tags (contains-ALL, comma-separated)',
    },
    all: {
      type: 'boolean',
      description: 'Include non-open (consolidated/discarded) items too',
    },
    limit: {
      type: 'string',
      description: 'Max results',
      default: '50',
    },
  },
  async run({ args }) {
    try {
      const response = await dispatchRaw('query', 'attention', 'show', {
        scope: args.scope as string | undefined,
        tags: parseTags(args.tag as string | undefined),
        includeAll: args.all === true,
        limit: Number.parseInt(args.limit, 10),
      });

      if (!response.success) {
        handleRawError(response, { command: 'attention show', operation: 'attention.show' });
        return;
      }

      const data = response.data as { items: AttentionItem[]; total: number } | null;

      if (!data?.items || data.items.length === 0) {
        cliOutput(
          { items: [], total: 0 },
          {
            command: 'attention show',
            message: 'No open attention items',
            operation: 'attention.show',
          },
        );
        process.exit(ExitCode.NO_DATA);
        return;
      }

      cliOutput(data, { command: 'attention show', operation: 'attention.show' });
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'CleoError', fix: err.fix });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Root attention command group.
 *
 * Aliases: `add` → `jot`, `show` → `list` / `ls` (shared subcommand instances
 * so help's reference-identity alias detection keeps working).
 */
export const attentionCommand = defineCommand({
  meta: {
    name: 'attention',
    description: 'Tier-2 scope-keyed working memory — quick decaying jots (alias: jot)',
  },
  subCommands: {
    add: addCommand,
    jot: addCommand,
    show: showCommand,
    list: showCommand,
    ls: showCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

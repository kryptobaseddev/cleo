/**
 * CLI agent-outputs command — search and browse agent output documents.
 *
 * Subcommands:
 *   cleo agent-outputs find <query>   — search agent outputs via DocsAccessor.searchDocs
 *
 * Routes through DocsAccessor (the Storage Layer abstraction) — no direct
 * brain/llmtxt access. ADR-069 Coordination Layers.
 *
 * @task T9191
 * @see packages/contracts/src/docs-accessor.ts (DocsAccessor interface)
 * @see packages/core/src/store/docs-accessor-impl.ts (implementation)
 */

import { ExitCode } from '@cleocode/contracts';
import { searchDocs } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// cleo agent-outputs find
// ---------------------------------------------------------------------------

/**
 * Search agent output documents by free-text query.
 *
 * Delegates to DocsAccessor.searchDocs — the canonical search path per
 * ADR-069 (Storage Layer). No direct brain/llmtxt access.
 *
 * @task T9191
 */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Search agent output documents by query (routed via DocsAccessor.searchDocs)',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Free-text search query to match against agent output documents',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results to return (default: 10)',
      default: '10',
    },
    json: {
      type: 'boolean',
      description: 'Emit raw JSON envelope instead of human-readable table',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const limit = parseInt(String(args.limit), 10);
      const query = String(args.query);

      const result = await searchDocs(query, { limit: Number.isNaN(limit) ? 10 : limit });

      if (args.json) {
        cliOutput(result, {
          command: 'agent-outputs find',
          operation: 'docs.agent-outputs.find',
        });
        return;
      }

      // Human-readable output
      if (result.hits.length === 0) {
        console.log(`No agent output documents found matching "${query}".`);
        return;
      }

      console.log(`Found ${result.hits.length} result(s) for "${query}":\n`);
      for (const hit of result.hits) {
        const score = typeof hit.score === 'number' ? ` (score: ${hit.score.toFixed(3)})` : '';
        console.log(`  ${hit.name ?? hit.id}${score}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`agent-outputs find failed: ${message}`, ExitCode.GENERAL_ERROR);
    }
  },
});

// ---------------------------------------------------------------------------
// Root agent-outputs command
// ---------------------------------------------------------------------------

/**
 * Root `cleo agent-outputs` command group.
 *
 * Subcommands:
 *   find   — search agent output documents via DocsAccessor.searchDocs
 *
 * @task T9191
 */
export const agentOutputsCommand = defineCommand({
  meta: {
    name: 'agent-outputs',
    description:
      'Agent output document management — find/search via DocsAccessor (find subcommand)',
  },
  subCommands: {
    find: findCommand,
  },
  run({ rawArgs }) {
    // No subcommand given — show usage
    const sub = rawArgs?.find((a) => !a.startsWith('-'));
    if (!sub) {
      showUsage(agentOutputsCommand);
    }
  },
});

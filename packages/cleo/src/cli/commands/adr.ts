/**
 * CLI adr command group — ADR validation, listing, sync, and search.
 *
 * Thin CLI wrapper delegating to dispatch layer (admin domain).
 * Core logic lives in src/core/adrs/.
 *
 * Commands:
 *   cleo adr validate              — validate frontmatter on all .cleo/adrs/*.md
 *   cleo adr list [--status]       — list ADRs with optional status filter
 *   cleo adr show <id>             — show single ADR by ID (e.g., ADR-017)
 *   cleo adr sync                  — sync .cleo/adrs/ into architecture_decisions DB
 *   cleo adr find <query>          — fuzzy search ADRs by title, summary, keywords, topics
 *
 * Dispatch equivalents:
 *   mutate({domain:'admin', operation:'adr.validate'})
 *   query({domain:'admin',  operation:'adr.list',  params:{status?}})
 *   query({domain:'admin',  operation:'adr.show',  params:{adrId}})
 *   mutate({domain:'admin', operation:'adr.sync'})
 *   query({domain:'admin',  operation:'adr.find',  params:{query, topics?, keywords?, status?}})
 *
 * @see ADR-017 §5.1 for canonical frontmatter spec
 * @see ADR-017 §5.4 for cognitive search spec
 * @see schemas/adr-frontmatter.schema.json for validation schema
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo adr validate — validate frontmatter on all .cleo/adrs/*.md files */
const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate frontmatter on all .cleo/adrs/*.md files against ADR-017 schema',
  },
  async run() {
    await dispatchFromCli(
      'mutate',
      'admin',
      'adr.sync',
      { validate: true },
      { command: 'adr validate', operation: 'admin.adr.sync' },
    );
  },
});

/** cleo adr list — list ADRs from .cleo/adrs/ with optional filtering */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List ADRs from .cleo/adrs/',
  },
  args: {
    status: {
      type: 'string',
      description: 'Filter by status: proposed | accepted | superseded | deprecated',
    },
    since: {
      type: 'string',
      description: 'Filter to ADRs created on or after YYYY-MM-DD',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'adr.find',
      {
        status: args.status as string | undefined,
        since: args.since as string | undefined,
      },
      { command: 'adr list', operation: 'admin.adr.find' },
    );
  },
});

/** cleo adr show <adrId> — show full details for a single ADR */
const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show full details for a single ADR (e.g., cleo adr show ADR-017)',
  },
  args: {
    adrId: {
      type: 'positional',
      description: 'ADR identifier (e.g., ADR-017)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'adr.show',
      { adrId: args.adrId },
      { command: 'adr show', operation: 'admin.adr.show' },
    );
  },
});

/** cleo adr sync — sync .cleo/adrs/ markdown files into the DB */
const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Sync .cleo/adrs/ markdown files into the architecture_decisions DB table',
  },
  async run() {
    await dispatchFromCli(
      'mutate',
      'admin',
      'adr.sync',
      {},
      { command: 'adr sync', operation: 'admin.adr.sync' },
    );
  },
});

/** cleo adr find <query> — fuzzy search ADRs by title, summary, keywords, and topics */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Fuzzy search ADRs by title, summary, keywords, and topics',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query string',
      required: true,
    },
    topics: {
      type: 'string',
      description: 'Filter by topics (comma-separated domain tags)',
    },
    keywords: {
      type: 'string',
      description: 'Filter by keywords (comma-separated tags)',
    },
    status: {
      type: 'string',
      description: 'Filter by status: proposed | accepted | superseded | deprecated',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'adr.find',
      {
        query: args.query,
        topics: args.topics as string | undefined,
        keywords: args.keywords as string | undefined,
        status: args.status as string | undefined,
      },
      { command: 'adr find', operation: 'admin.adr.find' },
    );
  },
});

/**
 * Root adr command group — ADR validation, listing, sync, and search.
 *
 * Dispatches to `admin.adr.*` registry operations.
 *
 * @see ADR-017 §5.1 for canonical frontmatter spec
 */
export const adrCommand = defineCommand({
  meta: {
    name: 'adr',
    description: 'Manage and validate Architecture Decision Records in .cleo/adrs/',
  },
  subCommands: {
    validate: validateCommand,
    list: listCommand,
    show: showCommand,
    sync: syncCommand,
    find: findCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

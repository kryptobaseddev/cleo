/**
 * Central token telemetry command group.
 *
 * Commands:
 *   cleo token summary   — summarize recorded token telemetry
 *   cleo token list      — list recorded token telemetry records
 *   cleo token show      — show a single token telemetry record
 *   cleo token delete    — delete a token telemetry record
 *   cleo token clear     — clear token telemetry records
 *   cleo token estimate  — estimate request/response tokens
 *
 * @task T5618
 * @why CLEO needs a provider-aware in-house token tool that works across CLI, tests, and telemetry workflows.
 * @what Adds summary/list/show/delete/clear plus direct estimate/record support for token telemetry.
 */

import { readFileSync } from 'node:fs';
import { measureTokenExchange, recordTokenExchange } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Read a text payload from inline text option or a file path option.
 *
 * @param args - Parsed citty args object.
 * @param textKey - Key name for the inline text arg.
 * @param fileKey - Key name for the file path arg.
 * @returns The payload string, or undefined if neither arg was provided.
 */
function readPayload(
  args: Record<string, unknown>,
  textKey: string,
  fileKey: string,
): string | undefined {
  const text = args[textKey] as string | undefined;
  const file = args[fileKey] as string | undefined;
  if (file) return readFileSync(file, 'utf-8');
  return text;
}

/** Shared filter args reused across summary, list, and clear subcommands */
const filterArgs = {
  provider: { type: 'string' as const, description: 'Filter by provider' },
  transport: { type: 'string' as const, description: 'Filter by transport' },
  domain: { type: 'string' as const, description: 'Filter by domain' },
  operation: { type: 'string' as const, description: 'Filter by operation name' },
  session: { type: 'string' as const, description: 'Filter by session ID' },
  task: { type: 'string' as const, description: 'Filter by task ID' },
};

/** cleo token summary — summarize recorded token telemetry */
const summaryCommand = defineCommand({
  meta: { name: 'summary', description: 'Summarize recorded token telemetry' },
  args: { ...filterArgs },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'token',
      {
        action: 'summary',
        provider: args.provider as string | undefined,
        transport: args.transport as string | undefined,
        domain: args.domain as string | undefined,
        operationName: args.operation as string | undefined,
        sessionId: args.session as string | undefined,
        taskId: args.task as string | undefined,
      },
      { command: 'token', operation: 'admin.token' },
    );
  },
});

/** cleo token list — list recorded token telemetry records */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List recorded token telemetry' },
  args: {
    ...filterArgs,
    limit: { type: 'string', description: 'Maximum records' },
    offset: { type: 'string', description: 'Skip records' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'token',
      {
        action: 'list',
        provider: args.provider as string | undefined,
        transport: args.transport as string | undefined,
        domain: args.domain as string | undefined,
        operationName: args.operation as string | undefined,
        sessionId: args.session as string | undefined,
        taskId: args.task as string | undefined,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
        offset: args.offset ? Number.parseInt(args.offset, 10) : undefined,
      },
      { command: 'token', operation: 'admin.token' },
    );
  },
});

/** cleo token show — show a single token telemetry record */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show a single token telemetry record' },
  args: {
    tokenId: {
      type: 'positional',
      description: 'Token telemetry record ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'token',
      { action: 'show', tokenId: args.tokenId },
      { command: 'token', operation: 'admin.token' },
    );
  },
});

/** cleo token delete — delete a token telemetry record */
const deleteCommand = defineCommand({
  meta: { name: 'delete', description: 'Delete a token telemetry record' },
  args: {
    tokenId: {
      type: 'positional',
      description: 'Token telemetry record ID to delete',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'token',
      { action: 'delete', tokenId: args.tokenId },
      { command: 'token', operation: 'admin.token' },
    );
  },
});

/** cleo token clear — clear token telemetry records (with optional filters) */
const clearCommand = defineCommand({
  meta: { name: 'clear', description: 'Clear token telemetry records' },
  args: { ...filterArgs },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'token',
      {
        action: 'clear',
        provider: args.provider as string | undefined,
        transport: args.transport as string | undefined,
        domain: args.domain as string | undefined,
        operationName: args.operation as string | undefined,
        sessionId: args.session as string | undefined,
        taskId: args.task as string | undefined,
      },
      { command: 'token', operation: 'admin.token' },
    );
  },
});

/** cleo token estimate — estimate request/response tokens using the central token service */
const estimateCommand = defineCommand({
  meta: {
    name: 'estimate',
    description: 'Estimate request/response tokens using the central token service',
  },
  args: {
    provider: { type: 'string', description: 'Provider name' },
    model: { type: 'string', description: 'Model name' },
    transport: {
      type: 'string',
      description: 'Transport (cli|api|agent|unknown)',
      default: 'unknown',
    },
    gateway: { type: 'string', description: 'Gateway name' },
    domain: { type: 'string', description: 'Domain name' },
    operation: { type: 'string', description: 'Operation name' },
    'request-text': { type: 'string', description: 'Inline request text' },
    'response-text': { type: 'string', description: 'Inline response text' },
    'request-file': { type: 'string', description: 'Read request payload from file' },
    'response-file': { type: 'string', description: 'Read response payload from file' },
    record: { type: 'boolean', description: 'Persist the measured exchange' },
  },
  async run({ args }) {
    const requestPayload = readPayload(args, 'request-text', 'request-file');
    const responsePayload = readPayload(args, 'response-text', 'response-file');
    const input = {
      requestPayload,
      responsePayload,
      provider: args.provider as string | undefined,
      model: args.model as string | undefined,
      transport: args.transport as 'cli' | 'api' | 'agent' | 'unknown' | undefined,
      gateway: args.gateway as string | undefined,
      domain: args.domain as string | undefined,
      operation: args.operation as string | undefined,
    };

    const result = args.record
      ? await recordTokenExchange(input)
      : await measureTokenExchange(input);

    cliOutput(result, {
      command: 'token',
      operation: args.record ? 'admin.token.record' : 'token.estimate',
    });
  },
});

/**
 * Root token command group — registers all token telemetry subcommands.
 *
 * Dispatches to `admin.token` registry operations.
 */
export const tokenCommand = defineCommand({
  meta: {
    name: 'token',
    description:
      'Provider-aware token telemetry from tasks.db (historical, per-operation tracking)',
  },
  subCommands: {
    summary: summaryCommand,
    list: listCommand,
    show: showCommand,
    delete: deleteCommand,
    clear: clearCommand,
    estimate: estimateCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

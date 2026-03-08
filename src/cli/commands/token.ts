/**
 * Central token telemetry command group.
 *
 * @task T5618
 * @why CLEO needs a provider-aware in-house token tool that works across CLI, MCP, tests, and telemetry workflows.
 * @what Adds summary/list/show/delete/clear plus direct estimate/record support for token telemetry.
 */

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { measureTokenExchange, recordTokenExchange } from '../../core/metrics/token-service.js';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

function readPayload(
  opts: Record<string, unknown>,
  textKey: string,
  fileKey: string,
): string | undefined {
  const text = opts[textKey] as string | undefined;
  const file = opts[fileKey] as string | undefined;
  if (file) return readFileSync(file, 'utf-8');
  return text;
}

export function registerTokenCommand(program: Command): void {
  const token = program
    .command('token')
    .description('Provider-aware token telemetry and estimation');

  token
    .command('summary')
    .description('Summarize recorded token telemetry')
    .option('--provider <provider>', 'Filter by provider')
    .option('--transport <transport>', 'Filter by transport')
    .option('--domain <domain>', 'Filter by domain')
    .option('--operation <name>', 'Filter by operation name')
    .option('--session <id>', 'Filter by session ID')
    .option('--task <id>', 'Filter by task ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'token',
        {
          action: 'summary',
          provider: opts['provider'] as string | undefined,
          transport: opts['transport'] as string | undefined,
          domain: opts['domain'] as string | undefined,
          operationName: opts['operation'] as string | undefined,
          sessionId: opts['session'] as string | undefined,
          taskId: opts['task'] as string | undefined,
        },
        { command: 'token', operation: 'admin.token' },
      );
    });

  token
    .command('list')
    .description('List recorded token telemetry')
    .option('--provider <provider>', 'Filter by provider')
    .option('--transport <transport>', 'Filter by transport')
    .option('--domain <domain>', 'Filter by domain')
    .option('--operation <name>', 'Filter by operation name')
    .option('--session <id>', 'Filter by session ID')
    .option('--task <id>', 'Filter by task ID')
    .option('--limit <n>', 'Maximum records', parseInt)
    .option('--offset <n>', 'Skip records', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'token',
        {
          action: 'list',
          provider: opts['provider'] as string | undefined,
          transport: opts['transport'] as string | undefined,
          domain: opts['domain'] as string | undefined,
          operationName: opts['operation'] as string | undefined,
          sessionId: opts['session'] as string | undefined,
          taskId: opts['task'] as string | undefined,
          limit: opts['limit'] as number | undefined,
          offset: opts['offset'] as number | undefined,
        },
        { command: 'token', operation: 'admin.token' },
      );
    });

  token
    .command('show <tokenId>')
    .description('Show a single token telemetry record')
    .action(async (tokenId: string) => {
      await dispatchFromCli(
        'query',
        'admin',
        'token',
        { action: 'show', tokenId },
        { command: 'token', operation: 'admin.token' },
      );
    });

  token
    .command('delete <tokenId>')
    .description('Delete a token telemetry record')
    .action(async (tokenId: string) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'token',
        { action: 'delete', tokenId },
        { command: 'token', operation: 'admin.token' },
      );
    });

  token
    .command('clear')
    .description('Clear token telemetry records')
    .option('--provider <provider>', 'Filter by provider')
    .option('--transport <transport>', 'Filter by transport')
    .option('--domain <domain>', 'Filter by domain')
    .option('--operation <name>', 'Filter by operation name')
    .option('--session <id>', 'Filter by session ID')
    .option('--task <id>', 'Filter by task ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'token',
        {
          action: 'clear',
          provider: opts['provider'] as string | undefined,
          transport: opts['transport'] as string | undefined,
          domain: opts['domain'] as string | undefined,
          operationName: opts['operation'] as string | undefined,
          sessionId: opts['session'] as string | undefined,
          taskId: opts['task'] as string | undefined,
        },
        { command: 'token', operation: 'admin.token' },
      );
    });

  token
    .command('estimate')
    .description('Estimate request/response tokens using the central token service')
    .option('--provider <provider>', 'Provider name')
    .option('--model <model>', 'Model name')
    .option('--transport <transport>', 'Transport (cli|mcp|api|agent|unknown)', 'unknown')
    .option('--gateway <gateway>', 'Gateway name')
    .option('--domain <domain>', 'Domain name')
    .option('--operation <name>', 'Operation name')
    .option('--request-text <text>', 'Inline request text')
    .option('--response-text <text>', 'Inline response text')
    .option('--request-file <path>', 'Read request payload from file')
    .option('--response-file <path>', 'Read response payload from file')
    .option('--record', 'Persist the measured exchange')
    .action(async (opts: Record<string, unknown>) => {
      const requestPayload = readPayload(opts, 'requestText', 'requestFile');
      const responsePayload = readPayload(opts, 'responseText', 'responseFile');
      const input = {
        requestPayload,
        responsePayload,
        provider: opts['provider'] as string | undefined,
        model: opts['model'] as string | undefined,
        transport: opts['transport'] as 'cli' | 'mcp' | 'api' | 'agent' | 'unknown' | undefined,
        gateway: opts['gateway'] as string | undefined,
        domain: opts['domain'] as string | undefined,
        operation: opts['operation'] as string | undefined,
      };

      const result = opts['record']
        ? await recordTokenExchange(input)
        : await measureTokenExchange(input);

      cliOutput(result, {
        command: 'token',
        operation: opts['record'] ? 'admin.token.record' : 'token.estimate',
      });
    });
}

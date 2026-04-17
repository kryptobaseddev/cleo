/**
 * CLI command group for OpenTelemetry token metrics tracking.
 *
 * Exposes lightweight token usage from `.cleo/metrics/TOKEN_USAGE.jsonl`
 * as a native citty subcommand group:
 *
 *   cleo otel status    — token tracking status and recent activity
 *   cleo otel summary   — combined token usage summary
 *   cleo otel sessions  — session-level token data
 *   cleo otel spawns    — spawn-level token data
 *   cleo otel real      — REAL token usage from Claude Code API
 *   cleo otel clear     — clear token tracking data (with backup)
 *
 * All subcommands call core functions directly (no otel dispatch domain —
 * telemetry is local-only).
 *
 * @task T4535
 * @epic T4454
 */

import {
  CleoError,
  clearOtelData,
  formatError,
  getOtelSessions,
  getOtelSpawns,
  getOtelStatus,
  getOtelSummary,
  getRealTokenUsage,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliOutput } from '../renderers/index.js';

/** cleo otel status — show token tracking status and recent activity */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show token tracking status and recent activity' },
  async run() {
    try {
      const result = await getOtelStatus();
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo otel summary — show combined token usage summary */
const summaryCommand = defineCommand({
  meta: { name: 'summary', description: 'Show combined token usage summary' },
  async run() {
    try {
      const result = await getOtelSummary();
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo otel sessions — show session-level token data */
const sessionsCommand = defineCommand({
  meta: { name: 'sessions', description: 'Show session-level token data' },
  args: {
    session: {
      type: 'string',
      description: 'Filter by session ID',
    },
    task: {
      type: 'string',
      description: 'Filter by task ID',
    },
  },
  async run({ args }) {
    try {
      const result = await getOtelSessions({
        session: args.session as string | undefined,
        task: args.task as string | undefined,
      });
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo otel spawns — show spawn-level token data */
const spawnsCommand = defineCommand({
  meta: { name: 'spawns', description: 'Show spawn-level token data' },
  args: {
    task: {
      type: 'string',
      description: 'Filter by task ID',
    },
    epic: {
      type: 'string',
      description: 'Filter by epic ID',
    },
  },
  async run({ args }) {
    try {
      const result = await getOtelSpawns({
        task: args.task as string | undefined,
        epic: args.epic as string | undefined,
      });
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo otel real — show REAL token usage from Claude Code API */
const realCommand = defineCommand({
  meta: { name: 'real', description: 'Show REAL token usage from Claude Code API' },
  args: {
    session: {
      type: 'string',
      description: 'Filter by session ID',
    },
    since: {
      type: 'string',
      description: 'Filter events since timestamp',
    },
  },
  async run({ args }) {
    try {
      const result = await getRealTokenUsage({
        session: args.session as string | undefined,
        since: args.since as string | undefined,
      });
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo otel clear — clear token tracking data (with backup) */
const clearCommand = defineCommand({
  meta: { name: 'clear', description: 'Clear token tracking data (with backup)' },
  async run() {
    try {
      const result = await clearOtelData();
      cliOutput(result, { command: 'otel' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Root otel command group — lightweight token metrics from TOKEN_USAGE.jsonl.
 *
 * All subcommands call core functions directly; no dispatch domain is involved
 * because telemetry is local-only.
 *
 * @task T4535
 * @epic T4454
 */
export const otelCommand = defineCommand({
  meta: {
    name: 'otel',
    description:
      'Lightweight token metrics from .cleo/metrics/TOKEN_USAGE.jsonl (session-level, spawn-level events)',
  },
  subCommands: {
    status: statusCommand,
    summary: summaryCommand,
    sessions: sessionsCommand,
    spawns: spawnsCommand,
    real: realCommand,
    clear: clearCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});

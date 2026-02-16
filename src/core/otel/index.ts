/**
 * OpenTelemetry token metrics core module.
 * @task T4535
 * @epic T4454
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

function getProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.cleo', 'config.json'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

function getTokenFilePath(): string {
  return join(getProjectRoot(), '.cleo', 'metrics', 'TOKEN_USAGE.jsonl');
}

function readJsonlFile(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

/** Get token tracking status. */
export async function getOtelStatus(): Promise<Record<string, unknown>> {
  const tokenFile = getTokenFilePath();
  const entries = readJsonlFile(tokenFile);
  const totalTokens = entries.reduce((sum, e) => sum + ((e.estimated_tokens as number) ?? 0), 0);
  const manifestTokens = entries
    .filter(e => e.event_type === 'manifest_read' || e.event_type === 'manifest_query')
    .reduce((sum, e) => sum + ((e.estimated_tokens as number) ?? 0), 0);
  const fullFileTokens = entries
    .filter(e => e.event_type === 'full_file_read')
    .reduce((sum, e) => sum + ((e.estimated_tokens as number) ?? 0), 0);

  return {
    file: tokenFile,
    events: entries.length,
    totalTokens,
    breakdown: {
      manifestReads: manifestTokens,
      fullFileReads: fullFileTokens,
      other: totalTokens - manifestTokens - fullFileTokens,
    },
  };
}

/** Get combined token usage summary. */
export async function getOtelSummary(): Promise<Record<string, unknown>> {
  const tokenFile = getTokenFilePath();
  const entries = readJsonlFile(tokenFile);

  if (entries.length === 0) {
    return { message: 'No token tracking data yet', events: 0 };
  }

  const totalTokens = entries.reduce((sum, e) => sum + ((e.estimated_tokens as number) ?? 0), 0);
  const sessions = entries.filter(e => e.event_type === 'session_start');
  const spawns = entries.filter(e => e.event_type !== 'session_start');

  const byType: Record<string, { count: number; tokens: number }> = {};
  for (const e of entries) {
    const type = (e.event_type as string) ?? 'unknown';
    if (!byType[type]) byType[type] = { count: 0, tokens: 0 };
    byType[type]!.count++;
    byType[type]!.tokens += (e.estimated_tokens as number) ?? 0;
  }

  return {
    totalEvents: entries.length,
    totalTokens,
    sessions: {
      count: sessions.length,
      tokens: sessions.reduce((s, e) => s + ((e.estimated_tokens as number) ?? 0), 0),
    },
    spawns: {
      count: spawns.length,
      tokens: spawns.reduce((s, e) => s + ((e.estimated_tokens as number) ?? 0), 0),
    },
    byType: Object.entries(byType).map(([type, stats]) => ({ type, ...stats })),
    file: tokenFile,
  };
}

/** Get session-level token data. */
export async function getOtelSessions(opts: {
  session?: string;
  task?: string;
}): Promise<Record<string, unknown>> {
  const entries = readJsonlFile(getTokenFilePath());
  let sessions = entries.filter(e => e.event_type === 'session_start');

  if (opts.session) {
    sessions = sessions.filter(e => {
      const ctx = (e.context ?? {}) as Record<string, unknown>;
      return ctx.session_id === opts.session;
    });
  }
  if (opts.task) {
    sessions = sessions.filter(e => e.task_id === opts.task);
  }

  return { sessions, count: sessions.length };
}

/** Get spawn-level token data. */
export async function getOtelSpawns(opts: {
  task?: string;
  epic?: string;
}): Promise<Record<string, unknown>> {
  const entries = readJsonlFile(getTokenFilePath());
  let spawns = entries.filter(e => e.event_type !== 'session_start');

  if (opts.task) {
    spawns = spawns.filter(e => e.task_id === opts.task);
  }

  return { spawns, count: spawns.length };
}

/** Get real token usage from Claude Code API. */
export async function getRealTokenUsage(_opts: {
  session?: string;
  since?: string;
}): Promise<Record<string, unknown>> {
  // Real token usage requires OTel integration - return placeholder
  return {
    message: 'Real token usage requires OpenTelemetry configuration',
    otelEnabled: process.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1',
  };
}

/** Clear token tracking data with backup. */
export async function clearOtelData(): Promise<Record<string, unknown>> {
  const tokenFile = getTokenFilePath();
  if (existsSync(tokenFile)) {
    const backup = `${tokenFile}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(tokenFile, backup);
    writeFileSync(tokenFile, '');
    return { message: 'Token tracking cleared', backup };
  }
  return { message: 'No token file to clear' };
}

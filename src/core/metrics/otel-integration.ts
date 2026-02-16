/**
 * OpenTelemetry integration for Claude Code metrics.
 *
 * Captures real token usage data from Claude Code OTel exports.
 * Supports setup, parsing, aggregation, and session comparison.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { isoTimestamp } from './common.js';

function getOtelDir(cwd?: string): string {
  return process.env.OTEL_METRICS_DIR ?? join(getCleoDir(cwd), 'metrics', 'otel');
}

function getTokenMetricsPath(cwd?: string): string {
  return join(getOtelDir(cwd), 'token_metrics.jsonl');
}

/** Check if OTel telemetry is enabled. */
export function isOtelEnabled(): boolean {
  return process.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1';
}

/** OTel capture mode. */
export type OtelCaptureMode = 'console' | 'file' | 'prometheus';

/** Get environment variable commands for OTel capture setup. */
export function getOtelSetupCommands(mode: OtelCaptureMode = 'file', cwd?: string): string {
  switch (mode) {
    case 'console':
      return [
        'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'export OTEL_METRICS_EXPORTER=console',
        'export OTEL_METRIC_EXPORT_INTERVAL=5000',
      ].join('\n');

    case 'file':
      return [
        'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'export OTEL_METRICS_EXPORTER=otlp',
        'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
        `export OTEL_EXPORTER_OTLP_ENDPOINT=file://${getOtelDir(cwd)}/`,
      ].join('\n');

    case 'prometheus':
      return [
        'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
        'export OTEL_METRICS_EXPORTER=prometheus',
        '# Metrics available at localhost:9464/metrics',
      ].join('\n');
  }
}

/** Token data point parsed from OTel metrics. */
export interface OtelTokenDataPoint {
  timestamp: string | number;
  type: string;
  model: string;
  tokens: number;
}

/** Find the most recent OTel metrics JSON file. */
function findLatestMetricsFile(cwd?: string): string | null {
  const otelDir = getOtelDir(cwd);
  if (!existsSync(otelDir)) return null;

  const files = readdirSync(otelDir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(otelDir, f))
    .filter(f => {
      try { return statSync(f).isFile(); } catch { return false; }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  return files[0] ?? null;
}

/** Parse OTel token metrics from collected data. */
export function parseTokenMetrics(inputFile?: string, cwd?: string): OtelTokenDataPoint[] {
  const file = inputFile ?? findLatestMetricsFile(cwd);
  if (!file || !existsSync(file)) return [];

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));

    // Standard OTel JSON format
    if (raw.resourceMetrics) {
      const points: OtelTokenDataPoint[] = [];
      for (const rm of raw.resourceMetrics ?? []) {
        for (const sm of rm.scopeMetrics ?? []) {
          for (const metric of sm.metrics ?? []) {
            if (metric.name !== 'claude_code.token.usage') continue;
            for (const dp of metric.sum?.dataPoints ?? []) {
              const attrs = dp.attributes ?? [];
              const typeAttr = attrs.find((a: Record<string, unknown>) => a.key === 'type');
              const modelAttr = attrs.find((a: Record<string, unknown>) => a.key === 'model');
              points.push({
                timestamp: dp.timeUnixNano,
                type: (typeAttr?.value as Record<string, string>)?.stringValue ?? 'unknown',
                model: (modelAttr?.value as Record<string, string>)?.stringValue ?? 'unknown',
                tokens: dp.asInt ?? Math.floor(dp.asDouble ?? 0),
              });
            }
          }
        }
      }
      return points;
    }

    return [];
  } catch {
    return [];
  }
}

/** Aggregated token counts. */
export interface AggregatedTokens {
  session_id: string | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    total: number;
    effective: number;
  };
  api_requests: number;
  source: 'otel';
}

/** Get aggregated token counts from OTel data. */
export function getSessionTokens(sessionId?: string, cwd?: string): AggregatedTokens {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;

  for (const point of parseTokenMetrics(undefined, cwd)) {
    switch (point.type) {
      case 'input':
        input += point.tokens;
        break;
      case 'output':
        output += point.tokens;
        break;
      case 'cacheRead':
        cacheRead += point.tokens;
        break;
      case 'cacheCreation':
        cacheCreate += point.tokens;
        break;
    }
  }

  return {
    session_id: sessionId ?? null,
    tokens: {
      input,
      output,
      cache_read: cacheRead,
      cache_creation: cacheCreate,
      total: input + output,
      effective: input + output - cacheRead,
    },
    api_requests: 0,
    source: 'otel',
  };
}

/** Record token counts at session start. */
export async function recordSessionStart(sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const otelDir = getOtelDir(cwd);
  await mkdir(otelDir, { recursive: true });

  const snapshot = getSessionTokens(sessionId, cwd);
  const entry = {
    ...snapshot,
    timestamp: isoTimestamp(),
    event: 'session_start',
  };

  const metricsPath = getTokenMetricsPath(cwd);
  appendFileSync(metricsPath, JSON.stringify(entry) + '\n');
  return entry;
}

/** Record token counts at session end. */
export async function recordSessionEnd(sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const otelDir = getOtelDir(cwd);
  await mkdir(otelDir, { recursive: true });

  const current = getSessionTokens(sessionId, cwd);
  const metricsPath = getTokenMetricsPath(cwd);

  // Find session start
  let deltaInput = 0;
  let deltaOutput = 0;

  if (existsSync(metricsPath)) {
    const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n').filter(Boolean);
    const startLine = lines
      .reverse()
      .find(l => l.includes(`"session_id":"${sessionId}"`) && l.includes('session_start'));

    if (startLine) {
      const startData = JSON.parse(startLine) as AggregatedTokens;
      deltaInput = current.tokens.input - startData.tokens.input;
      deltaOutput = current.tokens.output - startData.tokens.output;
    }
  }

  const summary = {
    session_id: sessionId,
    timestamp: isoTimestamp(),
    event: 'session_end',
    session_tokens: {
      input: deltaInput,
      output: deltaOutput,
      total: deltaInput + deltaOutput,
    },
    cumulative: current.tokens,
  };

  appendFileSync(metricsPath, JSON.stringify(summary) + '\n');
  return summary;
}

/** Compare token usage between two sessions. */
export function compareSessions(
  sessionA: string,
  sessionB: string,
  cwd?: string,
): Record<string, unknown> {
  const metricsPath = getTokenMetricsPath(cwd);
  if (!existsSync(metricsPath)) {
    return { error: 'One or both sessions not found' };
  }

  const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n').filter(Boolean);

  const findSessionEnd = (id: string): number => {
    const line = lines.reverse().find(
      l => l.includes(`"session_id":"${id}"`) && l.includes('session_end'),
    );
    if (!line) return 0;
    const data = JSON.parse(line) as { session_tokens?: { total?: number } };
    return data.session_tokens?.total ?? 0;
  };

  const aTotal = findSessionEnd(sessionA);
  const bTotal = findSessionEnd(sessionB);

  if (aTotal === 0 && bTotal === 0) {
    return { error: 'One or both sessions not found' };
  }

  const difference = bTotal - aTotal;
  const savingsPercent = bTotal > 0 ? Math.floor((difference * 100) / bTotal) : 0;

  let verdict: string;
  if (savingsPercent >= 50) verdict = 'Significant savings';
  else if (savingsPercent >= 20) verdict = 'Moderate savings';
  else if (savingsPercent >= 0) verdict = 'Minimal difference';
  else verdict = 'Session A used more tokens';

  return {
    comparison: {
      session_a: { id: sessionA, total_tokens: aTotal },
      session_b: { id: sessionB, total_tokens: bTotal },
    },
    difference,
    savings_percent: savingsPercent,
    winner: aTotal < bTotal ? sessionA : sessionB,
    verdict,
  };
}

/** Get statistics about token usage across sessions. */
export function getTokenStats(cwd?: string): Record<string, unknown> {
  const metricsPath = getTokenMetricsPath(cwd);
  if (!existsSync(metricsPath)) {
    return { error: 'No token metrics recorded' };
  }

  const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n').filter(Boolean);
  const endEvents = lines.filter(l => l.includes('session_end'));

  if (endEvents.length === 0) {
    return { sessions: 0, avg_tokens: 0, min_tokens: 0, max_tokens: 0 };
  }

  let sum = 0;
  let min = Infinity;
  let max = 0;

  for (const line of endEvents) {
    const data = JSON.parse(line) as { session_tokens?: { total?: number } };
    const tokens = data.session_tokens?.total ?? 0;
    sum += tokens;
    if (tokens < min) min = tokens;
    if (tokens > max) max = tokens;
  }

  return {
    sessions_tracked: endEvents.length,
    total_tokens_all_sessions: sum,
    avg_tokens_per_session: Math.floor(sum / endEvents.length),
    min_tokens_session: min === Infinity ? 0 : min,
    max_tokens_session: max,
  };
}

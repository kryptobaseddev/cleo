/**
 * Telemetry module — opt-in command telemetry for CLEO self-improvement.
 *
 * Entry point for all telemetry operations:
 *   - Recording events (fire-and-forget)
 *   - Querying patterns for `cleo diagnostics analyze`
 *   - Managing the anonymous ID and opt-in state
 *   - Emitting BRAIN observations from high-signal patterns
 *
 * Telemetry is DISABLED by default. Enable with `cleo diagnostics enable`.
 *
 * @task T624
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, count, desc, gt, sql } from 'drizzle-orm';
import { getCleoHome } from '../paths.js';
import { telemetryEvents } from './schema.js';
import { getTelemetryDb } from './sqlite.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single telemetry event to record. */
export interface TelemetryEvent {
  /** Canonical domain (e.g. "tasks", "session"). */
  domain: string;
  /** CQRS gateway. */
  gateway: 'query' | 'mutate';
  /** Operation name (e.g. "show", "add"). */
  operation: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** LAFS exit code (0 = success). */
  exitCode: number;
  /** Machine-readable error code (null on success). */
  errorCode?: string | null;
}

/** Aggregated stats for a single command. */
export interface CommandStats {
  /** Composed "{domain}.{operation}" command name. */
  command: string;
  /** Total invocation count. */
  count: number;
  /** Count of invocations that returned exitCode != 0. */
  failureCount: number;
  /** Failure rate as a fraction (0..1). */
  failureRate: number;
  /** Mean duration in milliseconds. */
  avgDurationMs: number;
  /** Max duration in milliseconds. */
  maxDurationMs: number;
  /** Most frequent error code, or null if no failures. */
  topErrorCode: string | null;
}

/** Aggregated diagnostics summary. */
export interface DiagnosticsReport {
  /** Period analyzed (ISO-8601 start and end). */
  period: { from: string; to: string };
  /** Total events in period. */
  totalEvents: number;
  /** Top 10 commands by failure rate (min 5 invocations). */
  topFailing: CommandStats[];
  /** Top 10 slowest commands by average duration. */
  topSlow: CommandStats[];
  /** Commands invoked exactly once (potential dead ends). */
  rareCommands: string[];
  /** High-signal observations suitable for BRAIN storage. */
  observations: string[];
}

/** Global telemetry config stored in ~/.local/share/cleo/telemetry-config.json */
export interface TelemetryConfig {
  /** Whether telemetry collection is enabled. */
  enabled: boolean;
  /** Anonymous UUID stable across invocations. Generated on first enable. */
  anonymousId: string;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

const TELEMETRY_CONFIG_FILENAME = 'telemetry-config.json';

/** Return the path to the telemetry config JSON file. */
export function getTelemetryConfigPath(): string {
  return join(getCleoHome(), TELEMETRY_CONFIG_FILENAME);
}

/** Load telemetry config from disk. Returns default (disabled) config if absent. */
export function loadTelemetryConfig(): TelemetryConfig {
  const path = getTelemetryConfigPath();
  if (!existsSync(path)) {
    return { enabled: false, anonymousId: '' };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TelemetryConfig;
  } catch {
    return { enabled: false, anonymousId: '' };
  }
}

/** Persist telemetry config to disk. */
export function saveTelemetryConfig(config: TelemetryConfig): void {
  const path = getTelemetryConfigPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/** Return true if telemetry collection is currently enabled. */
export function isTelemetryEnabled(): boolean {
  return loadTelemetryConfig().enabled;
}

/**
 * Enable telemetry and generate a stable anonymous ID.
 * Idempotent — calling again preserves the existing anonymousId.
 */
export function enableTelemetry(): TelemetryConfig {
  const existing = loadTelemetryConfig();
  const config: TelemetryConfig = {
    enabled: true,
    anonymousId: existing.anonymousId || randomUUID(),
  };
  saveTelemetryConfig(config);
  return config;
}

/**
 * Disable telemetry collection.
 * Existing data in telemetry.db is not deleted.
 */
export function disableTelemetry(): TelemetryConfig {
  const existing = loadTelemetryConfig();
  const config: TelemetryConfig = { ...existing, enabled: false };
  saveTelemetryConfig(config);
  return config;
}

// ---------------------------------------------------------------------------
// Event recording
// ---------------------------------------------------------------------------

/**
 * Record one telemetry event.
 * Fire-and-forget — errors are swallowed; never blocks the calling command.
 * No-op when telemetry is disabled.
 */
export async function recordTelemetryEvent(event: TelemetryEvent): Promise<void> {
  const config = loadTelemetryConfig();
  if (!config.enabled || !config.anonymousId) return;

  try {
    const db = await getTelemetryDb();
    const command = `${event.domain}.${event.operation}`;
    await db
      .insert(telemetryEvents)
      .values({
        id: randomUUID(),
        anonymousId: config.anonymousId,
        domain: event.domain,
        gateway: event.gateway,
        operation: event.operation,
        command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        errorCode: event.errorCode ?? null,
        timestamp: new Date().toISOString(),
      })
      .run();
  } catch {
    // Non-fatal: telemetry must never crash the calling command.
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp N days ago. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * Build a diagnostics report over the last `days` days (default 30).
 * Requires telemetry to be enabled; returns null if disabled or no data.
 */
export async function buildDiagnosticsReport(days = 30): Promise<DiagnosticsReport | null> {
  const config = loadTelemetryConfig();
  if (!config.enabled) return null;

  const db = await getTelemetryDb();
  const from = daysAgo(days);
  const to = new Date().toISOString();

  // Total events in window
  const [totalRow] = await db
    .select({ n: count(telemetryEvents.id) })
    .from(telemetryEvents)
    .where(gt(telemetryEvents.timestamp, from))
    .all();
  const totalEvents = totalRow?.n ?? 0;

  if (totalEvents === 0)
    return {
      period: { from, to },
      totalEvents: 0,
      topFailing: [],
      topSlow: [],
      rareCommands: [],
      observations: [],
    };

  // Per-command aggregates
  const rows = await db
    .select({
      command: telemetryEvents.command,
      total: count(telemetryEvents.id),
      failures: sql<number>`SUM(CASE WHEN ${telemetryEvents.exitCode} != 0 THEN 1 ELSE 0 END)`,
      avgMs: sql<number>`AVG(${telemetryEvents.durationMs})`,
      maxMs: sql<number>`MAX(${telemetryEvents.durationMs})`,
    })
    .from(telemetryEvents)
    .where(gt(telemetryEvents.timestamp, from))
    .groupBy(telemetryEvents.command)
    .all();

  // Get top error code per command
  const errorCodeRows = await db
    .select({
      command: telemetryEvents.command,
      errorCode: telemetryEvents.errorCode,
      n: count(telemetryEvents.id),
    })
    .from(telemetryEvents)
    .where(and(gt(telemetryEvents.timestamp, from), sql`${telemetryEvents.errorCode} IS NOT NULL`))
    .groupBy(telemetryEvents.command, telemetryEvents.errorCode)
    .orderBy(desc(count(telemetryEvents.id)))
    .all();

  // Build a map: command → top error code
  const topErrorMap = new Map<string, string>();
  for (const r of errorCodeRows) {
    if (!topErrorMap.has(r.command)) {
      topErrorMap.set(r.command, r.errorCode ?? '');
    }
  }

  // Build CommandStats
  const stats: CommandStats[] = rows.map((r) => {
    const failures = Number(r.failures) || 0;
    const total = Number(r.total) || 0;
    return {
      command: r.command,
      count: total,
      failureCount: failures,
      failureRate: total > 0 ? failures / total : 0,
      avgDurationMs: Math.round(Number(r.avgMs) || 0),
      maxDurationMs: Math.round(Number(r.maxMs) || 0),
      topErrorCode: topErrorMap.get(r.command) ?? null,
    };
  });

  // Top failing (min 5 invocations, sorted by failure rate desc)
  const topFailing = stats
    .filter((s) => s.count >= 5 && s.failureRate > 0)
    .sort((a, b) => b.failureRate - a.failureRate)
    .slice(0, 10);

  // Top slowest (sorted by avgDurationMs desc)
  const topSlow = [...stats].sort((a, b) => b.avgDurationMs - a.avgDurationMs).slice(0, 10);

  // Rare commands (invoked only once in the window)
  const rareCommands = stats.filter((s) => s.count === 1).map((s) => s.command);

  // Generate high-signal observations for BRAIN
  const observations: string[] = [];
  for (const s of topFailing.slice(0, 5)) {
    const pct = Math.round(s.failureRate * 100);
    const errPart = s.topErrorCode ? ` (most common error: ${s.topErrorCode})` : '';
    observations.push(
      `Command '${s.command}' fails ${pct}% of the time across ${s.count} invocations${errPart}. Investigate root cause.`,
    );
  }
  // Flag commands 2x slower than median
  const sortedAvg = stats.map((s) => s.avgDurationMs).sort((a, b) => a - b);
  const median = sortedAvg[Math.floor(sortedAvg.length / 2)] ?? 0;
  for (const s of topSlow.slice(0, 5)) {
    if (median > 0 && s.avgDurationMs > median * 2) {
      observations.push(
        `Command '${s.command}' averages ${s.avgDurationMs}ms — ${Math.round(s.avgDurationMs / median)}x slower than the ${median}ms median. Profile for performance improvement.`,
      );
    }
  }

  return { period: { from, to }, totalEvents, topFailing, topSlow, rareCommands, observations };
}

/**
 * Export all telemetry events as a JSON array.
 * Returns empty array when telemetry is disabled or DB is empty.
 */
export async function exportTelemetryEvents(days?: number): Promise<TelemetryEvent[]> {
  const config = loadTelemetryConfig();
  if (!config.enabled) return [];

  const db = await getTelemetryDb();
  const rows = days
    ? await db
        .select()
        .from(telemetryEvents)
        .where(gt(telemetryEvents.timestamp, daysAgo(days)))
        .orderBy(desc(telemetryEvents.timestamp))
        .all()
    : await db.select().from(telemetryEvents).orderBy(desc(telemetryEvents.timestamp)).all();

  return rows.map((r) => ({
    domain: r.domain,
    gateway: r.gateway as 'query' | 'mutate',
    operation: r.operation,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    errorCode: r.errorCode,
  }));
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export * from './schema.js';
export { getTelemetryDb, getTelemetryDbPath } from './sqlite.js';

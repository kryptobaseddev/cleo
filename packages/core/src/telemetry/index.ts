/**
 * Telemetry module — opt-in command telemetry for CLEO self-improvement.
 *
 * Entry point for all telemetry operations:
 *   - Recording events (buffered in-process, flushed on exit — T9051)
 *   - Querying patterns for `cleo diagnostics analyze`
 *   - Managing the anonymous ID and opt-in state
 *   - Emitting BRAIN observations from high-signal patterns
 *   - Retention / rotation (prune events older than N days — T9051)
 *
 * Telemetry is DISABLED by default. Enable with `cleo diagnostics enable`.
 * Opt-in is EXPLICIT — no data is written until the user runs that command.
 * New installs start with an absent config file, which resolves to disabled.
 *
 * @task T624
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, count, desc, gt, lt, sql } from 'drizzle-orm';
import { getCleoHome } from '../paths.js';
import { telemetryEvents } from '../store/schema/telemetry-schema.js';
import { withWriterLease } from '../store/writer-lease.js';
import { getTelemetryDb } from './sqlite.js';

// ---------------------------------------------------------------------------
// In-process event buffer (T9051)
// ---------------------------------------------------------------------------
// Events are buffered in memory and flushed as a single batch:
//   - When the buffer reaches TELEMETRY_BUFFER_MAX_EVENTS, OR
//   - When the process exits (via beforeExit / SIGINT / SIGTERM handlers).
//
// This prevents N concurrent SQLite writers on every CLI invocation. Each
// process owns exactly one buffer that drains once. Fire-and-forget: errors
// in the flush path are swallowed — telemetry must never surface to users.

/** Maximum events to buffer before an early flush. */
const TELEMETRY_BUFFER_MAX_EVENTS = 50;

/** Buffered events waiting to be flushed. */
const _telemetryBuffer: Array<Parameters<typeof _insertTelemetryRow>[0]> = [];

/** True once the process exit handlers have been registered. */
let _exitHandlersRegistered = false;

/** True while a flush is in-progress (prevents double-flush on exit). */
let _flushInProgress = false;

/**
 * Flush all buffered telemetry events to telemetry.db in one batch.
 *
 * Called automatically on process exit and when the buffer reaches capacity.
 * Errors are swallowed — telemetry must never crash the process.
 *
 * @internal
 */
async function _flushTelemetryBuffer(): Promise<void> {
  if (_flushInProgress || _telemetryBuffer.length === 0) return;
  _flushInProgress = true;
  const batch = _telemetryBuffer.splice(0, _telemetryBuffer.length);
  try {
    // Seam 3 (T11627): telemetry.db is a raw bypass writer (global-tier, sidesteps
    // the tasks chokepoint). Hold the global `bulk` lease for the whole flush batch
    // so the writes serialize against other writers. `off` mode → pass-through.
    await withWriterLease('global', 'bulk', async () => {
      const db = await getTelemetryDb();
      for (const row of batch) {
        await db.insert(telemetryEvents).values(row).run();
      }
    });
  } catch {
    // Non-fatal — telemetry flush must never surface errors.
  } finally {
    _flushInProgress = false;
  }
}

/**
 * Register process exit handlers to flush the buffer once on process teardown.
 * Safe to call multiple times — handlers are only attached once.
 *
 * @internal
 */
function _ensureExitHandlers(): void {
  if (_exitHandlersRegistered) return;
  _exitHandlersRegistered = true;

  // 'beforeExit' fires when the event loop empties — best-effort flush.
  process.on('beforeExit', () => {
    void _flushTelemetryBuffer();
  });
  // SIGINT / SIGTERM: synchronous-safe best-effort (do not await in handlers).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void _flushTelemetryBuffer();
    });
  }
}

// ---------------------------------------------------------------------------
// Retention / rotation (T9051)
// ---------------------------------------------------------------------------

/**
 * Default retention window in days.
 * Events older than this are deleted during pruning.
 */
export const TELEMETRY_RETENTION_DAYS = 90;

/**
 * Maximum row count before the table is pruned regardless of age.
 * Prevents unbounded growth on long-lived installs.
 */
export const TELEMETRY_MAX_ROWS = 50_000;

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
// Event recording (T9051: buffered writes)
// ---------------------------------------------------------------------------

/**
 * Shape of a row passed to the telemetry_events Drizzle insert.
 * Typed here so _telemetryBuffer can carry pre-built rows.
 *
 * @internal
 */
interface _TelemetryRow {
  id: string;
  anonymousId: string;
  domain: string;
  gateway: string;
  operation: string;
  command: string;
  exitCode: number;
  durationMs: number;
  errorCode: string | null;
  timestamp: string;
}

/**
 * Insert a single pre-built row.
 *
 * @internal Only called from _flushTelemetryBuffer.
 */
async function _insertTelemetryRow(row: _TelemetryRow): Promise<void> {
  const db = await getTelemetryDb();
  await db.insert(telemetryEvents).values(row).run();
}

/**
 * Record one telemetry event.
 *
 * Events are buffered in-process (T9051) and flushed on process exit or when
 * the buffer reaches {@link TELEMETRY_BUFFER_MAX_EVENTS}. Fire-and-forget —
 * errors are swallowed; never blocks the calling command.
 *
 * No-op when telemetry is disabled (opt-in required per T9051 privacy posture).
 */
export async function recordTelemetryEvent(event: TelemetryEvent): Promise<void> {
  const config = loadTelemetryConfig();
  if (!config.enabled || !config.anonymousId) return;

  try {
    const command = `${event.domain}.${event.operation}`;
    const row: _TelemetryRow = {
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
    };

    // Buffer the row in-process. Flush immediately when the buffer is full.
    _telemetryBuffer.push(row);
    _ensureExitHandlers();

    if (_telemetryBuffer.length >= TELEMETRY_BUFFER_MAX_EVENTS) {
      void _flushTelemetryBuffer();
    }
  } catch {
    // Non-fatal: telemetry must never crash the calling command.
  }
}

/**
 * Flush any buffered telemetry events immediately.
 *
 * Exposed for testing and for callers that need deterministic flushing
 * (e.g. the diagnostics analyze command). Not required in normal usage.
 */
export async function flushTelemetryBuffer(): Promise<void> {
  await _flushTelemetryBuffer();
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
// Retention / rotation (T9051)
// ---------------------------------------------------------------------------

/**
 * Prune telemetry events older than `retentionDays` days.
 *
 * Also enforces the max-row cap: when the table exceeds
 * {@link TELEMETRY_MAX_ROWS}, the oldest rows beyond the cap are deleted.
 *
 * Call this from `cleo diagnostics analyze` (or a periodic maintenance job)
 * to prevent unbounded database growth.
 *
 * @param retentionDays - Events older than this many days are deleted.
 *   Defaults to {@link TELEMETRY_RETENTION_DAYS} (90 days).
 * @returns Number of rows deleted.
 */
export async function pruneOldTelemetryEvents(
  retentionDays: number = TELEMETRY_RETENTION_DAYS,
): Promise<number> {
  try {
    const db = await getTelemetryDb();

    // Step 1: delete by age cutoff.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffIso = cutoff.toISOString();

    // Count before age-cutoff delete.
    const [beforeAge] = await db.select({ total: count() }).from(telemetryEvents).all();
    await db.delete(telemetryEvents).where(lt(telemetryEvents.timestamp, cutoffIso)).run();
    const [afterAge] = await db.select({ total: count() }).from(telemetryEvents).all();
    const byAge = (beforeAge?.total ?? 0) - (afterAge?.total ?? 0);

    // Step 2: enforce max-row cap.
    // Count remaining rows; if still over cap, delete oldest excess.
    const remaining = afterAge?.total ?? 0;
    let byCap = 0;
    if (remaining > TELEMETRY_MAX_ROWS) {
      const excess = remaining - TELEMETRY_MAX_ROWS;
      // Identify the timestamp of the (excess)-th oldest row.
      const [oldest] = await db
        .select({ timestamp: telemetryEvents.timestamp })
        .from(telemetryEvents)
        .orderBy(telemetryEvents.timestamp)
        .limit(excess)
        .all();
      if (oldest) {
        const [beforeCap] = await db.select({ total: count() }).from(telemetryEvents).all();
        await db
          .delete(telemetryEvents)
          .where(lt(telemetryEvents.timestamp, oldest.timestamp))
          .run();
        const [afterCap] = await db.select({ total: count() }).from(telemetryEvents).all();
        byCap = (beforeCap?.total ?? 0) - (afterCap?.total ?? 0);
      }
    }

    return byAge + byCap;
  } catch {
    // Non-fatal — retention pruning must never crash callers.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Reset the in-process telemetry buffer and exit-handler registration state.
 *
 * FOR TESTING ONLY. Ensures each test starts with a clean buffer so that
 * events from previous tests do not bleed into subsequent test assertions.
 *
 * @internal
 */
export function resetTelemetryBufferState(): void {
  _telemetryBuffer.length = 0;
  _exitHandlersRegistered = false;
  _flushInProgress = false;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export * from '../store/schema/telemetry-schema.js';
export { getTelemetryDb, getTelemetryDbPath } from './sqlite.js';

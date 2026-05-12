/**
 * Brain health dashboard — operator-facing status report for brain.db.
 *
 * Aggregates 8 named health flags for `cleo doctor brain`. Each flag includes
 * a count, status (ok/warn/fail), and a remediation hint pointing to the
 * relevant BBTT W-task.
 *
 * Read-only: MUST NOT write to brain.db or any persistent store.
 *
 * @module memory/brain-health-dashboard
 * @task T1908 (BBTT-W2-4)
 */

import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';

/** Health flag severity. */
export type HealthFlagStatus = 'ok' | 'warn' | 'fail';

/** A single named health flag in the dashboard. */
export interface HealthFlag {
  /** Short flag name (matches BBTT W-task reference). */
  name: string;
  /** Status level. */
  status: HealthFlagStatus;
  /** Numeric value (count, ratio %, etc.) for the underlying metric. */
  value: number;
  /** Human-readable description of what the flag measures. */
  description: string;
  /** Remediation hint — which BBTT W-task to consult. */
  remediationHint: string;
  /** True when this flag is P0 (triggers exit code 1 in `cleo doctor brain`). */
  isP0: boolean;
}

/** Full brain health dashboard result. */
export interface BrainHealthDashboard {
  /** All health flags. */
  flags: HealthFlag[];
  /** Total brain_observations row count. */
  totalObservations: number;
  /** True if any P0 flag is in `fail` state. */
  hasP0Failure: boolean;
  /** ISO timestamp of report generation. */
  generatedAt: string;
}

/**
 * Compute the brain health dashboard by running read-only queries against brain.db.
 *
 * Returns a structured report with 8 named flags. Callers should check
 * `hasP0Failure` and exit with code 1 when true.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 *
 * @task T1908
 */
export async function computeBrainHealthDashboard(
  projectRoot: string,
): Promise<BrainHealthDashboard> {
  const flags: HealthFlag[] = [];
  let totalObservations = 0;

  try {
    // Initialise the brain DB so getBrainNativeDb() is populated.
    await getBrainDb(projectRoot);
    const ndb = getBrainNativeDb();
    if (!ndb) throw new Error('brain.db not initialised');

    // 1. Row counts
    const obsCount = rawCount(ndb, 'brain_observations');
    const decCount = rawCount(ndb, 'brain_decisions');
    const patCount = rawCount(ndb, 'brain_patterns');
    const lrnCount = rawCount(ndb, 'brain_learnings');
    totalObservations = obsCount;

    flags.push({
      name: 'row-counts',
      status: obsCount > 0 ? 'ok' : 'warn',
      value: obsCount,
      description: `brain_observations=${obsCount} decisions=${decCount} patterns=${patCount} learnings=${lrnCount}`,
      remediationHint: 'Run `cleo memory observe` to populate brain entries (BBTT-W2)',
      isP0: false,
    });

    // 2. Dedup ratio (duplicate content hash %)
    const dupCount = rawDuplicateCount(ndb);
    const dupRatio = obsCount > 0 ? Math.round((dupCount / obsCount) * 100) : 0;
    flags.push({
      name: 'dedup-ratio',
      status: dupRatio > 20 ? 'fail' : dupRatio > 5 ? 'warn' : 'ok',
      value: dupRatio,
      description: `${dupCount} duplicate content hashes (${dupRatio}% of observations)`,
      remediationHint: 'Run `cleo memory consolidate` or see BBTT-W1-2 (T1896)',
      isP0: dupRatio > 20,
    });

    // 3. Last consolidation age (days since most recent consolidation event)
    const lastConsolidationDays = rawLastConsolidationAge(ndb);
    flags.push({
      name: 'last-consolidation',
      status: lastConsolidationDays === null ? 'warn' : lastConsolidationDays > 7 ? 'warn' : 'ok',
      value: lastConsolidationDays ?? -1,
      description:
        lastConsolidationDays === null
          ? 'No consolidation events recorded'
          : `Last consolidation: ${lastConsolidationDays}d ago`,
      remediationHint: 'Run `cleo memory dream` to consolidate (BBTT-W2-3, T1904)',
      isP0: false,
    });

    // 4. Recency violations (observations older than 30d with no retrieval)
    const staleCount = rawStaleCount(ndb, 30);
    flags.push({
      name: 'recency-violations',
      status: staleCount > 100 ? 'fail' : staleCount > 20 ? 'warn' : 'ok',
      value: staleCount,
      description: `${staleCount} observations older than 30d with zero retrieval`,
      remediationHint: 'See BBTT-W1-3 BriefingFieldContract (T1905) + memory purge',
      isP0: staleCount > 100,
    });

    // 5. Learnings ratio (learnings / observations %)
    const lrnRatio = obsCount > 0 ? Math.round((lrnCount / obsCount) * 100) : 0;
    flags.push({
      name: 'learnings-ratio',
      status: lrnRatio < 1 ? 'warn' : 'ok',
      value: lrnRatio,
      description: `${lrnCount} learnings for ${obsCount} observations (${lrnRatio}%)`,
      remediationHint: 'See BBTT-W3-5 auto-extract repair (T1903)',
      isP0: false,
    });

    // 6. Pattern bloat (patterns > 500 is a warning)
    flags.push({
      name: 'pattern-bloat',
      status: patCount > 1000 ? 'fail' : patCount > 500 ? 'warn' : 'ok',
      value: patCount,
      description: `${patCount} patterns in brain_patterns`,
      remediationHint: 'See BBTT-W1-2 pattern dedup at consolidation time (T1896)',
      isP0: false,
    });

    // 7. Fixture pollution (observations with provenance='test-fixture')
    const fixtureCount = rawProvenanceCount(ndb, 'test-fixture');
    flags.push({
      name: 'fixture-pollution',
      status: fixtureCount > 0 ? 'fail' : 'ok',
      value: fixtureCount,
      description: `${fixtureCount} brain_observations with provenance='test-fixture'`,
      remediationHint: 'See BBTT-W3-3 scan-test-fixtures-in-prod (T1909)',
      isP0: fixtureCount > 0,
    });

    // 8. Daemon liveness (brain dream daemon last heartbeat < 24h)
    const daemonAge = rawDaemonHeartbeatAge(ndb);
    flags.push({
      name: 'daemon-liveness',
      status: daemonAge === null ? 'warn' : daemonAge > 24 ? 'warn' : 'ok',
      value: daemonAge ?? -1,
      description:
        daemonAge === null
          ? 'No dream daemon heartbeat recorded'
          : `Dream daemon last heartbeat: ${daemonAge}h ago`,
      remediationHint: 'See BBTT-W2-1 `cleo memory dream --status` (T1895)',
      isP0: false,
    });
  } catch {
    // brain.db unavailable — return single-fail dashboard
    flags.push({
      name: 'brain-db-unavailable',
      status: 'fail',
      value: 0,
      description: 'brain.db could not be opened',
      remediationHint: 'Run `cleo init` or check .cleo/ directory permissions',
      isP0: true,
    });
  }

  const hasP0Failure = flags.some((f) => f.isP0 && f.status === 'fail');

  return {
    flags,
    totalObservations,
    hasP0Failure,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Private synchronous raw-query helpers (DatabaseSync, read-only)
// ---------------------------------------------------------------------------

type NativeDb = NonNullable<ReturnType<typeof getBrainNativeDb>>;

function rawCount(ndb: NativeDb, table: string): number {
  try {
    const stmt = ndb.prepare(`SELECT COUNT(*) as c FROM ${table}`);
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function rawDuplicateCount(ndb: NativeDb): number {
  try {
    const stmt = ndb.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT content FROM brain_observations
        WHERE content IS NOT NULL AND content != ''
        GROUP BY content HAVING COUNT(*) > 1
      )
    `);
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function rawLastConsolidationAge(ndb: NativeDb): number | null {
  try {
    const stmt = ndb.prepare(`
      SELECT MAX(createdAt) as last_at FROM brain_observations
      WHERE type = 'consolidation' OR provenance = 'consolidation'
    `);
    const row = stmt.get() as { last_at: string | null } | undefined;
    const lastAt = row?.last_at;
    if (!lastAt) return null;
    return Math.round((Date.now() - new Date(lastAt).getTime()) / 86_400_000);
  } catch {
    return null;
  }
}

function rawStaleCount(ndb: NativeDb, maxAgeDays: number): number {
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    const stmt = ndb.prepare(`
      SELECT COUNT(*) as c FROM brain_observations
      WHERE createdAt < ?
    `);
    const row = stmt.get(cutoff) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function rawProvenanceCount(ndb: NativeDb, provenance: string): number {
  try {
    const stmt = ndb.prepare(`
      SELECT COUNT(*) as c FROM brain_observations WHERE provenance = ?
    `);
    const row = stmt.get(provenance) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function rawDaemonHeartbeatAge(ndb: NativeDb): number | null {
  try {
    const stmt = ndb.prepare(`
      SELECT MAX(createdAt) as last_at FROM brain_observations
      WHERE type = 'daemon-heartbeat' OR provenance = 'dream-daemon'
    `);
    const row = stmt.get() as { last_at: string | null } | undefined;
    const lastAt = row?.last_at;
    if (!lastAt) return null;
    return Math.round((Date.now() - new Date(lastAt).getTime()) / 3_600_000);
  } catch {
    return null;
  }
}

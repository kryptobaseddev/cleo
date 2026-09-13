/**
 * Assert the schema-residency invariant that nexus silently depends on.
 *
 * ## The invariant nobody wrote down (gh#1298 · gh#1283)
 *
 * `ensureGlobalRegistryAttached()` ATTACHes the global `cleo.db` onto the
 * PROJECT handle as `nexus_global`, so that nexus registry tables resolve by
 * their BARE names through SQLite's fall-through. Its own comment states the
 * split:
 *
 *   > graph tables resolve to the project `main`; registry/identity tables fall
 *   > through to the attach.
 *
 * That split is correct **only while each bare name exists in exactly one of the
 * two schemas.** SQLite resolves an unqualified name by searching `temp`, then
 * `main`, then attached schemas in attach order — so a table present in BOTH is
 * answered by `main` with no error and no cue. Nexus is therefore correct today
 * **by resolution order, not by the invariant it documents**, and nothing fails
 * if that stops being true.
 *
 * ## It is already half-false
 *
 * ADR-090 / T11538 moved the four code-graph tables (`nexus_nodes`,
 * `nexus_relations`, `nexus_contracts`, `nexus_code_index`) into the project
 * scope, and T11539 removed them from the global schema source. **No migration
 * drops them from a database that already has them** — removing a table from a
 * schema module does not remove it from disk. So a global `cleo.db` created
 * before that change still carries all four, at 0 rows, shadowing the populated
 * project copies.
 *
 * Measured 2026-09-12: project `nexus_nodes` = 26,964 and `nexus_relations` =
 * 75,500; the global copies are present and empty. Today the right side wins
 * because `main` is the project. If anything ever reads them from a handle
 * whose `main` is the GLOBAL store, it gets **0 rows — an empty graph,
 * indistinguishable from "nothing has been indexed yet"**, which is precisely
 * the symptom this project has already lost a session to.
 *
 * ## Why this reports rather than repairs
 *
 * A blind `DROP TABLE` would be wrong. This install's global copies are empty,
 * but an install that used nexus BEFORE the residency move wrote its graph
 * rows to the global store, and no migration relocated them. There, the four
 * tables may hold the only copy. Dropping on the strength of one machine's
 * measurement is the same error as inferring a rule from the rows it is then
 * used to exempt.
 *
 * So this scan reports `safeToDrop` per table, and only ever for an EMPTY one.
 * A populated orphan is a data-migration question for the owner, not a cleanup.
 *
 * @task T12158
 * @see ADR-090 §2.1 — nexus graph residency
 * @see ADR-092 — failure geometries
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';

/**
 * Tables nexus resolves by BARE name through the `nexus_global` attach.
 *
 * Each MUST exist in exactly one of the two schemas. Sourced from
 * `schema/cleo-global/nexus.ts`, which is their only declaration.
 */
export const NEXUS_FALLTHROUGH_TABLES = [
  'nexus_audit_log',
  'nexus_project_id_aliases',
  'nexus_project_registry',
  'nexus_sigils',
  'nexus_user_profile',
] as const;

/**
 * Code-graph tables that moved to the project scope under ADR-090 / T11538.
 *
 * They must NOT be present in the global store. Any that are, are orphans left
 * by a schema removal that never became a migration.
 */
export const NEXUS_PROJECT_GRAPH_TABLES = [
  'nexus_code_index',
  'nexus_contracts',
  'nexus_nodes',
  'nexus_relations',
] as const;

/** One table that is resident where it should not be. */
export interface NexusResidencyFinding {
  /** The table name. */
  readonly table: string;
  /** What is wrong with where it lives. */
  readonly kind: 'orphaned-in-global' | 'ambiguous-fallthrough';
  /** Rows in the offending copy. */
  readonly rows: number;
  /**
   * Whether removing the offending copy is provably lossless.
   *
   * Only ever `true` for an empty table. A populated orphan may hold the only
   * copy on an install that predates the residency move, so it is a migration
   * question rather than a cleanup.
   */
  readonly safeToDrop: boolean;
}

/** The result of a residency audit. */
export interface NexusResidencyScanResult {
  /** Absolute path of the project store. */
  readonly projectStorePath: string;
  /** Absolute path of the global store. */
  readonly globalStorePath: string;
  /** `false` when either store is missing; findings are then empty. */
  readonly bothStoresExist: boolean;
  /** Tables resident where they should not be. */
  readonly findings: readonly NexusResidencyFinding[];
  /** Findings whose removal is provably lossless. */
  readonly safeToDropCount: number;
  /**
   * Findings that are NOT safe to drop — a populated orphan, or a bare name
   * that resolves in two schemas. These need a decision, not a cleanup.
   */
  readonly needsDecisionCount: number;
}

/** Does `table` exist in the database behind `snapshot`? */
function tableExists(db: ReturnType<typeof openCleoDbSnapshot>['db'], table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/** Count rows in `table`, or 0 when it cannot be read. */
function countRows(db: ReturnType<typeof openCleoDbSnapshot>['db'], table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get();
    const c = row?.['c'];
    if (typeof c === 'number') return c;
    if (typeof c === 'bigint') return Number(c);
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Audit where the nexus tables actually live, against where they must live.
 *
 * Read-only — opens both stores as snapshots and writes nothing.
 *
 * @param projectRoot - absolute path to the project root.
 * @param cleoHome - absolute path to the global cleo home.
 * @returns the audit; `findings` is empty when residency is correct.
 *
 * @task T12158
 */
export function scanNexusSchemaResidency(
  projectRoot: string,
  cleoHome: string,
): NexusResidencyScanResult {
  const projectStorePath = join(projectRoot, '.cleo', 'cleo.db');
  const globalStorePath = join(cleoHome, 'cleo.db');

  if (!existsSync(projectStorePath) || !existsSync(globalStorePath)) {
    return {
      projectStorePath,
      globalStorePath,
      bothStoresExist: false,
      findings: [],
      safeToDropCount: 0,
      needsDecisionCount: 0,
    };
  }

  const project = openCleoDbSnapshot(projectStorePath);
  try {
    const global = openCleoDbSnapshot(globalStorePath);
    try {
      const findings: NexusResidencyFinding[] = [];

      // Graph tables must live ONLY in the project store.
      for (const table of NEXUS_PROJECT_GRAPH_TABLES) {
        if (!tableExists(global.db, table)) continue;
        const rows = countRows(global.db, table);
        findings.push({
          table,
          kind: 'orphaned-in-global',
          rows,
          safeToDrop: rows === 0,
        });
      }

      // Fall-through tables must resolve in exactly ONE schema. Present in both
      // means a bare name silently answers from `main` — the project — while
      // every caller believes it is reading the global registry.
      for (const table of NEXUS_FALLTHROUGH_TABLES) {
        if (!tableExists(project.db, table)) continue;
        findings.push({
          table,
          kind: 'ambiguous-fallthrough',
          rows: countRows(project.db, table),
          // Never safe automatically: which copy is authoritative is exactly
          // the question, and the bare-name reads have been answering from the
          // project copy for as long as it has existed.
          safeToDrop: false,
        });
      }

      return {
        projectStorePath,
        globalStorePath,
        bothStoresExist: true,
        findings,
        safeToDropCount: findings.filter((f) => f.safeToDrop).length,
        needsDecisionCount: findings.filter((f) => !f.safeToDrop).length,
      };
    } finally {
      global.close();
    }
  } finally {
    project.close();
  }
}

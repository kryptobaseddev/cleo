/**
 * `cleo doctor exodus` core — read-only exodus health report (T11837).
 *
 * The fleet pre-check the owner flow opens with: a single, read-only snapshot of
 * where each scope stands so an operator (or the rollout automation) can route
 * the next step — already-sealed, migrated-but-unsealed (→ `cleo exodus seal`),
 * fresh-needs-migration, or no-cleo-data — and so any LARGE legacy DB is flagged
 * for individual attention before the streamed-verify build touches it.
 *
 * Pure assembly over existing primitives (`buildExodusPlan`, `runExodusStatus`,
 * `hasExodusCompleteMarker`, `detectStrandedResidue`, {@link computeCountParity}).
 * Never writes; never runs the heavy digest.
 *
 * @task T11837 (fleet-flow surface — exodus health-check)
 * @epic T11833 (EP-EXODUS-FLEET-HARDENING)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 */

import { existsSync, statSync } from 'node:fs';
import { hasExodusCompleteMarker } from './archive.js';
import { computeCountParity } from './count-parity.js';
import { buildExodusPlan } from './plan.js';
import type { ExodusScope } from './types.js';

/** Legacy DBs at or above this size are flagged for individual rollout attention. */
const LARGE_DB_BYTES = 500 * 1024 * 1024;

/** Per-scope migration state. */
export type ExodusScopeState =
  | 'sealed' // completion marker present — done, on-open inert
  | 'migrated-unsealed' // data in cleo.db, legacy present, NO marker → run `cleo exodus seal`
  | 'needs-migration' // legacy present, consolidated missing/empty/deficit
  | 'no-cleo-data'; // no legacy sources and no marker (fresh install or fully cleaned)

/** One legacy source DB's presence + size. */
export interface ExodusSourceHealth {
  readonly name: string;
  readonly path: string;
  readonly present: boolean;
  readonly bytes: number;
  /** `true` when `bytes >= LARGE_DB_BYTES` (route through streamed-verify build). */
  readonly large: boolean;
}

/** Health of one scope (project | global). */
export interface ExodusScopeHealth {
  readonly scope: ExodusScope;
  readonly state: ExodusScopeState;
  readonly consolidatedExists: boolean;
  readonly markerPresent: boolean;
  readonly legacySources: readonly ExodusSourceHealth[];
  readonly strandedResidue: readonly string[];
}

/** Full read-only exodus health report. */
export interface ExodusHealth {
  readonly project: ExodusScopeHealth;
  readonly global: ExodusScopeHealth;
  /** Disk pre-flight (current 3×-of-sum policy). */
  readonly diskHeadroomOk: boolean;
  readonly availableBytes: number;
  readonly requiredBytes: number;
  /** Whether `CLEO_DISABLE_EXODUS_ON_OPEN` is set (the fleet brake). */
  readonly killSwitchSet: boolean;
  /** COUNT(*)-only data-continuity across present sources (no digest). */
  readonly dataParityOk: boolean;
  readonly dataDeficits: number;
  /** Legacy DBs ≥ 500 MB across both scopes (need individual attention). */
  readonly largeLegacyDbs: ReadonlyArray<{ name: string; scope: ExodusScope; bytes: number }>;
  /** Actionable next-step recommendations. */
  readonly recommendations: readonly string[];
}

/**
 * Build a read-only exodus health report for the current project + global scope.
 *
 * @param cwd - Working directory used to resolve the project `.cleo/` dir.
 * @returns The assembled {@link ExodusHealth}.
 *
 * @task T11837
 */
export function buildExodusHealth(cwd: string | undefined): ExodusHealth {
  const plan = buildExodusPlan(cwd);
  const anyLegacyPresent = plan.sources.some((s) => existsSync(s.path));

  // COUNT(*)-only parity (no digest). Trivially ok when no legacy sources remain.
  const parity = anyLegacyPresent
    ? computeCountParity(plan.sources, plan.projectDbPath, plan.globalDbPath)
    : { ok: true, entries: [], deficits: [], checked: 0, skipped: 0 };

  const consolidatedExistsByScope: Record<ExodusScope, boolean> = {
    project: existsSync(plan.projectDbPath),
    global: existsSync(plan.globalDbPath),
  };

  const buildScope = (scope: ExodusScope): ExodusScopeHealth => {
    const sources: ExodusSourceHealth[] = plan.sources
      .filter((s) => s.targetScope === scope)
      .map((s) => {
        const present = existsSync(s.path);
        let bytes = 0;
        if (present) {
          try {
            bytes = statSync(s.path).size;
          } catch {
            bytes = 0;
          }
        }
        return { name: s.name, path: s.path, present, bytes, large: bytes >= LARGE_DB_BYTES };
      });
    const markerPresent = hasExodusCompleteMarker(scope, cwd);
    const legacyPresent = sources.some((s) => s.present);
    const consolidatedExists = consolidatedExistsByScope[scope];
    const scopeEntries = parity.entries.filter((e) => e.scope === scope);
    const scopeHasDeficit = scopeEntries.some((e) => e.deficit > 0);
    const scopeHasData = scopeEntries.some((e) => e.targetCount > 0);

    let state: ExodusScopeState;
    if (markerPresent) {
      state = 'sealed';
    } else if (legacyPresent && consolidatedExists && scopeHasData && !scopeHasDeficit) {
      state = 'migrated-unsealed';
    } else if (legacyPresent) {
      state = 'needs-migration';
    } else {
      state = 'no-cleo-data';
    }

    // Stranded residue is only meaningful once a marker exists for the scope.
    const stranded = sources.filter((s) => s.present && markerPresent).map((s) => s.name);

    return {
      scope,
      state,
      consolidatedExists,
      markerPresent,
      legacySources: sources,
      strandedResidue: stranded,
    };
  };

  const project = buildScope('project');
  const global = buildScope('global');

  const largeLegacyDbs = [
    ...project.legacySources
      .filter((s) => s.large)
      .map((s) => ({ name: s.name, scope: 'project' as const, bytes: s.bytes })),
    ...global.legacySources
      .filter((s) => s.large)
      .map((s) => ({ name: s.name, scope: 'global' as const, bytes: s.bytes })),
  ];

  const recommendations: string[] = [];
  for (const sc of [project, global]) {
    if (sc.state === 'migrated-unsealed') {
      recommendations.push(
        `${sc.scope}: data is consolidated but unsealed — run \`cleo exodus seal --scope ${sc.scope}\` to archive legacy DBs + stop on-open re-firing.`,
      );
    } else if (sc.state === 'needs-migration') {
      recommendations.push(
        `${sc.scope}: legacy data not yet consolidated — run \`cleo exodus migrate --scope ${sc.scope}\`.`,
      );
    } else if (sc.strandedResidue.length > 0) {
      recommendations.push(
        `${sc.scope}: ${sc.strandedResidue.length} stranded legacy DB(s) after a sealed cutover — run \`cleo doctor exodus-residue --fix\`.`,
      );
    }
  }
  if (largeLegacyDbs.length > 0) {
    recommendations.push(
      `${largeLegacyDbs.length} large legacy DB(s) (≥500 MB) — migrate these only with the streamed-verify build (T11834) to avoid the verify OOM.`,
    );
  }
  if (!parity.ok) {
    recommendations.push(
      `${parity.deficits.length} table(s) show a row deficit in cleo.db — DO NOT seal; run \`cleo exodus migrate\` first.`,
    );
  }

  return {
    project,
    global,
    diskHeadroomOk: plan.diskPreflight,
    availableBytes: plan.availableBytes,
    requiredBytes: 3 * plan.totalSourceBytes,
    killSwitchSet: process.env.CLEO_DISABLE_EXODUS_ON_OPEN === '1',
    dataParityOk: parity.ok,
    dataDeficits: parity.deficits.length,
    largeLegacyDbs,
    recommendations,
  };
}

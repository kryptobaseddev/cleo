/**
 * `cleo exodus seal` core — certify an already-migrated install (T11837).
 *
 * Some installs were cut over to the consolidated `cleo.db` BEFORE the archive +
 * completion-marker subsystem (T11777) existed: their data is fully in `cleo.db`
 * but the legacy source DBs were never archived and no `exodus-complete` marker
 * was written, so `exodus-on-open` keeps re-arming (the ~34s-per-command tax)
 * unless muzzled by `CLEO_DISABLE_EXODUS_ON_OPEN`. `cleo exodus migrate` would
 * complete the archival — but it routes through the heavy `verifyMigration`
 * digest, which OOMs on a 1.7 GB-class legacy `brain.db`.
 *
 * `sealExodus` closes the loop WITHOUT a destructive re-migrate and WITHOUT the
 * OOM digest: it gates on the memory-safe COUNT(*) deficit check
 * ({@link computeCountParity}) — the SAME gate (`target >= source`) the archive
 * path enforces — and, only when no rows are missing, archives the consumed
 * legacy sources (reversible move) and writes the per-scope completion marker.
 *
 * @task T11837 (fleet-flow surface — seal an already-migrated install)
 * @epic T11833 (EP-EXODUS-FLEET-HARDENING)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 */

import { getLogger } from '../../logger.js';
import { archiveSourceDb, hasExodusCompleteMarker, writeExodusCompleteMarker } from './archive.js';
import { type CountParityResult, computeCountParity } from './count-parity.js';
import type { ExodusPlan, ExodusScope } from './types.js';

const log = getLogger('exodus-seal');

/** Scope selector for {@link sealExodus}. */
export type SealScopeArg = ExodusScope | 'both';

/** Per-scope outcome of a seal. */
export interface SealScopeOutcome {
  /** Scope certified. */
  readonly scope: ExodusScope;
  /** `true` if a completion marker already existed (re-seal is idempotent). */
  readonly alreadySealed: boolean;
  /** Per-source archive outcomes for this scope. */
  readonly archived: ReadonlyArray<{
    readonly name: string;
    readonly action: 'archived' | 'absent';
    readonly archivedTo: string | null;
  }>;
  /** Absolute path of the completion marker written. */
  readonly markerPath: string;
}

/** Result of {@link sealExodus}. */
export interface SealResult {
  /** `true` when the seal proceeded; `false` when refused on a parity deficit. */
  readonly ok: boolean;
  /** Populated when `ok === false`: why the seal was refused. */
  readonly refusedReason?: string;
  /** The COUNT(*)-only parity sweep that gated the seal. */
  readonly parity: CountParityResult;
  /** Per-scope outcomes (empty when refused). */
  readonly scopes: readonly SealScopeOutcome[];
}

/** Resolve a {@link SealScopeArg} to the concrete scopes it covers. */
function resolveScopes(arg: SealScopeArg): ExodusScope[] {
  return arg === 'both' ? ['project', 'global'] : [arg];
}

/**
 * Seal one or more scopes of an already-migrated install: gate on COUNT(*) parity
 * (no digest), then archive the consumed legacy sources + write the completion
 * marker. Refuses (archives nothing) if ANY table has a deficit — the data is not
 * fully in `cleo.db` and the operator must run `cleo exodus migrate` first.
 *
 * Idempotent + reversible: archiving is a `rename` (never delete) and a re-seal
 * over an already-sealed scope simply refreshes the marker.
 *
 * @param plan     - The exodus plan (`buildExodusPlan(cwd)`).
 * @param scopeArg - Which scope(s) to seal.
 * @param cwd      - Working directory used to resolve the project dir.
 * @returns A {@link SealResult}.
 *
 * @task T11837
 */
export function sealExodus(
  plan: ExodusPlan,
  scopeArg: SealScopeArg,
  cwd: string | undefined,
): SealResult {
  // Memory-safe gate — NEVER the heavy verifyMigration digest (this whole epic
  // exists to avoid OOMing it on a 1.7 GB-class legacy brain.db).
  const parity = computeCountParity(plan.sources, plan.projectDbPath, plan.globalDbPath);

  if (!parity.ok) {
    const refusedReason =
      `Refusing to seal: ${parity.deficits.length} table(s) have FEWER rows in the ` +
      `consolidated cleo.db than the legacy source — the data is NOT fully migrated. Run ` +
      `\`cleo exodus migrate\` first. Deficits: ${parity.deficits
        .map((d) => `${d.targetTable}(${d.sourceCount}→${d.targetCount})`)
        .join(', ')}`;
    log.error({ deficits: parity.deficits.length }, `exodus seal refused — ${refusedReason}`);
    return { ok: false, refusedReason, parity, scopes: [] };
  }

  const outcomes: SealScopeOutcome[] = [];
  for (const scope of resolveScopes(scopeArg)) {
    const alreadySealed = hasExodusCompleteMarker(scope, cwd);
    const scopeSources = plan.sources.filter((s) => s.targetScope === scope);
    const archived = scopeSources.map((s) => {
      const r = archiveSourceDb(s, cwd);
      return { name: r.name, action: r.action, archivedTo: r.archivedTo };
    });
    const markerPath = writeExodusCompleteMarker(
      scope,
      scopeSources.map((s) => s.name),
      cwd,
    );
    log.info(
      { scope, alreadySealed, archived: archived.filter((a) => a.action === 'archived').length },
      `exodus seal: scope '${scope}' certified (count-parity verified, ${parity.checked} tables)`,
    );
    outcomes.push({ scope, alreadySealed, archived, markerPath });
  }

  return { ok: true, parity, scopes: outcomes };
}

/**
 * `cleo doctor row-identity --refill`: the explicit remedy for a store whose
 * identity predates the current recipe and that the open refused to refill
 * because it could not be proven unshared (T13231; spec `t12341-uid-scheme`
 * §12.1).
 *
 * A dry run by default. It prints the share verdict, its evidence (the local
 * link, vault and journal state, and what Cleo Nexus answered) and the rows
 * the refill would clear. `--apply` refills only when the verdict, with the
 * Nexus answer folded in, is `unshared`: a pre-refill `VACUUM INTO` snapshot,
 * then the from-scratch refill, inside the capture bracket when `sync.capture`
 * is on.
 *
 * Cleo Nexus is asked read-only, with this machine's device credential,
 * whether it holds ANY checkpoint or journal segment of the project from any
 * device. "Present" refuses: a uid in the cloud is never rewritten locally
 * (the future remedy is the T12344 re-key with aliases). "Unreachable" is
 * unknown, and unknown refuses.
 *
 * @module
 * @task T13231
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type {
  RowIdentityNexusAnswer,
  RowIdentityRefillReport,
  RowIdentityShareSignal,
  RowIdentityShareState,
} from '@cleocode/contracts';
import {
  getDualScopeNativeDb,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import {
  clearRowIdentityRefusal,
  fullRefillPlan,
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_REFILL_SNAPSHOT_KEY,
  readRowIdentityRefusal,
  rowIdentityRecipeCurrent,
  rowIdentityShareState,
  shareStateOf,
} from '../store/row-identity.js';
import { ROW_UID_FILL_FLAG, rowUidFillEnabled } from '../store/row-identity-flag.js';
import { hasTable } from '../store/sync/schema.js';

/** Asks Cleo Nexus for the project's history; defaults to `askNexusProjectHistory`. */
export type NexusHistoryProbe = (projectRoot: string) => Promise<RowIdentityNexusAnswer[]>;

/** Options of {@link rowIdentityRefill}. */
export interface RowIdentityRefillOptions {
  /** Refill when the verdict allows it; a dry run without it. */
  readonly apply?: boolean;
  /** The Nexus probe (tests inject a mock; never the real cloud in tests). */
  readonly probe?: NexusHistoryProbe;
}

const RE_KEY_REMEDY =
  'the cloud holds this project: its uids are never rewritten locally. The remedy is the re-key with aliases (T12344), not a refill';

/** Fold the Nexus answers into the local verdict. */
function verdictWith(
  local: RowIdentityShareState,
  nexus: readonly RowIdentityNexusAnswer[],
): RowIdentityShareState {
  // A linked store's `nexus-linked-no-vault` signal is resolved only when
  // every origin answered "none".
  const allNone = nexus.length > 0 && nexus.every((a) => a.answer === 'none');
  const signals: RowIdentityShareSignal[] = local.signals.filter(
    (s) => !(allNone && s.code === 'nexus-linked-no-vault'),
  );
  for (const a of nexus) {
    if (a.answer === 'present') {
      signals.push({
        code: 'nexus-checkpoint',
        kind: 'shared',
        detail: `${a.apiUrl} holds ${a.checkpoints} checkpoint(s) and journal head ${a.headSeq} for project ${a.remoteProjectId}`,
      });
    } else if (a.answer === 'error') {
      signals.push({
        code: 'nexus-unreachable',
        kind: 'unknown',
        detail: `${a.apiUrl} could not be asked: ${a.error ?? 'no answer'}`,
      });
    }
  }
  return shareStateOf(signals);
}

/** What to do next, from the verdict. */
function remedyOf(verdict: RowIdentityShareState, fillEnabled: boolean): string[] {
  const codes = new Set(verdict.signals.map((s) => s.code));
  const out: string[] = [];
  if (codes.has('nexus-checkpoint') || codes.has('vault-pushed')) out.push(RE_KEY_REMEDY);
  if (codes.has('nexus-unreachable')) {
    out.push('Cleo Nexus must answer: check `cleo login nexus` and the network, then re-run');
  }
  if (codes.has('unreadable')) out.push('repair or remove the unreadable file, then re-run');
  if (verdict.state === 'shared' && out.length === 0) {
    out.push(
      'local sync state references these uids: they are kept. The remedy is the re-key with aliases (T12344)',
    );
  }
  if (verdict.state === 'unshared' && !fillEnabled) {
    out.push(`set ${ROW_UID_FILL_FLAG}=1 for --apply (row uids are off in this process)`);
  }
  return out;
}

/** The undo instruction for a refill snapshot. */
function undoOf(projectRoot: string, snapshot: string): string {
  const db = resolveDualScopeDbPath('project', projectRoot);
  return (
    'STOP EVERY cleo PROCESS FIRST (agents, daemons, open terminals): a running writer would ' +
    'overwrite or corrupt the restored file. No `cleo restore` verb restores cleo.db from a named ' +
    'snapshot yet (T13240), so the undo is a file copy: ' +
    `cp '${snapshot}' '${db}' && rm -f '${db}-wal' '${db}-shm'`
  );
}

/** The snapshot the last full refill recorded, if any. */
function lastRefillSnapshot(db: DatabaseSync): string | null {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return null;
  const row = db
    .prepare(`SELECT value FROM main.${ROW_IDENTITY_META_TABLE} WHERE key = ?`)
    .get(ROW_IDENTITY_REFILL_SNAPSHOT_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Read the store's local verdict, marker and plan, read-only. */
function readLocal(dbPath: string): {
  local: RowIdentityShareState;
  recipeCurrent: boolean;
  planned: Record<string, number>;
  priorSnapshot: string | null;
  refused: boolean;
} {
  const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
  try {
    return {
      local: rowIdentityShareState(snap.db),
      recipeCurrent: rowIdentityRecipeCurrent(snap.db),
      planned: fullRefillPlan(snap.db),
      priorSnapshot: lastRefillSnapshot(snap.db),
      refused: readRowIdentityRefusal(snap.db)?.state === 'refused',
    };
  } finally {
    snap.close();
  }
}

/**
 * Plan, and with `apply` run, the explicit from-scratch identity refill of a
 * project store (T13231).
 *
 * @param projectRoot - Project directory.
 * @param options - `apply`, and the Nexus probe.
 * @returns The verdict, its evidence, the plan and what was done.
 * @task T13231
 */
export async function rowIdentityRefill(
  projectRoot: string,
  options: RowIdentityRefillOptions = {},
): Promise<RowIdentityRefillReport> {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const fillEnabled = rowUidFillEnabled();
  const empty = shareStateOf([]);
  if (!existsSync(dbPath)) {
    return {
      projectRoot,
      recipeCurrent: true,
      fillEnabled,
      local: empty,
      nexus: [],
      verdict: empty,
      planned: {},
      action: 'none',
      remedy: ['no project store yet'],
      applied: false,
      snapshot: null,
      undo: null,
      refusalCleared: false,
    };
  }
  const { local, recipeCurrent, planned, priorSnapshot, refused } = readLocal(dbPath);
  // T13305: an explicit --refill re-evaluates: a recorded refusal is cleared,
  // so the next open (or the --apply below) decides afresh.
  let refusalCleared = false;
  if (refused) {
    const handle = getDualScopeNativeDb(await openDualScopeDb('project', projectRoot));
    await import('../store/sqlite-data-accessor.js');
    refusalCleared = clearRowIdentityRefusal(handle);
  }
  const probe =
    options.probe ??
    (async (root: string) =>
      (await import('../cloud/nexus-project-history.js')).askNexusProjectHistory(root));
  const nexus = await probe(projectRoot);
  const verdict = verdictWith(local, nexus);
  const due = !recipeCurrent && Object.keys(planned).length > 0;
  const action = !due ? 'none' : verdict.state === 'unshared' ? 'refill' : 'refuse';
  const base: RowIdentityRefillReport = {
    projectRoot,
    recipeCurrent,
    fillEnabled,
    local,
    nexus,
    verdict,
    planned,
    action,
    remedy: due ? remedyOf(verdict, fillEnabled) : ['the identity follows the current recipe'],
    applied: false,
    snapshot: null,
    undo: null,
    refusalCleared,
  };
  if (options.apply !== true || action !== 'refill' || !fillEnabled) return base;
  const nexusCheckedNone = nexus.length > 0 && nexus.every((a) => a.answer === 'none');
  const db = getDualScopeNativeDb(await openDualScopeDb('project', projectRoot));
  const { prepareRowIdentityUnderCapture } = await import('../store/sync/identity-fill.js');
  const { report } = prepareRowIdentityUnderCapture(db, 'project', {
    share: { nexusCheckedNone },
  });
  const snapshot = lastRefillSnapshot(db);
  // The open itself may have refilled (an unlinked unshared store): a new
  // snapshot under a current marker proves it.
  const refilled =
    report?.refill === 'cleared' ||
    (rowIdentityRecipeCurrent(db) && snapshot !== null && snapshot !== priorSnapshot);
  if (!refilled) {
    // The open re-checks the verdict: something changed since the plan.
    return {
      ...base,
      action: 'refuse',
      remedy: [
        `the refill did not run (${report ? report.refill : 'the fill failed'}); see the log and re-run the dry run`,
      ],
    };
  }
  return {
    ...base,
    applied: true,
    remedy: [],
    snapshot,
    undo: snapshot ? undoOf(projectRoot, snapshot) : null,
  };
}

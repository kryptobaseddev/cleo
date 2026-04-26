/**
 * Sentient domain Core operations — ADR-057 D1 normalized shape.
 *
 * Each function follows the uniform `(projectRoot: string, params: <Op>Params)`
 * signature so the dispatch layer can call Core directly without inline business
 * logic.
 *
 * @task T1457 — sentient domain Core API alignment
 * @see ADR-057 — Core API normalization
 * @see packages/contracts/src/operations/sentient.ts
 */

import { join } from 'node:path';
import type {
  AllowlistAddParams,
  AllowlistAddResult,
  AllowlistListParams,
  AllowlistListResult,
  AllowlistRemoveParams,
  AllowlistRemoveResult,
  ProposeAcceptParams,
  ProposeAcceptResult,
  ProposeDiffParams,
  ProposeDiffResult,
  ProposeDisableParams,
  ProposeDisableResult,
  ProposeEnableParams,
  ProposeEnableResult,
  ProposeListParams,
  ProposeListResult,
  ProposeRejectParams,
  ProposeRejectResult,
  ProposeRunParams,
  ProposeRunResult,
} from '@cleocode/contracts';
import { SENTIENT_STATE_FILE } from './daemon.js';

/** Label that marks Tier-2 proposals in the tasks DB. */
const TIER2_LABEL = 'sentient-tier2';

// ---------------------------------------------------------------------------
// Query ops
// ---------------------------------------------------------------------------

/**
 * List all pending Tier-2 proposals, sorted by weight descending.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Query parameters (optional `limit`).
 */
export async function sentientProposeList(
  projectRoot: string,
  params: ProposeListParams,
): Promise<ProposeListResult> {
  const { getDb } = await import('@cleocode/core/internal');
  const { tasks } = await import('@cleocode/core/store/tasks-schema');
  const { and, eq, like } = await import('drizzle-orm');

  const db = await getDb(projectRoot);
  const limit = params.limit && params.limit > 0 ? params.limit : 50;

  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'proposed'), like(tasks.labelsJson, `%${TIER2_LABEL}%`)))
    .limit(limit)
    .all();

  const proposals = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    priority: row.priority ?? undefined,
    labels: safeParseJsonArray(row.labelsJson),
    createdAt: row.createdAt,
    meta: safeParseProposalMeta(row.notesJson),
  }));

  proposals.sort((a, b) => {
    const wa = typeof a.meta?.weight === 'number' ? a.meta.weight : 0;
    const wb = typeof b.meta?.weight === 'number' ? b.meta.weight : 0;
    return wb - wa;
  });

  return { proposals, total: proposals.length };
}

/**
 * Show what a proposal would change — Tier-3 stub.
 *
 * @param projectRoot - Absolute path to the project root (unused; Tier-3 feature).
 * @param params - Diff parameters (proposal `id`).
 */
export async function sentientProposeDiff(
  _projectRoot: string,
  params: ProposeDiffParams,
): Promise<ProposeDiffResult> {
  return {
    id: params.id,
    diff: null,
    message:
      'Content diff is a Tier-3 feature (blocked on T992+T993+T995). ' +
      'This proposal is a task-creation suggestion; no diff is available.',
  };
}

/**
 * List the current owner pubkey allowlist.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params - No parameters required.
 */
export async function sentientAllowlistList(
  projectRoot: string,
  _params: AllowlistListParams,
): Promise<AllowlistListResult> {
  const { getOwnerPubkeys } = await import('./allowlist.js');
  const pubkeys = await getOwnerPubkeys(projectRoot, { noCache: true });
  const ownerPubkeys: string[] = pubkeys.map((k: Uint8Array) => Buffer.from(k).toString('base64'));
  return { ownerPubkeys, count: ownerPubkeys.length };
}

// ---------------------------------------------------------------------------
// Mutate ops
// ---------------------------------------------------------------------------

/**
 * Accept a proposal: transition `proposed` → `pending`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Accept parameters (proposal `id`).
 */
export async function sentientProposeAccept(
  projectRoot: string,
  params: ProposeAcceptParams,
): Promise<ProposeAcceptResult> {
  const { getDb } = await import('@cleocode/core/internal');
  const { tasks } = await import('@cleocode/core/store/tasks-schema');
  const { and, eq, like } = await import('drizzle-orm');

  const db = await getDb(projectRoot);

  const existing = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, params.id),
        eq(tasks.status, 'proposed'),
        like(tasks.labelsJson, `%${TIER2_LABEL}%`),
      ),
    )
    .get();

  if (!existing) {
    const err = new Error(
      `E_NOT_FOUND: Task ${params.id} is not a pending proposal (status must be 'proposed' with label '${TIER2_LABEL}')`,
    );
    (err as NodeJS.ErrnoException).code = 'E_NOT_FOUND';
    throw err;
  }

  const now = new Date().toISOString();
  await db
    .update(tasks)
    .set({ status: 'pending', updatedAt: now })
    .where(eq(tasks.id, params.id))
    .run();

  await incrementTier2Stat(projectRoot, 'proposalsAccepted');

  return { id: params.id, status: 'pending', acceptedAt: now };
}

/**
 * Reject a proposal: transition `proposed` → `cancelled`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Reject parameters (proposal `id`, optional `reason`).
 */
export async function sentientProposeReject(
  projectRoot: string,
  params: ProposeRejectParams,
): Promise<ProposeRejectResult> {
  const { getDb } = await import('@cleocode/core/internal');
  const { tasks } = await import('@cleocode/core/store/tasks-schema');
  const { and, eq, like } = await import('drizzle-orm');

  const db = await getDb(projectRoot);
  const reason = params.reason ?? 'rejected by owner';

  const existing = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, params.id),
        eq(tasks.status, 'proposed'),
        like(tasks.labelsJson, `%${TIER2_LABEL}%`),
      ),
    )
    .get();

  if (!existing) {
    const err = new Error(
      `E_NOT_FOUND: Task ${params.id} is not a pending proposal (status must be 'proposed' with label '${TIER2_LABEL}')`,
    );
    (err as NodeJS.ErrnoException).code = 'E_NOT_FOUND';
    throw err;
  }

  const now = new Date().toISOString();
  await db
    .update(tasks)
    .set({
      status: 'cancelled',
      cancellationReason: reason,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(eq(tasks.id, params.id))
    .run();

  await incrementTier2Stat(projectRoot, 'proposalsRejected');

  return { id: params.id, status: 'cancelled', rejectedAt: now, reason };
}

/**
 * Manually trigger a single propose tick in-process.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params - No parameters required.
 */
export async function sentientProposeRun(
  projectRoot: string,
  _params: ProposeRunParams,
): Promise<ProposeRunResult> {
  const { safeRunProposeTick } = await import('./propose-tick.js');
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const outcome = await safeRunProposeTick({ projectRoot, statePath });
  return { outcome };
}

/**
 * Enable Tier-2 proposal generation (M7 gate enforced).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params - No parameters required.
 */
export async function sentientProposeEnable(
  projectRoot: string,
  _params: ProposeEnableParams,
): Promise<ProposeEnableResult> {
  return setTier2Enabled(projectRoot, true);
}

/**
 * Disable Tier-2 proposal generation.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params - No parameters required.
 */
export async function sentientProposeDisable(
  projectRoot: string,
  _params: ProposeDisableParams,
): Promise<ProposeDisableResult> {
  return setTier2Enabled(projectRoot, false);
}

/**
 * Add a base64-encoded pubkey to the owner allowlist.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Add parameters (base64 `pubkey`).
 */
export async function sentientAllowlistAdd(
  projectRoot: string,
  params: AllowlistAddParams,
): Promise<AllowlistAddResult> {
  const { addOwnerPubkey } = await import('./allowlist.js');
  await addOwnerPubkey(projectRoot, params.pubkey);
  return { added: params.pubkey };
}

/**
 * Remove a base64-encoded pubkey from the owner allowlist.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Remove parameters (base64 `pubkey`).
 */
export async function sentientAllowlistRemove(
  projectRoot: string,
  params: AllowlistRemoveParams,
): Promise<AllowlistRemoveResult> {
  const { removeOwnerPubkey } = await import('./allowlist.js');
  await removeOwnerPubkey(projectRoot, params.pubkey);
  return { removed: params.pubkey };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Enable or disable Tier-2 proposals. When enabling, enforces the M7 gate.
 *
 * @task T1148 W8-7
 */
async function setTier2Enabled(
  projectRoot: string,
  enabled: boolean,
): Promise<ProposeEnableResult | ProposeDisableResult> {
  if (enabled) {
    try {
      const { scanBrainNoise } = await import('../memory/brain-doctor.js');
      const doctorResult = await scanBrainNoise(projectRoot);
      if (!doctorResult.isClean) {
        const err = new Error(
          `E_M7_GATE_FAILED: brain corpus has ${doctorResult.findings.length} noise pattern(s) ` +
            `across ${doctorResult.totalScanned} entries. ` +
            `Run \`cleo memory doctor\` for details, then \`cleo memory sweep --approve\` to clean before enabling Sentient v1.`,
        );
        (err as NodeJS.ErrnoException & { details?: unknown }).details = {
          findings: doctorResult.findings,
          totalScanned: doctorResult.totalScanned,
        };
        (err as NodeJS.ErrnoException).code = 'E_M7_GATE_FAILED';
        throw err;
      }
    } catch (err) {
      // Re-throw M7 gate failures; swallow unavailability (e.g. fresh installs).
      if ((err as NodeJS.ErrnoException).code === 'E_M7_GATE_FAILED') throw err;
    }
  }

  const { patchSentientState } = await import('./state.js');
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const updated = await patchSentientState(statePath, { tier2Enabled: enabled });

  return {
    tier2Enabled: updated.tier2Enabled,
    message: enabled ? 'Tier-2 proposals enabled' : 'Tier-2 proposals disabled',
  };
}

/**
 * Increment a Tier-2 stat counter in sentient-state.json. Best-effort.
 */
async function incrementTier2Stat(
  projectRoot: string,
  field: 'proposalsAccepted' | 'proposalsRejected' | 'proposalsGenerated',
): Promise<void> {
  try {
    const { patchSentientState, readSentientState } = await import('./state.js');
    const statePath = join(projectRoot, SENTIENT_STATE_FILE);
    const state = await readSentientState(statePath);
    await patchSentientState(statePath, {
      tier2Stats: {
        ...state.tier2Stats,
        [field]: state.tier2Stats[field] + 1,
      },
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Parse a JSON array string, returning an empty array on failure.
 */
function safeParseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Extract the proposal-meta object from notes_json (first entry if
 * `kind === 'proposal-meta'`).
 */
function safeParseProposalMeta(
  notesJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!notesJson) return null;
  try {
    const notes = JSON.parse(notesJson);
    if (!Array.isArray(notes) || notes.length === 0) return null;
    const first = notes[0];
    if (typeof first !== 'string') return null;
    const meta = JSON.parse(first);
    if (meta.kind === 'proposal-meta') return meta;
    return null;
  } catch {
    return null;
  }
}

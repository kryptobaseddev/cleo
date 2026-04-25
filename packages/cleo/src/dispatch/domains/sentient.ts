/**
 * Sentient Domain Handler — Tier-2 proposal management via dispatch.
 *
 * Operations:
 *   propose.list    (query)  — list tasks with status='proposed'
 *   propose.accept  (mutate) — transition proposed → pending (owner action)
 *   propose.reject  (mutate) — transition proposed → cancelled
 *   propose.diff    (query)  — show what a proposal would change (Tier-3 stub)
 *   propose.run     (mutate) — manually trigger a single propose tick in-process
 *
 * All operations emit LAFS-compliant envelopes.
 *
 * Handler uses TypedDomainHandler<SentientOps> (Wave D · T975 follow-on)
 * to eliminate param casts. Zero `as string` / `as unknown` param casts in
 * per-op code. Single boundary cast inside typedDispatch (T974 adapter).
 *
 * @task T1008
 * @task T1421 — typed narrowing migration (Wave D follow-on)
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { join } from 'node:path';
import type {
  AllowlistAddParams,
  AllowlistListParams,
  AllowlistRemoveParams,
  ProposeAcceptParams,
  ProposeDiffParams,
  ProposeDisableParams,
  ProposeEnableParams,
  ProposeListParams,
  ProposeRejectParams,
  ProposeRunParams,
  SentientOps,
} from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import type { EngineResult } from './_base.js';
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

/** The label that marks Tier-2 proposals. */
const TIER2_LABEL = 'sentient-tier2';

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1421)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _sentientTypedHandler = defineTypedHandler<SentientOps>('sentient', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  'propose.list': async (params: ProposeListParams) => {
    const projectRoot = getProjectRoot();
    const result = await listProposals(projectRoot, params);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.list',
      );
    }
    return lafsSuccess(result.data ?? { proposals: [], total: 0 }, 'propose.list');
  },

  'propose.diff': async (params: ProposeDiffParams) => {
    // Tier-3 stub — diff is only meaningful for content-change proposals.
    // Register the verb now; content is Tier-3 scope.
    return lafsSuccess(
      {
        id: params.id,
        diff: null,
        message:
          'Content diff is a Tier-3 feature (blocked on T992+T993+T995). ' +
          'This proposal is a task-creation suggestion; no diff is available.',
      },
      'propose.diff',
    );
  },

  'allowlist.list': async (_params: AllowlistListParams) => {
    const projectRoot = getProjectRoot();
    const result = await listAllowlist(projectRoot);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'allowlist.list',
      );
    }
    return lafsSuccess(result.data ?? { ownerPubkeys: [], count: 0 }, 'allowlist.list');
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  'propose.accept': async (params: ProposeAcceptParams) => {
    const projectRoot = getProjectRoot();
    const result = await acceptProposal(projectRoot, params.id);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.accept',
      );
    }
    return lafsSuccess(result.data ?? { id: '', status: '', acceptedAt: '' }, 'propose.accept');
  },

  'propose.reject': async (params: ProposeRejectParams) => {
    const projectRoot = getProjectRoot();
    const reason = params.reason ?? 'rejected by owner';
    const result = await rejectProposal(projectRoot, params.id, reason);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.reject',
      );
    }
    return lafsSuccess(
      result.data ?? { id: '', status: '', rejectedAt: '', reason: '' },
      'propose.reject',
    );
  },

  'propose.run': async (_params: ProposeRunParams) => {
    const projectRoot = getProjectRoot();
    const result = await runProposeTick(projectRoot);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.run',
      );
    }
    return lafsSuccess(result.data ?? { outcome: null }, 'propose.run');
  },

  'propose.enable': async (_params: ProposeEnableParams) => {
    const projectRoot = getProjectRoot();
    const result = await setTier2Enabled(projectRoot, true);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.enable',
      );
    }
    return lafsSuccess(result.data ?? { tier2Enabled: false, message: '' }, 'propose.enable');
  },

  'propose.disable': async (_params: ProposeDisableParams) => {
    const projectRoot = getProjectRoot();
    const result = await setTier2Enabled(projectRoot, false);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'propose.disable',
      );
    }
    return lafsSuccess(result.data ?? { tier2Enabled: true, message: '' }, 'propose.disable');
  },

  'allowlist.add': async (params: AllowlistAddParams) => {
    const projectRoot = getProjectRoot();
    const result = await addAllowlistKey(projectRoot, params.pubkey);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'allowlist.add',
      );
    }
    return lafsSuccess(result.data ?? { added: '' }, 'allowlist.add');
  },

  'allowlist.remove': async (params: AllowlistRemoveParams) => {
    const projectRoot = getProjectRoot();
    const result = await removeAllowlistKey(projectRoot, params.pubkey);
    if (!result.success) {
      return lafsError(
        result.error?.code ?? 'E_INTERNAL',
        result.error?.message ?? 'Unknown error',
        'allowlist.remove',
      );
    }
    return lafsSuccess(result.data ?? { removed: '' }, 'allowlist.remove');
  },
});

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
//
// Converts a LafsEnvelope into the minimal EngineResult shape accepted by
// wrapResult. Similar to session.ts pattern (T975).
// ---------------------------------------------------------------------------

interface LafsEnvelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * @param envelope - The LAFS envelope returned by the typed op function.
 * @returns An object compatible with the `EngineResult` type in `_base.ts`.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: LafsEnvelope): {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
} {
  if (envelope.success) {
    return { success: true, data: envelope.data };
  }
  return {
    success: false,
    error: {
      code: envelope.error?.code ?? 'E_INTERNAL',
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['propose.list', 'propose.diff', 'allowlist.list']);

const MUTATE_OPS = new Set<string>([
  'propose.accept',
  'propose.reject',
  'propose.run',
  'propose.enable',
  'propose.disable',
  'allowlist.add',
  'allowlist.remove',
]);

// ---------------------------------------------------------------------------
// SentientHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `sentient` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_sentientTypedHandler` (a `TypedDomainHandler<SentientOps>`). This
 * satisfies the registry's `DomainHandler` interface while keeping every
 * param access fully type-safe via the Wave D adapter.
 */
export class SentientHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['propose.list', 'propose.diff', 'allowlist.list'],
      mutate: [
        'propose.accept',
        'propose.reject',
        'propose.run',
        'propose.enable',
        'propose.disable',
        'allowlist.add',
        'allowlist.remove',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only sentient query operation.
   *
   * @param operation - The sentient query op name (e.g. 'propose.list').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'sentient', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid sentient query op name at this point.
      const envelope = await typedDispatch(
        _sentientTypedHandler,
        operation as keyof SentientOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'query',
        'sentient',
        operation,
        startTime,
      );
    } catch (error) {
      return handleErrorResult('query', 'sentient', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  /**
   * Execute a state-modifying sentient mutation operation.
   *
   * @param operation - The sentient mutate op name (e.g. 'propose.accept').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'sentient', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid sentient mutate op name at this point.
      const envelope = await typedDispatch(
        _sentientTypedHandler,
        operation as keyof SentientOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'mutate',
        'sentient',
        operation,
        startTime,
      );
    } catch (error) {
      return handleErrorResult('mutate', 'sentient', operation, error, startTime);
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation helpers (zero casts in param extraction)
// ---------------------------------------------------------------------------

/**
 * List all tasks with `status='proposed'` that carry the TIER2_LABEL.
 * Sorted by weight descending (from notes_json proposal-meta entry).
 */
async function listProposals(
  projectRoot: string,
  params: ProposeListParams,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
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
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: safeParseJsonArray(row.labelsJson),
    createdAt: row.createdAt,
    meta: safeParseProposalMeta(row.notesJson),
  }));

  // Sort by meta.weight descending if available
  proposals.sort((a, b) => {
    const wa = typeof a.meta?.weight === 'number' ? a.meta.weight : 0;
    const wb = typeof b.meta?.weight === 'number' ? b.meta.weight : 0;
    return wb - wa;
  });

  return { success: true, data: { proposals, total: proposals.length } };
}

/**
 * Accept a proposal: transition `proposed` → `pending`.
 * Updates tier2Stats.proposalsAccepted in sentient-state.json.
 */
async function acceptProposal(
  projectRoot: string,
  id: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const { getDb } = await import('@cleocode/core/internal');
  const { tasks } = await import('@cleocode/core/store/tasks-schema');
  const { and, eq, like } = await import('drizzle-orm');

  const db = await getDb(projectRoot);

  // Verify it's a proposed task with the tier2 label
  const existing = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, 'proposed'),
        like(tasks.labelsJson, `%${TIER2_LABEL}%`),
      ),
    )
    .get();

  if (!existing) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Task ${id} is not a pending proposal (status must be 'proposed' with label '${TIER2_LABEL}')`,
      },
    };
  }

  const now = new Date().toISOString();
  await db.update(tasks).set({ status: 'pending', updatedAt: now }).where(eq(tasks.id, id)).run();

  // Update tier2Stats
  await incrementTier2Stat(projectRoot, 'proposalsAccepted');

  return { success: true, data: { id, status: 'pending', acceptedAt: now } };
}

/**
 * Reject a proposal: transition `proposed` → `cancelled`.
 * Updates tier2Stats.proposalsRejected in sentient-state.json.
 */
async function rejectProposal(
  projectRoot: string,
  id: string,
  reason: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const { getDb } = await import('@cleocode/core/internal');
  const { tasks } = await import('@cleocode/core/store/tasks-schema');
  const { and, eq, like } = await import('drizzle-orm');

  const db = await getDb(projectRoot);

  const existing = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, 'proposed'),
        like(tasks.labelsJson, `%${TIER2_LABEL}%`),
      ),
    )
    .get();

  if (!existing) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Task ${id} is not a pending proposal (status must be 'proposed' with label '${TIER2_LABEL}')`,
      },
    };
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
    .where(eq(tasks.id, id))
    .run();

  // Update tier2Stats
  await incrementTier2Stat(projectRoot, 'proposalsRejected');

  return { success: true, data: { id, status: 'cancelled', rejectedAt: now, reason } };
}

/**
 * Manually trigger a single propose tick in-process.
 * Useful for owner testing without starting the daemon.
 */
async function runProposeTick(
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const { safeRunProposeTick } = await import('@cleocode/core/sentient/propose-tick.js');
  const { SENTIENT_STATE_FILE } = await import('@cleocode/core/sentient/daemon.js');

  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const outcome = await safeRunProposeTick({ projectRoot, statePath });

  return { success: true, data: { outcome } };
}

/**
 * List the current owner pubkey allowlist.
 */
async function listAllowlist(
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const { getOwnerPubkeys } = await import('@cleocode/core/sentient/allowlist.js');
  const pubkeys = await getOwnerPubkeys(projectRoot, { noCache: true });
  const b64List: string[] = pubkeys.map((k: Uint8Array) => Buffer.from(k).toString('base64'));
  return { success: true, data: { ownerPubkeys: b64List, count: b64List.length } };
}

/**
 * Add a base64-encoded pubkey to the owner allowlist.
 */
async function addAllowlistKey(
  projectRoot: string,
  pubkeyBase64: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const { addOwnerPubkey } = await import('@cleocode/core/sentient/allowlist.js');
    await addOwnerPubkey(projectRoot, pubkeyBase64);
    return { success: true, data: { added: pubkeyBase64 } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code: 'E_ALLOWLIST_ADD', message } };
  }
}

/**
 * Remove a base64-encoded pubkey from the owner allowlist.
 */
async function removeAllowlistKey(
  projectRoot: string,
  pubkeyBase64: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const { removeOwnerPubkey } = await import('@cleocode/core/sentient/allowlist.js');
    await removeOwnerPubkey(projectRoot, pubkeyBase64);
    return { success: true, data: { removed: pubkeyBase64 } };
  } catch (err) {
    const code =
      (err as NodeJS.ErrnoException).code === 'E_ALLOWLIST_KEY_NOT_FOUND'
        ? 'E_ALLOWLIST_KEY_NOT_FOUND'
        : 'E_ALLOWLIST_REMOVE';
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: { code, message } };
  }
}

/**
 * Enable or disable Tier-2 proposal generation.
 *
 * When `enabled=true`, enforces the M7 gate (T-COUNCIL-RECONCILIATION-2026-04-24):
 * `cleo memory doctor --assert-clean` must pass before Tier-2 is activated.
 * Returns `E_M7_GATE_FAILED` if the brain corpus is not clean.
 *
 * @task T1148 W8-7
 */
async function setTier2Enabled(projectRoot: string, enabled: boolean): Promise<EngineResult> {
  // M7 gate: assert memory is clean before enabling Tier-2 (ADR council 2026-04-24).
  if (enabled) {
    try {
      const { scanBrainNoise } = await import('@cleocode/core/memory/brain-doctor.js');
      const doctorResult = await scanBrainNoise(projectRoot);
      if (!doctorResult.isClean) {
        return {
          success: false,
          error: {
            code: 'E_M7_GATE_FAILED',
            message:
              `M7 gate blocked: brain corpus has ${doctorResult.findings.length} noise pattern(s) ` +
              `across ${doctorResult.totalScanned} entries. ` +
              `Run \`cleo memory doctor\` for details, then \`cleo memory sweep --approve\` to clean before enabling Sentient v1.`,
            details: { findings: doctorResult.findings, totalScanned: doctorResult.totalScanned },
          },
        };
      }
    } catch {
      // If doctor is unavailable (e.g. brain.db not yet initialised), allow
      // enablement so fresh installs are not blocked.  The gate fires only
      // when the corpus is known-dirty.
    }
  }

  const { patchSentientState } = await import('@cleocode/core/sentient/state.js');
  const { SENTIENT_STATE_FILE } = await import('@cleocode/core/sentient/daemon.js');

  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const updated = await patchSentientState(statePath, { tier2Enabled: enabled });

  return {
    success: true,
    data: {
      tier2Enabled: updated.tier2Enabled,
      message: enabled ? 'Tier-2 proposals enabled' : 'Tier-2 proposals disabled',
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

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
 * Extract the proposal-meta object from notes_json (first entry if it
 * contains a JSON string with `kind === 'proposal-meta'`).
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

/**
 * Increment a Tier-2 stat counter in sentient-state.json.
 */
async function incrementTier2Stat(
  projectRoot: string,
  field: 'proposalsAccepted' | 'proposalsRejected' | 'proposalsGenerated',
): Promise<void> {
  try {
    const { patchSentientState, readSentientState } = await import(
      '@cleocode/core/sentient/state.js'
    );
    const { SENTIENT_STATE_FILE } = await import('@cleocode/core/sentient/daemon.js');

    const statePath = join(projectRoot, SENTIENT_STATE_FILE);
    const state = await readSentientState(statePath);
    await patchSentientState(statePath, {
      tier2Stats: {
        ...state.tier2Stats,
        [field]: state.tier2Stats[field] + 1,
      },
    });
  } catch {
    // Best-effort: stat update failure must not break the operation.
  }
}

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
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { join } from 'node:path';
import { getProjectRoot } from '@cleocode/core';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

/** The label that marks Tier-2 proposals. */
const TIER2_LABEL = 'sentient-tier2';

/** Sentient dispatch handler for Tier-2 proposal operations. */
export class SentientHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  /** Returns the list of supported query and mutate operations. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['propose.list', 'propose.diff'],
      mutate: [
        'propose.accept',
        'propose.reject',
        'propose.run',
        'propose.enable',
        'propose.disable',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    const projectRoot = getProjectRoot();

    try {
      switch (operation) {
        case 'propose.list': {
          const result = await this.listProposals(projectRoot, params);
          return wrapResult(result, 'query', 'sentient', operation, startTime);
        }
        case 'propose.diff': {
          const id = params?.id as string | undefined;
          if (!id) {
            return errorResult(
              'query',
              'sentient',
              operation,
              'E_MISSING_PARAM',
              'id is required for propose.diff',
              startTime,
            );
          }
          // Tier-3 stub — diff is only meaningful for content-change proposals.
          // Register the verb now; content is Tier-3 scope.
          return wrapResult(
            {
              success: true,
              data: {
                id,
                diff: null,
                message:
                  'Content diff is a Tier-3 feature (blocked on T992+T993+T995). ' +
                  'This proposal is a task-creation suggestion; no diff is available.',
              },
            },
            'query',
            'sentient',
            operation,
            startTime,
          );
        }
        default:
          return unsupportedOp('query', 'sentient', operation, startTime);
      }
    } catch (error) {
      return handleErrorResult('query', 'sentient', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    const projectRoot = getProjectRoot();

    try {
      switch (operation) {
        case 'propose.accept': {
          const id = params?.id as string | undefined;
          if (!id) {
            return errorResult(
              'mutate',
              'sentient',
              operation,
              'E_MISSING_PARAM',
              'id is required for propose.accept',
              startTime,
            );
          }
          const result = await this.acceptProposal(projectRoot, id);
          return wrapResult(result, 'mutate', 'sentient', operation, startTime);
        }
        case 'propose.reject': {
          const id = params?.id as string | undefined;
          if (!id) {
            return errorResult(
              'mutate',
              'sentient',
              operation,
              'E_MISSING_PARAM',
              'id is required for propose.reject',
              startTime,
            );
          }
          const reason = (params?.reason as string | undefined) ?? 'rejected by owner';
          const result = await this.rejectProposal(projectRoot, id, reason);
          return wrapResult(result, 'mutate', 'sentient', operation, startTime);
        }
        case 'propose.run': {
          const result = await this.runProposeTick(projectRoot, params);
          return wrapResult(result, 'mutate', 'sentient', operation, startTime);
        }
        case 'propose.enable': {
          const result = await this.setTier2Enabled(projectRoot, true);
          return wrapResult(result, 'mutate', 'sentient', operation, startTime);
        }
        case 'propose.disable': {
          const result = await this.setTier2Enabled(projectRoot, false);
          return wrapResult(result, 'mutate', 'sentient', operation, startTime);
        }
        default:
          return unsupportedOp('mutate', 'sentient', operation, startTime);
      }
    } catch (error) {
      return handleErrorResult('mutate', 'sentient', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Implementation helpers
  // -----------------------------------------------------------------------

  /**
   * List all tasks with `status='proposed'` that carry the TIER2_LABEL.
   * Sorted by weight descending (from notes_json proposal-meta entry).
   */
  private async listProposals(
    projectRoot: string,
    params?: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown }> {
    const { getDb } = await import('@cleocode/core/internal');
    const { tasks } = await import('@cleocode/core/store/tasks-schema');
    const { and, eq, like } = await import('drizzle-orm');

    const db = await getDb(projectRoot);
    const limit = typeof params?.limit === 'number' && params.limit > 0 ? params.limit : 50;

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
  private async acceptProposal(
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
  private async rejectProposal(
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
  private async runProposeTick(
    projectRoot: string,
    params?: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown }> {
    const { safeRunProposeTick } = await import('@cleocode/core/sentient/propose-tick.js');
    const { SENTIENT_STATE_FILE } = await import('@cleocode/core/sentient/daemon.js');

    const statePath = join(projectRoot, SENTIENT_STATE_FILE);
    const outcome = await safeRunProposeTick({ projectRoot, statePath });

    const _ = params; // params reserved for future options
    void _;

    return { success: true, data: { outcome } };
  }

  /**
   * Enable or disable Tier-2 proposal generation.
   */
  private async setTier2Enabled(
    projectRoot: string,
    enabled: boolean,
  ): Promise<{ success: boolean; data?: unknown }> {
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
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
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
    const notes = JSON.parse(notesJson) as unknown[];
    if (!Array.isArray(notes) || notes.length === 0) return null;
    const first = notes[0];
    if (typeof first !== 'string') return null;
    const meta = JSON.parse(first) as Record<string, unknown>;
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

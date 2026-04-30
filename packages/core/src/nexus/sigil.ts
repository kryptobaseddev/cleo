/**
 * Sigil CRUD operations for the NEXUS sigils table.
 *
 * Provides the 3 SDK functions for PSYCHE Wave 8 (T1148):
 *   - getSigil     — fetch a single sigil by peer ID
 *   - upsertSigil  — create-or-update a sigil record
 *   - listSigils   — list all sigils (optionally filtered by role)
 *
 * All functions accept a `nexusDb` argument (NodeSQLiteDatabase<NexusSchema>)
 * to keep them unit-testable without touching the real nexus.db singleton.
 * Callers that do not need test isolation may use `getNexusDb()` from
 * `packages/core/src/store/nexus-sqlite.ts` directly.
 *
 * PSYCHE reference: `upstream psyche-lineage · crud/peer_card.py` (getOrCreate
 * + metadata merge pattern).
 *
 * @task T1148
 * @epic T1075
 */

import type { NexusSigilListResult } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import * as nexusSchema from '../store/nexus-schema.js';
import { getNexusDb } from '../store/nexus-sqlite.js';

/** Type alias for the Drizzle nexus database instance. */
type NexusDb = NodeSQLiteDatabase<typeof nexusSchema>;

// ---------------------------------------------------------------------------
// Public types (wire shapes)
// ---------------------------------------------------------------------------

/**
 * Wire shape for a single sigil record.
 * Mirrors `nexusSchema.SigilRow` but surfaces timestamps as ISO 8601 strings.
 */
export interface SigilCard {
  /** Stable peer identifier — matches `peer_id` on brain tables. */
  peerId: string;
  /** Absolute or relative path to the CANT agent file (.cant). Null if unset. */
  cantFile: string | null;
  /** Human-readable display name, e.g. "cleo-prime". */
  displayName: string;
  /** Short role description, e.g. "orchestrator". */
  role: string;
  /**
   * System-prompt fragment to inject into spawn payloads when this peer is
   * the active agent.  Null when no fragment is set.
   */
  systemPromptFragment: string | null;
  /**
   * JSON-encoded capability flags object, e.g.
   * `{"tier":1,"spawnRights":true,"thinAgentMode":false}`.
   * Null until flags are explicitly set.
   */
  capabilityFlags: string | null;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

/**
 * Input shape for {@link upsertSigil}.
 * `peerId` is required; all other fields are optional.
 */
export interface SigilInput {
  /** Stable peer identifier (primary key). */
  peerId: string;
  /** Path to the CANT agent file. */
  cantFile?: string | null;
  /** Human-readable display name. */
  displayName?: string;
  /** Short role description. */
  role?: string;
  /** System-prompt fragment to inject into spawn payloads. */
  systemPromptFragment?: string | null;
  /** JSON-encoded capability flags object. */
  capabilityFlags?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DB row into the canonical {@link SigilCard} wire shape.
 * Timestamps are stored as Date objects in the DB and surfaced as ISO 8601
 * strings on the wire contract.
 *
 * @param row - Raw row from the `sigils` table.
 * @returns Canonical {@link SigilCard} object.
 */
function rowToSigilCard(row: nexusSchema.SigilRow): SigilCard {
  return {
    peerId: row.peerId,
    cantFile: row.cantFile ?? null,
    displayName: row.displayName,
    role: row.role,
    systemPromptFragment: row.systemPromptFragment ?? null,
    capabilityFlags: row.capabilityFlags ?? null,
    createdAt: (row.createdAt instanceof Date
      ? row.createdAt
      : new Date(row.createdAt)
    ).toISOString(),
    updatedAt: (row.updatedAt instanceof Date
      ? row.updatedAt
      : new Date(row.updatedAt)
    ).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public SDK functions
// ---------------------------------------------------------------------------

/**
 * Fetch a single sigil by peer ID.
 *
 * Returns `null` when no matching row exists.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param peerId  - The peer identifier to look up.
 * @returns The matching {@link SigilCard}, or `null`.
 */
export async function getSigil(nexusDb: NexusDb, peerId: string): Promise<SigilCard | null> {
  const rows = await nexusDb
    .select()
    .from(nexusSchema.sigils)
    .where(eq(nexusSchema.sigils.peerId, peerId))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToSigilCard(rows[0]!);
}

/**
 * Create or update a sigil record.
 *
 * When a row with the same `peerId` already exists, it is updated in-place
 * (last-writer-wins semantics for all mutable fields).  `createdAt` is
 * preserved from the existing row on update.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param input   - Sigil fields to insert or update.
 * @returns The resulting {@link SigilCard} after the upsert.
 */
export async function upsertSigil(nexusDb: NexusDb, input: SigilInput): Promise<SigilCard> {
  const now = new Date();

  const existing = await nexusDb
    .select({ createdAt: nexusSchema.sigils.createdAt })
    .from(nexusSchema.sigils)
    .where(eq(nexusSchema.sigils.peerId, input.peerId))
    .limit(1);

  const createdAt = existing.length > 0 ? existing[0]!.createdAt : now;

  await nexusDb
    .insert(nexusSchema.sigils)
    .values({
      peerId: input.peerId,
      cantFile: input.cantFile ?? null,
      displayName: input.displayName ?? '',
      role: input.role ?? '',
      systemPromptFragment: input.systemPromptFragment ?? null,
      capabilityFlags: input.capabilityFlags ?? null,
      createdAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: nexusSchema.sigils.peerId,
      set: {
        cantFile: input.cantFile ?? null,
        displayName: input.displayName ?? '',
        role: input.role ?? '',
        systemPromptFragment: input.systemPromptFragment ?? null,
        capabilityFlags: input.capabilityFlags ?? null,
        updatedAt: now,
      },
    });

  const result = await getSigil(nexusDb, input.peerId);
  // upsert guarantees the row exists; result should never be null.
  return result!;
}

/**
 * List all sigil records, optionally filtered by role.
 *
 * Returns an array of {@link SigilCard} objects ordered by `displayName`
 * ascending.  Returns an empty array when no sigils have been created yet.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param opts    - Optional filter options.
 * @param opts.role - When provided, return only sigils with this role.
 * @returns Array of matching {@link SigilCard} objects.
 */
export async function listSigils(nexusDb: NexusDb, opts?: { role?: string }): Promise<SigilCard[]> {
  const query = nexusDb.select().from(nexusSchema.sigils);

  const rows = opts?.role ? await query.where(eq(nexusSchema.sigils.role, opts.role)) : await query;

  return rows.map(rowToSigilCard);
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSigilList(role?: string): Promise<EngineResult<NexusSigilListResult>> {
  try {
    const nexusDb = await getNexusDb();
    const sigils = await listSigils(nexusDb, role ? { role } : undefined);
    return engineSuccess({ sigils, count: sigils.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

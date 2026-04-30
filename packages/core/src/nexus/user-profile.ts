/**
 * User-profile CRUD operations for the NEXUS user_profile table.
 *
 * Provides the 5 SDK functions for PSYCHE Wave 1 (T1078):
 *   - getUserProfileTrait    — fetch a single trait by key
 *   - upsertUserProfileTrait — create-or-update a trait
 *   - reinforceTrait         — increment reinforcement count + bump confidence
 *   - listUserProfile        — list all traits (with optional confidence filter)
 *   - supersedeTrait         — mark one trait as superseded by another
 *
 * All functions accept a `nexusDb` argument (NodeSQLiteDatabase<NexusSchema>)
 * to keep them unit-testable without touching the real nexus.db singleton.
 * Callers that do not need test isolation may use `getNexusDb()` from
 * `packages/core/src/store/nexus-sqlite.ts` directly.
 *
 * PSYCHE reference: `upstream psyche-lineage · crud/peer.py` (getOrCreate +
 * metadata merge pattern) and `models.py` (User metadata attributes).
 *
 * @task T1078
 * @epic T1076
 */

import type {
  NexusProfileExportResult,
  NexusProfileGetResult,
  NexusProfileImportResult,
  NexusProfileReinforceResult,
  NexusProfileSupersedeResult,
  NexusProfileUpsertResult,
  NexusProfileViewResult,
  UserProfileTrait,
} from '@cleocode/contracts';
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import * as nexusSchema from '../store/nexus-schema.js';
import { getNexusDb } from '../store/nexus-sqlite.js';

/** Type alias for the Drizzle nexus database instance. */
type NexusDb = NodeSQLiteDatabase<typeof nexusSchema>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DB row into the canonical `UserProfileTrait` wire shape.
 * Timestamps are stored as Unix-epoch numbers in the DB and surfaced as ISO
 * 8601 strings on the wire contract.
 *
 * @param row - Raw row from the `user_profile` table.
 * @returns Canonical `UserProfileTrait` object.
 */
function rowToTrait(row: nexusSchema.UserProfileRow): UserProfileTrait {
  return {
    traitKey: row.traitKey,
    traitValue: row.traitValue,
    confidence: row.confidence,
    source: row.source,
    derivedFromMessageId: row.derivedFromMessageId ?? null,
    firstObservedAt: new Date(row.firstObservedAt).toISOString(),
    lastReinforcedAt: new Date(row.lastReinforcedAt).toISOString(),
    reinforcementCount: row.reinforcementCount,
    supersededBy: row.supersededBy ?? null,
  };
}

/**
 * Clamp a confidence value to [0.0, 1.0].
 *
 * @param value - Raw floating-point confidence.
 * @returns Clamped value in [0.0, 1.0].
 */
function clampConfidence(value: number): number {
  return Math.min(1.0, Math.max(0.0, value));
}

// ---------------------------------------------------------------------------
// Public SDK functions
// ---------------------------------------------------------------------------

/**
 * Fetch a single user-profile trait by its key.
 *
 * Returns `null` when no matching row exists.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param traitKey - Semantic trait key to look up.
 * @returns The matching `UserProfileTrait`, or `null`.
 */
export async function getUserProfileTrait(
  nexusDb: NexusDb,
  traitKey: string,
): Promise<UserProfileTrait | null> {
  const rows = await nexusDb
    .select()
    .from(nexusSchema.userProfile)
    .where(eq(nexusSchema.userProfile.traitKey, traitKey))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToTrait(rows[0]!);
}

/**
 * Create or update a user-profile trait.
 *
 * When a row with the same `traitKey` already exists it is overwritten
 * in full — this is the "last writer wins" semantics used by `importUserProfile`
 * after the conflict-resolution step (higher confidence wins, see T1079).
 * The `firstObservedAt` field is preserved from the existing row on update.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param trait   - Trait to insert or replace.  `firstObservedAt` and
 *                  `lastReinforcedAt` should be ISO 8601 strings; they are
 *                  stored as Unix-epoch milliseconds internally.
 */
export async function upsertUserProfileTrait(
  nexusDb: NexusDb,
  trait: UserProfileTrait,
): Promise<void> {
  const now = new Date(trait.lastReinforcedAt);
  const firstObserved = new Date(trait.firstObservedAt);

  const existing = await nexusDb
    .select({ firstObservedAt: nexusSchema.userProfile.firstObservedAt })
    .from(nexusSchema.userProfile)
    .where(eq(nexusSchema.userProfile.traitKey, trait.traitKey))
    .limit(1);

  // Preserve original firstObservedAt when updating an existing row.
  const preservedFirstObserved = existing.length > 0 ? existing[0]!.firstObservedAt : firstObserved;

  await nexusDb
    .insert(nexusSchema.userProfile)
    .values({
      traitKey: trait.traitKey,
      traitValue: trait.traitValue,
      confidence: clampConfidence(trait.confidence),
      source: trait.source,
      derivedFromMessageId: trait.derivedFromMessageId ?? undefined,
      firstObservedAt: preservedFirstObserved,
      lastReinforcedAt: now,
      reinforcementCount: trait.reinforcementCount,
      supersededBy: trait.supersededBy ?? undefined,
    })
    .onConflictDoUpdate({
      target: nexusSchema.userProfile.traitKey,
      set: {
        traitValue: trait.traitValue,
        confidence: clampConfidence(trait.confidence),
        source: trait.source,
        derivedFromMessageId: trait.derivedFromMessageId ?? undefined,
        lastReinforcedAt: now,
        reinforcementCount: trait.reinforcementCount,
        supersededBy: trait.supersededBy ?? undefined,
      },
    });
}

/**
 * Increment the reinforcement count for an existing trait and boost its
 * confidence.
 *
 * Reinforcement boost formula:
 *   newConfidence = existing + (1 − existing) × 0.1
 * Each reinforcement moves confidence 10% closer to 1.0 (asymptotic approach).
 * Capped at 1.0.
 *
 * No-ops silently when the traitKey does not exist.
 *
 * @param nexusDb  - Drizzle nexus database handle.
 * @param traitKey - Key of the trait to reinforce.
 * @param source   - Source identifier recorded on the update (e.g. "manual").
 */
export async function reinforceTrait(
  nexusDb: NexusDb,
  traitKey: string,
  source: string,
): Promise<void> {
  const rows = await nexusDb
    .select()
    .from(nexusSchema.userProfile)
    .where(eq(nexusSchema.userProfile.traitKey, traitKey))
    .limit(1);

  if (rows.length === 0) return;

  const existing = rows[0]!;
  const newCount = existing.reinforcementCount + 1;
  const newConfidence = clampConfidence(existing.confidence + (1 - existing.confidence) * 0.1);
  const now = new Date();

  await nexusDb
    .update(nexusSchema.userProfile)
    .set({
      reinforcementCount: newCount,
      confidence: newConfidence,
      lastReinforcedAt: now,
      source,
    })
    .where(eq(nexusSchema.userProfile.traitKey, traitKey));
}

/**
 * List all user-profile traits, optionally filtered by minimum confidence.
 *
 * Only non-superseded traits are returned by default — pass
 * `opts.includeSuperseded = true` to include deprecated traits.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param opts    - Optional filtering options.
 * @returns Array of traits ordered by confidence desc, then traitKey asc.
 */
export async function listUserProfile(
  nexusDb: NexusDb,
  opts?: {
    /** Minimum confidence threshold (inclusive). Defaults to 0.0. */
    minConfidence?: number;
    /** Include superseded (deprecated) traits. Defaults to false. */
    includeSuperseded?: boolean;
  },
): Promise<UserProfileTrait[]> {
  const minConf = opts?.minConfidence ?? 0.0;
  const includeSuperseded = opts?.includeSuperseded ?? false;

  const query = nexusDb
    .select()
    .from(nexusSchema.userProfile)
    .where(
      includeSuperseded
        ? gte(nexusSchema.userProfile.confidence, minConf)
        : and(
            gte(nexusSchema.userProfile.confidence, minConf),
            isNull(nexusSchema.userProfile.supersededBy),
          ),
    )
    .orderBy(desc(nexusSchema.userProfile.confidence), asc(nexusSchema.userProfile.traitKey));

  const rows = await query;
  return rows.map(rowToTrait);
}

/**
 * Mark a trait as superseded by another, implementing the T1139 supersession
 * link for the profile domain.
 *
 * The old trait row has its `supersededBy` field set to `newKey`.
 * The new trait is not modified (it must already exist or be created separately
 * via `upsertUserProfileTrait`).
 *
 * No-ops silently when `oldKey` does not exist.
 *
 * @param nexusDb - Drizzle nexus database handle.
 * @param oldKey  - Trait key that is being deprecated.
 * @param newKey  - Trait key that replaces it.
 */
export async function supersedeTrait(
  nexusDb: NexusDb,
  oldKey: string,
  newKey: string,
): Promise<void> {
  await nexusDb
    .update(nexusSchema.userProfile)
    .set({ supersededBy: newKey })
    .where(eq(nexusSchema.userProfile.traitKey, oldKey));
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileView(
  minConfidence?: number,
  includeSuperseded?: boolean,
): Promise<EngineResult<NexusProfileViewResult>> {
  try {
    const nexusDb = await getNexusDb();
    const traits = await listUserProfile(nexusDb, { minConfidence, includeSuperseded });
    return engineSuccess({ traits, count: traits.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileGet(
  traitKey: string,
): Promise<EngineResult<NexusProfileGetResult>> {
  try {
    const nexusDb = await getNexusDb();
    const trait = await getUserProfileTrait(nexusDb, traitKey);
    return engineSuccess({ trait });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileImport(
  path?: string,
): Promise<EngineResult<NexusProfileImportResult>> {
  try {
    const { importUserProfile } = await import('../nexus/transfer.js');
    const result = await importUserProfile(path);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileExport(
  path?: string,
): Promise<EngineResult<NexusProfileExportResult>> {
  try {
    const { exportUserProfile } = await import('../nexus/transfer.js');
    const result = await exportUserProfile(path);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileReinforce(
  traitKey: string,
  source?: string,
): Promise<EngineResult<NexusProfileReinforceResult>> {
  try {
    const nexusDb = await getNexusDb();
    await reinforceTrait(nexusDb, traitKey, source ?? 'manual');
    const updated = await getUserProfileTrait(nexusDb, traitKey);
    if (!updated) {
      return engineError('E_NOT_FOUND', `Trait not found: ${traitKey}`);
    }
    return engineSuccess({
      reinforcementCount: updated.reinforcementCount,
      confidence: updated.confidence,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileUpsert(
  trait: Pick<
    UserProfileTrait,
    'traitKey' | 'traitValue' | 'confidence' | 'source' | 'derivedFromMessageId'
  >,
): Promise<EngineResult<NexusProfileUpsertResult>> {
  try {
    const nexusDb = await getNexusDb();
    const existing = await getUserProfileTrait(nexusDb, trait.traitKey);
    const now = new Date().toISOString();
    const fullTrait: UserProfileTrait = {
      ...trait,
      firstObservedAt: existing?.firstObservedAt ?? now,
      lastReinforcedAt: now,
      reinforcementCount: existing ? existing.reinforcementCount + 1 : 1,
      supersededBy: existing?.supersededBy ?? null,
    };
    await upsertUserProfileTrait(nexusDb, fullTrait);
    return engineSuccess({ created: existing === null });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProfileSupersede(
  oldKey: string,
  newKey: string,
): Promise<EngineResult<NexusProfileSupersedeResult>> {
  try {
    const nexusDb = await getNexusDb();
    await supersedeTrait(nexusDb, oldKey, newKey);
    return engineSuccess({ oldKey, newKey });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Canonical accessors for `decision_adr_links` — the two-way link table
 * between `D####` brain ledger decisions and curated ADR docs
 * (T13359 · spec `cleodocs-rearch-design` §4/§10 · D11165).
 *
 * Every write goes through the functions here, on the `openDualScopeDb`
 * chokepoint's drizzle handle ({@link getDb}) — gate 3 (no raw opens) and
 * gate 28 (no raw writes to syncing tables).
 *
 * Semantics implemented here (the settled tiered methodology, spec §4):
 *
 *   - The `D####` ledger stays the operational authority; ADR docs are the
 *     curated architecture record, authored when a decision graduates.
 *     Neither tier is generated from the other — this table is the only
 *     cross-reference, and it starts EMPTY (AC4: no ledger rewrite, no
 *     backfill of the ~360 existing decisions).
 *   - Identity is NATURAL over (decision_id, adr_slug): both devices derive
 *     the same uid for one pair, so concurrent identical links coalesce via
 *     `ON CONFLICT DO NOTHING` instead of breaking a unique index on apply
 *     (spec §10).
 *   - APPEND-ONLY: no DELETE exists. An unlink is a one-way monotonic latch
 *     flipping `status` to 'revoked' — the row itself is the tombstone and
 *     survives sync/restore. A revoked pair is never re-linked (rejection,
 *     not resurrection), so the latch can never be observed half-flipped.
 *     The latch is enforced at MERGE too (T13597): `SYNC_MERGE_RULES` marks
 *     'revoked' absorbing with no leave op, so a concurrent same-uid link op
 *     from another device is refused by the merge engine and cannot
 *     resurrect the tombstone by LWW.
 *   - Neither column is a DB-level FK: `decision_id` is a cross-DB soft
 *     reference (the ledger lives in brain.db) and `adr_slug` is a mutable
 *     doc alias (old slugs resolve through `conduit_doc_slug_aliases`).
 *
 * @module
 * @task T13359
 * @epic T13340
 * @saga T13339
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { and, eq } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import { naturalRowUid } from './row-identity.js';
import type { DecisionAdrLinkRow } from './schema/cleo-project/docs.js';
import { decisionAdrLinks } from './schema/cleo-project/docs.js';
import { getDb } from './sqlite.js';

/** Link states. The revoke latch only ever moves `linked` → `revoked`. */
export const DECISION_ADR_LINK_STATUSES = ['linked', 'revoked'] as const;

/** A live link state. */
export type DecisionAdrLinkStatus = (typeof DECISION_ADR_LINK_STATUSES)[number];

/** Bare `D####` ledger decision id shape (real brain ids, per T13358). */
const DECISION_ID_PATTERN = /^D\d+$/;

/**
 * Refuse an invalid input at the write boundary.
 *
 * @param name - Field name for the message.
 * @param value - The value to check.
 */
function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    // @sync-invariant none:input-shape a blank identifier is refused before any write; nothing was written
    throw new CleoError(ExitCode.VALIDATION_ERROR, `${name} must be a non-empty string`);
  }
}

/**
 * The natural row uid of one (decision, ADR) pair. Both devices derive this
 * same value, which is what makes concurrent identical links coalesce.
 *
 * @param decisionId - The `D####` ledger decision id.
 * @param adrSlug - The ADR doc slug.
 * @returns The canonical natural uid.
 */
export function decisionAdrLinkUid(decisionId: string, adrSlug: string): string {
  return naturalRowUid('project', 'decision_adr_links', [decisionId, adrSlug]);
}

/** Input for {@link linkDecisionToAdr}. */
export interface LinkDecisionToAdrInput {
  /** The `D####` ledger decision id. */
  readonly decisionId: string;
  /** The ADR doc slug (`adr-NNN-…`). */
  readonly adrSlug: string;
  /** Agent id creating the link; omitted when unknown. */
  readonly linkedBy?: string;
}

/** Outcome of a {@link linkDecisionToAdr} call. */
export interface LinkDecisionToAdrResult {
  /** The link row after the call. */
  readonly row: DecisionAdrLinkRow;
  /** True when this call inserted the row; false for an idempotent re-link. */
  readonly inserted: boolean;
}

/**
 * Link a `D####` decision to an ADR doc (append-only, natural identity).
 *
 * A repeat link of an already-linked pair is an idempotent no-op. A link of
 * a REVOKED pair is refused: append-only means the tombstone latch never
 * flips back, so re-linking would require resurrecting a dead row.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The link facts.
 * @returns The link row and whether it was inserted.
 */
// @sync-invariant docs.decision-adr-links.revoke-monotonic the read of the existing row and the conditional insert are one causal step: the read refuses a tombstoned pair (no resurrection) and the natural uid + ON CONFLICT DO NOTHING makes a concurrent identical link coalesce into the same row
export async function linkDecisionToAdr(
  projectRoot: string,
  input: LinkDecisionToAdrInput,
): Promise<LinkDecisionToAdrResult> {
  requireNonEmpty('decisionId', input.decisionId);
  requireNonEmpty('adrSlug', input.adrSlug);
  if (!DECISION_ID_PATTERN.test(input.decisionId)) {
    // @sync-invariant none:input-shape only bare D#### ledger ids may anchor a link; nothing was written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `decisionId must be a bare D#### ledger id (got '${input.decisionId}')`,
    );
  }
  const db = await getDb(projectRoot);
  const existing = await db
    .select()
    .from(decisionAdrLinks)
    .where(
      and(
        eq(decisionAdrLinks.decisionId, input.decisionId),
        eq(decisionAdrLinks.adrSlug, input.adrSlug),
      ),
    )
    .get();
  if (existing) {
    if (existing.status === 'revoked') {
      // @sync-invariant docs.decision-adr-links.revoke-monotonic the revoke latch is one-way; re-linking a tombstoned pair would resurrect a dead row
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `link ${input.decisionId} → ${input.adrSlug} was revoked; a revoked pair is never re-linked`,
      );
    }
    return { row: existing, inserted: false };
  }
  const uid = decisionAdrLinkUid(input.decisionId, input.adrSlug);
  const now = new Date().toISOString();
  await db
    .insert(decisionAdrLinks)
    .values({
      decisionId: input.decisionId,
      adrSlug: input.adrSlug,
      status: 'linked',
      ...(input.linkedBy !== undefined ? { linkedBy: input.linkedBy } : {}),
      createdAt: now,
      updatedAt: now,
      uid,
    })
    .onConflictDoNothing()
    .run();
  const row = await db
    .select()
    .from(decisionAdrLinks)
    .where(
      and(
        eq(decisionAdrLinks.decisionId, input.decisionId),
        eq(decisionAdrLinks.adrSlug, input.adrSlug),
      ),
    )
    .get();
  if (!row) {
    // @sync-invariant docs.decision-adr-links.revoke-monotonic a link insert that cannot be read back means the store lost the write; fail loudly instead of returning a phantom
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `link insert for ${input.decisionId} → ${input.adrSlug} could not be read back`,
    );
  }
  return { row, inserted: true };
}

/** Input for {@link revokeDecisionAdrLink}. */
export interface RevokeDecisionAdrLinkInput {
  /** The `D####` ledger decision id. */
  readonly decisionId: string;
  /** The ADR doc slug. */
  readonly adrSlug: string;
  /** Agent id revoking the link; omitted when unknown. */
  readonly revokedBy?: string;
}

/** Outcome of a {@link revokeDecisionAdrLink} call. */
export interface RevokeDecisionAdrLinkResult {
  /** The link row after the call. */
  readonly row: DecisionAdrLinkRow;
  /** True when this call flipped the latch; false for an idempotent re-revoke. */
  readonly revoked: boolean;
}

/**
 * Revoke a link as a TOMBSTONE LATCH (never a DELETE, never a resurrection).
 *
 * `status` flips `linked` → `revoked` exactly once and `updated_at` records
 * the tombstone instant; the row survives sync and restore as the permanent
 * record that this pair was once linked and then unlinked. Re-revoking an
 * already-revoked pair is an idempotent no-op. Revoking a pair that was
 * never linked is refused — a tombstone must reference a real link.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The revoke facts.
 * @returns The link row and whether the latch flipped.
 */
// @sync-invariant docs.decision-adr-links.revoke-monotonic the read-modify-write IS the one-way latch: flip linked→revoked exactly once, refuse if never linked; no DELETE exists on this table
export async function revokeDecisionAdrLink(
  projectRoot: string,
  input: RevokeDecisionAdrLinkInput,
): Promise<RevokeDecisionAdrLinkResult> {
  requireNonEmpty('decisionId', input.decisionId);
  requireNonEmpty('adrSlug', input.adrSlug);
  const db = await getDb(projectRoot);
  const existing = await db
    .select()
    .from(decisionAdrLinks)
    .where(
      and(
        eq(decisionAdrLinks.decisionId, input.decisionId),
        eq(decisionAdrLinks.adrSlug, input.adrSlug),
      ),
    )
    .get();
  if (!existing) {
    // @sync-invariant docs.decision-adr-links.revoke-monotonic a tombstone must reference a real link; revoking a never-linked pair would fabricate history
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `link ${input.decisionId} → ${input.adrSlug} does not exist; nothing to revoke`,
    );
  }
  if (existing.status === 'revoked') {
    return { row: existing, revoked: false };
  }
  await db
    .update(decisionAdrLinks)
    .set({
      status: 'revoked',
      ...(input.revokedBy !== undefined ? { revokedBy: input.revokedBy } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(decisionAdrLinks.decisionId, input.decisionId),
        eq(decisionAdrLinks.adrSlug, input.adrSlug),
      ),
    )
    .run();
  const row = await db
    .select()
    .from(decisionAdrLinks)
    .where(
      and(
        eq(decisionAdrLinks.decisionId, input.decisionId),
        eq(decisionAdrLinks.adrSlug, input.adrSlug),
      ),
    )
    .get();
  if (!row) {
    // @sync-invariant docs.decision-adr-links.revoke-monotonic a revoked row must still exist — the tombstone is a surviving row, never a disappearance
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `link ${input.decisionId} → ${input.adrSlug} vanished during its revoke tombstone`,
    );
  }
  return { row, revoked: true };
}

/** Read one link row by its natural key, any state. */
export async function getDecisionAdrLink(
  projectRoot: string,
  decisionId: string,
  adrSlug: string,
): Promise<DecisionAdrLinkRow | null> {
  requireNonEmpty('decisionId', decisionId);
  requireNonEmpty('adrSlug', adrSlug);
  const db = await getDb(projectRoot);
  const row = await db
    .select()
    .from(decisionAdrLinks)
    .where(and(eq(decisionAdrLinks.decisionId, decisionId), eq(decisionAdrLinks.adrSlug, adrSlug)))
    .get();
  return row ?? null;
}

/**
 * The ADR docs linked to one decision — the decision→ADR direction of the
 * two-way surfacing (spec §4: decision lookups surface their ADRs).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param decisionId - The `D####` ledger decision id.
 * @param opts.includeRevoked - Also return tombstoned links (default false).
 * @returns The link rows, ADR slug ascending.
 */
export async function listAdrLinksForDecision(
  projectRoot: string,
  decisionId: string,
  opts?: { includeRevoked?: boolean },
): Promise<DecisionAdrLinkRow[]> {
  requireNonEmpty('decisionId', decisionId);
  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(decisionAdrLinks)
    .where(eq(decisionAdrLinks.decisionId, decisionId))
    .all();
  const filtered = opts?.includeRevoked === true ? rows : rows.filter((r) => r.status === 'linked');
  return filtered.sort((a, b) => a.adrSlug.localeCompare(b.adrSlug));
}

/**
 * The `D####` decisions linked to one ADR doc — the ADR→decision direction
 * (`cleo docs fetch adr-NNN` surfaces its source decisions, spec §4 AC2).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param adrSlug - The ADR doc slug.
 * @param opts.includeRevoked - Also return tombstoned links (default false).
 * @returns The link rows, decision id ascending.
 */
export async function listDecisionLinksForAdr(
  projectRoot: string,
  adrSlug: string,
  opts?: { includeRevoked?: boolean },
): Promise<DecisionAdrLinkRow[]> {
  requireNonEmpty('adrSlug', adrSlug);
  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(decisionAdrLinks)
    .where(eq(decisionAdrLinks.adrSlug, adrSlug))
    .all();
  const filtered = opts?.includeRevoked === true ? rows : rows.filter((r) => r.status === 'linked');
  return filtered.sort((a, b) => a.decisionId.localeCompare(b.decisionId));
}

/** Optional `linkedAdrs` field attached by {@link attachLinkedAdrs}. */
export interface DecisionWithLinkedAdrs {
  /** ADR doc slugs with a live link to this decision; absent when none. */
  readonly linkedAdrs?: string[];
}

/**
 * Attach each `D####` decision's linked ADR slugs — the decision→ADR
 * direction of the two-way trace (spec §4: decision lookups surface their
 * curated ADR records). Rows without a bare `D####` id pass through
 * untouched.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param decisions - Decision rows as returned by the brain store.
 * @returns The same rows, with `linkedAdrs` added where links exist.
 */
export async function attachLinkedAdrs<T extends object>(
  projectRoot: string,
  decisions: readonly T[],
): Promise<Array<T & DecisionWithLinkedAdrs>> {
  const out: Array<T & DecisionWithLinkedAdrs> = [];
  for (const row of decisions) {
    const id = 'id' in row ? row.id : undefined;
    if (typeof id !== 'string' || !DECISION_ID_PATTERN.test(id)) {
      out.push(row);
      continue;
    }
    const links = await listAdrLinksForDecision(projectRoot, id);
    if (links.length === 0) {
      out.push(row);
      continue;
    }
    out.push({ ...row, linkedAdrs: links.map((link) => link.adrSlug) });
  }
  return out;
}

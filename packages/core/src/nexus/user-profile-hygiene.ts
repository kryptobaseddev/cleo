/**
 * User-profile hygiene: keep operation receipts out of `nexus_user_profile`
 * and repair the rows that already got in (T12543).
 *
 * ## The defect
 *
 * The dialectic hook in the CQRS dispatcher fed every successful mutate
 * operation to the evaluator as a "turn": `cleo <domain> <op> {params}` paired
 * with `Operation succeeded in domain "<domain>"`. The evaluator minted
 * user traits from those envelopes — "Operation succeeded in domain 'check'",
 * "gate set to true for T1655" — and, because the table is GLOBAL, facts
 * lifted from one project's task params were injected into every other
 * project's spawn prompts. Measured 2026-09-27: 399 of 404 rows were
 * `dialectic:<session>` rows, each seen exactly once.
 *
 * ## What this module provides
 *
 * - {@link classifyReceiptTrait} — the text classifier for status lines and
 *   operation receipts. The evaluator applies it to every global trait
 *   (defence in depth behind the structural `origin` filter).
 * - {@link pruneReceiptTraits} — dry-run / apply repair. Apply writes a
 *   backup file FIRST (a `user_profile.json`-shaped envelope carrying the full
 *   rows), then deletes each row only if it is unchanged since it was read.
 * - {@link restorePrunedTraits} — re-inserts rows from that backup, never
 *   overwriting a row that was re-created since.
 *
 * @task T12543
 * @epic T12515
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserProfileTrait } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
import * as nexusSchema from '../store/schema/nexus-schema.js';
import { getUserProfileTrait, listUserProfile, upsertUserProfileTrait } from './user-profile.js';

/** Drizzle handle over a database holding `nexus_user_profile`. */
type NexusDb = NodeSQLiteDatabase;

// ---------------------------------------------------------------------------
// Receipt classifier
// ---------------------------------------------------------------------------

/** One receipt-detection rule. */
interface ReceiptRule {
  /** Stable rule id reported by the repair. */
  readonly id: string;
  /** Test applied to the trait key. */
  readonly key?: RegExp;
  /** Test applied to the trait value. */
  readonly value?: RegExp;
}

/**
 * Status-line / operation-receipt rules. A trait matches when ANY rule's key
 * OR value pattern matches. Each targets a shape that states what an operation
 * DID, which is never a durable fact about the user.
 */
const RECEIPT_RULES: readonly ReceiptRule[] = [
  {
    id: 'operation-status',
    value:
      /\boperations?\b[^.\n]{0,60}\b(succeeded|successful(ly)?|failed|completed)\b|\b(succeeded|success)\b[^.\n]{0,20}\b(in|for)\b[^.\n]{0,12}\bdomain\b/i,
  },
  {
    id: 'success-key',
    key: /(^|[-_.])(succeed(ed|s)?|success(ful)?|succeeded-in|ops-success)([-_.]|$)/i,
  },
  {
    id: 'command-echo',
    value:
      /^\s*cleo\s+[a-z-]+\s+[a-z.-]+\b|\bcleo (successfully|set|completed|executed|interacted)\b/i,
  },
  {
    id: 'gate-receipt',
    value:
      /\bgate\b[^.\n]{0,80}\bset\b|\bset\b[^.\n]{0,40}\bgates?\b|\bgate\b[^.\n]{0,60}\b(to )?true\b|\bgate\.(set|implemented)\b/i,
  },
  {
    id: 'task-receipt',
    value:
      /\b(completed|created|added|updated|closed|marked|recorded|passed)\b[^.\n]{0,40}\bT\d{2,}\b|\bT\d{2,}\b[^.\n]{0,40}\b(has been|was|were)\b[^.\n]{0,20}\b(completed|created|added|updated|marked|set)\b/i,
  },
  {
    id: 'session-status',
    value: /\bactive peer\b|\bglobal peer\b/i,
    key: /(^|-)active-peer(-|$)/i,
  },
];

/**
 * Classify a trait as an operation receipt / status line.
 *
 * @param traitKey - Trait key (kebab-case semantic key).
 * @param traitValue - Trait value text.
 * @returns The id of the first matching rule, or `null` when the trait does
 *   not look like a receipt.
 *
 * @example
 * ```ts
 * classifyReceiptTrait('task-successful', 'Cleo tasks update operation succeeded'); // 'operation-status'
 * classifyReceiptTrait('strict-typescript', 'never use any');                        // null
 * ```
 *
 * @task T12543
 */
export function classifyReceiptTrait(traitKey: string, traitValue: string): string | null {
  for (const rule of RECEIPT_RULES) {
    if (rule.value?.test(traitValue) || rule.key?.test(traitKey)) return rule.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repair: prune + restore
// ---------------------------------------------------------------------------

/**
 * Structural rule id: a legacy `dialectic:*` row with no project stamp. Before
 * T12543 the only writer of dialectic global traits was the dispatcher hook,
 * whose "turn" was always an operation envelope — so every such row is a
 * receipt by construction, whatever its text says.
 */
export const OPERATION_ENVELOPE_RULE = 'operation-envelope' as const;

/** One trait matched by the repair. */
export interface TraitPruneCandidate {
  /** Trait key (primary key). */
  readonly traitKey: string;
  /** Trait value at read time. */
  readonly traitValue: string;
  /** Trait source (e.g. `dialectic:<sessionId>`). */
  readonly source: string;
  /** Originating project id, or `null` for unknown origin. */
  readonly projectId: string | null;
  /** Matching rule id (a receipt rule, or {@link OPERATION_ENVELOPE_RULE}). */
  readonly rule: string;
}

/** Options for {@link pruneReceiptTraits}. */
export interface TraitPruneOptions {
  /** Delete matched rows (after writing a backup). Default: dry run. */
  readonly apply?: boolean;
  /**
   * Also match every legacy `dialectic:*` row with no project stamp
   * ({@link OPERATION_ENVELOPE_RULE}). Default: receipt-text rules only.
   */
  readonly includeEnvelopeDerived?: boolean;
  /** Directory for the backup file. Default: `<cleoHome>/backups/user-profile`. */
  readonly backupDir?: string;
}

/** Outcome (and, when applied, receipt) of {@link pruneReceiptTraits}. */
export interface TraitPruneResult {
  /** Whether rows were deleted (`false` = dry run). */
  readonly applied: boolean;
  /** Row count before the run. */
  readonly before: number;
  /** Row count after the run (equals `before` on a dry run). */
  readonly after: number;
  /** Number of rows matched. */
  readonly matched: number;
  /** Per-rule match counts. */
  readonly byRule: Record<string, number>;
  /** Every matched trait key, in key order. */
  readonly candidateKeys: readonly string[];
  /** Up to 10 matched rows, so a dry run shows what would go. */
  readonly sample: readonly TraitPruneCandidate[];
  /**
   * Unknown-origin rows (`project_id IS NULL`, scope `project`) that this run
   * leaves in place. They are excluded from every spawn prompt and remain
   * queryable via `cleo nexus profile view`.
   */
  readonly unknownOriginRetained: number;
  /** Keys actually deleted (apply only). */
  readonly removedKeys?: readonly string[];
  /** Keys skipped because the row changed after it was read (apply only). */
  readonly changedSkipped?: readonly string[];
  /** ISO-8601 instant of the deletion (apply only). */
  readonly removedAt?: string;
  /** Absolute path of the backup written BEFORE any deletion (apply only). */
  readonly backupPath?: string;
  /** SHA-256 of the backup file bytes (apply only). */
  readonly backupSha256?: string;
  /** Command that reverses the apply (apply only). */
  readonly restoreCommand?: string;
}

/** Backup envelope written by {@link pruneReceiptTraits}. */
interface TraitPruneBackup {
  readonly $schema: string;
  readonly exportedAt: string;
  readonly reason: string;
  readonly traits: UserProfileTrait[];
}

/**
 * Match one trait against the enabled rules.
 *
 * @param trait - Row to classify.
 * @param includeEnvelopeDerived - Whether the structural rule is enabled.
 * @returns The matching rule id, or `null`.
 */
function matchTrait(trait: UserProfileTrait, includeEnvelopeDerived: boolean): string | null {
  const textRule = classifyReceiptTrait(trait.traitKey, trait.traitValue);
  if (textRule) return textRule;
  if (
    includeEnvelopeDerived &&
    trait.source.startsWith('dialectic:') &&
    (trait.projectId ?? null) === null
  ) {
    return OPERATION_ENVELOPE_RULE;
  }
  return null;
}

/**
 * List — and with `apply`, remove — receipt-style user-profile traits.
 *
 * Apply is reversible: the full matched rows are written to a backup file
 * before anything is deleted, and each delete is guarded on the row being
 * unchanged since it was read (a re-derived or edited row is skipped and
 * reported). Reverse with {@link restorePrunedTraits} /
 * `cleo memory prune-traits --restore <backupPath>`.
 *
 * @param nexusDb - Drizzle handle over the database holding `nexus_user_profile`.
 * @param options - Apply flag, rule selection and backup location.
 * @returns Counts, per-rule breakdown, sample, and — when applied — the receipt.
 *
 * @example
 * ```ts
 * const preview = await pruneReceiptTraits(db);
 * if (preview.matched > 0) await pruneReceiptTraits(db, { apply: true });
 * ```
 *
 * @task T12543
 */
export async function pruneReceiptTraits(
  nexusDb: NexusDb,
  options: TraitPruneOptions = {},
): Promise<TraitPruneResult> {
  const includeEnvelopeDerived = options.includeEnvelopeDerived === true;
  const all = await listUserProfile(nexusDb, { includeSuperseded: true });
  const matchedRows: Array<{ trait: UserProfileTrait; rule: string }> = [];
  const byRule: Record<string, number> = {};
  for (const trait of all) {
    const rule = matchTrait(trait, includeEnvelopeDerived);
    if (!rule) continue;
    matchedRows.push({ trait, rule });
    byRule[rule] = (byRule[rule] ?? 0) + 1;
  }
  matchedRows.sort((a, b) => a.trait.traitKey.localeCompare(b.trait.traitKey));
  const matchedKeys = new Set(matchedRows.map((m) => m.trait.traitKey));
  const unknownOriginRetained = all.filter(
    (t) =>
      (t.projectId ?? null) === null &&
      (t.scope ?? 'project') === 'project' &&
      !matchedKeys.has(t.traitKey),
  ).length;

  const report = {
    before: all.length,
    matched: matchedRows.length,
    byRule,
    candidateKeys: matchedRows.map((m) => m.trait.traitKey),
    sample: matchedRows.slice(0, 10).map(({ trait, rule }) => ({
      traitKey: trait.traitKey,
      traitValue: trait.traitValue,
      source: trait.source,
      projectId: trait.projectId ?? null,
      rule,
    })),
    unknownOriginRetained,
  };
  if (!options.apply || matchedRows.length === 0) {
    return { applied: false, after: all.length, ...report };
  }

  // 1. Backup FIRST — nothing is deleted unless the backup is on disk.
  const removedAt = new Date().toISOString();
  const backupDir = options.backupDir ?? join(getCleoHome(), 'backups', 'user-profile');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `receipt-traits-${removedAt.replace(/[:.]/g, '-')}.json`);
  const backup: TraitPruneBackup = {
    $schema: 'https://cleocode.dev/schemas/user-profile/v1.json',
    exportedAt: removedAt,
    reason: `T12543 prune-traits (${includeEnvelopeDerived ? 'receipt-text + operation-envelope' : 'receipt-text'})`,
    traits: matchedRows.map((m) => m.trait),
  };
  const bytes = `${JSON.stringify(backup, null, 2)}\n`;
  await writeFile(backupPath, bytes, { encoding: 'utf8', flag: 'wx' });
  const backupSha256 = createHash('sha256').update(bytes).digest('hex');

  // 2. Guarded deletes: only a row unchanged since the read above is removed.
  const removedKeys: string[] = [];
  const changedSkipped: string[] = [];
  const table = nexusSchema.userProfile;
  for (const { trait } of matchedRows) {
    const deleted = await nexusDb
      .delete(table)
      .where(
        and(
          eq(table.traitKey, trait.traitKey),
          eq(table.traitValue, trait.traitValue),
          eq(table.source, trait.source),
          eq(table.lastReinforcedAt, new Date(trait.lastReinforcedAt).toISOString()),
        ),
      )
      .returning({ traitKey: table.traitKey });
    if (deleted.length > 0) removedKeys.push(trait.traitKey);
    else changedSkipped.push(trait.traitKey);
  }

  const after = (await listUserProfile(nexusDb, { includeSuperseded: true })).length;
  return {
    applied: true,
    after,
    ...report,
    removedKeys,
    changedSkipped,
    removedAt,
    backupPath,
    backupSha256,
    restoreCommand: `cleo memory prune-traits --restore '${backupPath}'`,
  };
}

/** Outcome of {@link restorePrunedTraits}. */
export interface TraitRestoreResult {
  /** Backup file read. */
  readonly backupPath: string;
  /** SHA-256 of the backup bytes read (compare with the prune receipt). */
  readonly backupSha256: string;
  /** Keys re-inserted. */
  readonly restoredKeys: readonly string[];
  /** Keys skipped because a row with that key exists again. */
  readonly skippedExisting: readonly string[];
}

/**
 * Reverse a {@link pruneReceiptTraits} apply from its backup file.
 *
 * Re-inserts each backed-up row verbatim (value, provenance, project stamp,
 * scope, timestamps). A key that exists again is left untouched — a newer
 * row always wins over a restore.
 *
 * @param nexusDb - Drizzle handle over the database holding `nexus_user_profile`.
 * @param backupPath - Path from the prune receipt's `backupPath`.
 * @returns The restored and skipped keys plus the backup digest.
 *
 * @task T12543
 */
export async function restorePrunedTraits(
  nexusDb: NexusDb,
  backupPath: string,
): Promise<TraitRestoreResult> {
  const bytes = await readFile(backupPath, 'utf8');
  const backup = JSON.parse(bytes) as Partial<TraitPruneBackup>;
  const traits = Array.isArray(backup.traits) ? backup.traits : [];
  const restoredKeys: string[] = [];
  const skippedExisting: string[] = [];
  for (const trait of traits) {
    if (await getUserProfileTrait(nexusDb, trait.traitKey)) {
      skippedExisting.push(trait.traitKey);
      continue;
    }
    await upsertUserProfileTrait(nexusDb, trait);
    restoredKeys.push(trait.traitKey);
  }
  return {
    backupPath,
    backupSha256: createHash('sha256').update(bytes).digest('hex'),
    restoredKeys,
    skippedExisting,
  };
}

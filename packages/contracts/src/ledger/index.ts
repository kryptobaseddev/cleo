/**
 * `@cleocode/contracts/ledger`: the decoded change-journal transaction and op
 * shapes (journal spec `t12342-t12343-journal-design` §2.6).
 *
 * A sealed segment carries an array of {@link LedgerTxn}; each transaction
 * carries {@link LedgerOp}s on sync-set rows, keyed by row uid. Values use the
 * canonical typed wire encoding ({@link LedgerWireValue}), and counter deltas
 * travel as `{ $inc }` ({@link LedgerValue}).
 *
 * Zod schemas, inferred types and const data only (arch gate 10). The sealer
 * that produces these shapes and the merge engine that applies them live in
 * `@cleocode/core` (`store/sync/`).
 *
 * @module ledger
 * @task T12344
 * @epic T12323
 */

import { z } from 'zod';
import { Hlc } from '../cloud/ids.js';

/** The transaction format version this build writes and reads (`LedgerTxn.v`). */
export const LEDGER_TXN_VERSION = 1;

/**
 * A typed wire value: a string, null, a safe integer, or a typed escape for an
 * integer beyond 2^53 (`$i`), a REAL (`$r`, `%!.17g` text, `Inf` accepted) or a
 * BLOB (`$b`, base64).
 */
export const LedgerWireValue = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.object({ $i: z.string() }).strict(),
  z.object({ $r: z.string() }).strict(),
  z.object({ $b: z.string() }).strict(),
]);
export type LedgerWireValue = z.infer<typeof LedgerWireValue>;

/** A counter delta (`SYNC_COUNTER_COLUMNS`): applied by summing, never by plain LWW. */
export const LedgerIncrement = z.object({ $inc: z.number() }).strict();
export type LedgerIncrement = z.infer<typeof LedgerIncrement>;

/** An after-value: a wire value or a counter delta. */
export const LedgerValue = z.union([LedgerWireValue, LedgerIncrement]);
export type LedgerValue = z.infer<typeof LedgerValue>;

/** The op kinds: insert, update, delete, re-key. */
export const LedgerOpKind = z.enum(['I', 'U', 'D', 'K']);
export type LedgerOpKind = z.infer<typeof LedgerOpKind>;

/** One op on one sync-set row (§2.6). */
export const LedgerOp = z
  .object({
    /** Table. */
    t: z.string().min(1),
    /** Row uid; for K the OLD uid. */
    u: z.string().min(1),
    o: LedgerOpKind,
    /** The op's HLC; also every field's HLC unless `fh` names a different one. */
    h: Hlc,
    /** K only: the new uid. */
    nu: z.string().min(1).optional(),
    /** birth_fp, on every op of a minted row; for K, the new value. */
    bfp: z.string().optional(),
    /** K only: the old birth_fp. */
    obfp: z.string().optional(),
    /** Per-field HLCs where they differ from `h`. */
    fh: z.record(z.string(), Hlc).optional(),
    /** Natural rows: the key, with refs as uids. */
    k: z.record(z.string(), LedgerValue).optional(),
    /** After-values (refs as uids; counters as `{ $inc }`). */
    a: z.record(z.string(), LedgerValue).optional(),
    /** Before-image (secrets excluded). */
    b: z.record(z.string(), LedgerWireValue).optional(),
  })
  .strict()
  .refine((op) => (op.o === 'K') === (op.nu !== undefined), {
    message: 'nu is required on a K op and only there',
  });
export type LedgerOp = z.infer<typeof LedgerOp>;

/** Who wrote a transaction; `op` names the command (e.g. `tasks.reopen`). */
export const LedgerActor = z
  .object({
    agent: z.string().optional(),
    session: z.string().optional(),
    op: z.string().optional(),
  })
  .strict();
export type LedgerActor = z.infer<typeof LedgerActor>;

/** How a transaction's writes reached the store. */
export const LedgerTxnVia = z.enum(['accessor', 'connection', 'foreign', 'repair', 'rebind']);
export type LedgerTxnVia = z.infer<typeof LedgerTxnVia>;

/** What a transaction is for. */
export const LedgerTxnKind = z.enum([
  'write',
  'remint',
  'rekey',
  'repair',
  'exodus',
  'import',
  'retire',
]);
export type LedgerTxnKind = z.infer<typeof LedgerTxnKind>;

/**
 * One sealed transaction (§2.6). `v` is checked by the receiver, not by this
 * schema, so a newer format is refused with an explicit error rather than a
 * parse failure.
 */
export const LedgerTxn = z
  .object({
    v: z.number().int().positive(),
    /** `${replicaId}:${localTxnSeq}`. */
    txn: z.string().min(1),
    /** Only for split oversized groups: [part, of]. */
    part: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    hlc: Hlc,
    /** Merge key is (project, uid). */
    project: z.string().nullable(),
    scope: z.enum(['project', 'global']),
    via: LedgerTxnVia,
    kind: LedgerTxnKind,
    actor: LedgerActor.nullable(),
    ops: z.array(LedgerOp),
    retire: z
      .object({
        replica: z.string(),
        successor: z.string(),
        lastReplicaSeq: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Ed25519 over the transaction signing message (§2.8). */
    sig: z.string(),
  })
  .strict();
export type LedgerTxn = z.infer<typeof LedgerTxn>;

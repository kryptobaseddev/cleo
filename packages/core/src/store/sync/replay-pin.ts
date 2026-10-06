/**
 * The replay pin of a checkpoint (journal spec §2.11 §7; NEW-9, R5-8,
 * T12797): what an endorsing device must replay under to recompute the
 * checkpoint's tallies.
 *
 * - `journal`: sha256 over the store's WHOLE ordered migration journal,
 *   `(created_at, name, hash)` per applied migration, in drizzle's order
 *   `(created_at, name)`. A single head is not enough: stamped and drifted
 *   stores differ below it.
 * - `triggerSetHash`: sha256 over the normalized DDL of the store's OWNED
 *   triggers ({@link OWNED_TRIGGERS}: the guard and side-effect triggers a
 *   replay runs under), sorted by name. Device-local maintenance triggers
 *   (the twin-collapse docs freeze, whose message names the build that froze
 *   that store, and the legacy track triggers) never touch a replayed table,
 *   so they stay out: two devices with the same replay semantics agree
 *   (T13298). Normalization is literal-safe ({@link normalizeTriggerDdl}).
 * - `transitions`: the schema rise points inside the checkpoint's window;
 *   the caller computes them from the segments it replayed (empty for a
 *   genesis checkpoint, which has no window to replay).
 *
 * The server cannot check the two hashes; another device recomputes them
 * from its own store and requires a match before it endorses.
 *
 * @task T12343
 * @module store/sync/replay-pin
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ReplayPin } from '@cleocode/contracts/cloud';
import { hasTable } from './schema.js';
import { canonicalJson } from './sealer-values.js';
import { OWNED_TRIGGERS } from './trigger-classes.js';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Normalize trigger DDL for hashing, literal-safely (§2.11 §7): comments are
 * dropped; outside string literals and quoted identifiers, whitespace runs
 * collapse to one space (and vanish next to punctuation) and words are
 * lower-cased; a string literal is kept byte for byte (`'Done'` stays
 * `'Done'`); every quoted identifier (`"x"`, `` `x` ``, `[x]`) is written
 * `"x"`, and a bare identifier stays bare (SQLite treats both alike for the
 * names a trigger uses, so the two spellings of one trigger hash alike only
 * when quoting is unified this way).
 *
 * @param sql - The trigger's `CREATE TRIGGER` text.
 * @returns The normalized text.
 */
export function normalizeTriggerDdl(sql: string): string {
  const out: string[] = [];
  let i = 0;
  let space = false;
  const push = (tok: string, word: boolean): void => {
    const prev = out[out.length - 1];
    // One space between two word-like tokens; none around punctuation.
    if (space && prev !== undefined && word && /[\w"'\]`]$/.test(prev)) out.push(' ');
    out.push(tok);
    space = false;
  };
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) {
      space = true;
      i += 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      space = true;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      space = true;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j += 1;
      }
      push(sql.slice(i, j + 1), true);
      i = j + 1;
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      let name = '';
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            name += close;
            j += 2;
          } else break;
        } else {
          name += sql[j];
          j += 1;
        }
      }
      push(`"${name.replaceAll('"', '""')}"`, true);
      i = j + 1;
    } else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql[j] as string)) j += 1;
      push(sql.slice(i, j).toLowerCase(), true);
      i = j;
    } else {
      push(c, false);
      i += 1;
    }
  }
  return out.join('').replace(/;$/, '');
}

/**
 * sha256 of the store's whole ordered migration journal (§2.11 §7): every
 * `__drizzle_migrations` row as `[created_at, name, hash]`, ordered by
 * `(created_at, name)`. A store without the journal hashes an empty list.
 *
 * @param db - The store.
 * @returns The hex digest.
 */
export function migrationJournalHash(db: DatabaseSync): string {
  const rows = hasTable(db, '__drizzle_migrations')
    ? (db
        .prepare(
          'SELECT created_at, name, hash FROM main."__drizzle_migrations" ORDER BY created_at, name',
        )
        .all() as Array<{ created_at: number | bigint | null; name: string | null; hash: string }>)
    : [];
  return sha256Hex(
    canonicalJson(
      rows.map((r) => [r.created_at === null ? null : Number(r.created_at), r.name, r.hash]),
    ),
  );
}

/**
 * sha256 over the normalized DDL of every owned trigger present in the store
 * ({@link OWNED_TRIGGERS}), sorted by name (§2.11 §7; T13298). Capture
 * triggers (generated per build) and device-local maintenance triggers are
 * excluded: they never run in a replay.
 *
 * @param db - The store.
 * @returns The hex digest.
 */
export function triggerSetHash(db: DatabaseSync): string {
  const rows = (
    db
      .prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>
  ).filter((r) => Object.hasOwn(OWNED_TRIGGERS, r.name) && r.sql !== null);
  return sha256Hex(canonicalJson(rows.map((r) => [r.name, normalizeTriggerDdl(r.sql as string)])));
}

/**
 * A checkpoint's replay pin, from the store it snapshots (§2.11 §7).
 *
 * @param db - The store (or the snapshot of it the checkpoint carries).
 * @param transitions - The window's schema rise points (empty for genesis).
 * @returns The pin.
 */
export function replayPinOf(
  db: DatabaseSync,
  transitions: ReplayPin['transitions'] = [],
): ReplayPin {
  return {
    journal: migrationJournalHash(db),
    triggerSetHash: triggerSetHash(db),
    transitions: [...transitions],
  };
}

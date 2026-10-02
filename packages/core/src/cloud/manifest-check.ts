import type { Manifest, TableDeltas, TxnRef } from '@cleocode/contracts/cloud';

/*
 * The checkpoint manifest rules of Cleo Nexus, mirrored from cleo-nexus
 * `packages/shared/src/manifest-check.ts` (journal spec §2.11, T089, T090): the server runs them on
 * every checkpoint create, and a client runs them to know what the server will accept before it
 * writes anything. Keep the two copies identical in behaviour (T13034).
 */

/**
 * 3 for a manifest with the §2.11 accounting fields (checkpoint/v3), else 2. The server's copy is in
 * its wire contract; contracts export no runtime helpers here (arch gate 10), so it lives beside the
 * rules.
 *
 * @param m - A checkpoint manifest.
 * @returns The manifest format, which picks the checkpoint signing domain.
 */
export function manifestVersion(m: Manifest): 2 | 3 {
  return m.replayPin !== undefined ? 3 : 2;
}

/** The v2 verdict on a checkpoint manifest: accepted, a row regression, or a schema too new. */
export type ManifestVerdict =
  | { ok: true }
  | { ok: false; code: 'E_REGRESSION'; tables: RegressionFinding[] }
  | { ok: false; code: 'E_SCHEMA_AHEAD'; schemaVersion: number; maxAccepted: number };

/** One table whose rows do not reconcile with the parent and the journal. */
export interface RegressionFinding {
  table: string;
  parentRows: number;
  created: number;
  deleted: number;
  expectedRows: number;
  actualRows: number;
  reason: 'missing-table' | 'count-mismatch';
}

/** Sum the per-table deltas of every segment folded into a checkpoint. */
export function sumDeltas(deltas: readonly TableDeltas[]): TableDeltas {
  const out: TableDeltas = {};
  for (const d of deltas) {
    for (const [table, { created, deleted }] of Object.entries(d)) {
      // Own keys only: a table named like an Object.prototype member must not read the prototype.
      const prev = (Object.hasOwn(out, table) ? out[table] : undefined) ?? {
        created: 0,
        deleted: 0,
      };
      out[table] = { created: prev.created + created, deleted: prev.deleted + deleted };
    }
  }
  return out;
}

/**
 * Decide whether a new checkpoint manifest may replace its parent.
 *
 * The rule is exact, not a heuristic: for every table either side names,
 * `next.rows === parent.rows + created - deleted`, summed over the segments between the two
 * checkpoints. Every shrink therefore needs a tombstone op to back it, and every new table's rows
 * need declared creates. A table with rows in the parent must still be present, even with 0 rows.
 *
 * With no parent (genesis), only the schema version is checked.
 */
export function checkManifest(
  parent: Manifest | null,
  next: Manifest,
  between: TableDeltas,
  maxAcceptedSchemaVersion: number,
): ManifestVerdict {
  if (next.schemaVersion > maxAcceptedSchemaVersion) {
    return {
      ok: false,
      code: 'E_SCHEMA_AHEAD',
      schemaVersion: next.schemaVersion,
      maxAccepted: maxAcceptedSchemaVersion,
    };
  }
  if (parent === null) return { ok: true };

  const findings: RegressionFinding[] = [];
  // Every table either side names: a new table with rows needs declared creates too.
  const tables = new Set([
    ...Object.keys(parent.tables),
    ...Object.keys(between),
    ...Object.keys(next.tables),
  ]);
  for (const table of [...tables].sort()) {
    const parentRows = Object.hasOwn(parent.tables, table) ? (parent.tables[table]?.rows ?? 0) : 0;
    const { created, deleted } = Object.hasOwn(between, table)
      ? (between[table] ?? { created: 0, deleted: 0 })
      : { created: 0, deleted: 0 };
    const expectedRows = parentRows + created - deleted;
    const entry = Object.hasOwn(next.tables, table) ? next.tables[table] : undefined;
    if (entry === undefined) {
      // Absent counts as 0 rows only when 0 is what the journal leaves (a negative expectation too).
      if (parentRows > 0 || expectedRows !== 0) {
        findings.push({
          table,
          parentRows,
          created,
          deleted,
          expectedRows,
          actualRows: 0,
          reason: 'missing-table',
        });
      }
      continue;
    }
    if (entry.rows !== expectedRows) {
      findings.push({
        table,
        parentRows,
        created,
        deleted,
        expectedRows,
        actualRows: entry.rows,
        reason: 'count-mismatch',
      });
    }
  }
  return findings.length === 0
    ? { ok: true }
    : { ok: false, code: 'E_REGRESSION', tables: findings };
}

// ---------------------------------------------------------------------------
// v3: applied-effect accounting under concurrent writers (journal spec §2.11)
// ---------------------------------------------------------------------------

/** A transaction and its declared (or remaining voided) per-table counts. */
export interface DeclaredTxn {
  readonly ref: TxnRef;
  readonly deltas: TableDeltas;
}

/** A seq in a checkpoint window at which the highest segment schemaVersion seen so far rises. */
export interface SchemaRise {
  readonly seq: number;
  readonly schemaVersion: number;
}

/** What the server knows about a checkpoint's window, the segments in (parent.coversSeq, coversSeq]. */
export interface CheckpointWindow {
  /** The declared deltas of every transaction in the window: the sum of its segments' `deltas`. */
  readonly deltas: TableDeltas;
  /**
   * Declared transactions of the window: at least every one the manifest names in `pending` or
   * `voided` (the server loads only those). A named ref missing here is not in the window.
   */
  readonly txns: readonly DeclaredTxn[];
  /** Each window segment's seq and schemaVersion, in seq order. */
  readonly schemaVersions: readonly SchemaRise[];
}

/** A window built from all of its transactions (and segment schema versions), for small windows and tests. */
export function windowOf(
  txns: readonly DeclaredTxn[],
  schemaVersions: readonly SchemaRise[] = [],
): CheckpointWindow {
  return { deltas: sumDeltas(txns.map((t) => t.deltas)), txns, schemaVersions };
}

/**
 * The transition points of a replay pin (journal spec §2.11 §7): each seq at which the highest
 * schemaVersion seen so far rises above everything before it, starting from `baseline` (the parent
 * checkpoint's schemaVersion).
 */
export function schemaRises(baseline: number, schemaVersions: readonly SchemaRise[]): SchemaRise[] {
  const out: SchemaRise[] = [];
  let max = baseline;
  for (const s of schemaVersions) {
    if (s.schemaVersion > max) {
      out.push({ seq: s.seq, schemaVersion: s.schemaVersion });
      max = s.schemaVersion;
    }
  }
  return out;
}

/** Why a v3 manifest's accounting lists are refused. */
export type AccountingFinding =
  | { reason: 'genesis-not-empty' }
  | { reason: 'duplicate-ref'; list: 'pending' | 'voided' | 'revived'; ref: TxnRef }
  | { reason: 'pending-not-in-window'; ref: TxnRef }
  | { reason: 'pending-unresolved'; ref: TxnRef }
  | { reason: 'transitions-mismatch'; expected: SchemaRise[]; actual: SchemaRise[] }
  | { reason: 'schema-version-below-floor'; schemaVersion: number; floor: number }
  | { reason: 'voided-not-applied'; ref: TxnRef }
  | { reason: 'voided-exceeds-declared'; ref: TxnRef; table: string }
  | { reason: 'revived-not-voided'; ref: TxnRef }
  | { reason: 'revived-exceeds-voided'; ref: TxnRef; table: string }
  | { reason: 'pruned-out-of-range'; table: string; pruned: number; max: number };

/** The v3 verdict: the v2 outcomes, accounting refusals, or the stream's v3 ratchet. */
export type ManifestVerdictV3 =
  | ManifestVerdict
  | { ok: false; code: 'E_MANIFEST_ACCOUNTING'; findings: AccountingFinding[] }
  | { ok: false; code: 'E_STREAM_VERSION'; reason: 'stream-v3'; parentVersion: 3; nextVersion: 2 };

/** The key of a transaction ref in maps. */
export function txnRefKey(r: TxnRef): string {
  return `${r.replicaId}\u0000${r.replicaSeq}\u0000${r.txn}`;
}

type Counts = { created: number; deleted: number };
const ZERO: Counts = { created: 0, deleted: 0 };
const own = (d: TableDeltas, t: string): Counts =>
  Object.hasOwn(d, t) ? ((d[t] as Counts | undefined) ?? ZERO) : ZERO;

function addInto(into: Map<string, Counts>, d: TableDeltas, sign = 1): void {
  for (const [t, c] of Object.entries(d)) {
    const s = into.get(t) ?? ZERO;
    into.set(t, { created: s.created + sign * c.created, deleted: s.deleted + sign * c.deleted });
  }
}

/**
 * Decide whether a v3 checkpoint manifest may replace its parent (journal spec §2.11 §4). Exact:
 * no aggregate slack for pending and no age bound. With `A` = (window transactions ∪ the parent's
 * pending) − the new pending, every table must hold
 *
 *   rows = parent.rows + Decl(A).created − Decl(A).deleted
 *          − Σ voided.created + Σ voided.deleted
 *          + Σ revived.created − Σ revived.deleted
 *          − pruned
 *
 * and: pending ⊆ window ∪ parent.pending; every voided ref ∈ A with counts ≤ its declared counts;
 * every revived ref in the stream's cumulative voided set with counts ≤ what is still voided there;
 * 0 ≤ pruned ≤ parent.rows + Decl(A).created; the replay pin's transitions are exactly the window's
 * schema rise points from the parent's schemaVersion, and the manifest's schemaVersion is at least the
 * parent's and the last of those rises (T090), so the next window's baseline never sits below what
 * the replay already reached. Decl(A) is computed from the window's sum, so
 * only the named transactions need loading: Decl(window) + Decl(parent.pending) − Decl(pending).
 * A v2 manifest is the v3 one with empty lists; a v2 segment is one transaction (txn 0) with the
 * segment's deltas. Once a stream has a v3 checkpoint, a v2 one is refused (E_STREAM_VERSION): the
 * lineage is linear, so checking the parent ratchets the whole stream.
 *
 * @param input.window - The window's deltas sum, its named transactions and its segment versions.
 * @param input.parentPending - The declared deltas of the parent manifest's pending refs. Each of
 *   them must be here (`pending-unresolved` otherwise).
 * @param input.voidedBefore - The stream's cumulative voided set before this checkpoint: at least
 *   the entries of every ref `next.revived` names.
 */
export function checkManifestV3(input: {
  readonly parent: Manifest | null;
  readonly next: Manifest;
  readonly window: CheckpointWindow;
  readonly parentPending: readonly DeclaredTxn[];
  readonly voidedBefore: readonly DeclaredTxn[];
  readonly maxAcceptedSchemaVersion: number;
}): ManifestVerdictV3 {
  const { parent, next } = input;
  const transitions = next.replayPin?.transitions ?? [];
  const ahead = Math.max(next.schemaVersion, ...transitions.map((t) => t.schemaVersion));
  if (ahead > input.maxAcceptedSchemaVersion) {
    return {
      ok: false,
      code: 'E_SCHEMA_AHEAD',
      schemaVersion: ahead,
      maxAccepted: input.maxAcceptedSchemaVersion,
    };
  }
  if (parent !== null && manifestVersion(parent) === 3 && manifestVersion(next) === 2) {
    return {
      ok: false,
      code: 'E_STREAM_VERSION',
      reason: 'stream-v3',
      parentVersion: 3,
      nextVersion: 2,
    };
  }
  const pending = next.pending ?? [];
  const voided = next.voided ?? [];
  const revived = next.revived ?? [];
  const pruned = next.pruned ?? {};
  const findings: AccountingFinding[] = [];

  for (const [list, refs] of [
    ['pending', pending],
    ['voided', voided.map((v) => v.ref)],
    ['revived', revived.map((v) => v.ref)],
  ] as const) {
    const seen = new Set<string>();
    for (const ref of refs) {
      const k = txnRefKey(ref);
      if (seen.has(k)) findings.push({ reason: 'duplicate-ref', list, ref });
      seen.add(k);
    }
  }

  if (parent === null) {
    // Genesis snapshots the store: there is no window to account for or replay.
    const empty =
      pending.length === 0 &&
      voided.length === 0 &&
      revived.length === 0 &&
      Object.keys(pruned).length === 0 &&
      transitions.length === 0;
    if (!empty) findings.push({ reason: 'genesis-not-empty' });
    return findings.length > 0
      ? { ok: false, code: 'E_MANIFEST_ACCOUNTING', findings }
      : { ok: true };
  }

  const parentPending = new Map(input.parentPending.map((t) => [txnRefKey(t.ref), t] as const));
  for (const ref of parent.pending ?? []) {
    if (!parentPending.has(txnRefKey(ref))) findings.push({ reason: 'pending-unresolved', ref });
  }
  const candidates = new Map<string, DeclaredTxn>();
  for (const t of input.window.txns) candidates.set(txnRefKey(t.ref), t);
  for (const [k, t] of parentPending) candidates.set(k, t);
  const pendingKeys = new Set(pending.map(txnRefKey));
  // Decl(A) = Decl(window) + Decl(parent.pending) − Decl(pending), without expanding the window.
  const declA = new Map<string, Counts>();
  addInto(declA, input.window.deltas);
  for (const t of parentPending.values()) addInto(declA, t.deltas);
  for (const ref of pending) {
    const t = candidates.get(txnRefKey(ref));
    if (!t) findings.push({ reason: 'pending-not-in-window', ref });
    else addInto(declA, t.deltas, -1);
  }
  const appliedByKey = new Map([...candidates].filter(([k]) => !pendingKeys.has(k)));

  for (const v of voided) {
    const declared = appliedByKey.get(txnRefKey(v.ref));
    if (!declared) {
      findings.push({ reason: 'voided-not-applied', ref: v.ref });
      continue;
    }
    for (const [table, c] of Object.entries(v.deltas)) {
      const d = own(declared.deltas, table);
      if (c.created > d.created || c.deleted > d.deleted) {
        findings.push({ reason: 'voided-exceeds-declared', ref: v.ref, table });
      }
    }
  }
  const before = new Map(input.voidedBefore.map((t) => [txnRefKey(t.ref), t] as const));
  for (const r of revived) {
    const still = before.get(txnRefKey(r.ref));
    if (!still) {
      findings.push({ reason: 'revived-not-voided', ref: r.ref });
      continue;
    }
    for (const [table, c] of Object.entries(r.deltas)) {
      const d = own(still.deltas, table);
      if (c.created > d.created || c.deleted > d.deleted) {
        findings.push({ reason: 'revived-exceeds-voided', ref: r.ref, table });
      }
    }
  }
  for (const [table, n] of Object.entries(pruned)) {
    const parentRows = Object.hasOwn(parent.tables, table) ? (parent.tables[table]?.rows ?? 0) : 0;
    const max = parentRows + (declA.get(table)?.created ?? 0);
    if (n < 0 || n > max) findings.push({ reason: 'pruned-out-of-range', table, pruned: n, max });
  }
  if (next.replayPin !== undefined) {
    const expected = schemaRises(parent.schemaVersion, input.window.schemaVersions);
    const actual = transitions.map((t) => ({ seq: t.seq, schemaVersion: t.schemaVersion }));
    const same =
      expected.length === actual.length &&
      expected.every(
        (e, i) => e.seq === actual[i]?.seq && e.schemaVersion === actual[i]?.schemaVersion,
      );
    if (!same) findings.push({ reason: 'transitions-mismatch', expected, actual });
    // T090: the next window's baseline is this manifest's schemaVersion, so it may not sit below the
    // parent's or the window's last rise; the server would then expect rises the replay already did.
    const floor = Math.max(parent.schemaVersion, ...expected.map((e) => e.schemaVersion));
    if (next.schemaVersion < floor) {
      findings.push({
        reason: 'schema-version-below-floor',
        schemaVersion: next.schemaVersion,
        floor,
      });
    }
  }
  if (findings.length > 0) return { ok: false, code: 'E_MANIFEST_ACCOUNTING', findings };

  // The exact row rule, per table.
  const adjust = new Map<string, number>();
  const bump = (t: string, n: number) => adjust.set(t, (adjust.get(t) ?? 0) + n);
  for (const v of voided)
    for (const [t, c] of Object.entries(v.deltas)) bump(t, c.deleted - c.created);
  for (const r of revived)
    for (const [t, c] of Object.entries(r.deltas)) bump(t, c.created - c.deleted);
  for (const [t, n] of Object.entries(pruned)) bump(t, -n);

  const tables = new Set([
    ...Object.keys(parent.tables),
    ...declA.keys(),
    ...adjust.keys(),
    ...Object.keys(next.tables),
  ]);
  const regressions: RegressionFinding[] = [];
  for (const table of [...tables].sort()) {
    const parentRows = Object.hasOwn(parent.tables, table) ? (parent.tables[table]?.rows ?? 0) : 0;
    const { created, deleted } = declA.get(table) ?? ZERO;
    const expectedRows = parentRows + created - deleted + (adjust.get(table) ?? 0);
    const entry = Object.hasOwn(next.tables, table) ? next.tables[table] : undefined;
    if (entry === undefined) {
      if (parentRows > 0 || expectedRows !== 0) {
        regressions.push({
          table,
          parentRows,
          created,
          deleted,
          expectedRows,
          actualRows: 0,
          reason: 'missing-table',
        });
      }
      continue;
    }
    if (entry.rows !== expectedRows) {
      regressions.push({
        table,
        parentRows,
        created,
        deleted,
        expectedRows,
        actualRows: entry.rows,
        reason: 'count-mismatch',
      });
    }
  }
  return regressions.length === 0
    ? { ok: true }
    : { ok: false, code: 'E_REGRESSION', tables: regressions };
}

/**
 * The stream's cumulative voided set after an accepted checkpoint: the set before it, plus this
 * window's `voided`, minus its `revived`, per ref and table; refs left with nothing are dropped.
 */
export function nextVoidedSet(
  before: readonly DeclaredTxn[],
  voided: readonly DeclaredTxn[],
  revived: readonly DeclaredTxn[],
): DeclaredTxn[] {
  const out = new Map<string, { ref: TxnRef; counts: Map<string, Counts> }>();
  const apply = (list: readonly DeclaredTxn[], sign: number) => {
    for (const t of list) {
      const k = txnRefKey(t.ref);
      const e = out.get(k) ?? { ref: t.ref, counts: new Map<string, Counts>() };
      addInto(e.counts, t.deltas, sign);
      out.set(k, e);
    }
  };
  apply(before, 1);
  apply(voided, 1);
  apply(revived, -1);
  const result: DeclaredTxn[] = [];
  for (const { ref, counts } of out.values()) {
    const deltas: TableDeltas = {};
    for (const [t, c] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (c.created > 0 || c.deleted > 0) deltas[t] = { created: c.created, deleted: c.deleted };
    }
    if (Object.keys(deltas).length > 0) result.push({ ref, deltas });
  }
  return result;
}

#!/usr/bin/env node
/**
 * Gate B + Gate C comparator (T12332 · epic T12322).
 *
 * Compares two fingerprints written by `scripts/fingerprint-store.mjs`:
 * `--source` (the original store) and `--replica` (the store rebuilt from the
 * journal, or the store after a merge).
 *
 * Modes:
 *   replay  The replica must reproduce the source exactly (Gate B + C). Every
 *           table whose class syncs must match on row count AND content
 *           digest (the digest is over the sorted row hashes, so it is exact
 *           multiset equality and independent of physical row order). A
 *           syncing table present only on the replica also fails.
 *   merge   Remote ops were applied, so the replica may hold MORE rows, but it
 *           must not lose any: every source row of a syncing table must be in
 *           the replica (a multiset subset check over the per-row hashes in
 *           the `.rows` sidecars), unless the merge was entitled to remove it.
 *           Those rows are listed in `--allow-deleted <file>`, one
 *           `<table>\t<rowHash>` line per removed row version (same format as
 *           the sidecar): the tombstones, and the old version of a row a remote
 *           op replaced. Each line excuses ONE missing occurrence.
 *
 * ## --allow-deleted is validated, never trusted
 *
 * A tombstone file can excuse any loss, so it is checked before it is used.
 * The comparison FAILS when:
 *   - a line names a row that is not in the source (or more copies of it than
 *     the source holds): a tombstone can only delete what existed;
 *   - it holds more lines than `--max-deleted` (default `1%` of the source's
 *     syncing rows, rounded up; an absolute count or another percentage can be
 *     passed explicitly);
 *   - it equals the source row set: passing the source's own `.rows` as the
 *     tombstone file would launder a wiped replica.
 * Every excused row is reported per table, as a WARNING line and in the JSON
 * `excused` map, so an allowance is never silent.
 *
 * The long-term source of this file is the sync journal: its tombstones and
 * superseded row versions, written out by the sync layer (there is no
 * tombstone table yet). A hand-written file is for investigation only.
 *
 * ## Binding each `.rows` sidecar to its JSON
 *
 * Merge reads rows from the sidecars, so a sidecar copied from another store
 * would decide the result. Each sidecar is checked against its own
 * fingerprint: its sha256 must equal `rowsSha256`, and for every syncing table
 * the line count and the digest recomputed from its lines must equal the
 * table's `rows` and `sha256`. Any mismatch FAILS.
 *
 * Both fingerprints must carry the same `keyId` (the row hashes are HMACs; see
 * fingerprint-store.mjs). Fingerprints made with different keys cannot be
 * compared and FAIL.
 *
 * In both modes a syncing table the comparator cannot verify FAILS: one that
 * is `unreadable` on either side (e.g. vec0 without sqlite-vec), missing on the
 * replica, or hashed over a different column set.
 *
 * Both modes also fail on:
 *   - any relationship edge with more dangling references than the source
 *     (edges marked `informational`, such as the personal `tasks.session_id`,
 *     are reported but never held to this);
 *   - any CLI-rule invariant count higher than the source (relative, not
 *     zero: legacy rows already violate some rules);
 *   - any edge or invariant the SOURCE could not measure (`error` or
 *     `skipped`): an unmeasured baseline would let any replica pass;
 *   - any UNCLASSIFIED table in either fingerprint (Gate A). A table pending
 *     an owner ruling is not a failure; it never syncs.
 *
 * Derived and local-only tables are not compared: derived tables are rebuilt
 * locally, and local-only tables never travel (both are still backed up).
 *
 * Memory (merge): both sidecars are read whole and grouped by table, so the
 * comparator holds every syncing row hash of both stores (~130 bytes each).
 *
 * Usage:
 *   node scripts/compare-fingerprints.mjs --source a.json --replica b.json
 *     [--mode replay|merge] [--allow-deleted <file>] [--max-deleted <n|p%>] [--json]
 *
 * The `.rows` sidecar of each fingerprint is found next to its JSON, by the
 * basename the fingerprint records (`rowsFile`).
 *
 * Exit 0 on PASS, 1 on FAIL.
 *
 * @task T12332
 * @task T12613
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    replica: { type: 'string' },
    mode: { type: 'string', default: 'replay' },
    'allow-deleted': { type: 'string' },
    'max-deleted': { type: 'string', default: '1%' },
    json: { type: 'boolean', default: false },
  },
});
if (!values.source || !values.replica) throw new Error('pass --source <a.json> --replica <b.json>');
if (!['replay', 'merge'].includes(values.mode)) throw new Error('--mode must be replay or merge');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Parse `<table>\t<hash>` lines into table → (hash → count). */
function readRowLines(text) {
  const byTable = new Map();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error(`malformed row line: ${line.slice(0, 80)}`);
    const table = line.slice(0, tab);
    const hash = line.slice(tab + 1);
    if (!byTable.has(table)) byTable.set(table, new Map());
    const counts = byTable.get(table);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return byTable;
}

/** The `.rows` sidecar of a fingerprint, or null when it was not written or is gone. */
function loadRows(fpPath, fp) {
  if (!fp.rowsFile) return null;
  const file = join(dirname(fpPath), fp.rowsFile);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return { text, byTable: readRowLines(text) };
}

/** Total lines in a table → (hash → count) map. */
const countLines = (byTable) =>
  [...byTable.values()].reduce((n, m) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);

/** Fail when a sidecar does not belong to its fingerprint (file hash, per-table counts and digests). */
function checkRowsBinding(side, fp, loaded, failures) {
  const bad = (table, reason) =>
    failures.push({
      gate: 'B',
      table,
      reason: `${side} .rows does not match its fingerprint: ${reason}`,
    });
  if (createHash('sha256').update(loaded.text).digest('hex') !== fp.rowsSha256)
    bad('*', 'file sha256 differs from rowsSha256');
  for (const table of loaded.byTable.keys()) {
    if (!fp.tables[table]?.shareable) bad(table, 'lines for a table the fingerprint does not hash');
  }
  for (const [table, e] of Object.entries(fp.tables)) {
    if (!e.shareable || e.unreadable) continue;
    const counts = loaded.byTable.get(table) ?? new Map();
    const hashes = [];
    for (const [hash, n] of counts) for (let i = 0; i < n; i++) hashes.push(hash);
    hashes.sort();
    const h = createHash('sha256').update((e.columns ?? []).join('\u0000'));
    for (const rh of hashes) h.update(`${rh}\n`);
    if (hashes.length !== e.rows) bad(table, `${hashes.length} line(s) for ${e.rows} row(s)`);
    else if (h.digest('hex') !== e.sha256) bad(table, 'digest recomputed from the lines differs');
  }
}

/** Resolve `--max-deleted` (`<n>` or `<p>%`) against the source's syncing row count. */
function deletionCap(spec, sourceRows) {
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(spec);
  if (!m) throw new Error('--max-deleted must be a count or a percentage, e.g. 25 or 1%');
  return m[2] ? Math.ceil((sourceRows * Number(m[1])) / 100) : Math.floor(Number(m[1]));
}

/** Fail a tombstone file that names rows the source never had, exceeds the cap, or IS the source. */
function checkTombstones(source, allow, cap, failures) {
  let foreign = 0;
  let lines = 0;
  let equal = countLines(source) === countLines(allow);
  for (const [table, counts] of allow) {
    const src = source.get(table) ?? new Map();
    for (const [hash, n] of counts) {
      lines += n;
      const have = src.get(hash) ?? 0;
      if (n > have) foreign += n - have;
      if (n !== have) equal = false;
    }
  }
  if (foreign > 0)
    failures.push({
      gate: 'B',
      table: '*',
      reason: `--allow-deleted names ${foreign} row(s) that are not in the source`,
    });
  if (lines > cap)
    failures.push({
      gate: 'B',
      table: '*',
      reason: `--allow-deleted holds ${lines} row(s), over the --max-deleted cap of ${cap}`,
    });
  if (equal && lines > 0)
    failures.push({
      gate: 'B',
      table: '*',
      reason: '--allow-deleted equals the source row set (it would excuse deleting everything)',
    });
  return lines;
}

function compare(source, replica, mode, rows) {
  const failures = [];
  const notes = [];
  const excused = {};
  if (!source.keyId || source.keyId !== replica.keyId)
    failures.push({
      gate: 'B',
      table: '*',
      reason: `fingerprints were made with different HMAC keys (keyId ${source.keyId ?? 'none'} vs ${replica.keyId ?? 'none'}); fingerprint both with the same --key-file`,
    });
  for (const [side, fp] of [
    ['source', source],
    ['replica', replica],
  ]) {
    for (const [table, e] of Object.entries(fp.tables)) {
      if (e.class === 'UNCLASSIFIED')
        failures.push({ gate: 'A', table, reason: `unclassified on ${side}` });
    }
  }

  if (mode === 'merge' && (!rows.source || !rows.replica))
    failures.push({
      gate: 'B',
      table: '*',
      reason: `row hashes not available on ${!rows.source ? 'source' : 'replica'} (the .rows sidecar)`,
    });
  if (rows.source) checkRowsBinding('source', source, rows.source, failures);
  if (rows.replica) checkRowsBinding('replica', replica, rows.replica, failures);
  let allowance;
  if (rows.allowDeleted && rows.source) {
    const cap = deletionCap(values['max-deleted'], countLines(rows.source.byTable));
    const lines = checkTombstones(rows.source.byTable, rows.allowDeleted, cap, failures);
    allowance = { lines, cap };
  }

  for (const [table, s] of Object.entries(source.tables)) {
    if (!s.shareable) continue;
    const r = replica.tables[table];
    if (s.unreadable) {
      failures.push({
        gate: 'B',
        table,
        reason: `not fingerprinted on source (${s.unreadable})`,
      });
      continue;
    }
    if (!r) {
      failures.push({ gate: 'B', table, reason: 'missing on replica' });
      continue;
    }
    if (r.unreadable) {
      failures.push({
        gate: 'B',
        table,
        reason: `not fingerprinted on replica (${r.unreadable})`,
      });
      continue;
    }
    if (JSON.stringify(r.columns) !== JSON.stringify(s.columns)) {
      failures.push({ gate: 'B', table, reason: 'hashed column set differs' });
      continue;
    }
    if (mode === 'replay') {
      if (r.rows !== s.rows)
        failures.push({ gate: 'B', table, reason: `rows ${s.rows} → ${r.rows}` });
      else if (r.sha256 !== s.sha256)
        failures.push({ gate: 'B', table, reason: 'content hash differs' });
    } else if (rows.source && rows.replica) {
      // Merge: every source row must survive, or be accounted for by --allow-deleted.
      const have = rows.replica.byTable.get(table) ?? new Map();
      const allowed = rows.allowDeleted?.get(table) ?? new Map();
      let lost = 0;
      let ok = 0;
      for (const [hash, n] of rows.source.byTable.get(table) ?? new Map()) {
        const missing = n - Math.min(n, have.get(hash) ?? 0);
        if (missing === 0) continue;
        const allowedHere = Math.min(missing, allowed.get(hash) ?? 0);
        ok += allowedHere;
        lost += missing - allowedHere;
      }
      if (lost > 0)
        failures.push({
          gate: 'B',
          table,
          reason: `${lost} source row(s) missing on replica and not in --allow-deleted`,
        });
      if (ok > 0) excused[table] = ok;
    }
  }
  if (mode === 'replay') {
    for (const [table, r] of Object.entries(replica.tables)) {
      if (r.shareable && !source.tables[table])
        failures.push({ gate: 'B', table, reason: 'syncing table present only on replica' });
    }
  }

  for (const [edge, s] of Object.entries(source.relationships ?? {})) {
    const r = replica.relationships?.[edge];
    if (typeof s?.dangling !== 'number') {
      failures.push({
        gate: 'B',
        edge,
        reason: `not measured on source (${s?.error ?? s?.skipped ?? 'no count'})`,
      });
      continue;
    }
    if (s.informational) {
      notes.push(`${edge} (informational): dangling ${s.dangling} → ${r?.dangling ?? '?'}`);
      continue;
    }
    if (typeof r?.dangling !== 'number')
      failures.push({ gate: 'B', edge, reason: 'edge not measured on replica' });
    else if (r.dangling > s.dangling)
      failures.push({ gate: 'B', edge, reason: `dangling ${s.dangling} → ${r.dangling}` });
  }
  for (const [inv, s] of Object.entries(source.invariants ?? {})) {
    const r = replica.invariants?.[inv];
    if (typeof s !== 'number')
      failures.push({
        gate: 'C',
        invariant: inv,
        reason: `not measured on source (${s?.error ?? 'no count'})`,
      });
    else if (typeof r !== 'number')
      failures.push({ gate: 'C', invariant: inv, reason: 'not measured on replica' });
    else if (r > s) failures.push({ gate: 'C', invariant: inv, reason: `${s} → ${r}` });
  }
  return { ok: failures.length === 0, mode, failures, notes, excused, allowance };
}

const source = load(values.source);
const replica = load(values.replica);
const rows =
  values.mode === 'merge'
    ? {
        source: loadRows(values.source, source),
        replica: loadRows(values.replica, replica),
        allowDeleted: values['allow-deleted']
          ? readRowLines(readFileSync(values['allow-deleted'], 'utf8'))
          : null,
      }
    : {};
const result = compare(source, replica, values.mode, rows);
if (values.json) console.log(JSON.stringify(result, null, 1));
else {
  for (const f of result.failures)
    console.log(`GATE ${f.gate} FAIL ${f.table ?? f.edge ?? f.invariant}: ${f.reason}`);
  for (const [table, n] of Object.entries(result.excused))
    console.log(
      `WARNING: --allow-deleted EXCUSED ${n} missing row(s) in ${table} (${result.allowance.lines} tombstone(s), cap ${result.allowance.cap})`,
    );
  for (const n of result.notes) console.log(`note: ${n}`);
  console.log(
    result.ok
      ? `PASS (${values.mode})`
      : `FAIL (${values.mode}): ${result.failures.length} finding(s)`,
  );
}
process.exit(result.ok ? 0 : 1);

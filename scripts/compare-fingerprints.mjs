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
 *           op replaced. There is no tombstone table yet; the sync layer will
 *           write this file from its journal. Each line excuses ONE missing
 *           occurrence.
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
 *     [--mode replay|merge] [--allow-deleted <file>] [--json]
 *
 * The `.rows` sidecar of each fingerprint is found next to its JSON, by the
 * basename the fingerprint records (`rowsFile`).
 *
 * Exit 0 on PASS, 1 on FAIL.
 *
 * @task T12332
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    replica: { type: 'string' },
    mode: { type: 'string', default: 'replay' },
    'allow-deleted': { type: 'string' },
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
  return existsSync(file) ? readRowLines(readFileSync(file, 'utf8')) : null;
}

function compare(source, replica, mode, rows) {
  const failures = [];
  const notes = [];
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
      const have = rows.replica.get(table) ?? new Map();
      const allowed = rows.allowDeleted?.get(table) ?? new Map();
      let lost = 0;
      let excused = 0;
      for (const [hash, n] of rows.source.get(table) ?? new Map()) {
        const missing = n - Math.min(n, have.get(hash) ?? 0);
        if (missing === 0) continue;
        const ok = Math.min(missing, allowed.get(hash) ?? 0);
        excused += ok;
        lost += missing - ok;
      }
      if (lost > 0)
        failures.push({
          gate: 'B',
          table,
          reason: `${lost} source row(s) missing on replica and not in --allow-deleted`,
        });
      if (excused > 0)
        notes.push(`${table}: ${excused} row version(s) removed per --allow-deleted`);
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
  return { ok: failures.length === 0, mode, failures, notes };
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
  for (const n of result.notes) console.log(`note: ${n}`);
  console.log(
    result.ok
      ? `PASS (${values.mode})`
      : `FAIL (${values.mode}): ${result.failures.length} finding(s)`,
  );
}
process.exit(result.ok ? 0 : 1);

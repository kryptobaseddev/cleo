#!/usr/bin/env node
/**
 * Gate B + Gate C comparator (T12332 · epic T12322).
 *
 * Compares two fingerprints written by `scripts/fingerprint-store.mjs`:
 * `--source` (the original store) and `--replica` (the store rebuilt from the
 * journal, or the store after a merge).
 *
 * Modes:
 *   replay  The replica must reproduce the source (Gate B + C). Every table
 *           whose class syncs must match on row count AND content hash. A
 *           syncing table the source could not hash (`unreadable`, e.g. vec0
 *           without sqlite-vec) FAILS: an unverified table is not a pass.
 *   merge   Remote ops were applied, so synced content may differ. Only the
 *           Gate C rule counts and the dangling-reference counts are held to
 *           "no increase".
 *
 * Both modes fail on:
 *   - any relationship edge with more dangling references than the source;
 *   - any CLI-rule invariant count higher than the source (relative, not
 *     zero: legacy rows already violate some rules);
 *   - any UNCLASSIFIED table in either fingerprint (Gate A). A table pending
 *     an owner ruling is not a failure; it never syncs.
 *
 * Derived and local-only tables are not compared: derived tables are rebuilt
 * locally, and local-only tables never travel (both are still backed up).
 *
 * Usage:
 *   node scripts/compare-fingerprints.mjs --source a.json --replica b.json
 *     [--mode replay|merge] [--json]
 *
 * Exit 0 on PASS, 1 on FAIL.
 *
 * @task T12332
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    replica: { type: 'string' },
    mode: { type: 'string', default: 'replay' },
    json: { type: 'boolean', default: false },
  },
});
if (!values.source || !values.replica) throw new Error('pass --source <a.json> --replica <b.json>');
if (!['replay', 'merge'].includes(values.mode)) throw new Error('--mode must be replay or merge');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

function compare(source, replica, mode) {
  const failures = [];
  for (const [side, fp] of [
    ['source', source],
    ['replica', replica],
  ]) {
    for (const [table, e] of Object.entries(fp.tables)) {
      if (e.class === 'UNCLASSIFIED')
        failures.push({ gate: 'A', table, reason: `unclassified on ${side}` });
    }
  }
  if (mode === 'replay') {
    for (const [table, s] of Object.entries(source.tables)) {
      if (!s.shareable) continue;
      const r = replica.tables[table];
      if (s.unreadable)
        failures.push({
          gate: 'B',
          table,
          reason: `not fingerprinted on source (${s.unreadable})`,
        });
      else if (!r) failures.push({ gate: 'B', table, reason: 'missing on replica' });
      else if (r.unreadable)
        failures.push({
          gate: 'B',
          table,
          reason: `not fingerprinted on replica (${r.unreadable})`,
        });
      else if (r.rows !== s.rows)
        failures.push({ gate: 'B', table, reason: `rows ${s.rows} → ${r.rows}` });
      else if (r.sha256 !== s.sha256)
        failures.push({ gate: 'B', table, reason: 'content hash differs' });
    }
  }
  for (const [edge, s] of Object.entries(source.relationships ?? {})) {
    const r = replica.relationships?.[edge];
    if (typeof s?.dangling !== 'number') continue;
    if (typeof r?.dangling !== 'number')
      failures.push({ gate: 'B', edge, reason: 'edge not measured on replica' });
    else if (r.dangling > s.dangling)
      failures.push({ gate: 'B', edge, reason: `dangling ${s.dangling} → ${r.dangling}` });
  }
  for (const [inv, s] of Object.entries(source.invariants ?? {})) {
    const r = replica.invariants?.[inv];
    if (typeof s !== 'number') continue;
    if (typeof r !== 'number')
      failures.push({ gate: 'C', invariant: inv, reason: 'not measured on replica' });
    else if (r > s) failures.push({ gate: 'C', invariant: inv, reason: `${s} → ${r}` });
  }
  return { ok: failures.length === 0, mode, failures };
}

const result = compare(load(values.source), load(values.replica), values.mode);
if (values.json) console.log(JSON.stringify(result, null, 1));
else {
  for (const f of result.failures)
    console.log(`GATE ${f.gate} FAIL ${f.table ?? f.edge ?? f.invariant}: ${f.reason}`);
  console.log(
    result.ok
      ? `PASS (${values.mode})`
      : `FAIL (${values.mode}): ${result.failures.length} finding(s)`,
  );
}
process.exit(result.ok ? 0 : 1);

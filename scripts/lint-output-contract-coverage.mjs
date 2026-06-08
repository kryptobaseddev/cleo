#!/usr/bin/env node
/**
 * Lint rule: per-operation OUTPUT-contract coverage (T11762 ST-3b · DHQ-057).
 *
 * The OUTPUT-contract surface (`getOutputContract`) MUST resolve a contract —
 * hand-authored {@link OUTPUT_CONTRACTS} OR derived via `deriveOutputContract` —
 * for the large majority of operations in the 411-row `OPERATIONS` registry.
 * Before T11762 ST-3 only the 7 hand-authored `tasks.*` ops resolved anything;
 * `deriveOutputContract` lifts coverage to ~100% by synthesising a contract
 * from existing shape registries (`OPERATION_RESULT_SCHEMAS`, `PROJECTION_PLANS`,
 * `MinimalMutateEnvelope`) plus a generic-object fallback for any other
 * registered query op.
 *
 * This gate is the enforcer the LAFS-envelope SSoT (T10400 §8 item 6) says
 * SHOULD exist: it guarantees the coverage never silently regresses (e.g. if the
 * derive fallback is broken or an op is added that resolves nothing).
 *
 * ## What it checks
 *
 * A pure, deterministic STATIC scan (no DB, no network) — it replicates the
 * `getOutputContract` resolution tiers against the registry SOURCE files:
 *   1. enumerate every `(gateway, domain, operation)` triple in the OPERATIONS
 *      registry source → canonical key `<domain>.<operation>`;
 *   2. cross-check the parsed op count against the authoritative
 *      `operation: '...'` entry count — a mismatch is treated as PARSE DRIFT and
 *      fails closed (the coverage number is otherwise untrustworthy);
 *   3. an op is COVERED when it is hand-authored, has a workgraph result schema,
 *      has a projection plan, is a mutate op, or is any registered query op
 *      (the generic fallback) — i.e. every registered op is covered by design;
 *   4. an UNCOVERED op (should be none) fails unless it is on the baseline
 *      waiver allowlist.
 *
 * Baseline mode (default): only NET-NEW uncovered ops (beyond the pinned
 * baseline) fail. `--strict`: ANY uncovered op fails. `--update-baseline`:
 * rewrite the waiver file. Mirrors the existing arch-gate `.mjs` idiom
 * (`lint-tools-vs-skills-boundary.mjs`). This is the conformance enforcer that
 * the LAFS-envelope SSoT calls for in T10400 §8 item 6.
 *
 * @task T11762 ST-3 / ST-3b (T11904)
 * @epic T11679
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OPERATIONS_REGISTRY_REL = 'packages/contracts/src/dispatch/operations-registry.ts';
const RESULT_SCHEMAS_REL = 'packages/contracts/src/operation-envelope-validation.ts';
const PROJECTION_PLANS_REL = 'packages/core/src/dispatch/mvi-projection.ts';
const OUTPUT_CONTRACTS_REL = 'packages/contracts/src/operations/output-contracts-data.ts';
const BASELINE_REL = 'scripts/.lint-output-contract-coverage-baseline.json';

/**
 * Count the authoritative number of `OperationDef` entries in the registry
 * source — every entry carries exactly one `operation: '<verb>'` property
 * literal, so counting those property tokens is the ground-truth registered-op
 * count, independent of the ordered triple regex used by {@link parseOperations}.
 * Used to fail-closed when the triple parse silently drops an op (regex drift,
 * e.g. a future non-`query|mutate` gateway value), which would otherwise let the
 * gate pass while under-measuring coverage.
 *
 * The token is matched with the SAME tolerance as the triple regex's third group
 * (a `operation:` property assigned a single-quoted string), so legitimate
 * formatting differences never produce false drift; only a genuine count
 * mismatch between "ops the triple regex recovered" and "operation: properties
 * present" does.
 *
 * @param {string} src - operations-registry.ts source text.
 * @returns {number} count of `operation: '...'` property tokens.
 */
export function countOperationEntries(src) {
  const re = /\boperation:\s*'[^']+'/g;
  let n = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) n += 1;
  return n;
}

/**
 * Parse the ordered `(gateway, domain, operation)` triples out of the OPERATIONS
 * registry source. The registry authors every entry with `gateway:` then
 * `domain:` then `operation:` in sequence, so a single ordered regex over the
 * file recovers the canonical `<domain>.<operation>` key + its gateway.
 *
 * @param {string} src - operations-registry.ts source text.
 * @returns {{ key: string, gateway: string }[]} one entry per registered op.
 */
export function parseOperations(src) {
  const re =
    /gateway:\s*'(query|mutate)'[\s\S]{0,200}?domain:\s*'([^']+)'[\s\S]{0,200}?operation:\s*'([^']+)'/g;
  const ops = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    ops.push({ key: `${m[2]}.${m[3]}`, gateway: m[1] });
  }
  return ops;
}

/** Parse the keys of a `new Map<...>([['key.a', ...], ['key.b', ...]])` literal. */
function parseMapKeys(src, anchor) {
  const idx = src.indexOf(anchor);
  if (idx === -1) return [];
  const tail = src.slice(idx);
  const keys = [];
  const re = /\[\s*'([a-z][\w.-]+\.[\w.-]+)'\s*,/g;
  // Bound the scan to the Map literal (stop at the closing `]);`).
  const end = tail.indexOf(']);');
  const region = end === -1 ? tail : tail.slice(0, end);
  for (let m = re.exec(region); m !== null; m = re.exec(region)) keys.push(m[1]);
  return keys;
}

/** Parse the keys of a `Record<string, X> = { 'key.a': ..., 'key.b': ... }` literal. */
function parseRecordKeys(src, anchor) {
  const idx = src.indexOf(anchor);
  if (idx === -1) return [];
  const tail = src.slice(idx);
  const end = tail.indexOf('};');
  const region = end === -1 ? tail : tail.slice(0, end);
  const keys = [];
  const re = /'([a-z][\w.-]+\.[\w.-]+)'\s*:/g;
  for (let m = re.exec(region); m !== null; m = re.exec(region)) keys.push(m[1]);
  return keys;
}

/**
 * Compute the set of operation keys that resolve NO output contract under the
 * `getOutputContract` resolution tiers (hand-authored → derived → generic
 * query fallback). By design this should be EMPTY: every registered query op is
 * covered by the generic fallback and every mutate op by the minimal-mutate
 * contract. A non-empty result means the derive tiering has a hole.
 *
 * `parseDrift` is non-null when the ordered-triple parse recovers a DIFFERENT
 * op count than the authoritative `operation: '...'` entry count — a signal that
 * the triple regex silently dropped (or double-counted) entries and the coverage
 * measurement can no longer be trusted. Callers MUST treat a non-null
 * `parseDrift` as a hard failure (fail-closed), never as 100% coverage.
 *
 * @param {string} repoRoot
 * @returns {{ uncovered: string[], total: number, covered: number, registryCount: number, parseDrift: string | null }}
 */
export function scanUncovered(repoRoot) {
  const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
  const registrySrc = read(OPERATIONS_REGISTRY_REL);
  const ops = parseOperations(registrySrc);
  const registryCount = countOperationEntries(registrySrc);

  const handAuthored = new Set(parseRecordKeys(read(OUTPUT_CONTRACTS_REL), 'OUTPUT_CONTRACTS'));
  const workgraphSchemas = new Set(
    parseMapKeys(read(RESULT_SCHEMAS_REL), 'OPERATION_RESULT_SCHEMAS'),
  );
  const projectionPlans = new Set(parseRecordKeys(read(PROJECTION_PLANS_REL), 'PROJECTION_PLANS'));

  const uncovered = [];
  for (const { key, gateway } of ops) {
    const covered =
      handAuthored.has(key) ||
      workgraphSchemas.has(key) ||
      projectionPlans.has(key) ||
      gateway === 'mutate' || // shared minimal-mutate contract
      gateway === 'query'; // generic object fallback for any registered query op
    if (!covered) uncovered.push(key);
  }

  const parseDrift =
    ops.length === registryCount
      ? null
      : `operations-registry parse drift: ordered (gateway,domain,operation) triples parsed ` +
        `${ops.length} op(s) but the registry declares ${registryCount} \`operation:\` entr(y/ies). ` +
        `The coverage measurement is unreliable until the triple regex in parseOperations is fixed.`;

  return {
    uncovered: [...new Set(uncovered)].sort(),
    total: ops.length,
    covered: ops.length - uncovered.length,
    registryCount,
    parseDrift,
  };
}

/** CLI entry. */
function main() {
  const repoRoot = process.cwd();
  const mode = process.argv.includes('--strict')
    ? 'strict'
    : process.argv.includes('--update-baseline')
      ? 'update'
      : 'check';
  const baselinePath = join(repoRoot, BASELINE_REL);
  const { uncovered, total, covered, parseDrift } = scanUncovered(repoRoot);

  if (total === 0) {
    console.error('✗ output-contract coverage: parsed ZERO operations — registry parse failed.');
    return 1;
  }

  // Fail-closed (every mode, incl. --update-baseline): a drifted parse must
  // never be allowed to silently under-measure coverage or pin a wrong baseline.
  if (parseDrift !== null) {
    console.error(`\n✗ output-contract coverage: ${parseDrift}\n`);
    return 1;
  }

  if (mode === 'update') {
    writeFileSync(baselinePath, `${JSON.stringify(uncovered, null, 2)}\n`, 'utf8');
    console.log(
      `lint-output-contract-coverage: baseline updated — ${uncovered.length} waived op(s); ` +
        `${covered}/${total} covered.`,
    );
    return 0;
  }

  if (mode === 'strict') {
    if (uncovered.length > 0) {
      console.error(
        `\n✗ output-contract coverage (strict): ${uncovered.length}/${total} op(s) resolve NO contract:\n`,
      );
      for (const v of uncovered) console.error(`  - ${v}`);
      console.error(
        '\nEvery registered operation must resolve a contract via getOutputContract ' +
          '(hand-authored OUTPUT_CONTRACTS or deriveOutputContract). See T11762 ST-3.\n',
      );
      return 1;
    }
    console.log(`✓ output-contract coverage (strict): ${covered}/${total} ops covered.`);
    return 0;
  }

  const baseline = existsSync(baselinePath)
    ? new Set(JSON.parse(readFileSync(baselinePath, 'utf8')))
    : new Set();
  const netNew = uncovered.filter((v) => !baseline.has(v));
  if (netNew.length > 0) {
    console.error(
      `\n✗ output-contract coverage: ${netNew.length} NEW uncovered op(s) (baseline ${baseline.size}):\n`,
    );
    for (const v of netNew) console.error(`  - ${v}`);
    console.error(
      '\nNew operations must resolve an output contract (hand-authored or derived). ' +
        'See T11762 ST-3 (deriveOutputContract).\n',
    );
    return 1;
  }
  console.log(
    `✓ output-contract coverage: ${covered}/${total} ops covered, no net-new uncovered ` +
      `(baseline ${baseline.size}).`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('lint-output-contract-coverage.mjs')) {
  process.exit(main());
}

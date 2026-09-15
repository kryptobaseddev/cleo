#!/usr/bin/env node
/**
 * Gate 23 — documented `--field` POINTERS must resolve (T12192 · gh#1421).
 *
 * Gates 14 and 15 assert that every `cleo <verb> [<sub>]` named in
 * CLEO-INJECTION.md and in workflow `run:` blocks resolves against the command
 * manifest. Neither asserts anything about the POINTERS passed beside those
 * verbs, and a pointer is the half that actually carries data back.
 *
 * The cost of that gap, measured 2026-09-14 (gh#1420): CLEO-INJECTION.md — a
 * tier-0 artefact injected verbatim into EVERY spawned agent — instructed
 * every agent to read `cleo verify`'s result with
 * `--field /data/task/verification`. `verify` returns the FLAT mutate record,
 * so that pointer cannot resolve. The document's own rule two sentences
 * earlier states the distinction correctly and then gets it wrong for this
 * verb. Gate 14 was green throughout: the verb exists.
 *
 * WHAT THIS CHECKS
 *
 * Every `--field <pointer>` in CLEO-INJECTION.md that sits beside a `cleo
 * <verb>` with an EXPLICIT output contract must appear in that contract's
 * `fieldPointers`, or be a prefix-extension of one (`/data/verification/gates`
 * is reachable when `/data/verification` is contracted).
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * Verbs whose operation has no explicit contract are SKIPPED and counted, not
 * failed. Most ops fall through to `genericObjectContract`, which is honest
 * about not knowing the shape (`fieldPointers: []`); failing against it would
 * mean failing every pointer in the document and the gate would be turned off
 * within a day. The skip count is PRINTED so the gap is visible rather than
 * silent — per gh#1353, a gate that does not say what it looked at hides its
 * own scope.
 *
 * Adding a contract to `OUTPUT_CONTRACTS` therefore tightens this gate
 * automatically, with no edit here.
 *
 * Exit: 0 pass · 1 violation · 2 unparseable (fails CLOSED).
 *
 * @task T12192 (gh#1421)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(REPO, 'packages/core/templates/CLEO-INJECTION.md');

/**
 * CLI verb (and optional subcommand) -> dispatch operation id.
 *
 * Hand-maintained because the mapping lives in each command module's
 * `dispatchFromCli` call and is not exported anywhere joinable. Kept SMALL on
 * purpose: only verbs that have an explicit output contract are useful here,
 * and an unmapped verb is skipped rather than guessed.
 */
const VERB_TO_OPERATION = {
  verify: 'check.gate.set',
  show: 'tasks.show',
  list: 'tasks.list',
  find: 'tasks.find',
  add: 'tasks.add',
  'add-batch': 'tasks.add-batch',
  update: 'tasks.update',
  complete: 'tasks.complete',
};

function loadContracts() {
  const path = join(REPO, 'packages/contracts/dist/index.js');
  try {
    return import(path).then((m) => m.OUTPUT_CONTRACTS);
  } catch (err) {
    console.error(`FATAL: cannot load output contracts from ${path}: ${err.message}`);
    console.error('Run `pnpm --filter @cleocode/contracts build` first.');
    process.exit(2);
  }
}

/**
 * Extract `(verb, pointer)` pairs from the document.
 *
 * Scans each line for `cleo <verb>` occurrences and `--field <pointer>`
 * occurrences and pairs a pointer with the nearest preceding verb ON THE SAME
 * LINE. Cross-line pairing is deliberately not attempted: it would invent
 * associations the document does not make, and a pointer with no verb beside
 * it is reported as unpaired rather than guessed at.
 */
function extractPairs(text) {
  const pairs = [];
  const unpaired = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('--field')) continue;
    const tokens = [...line.matchAll(/cleo\s+([a-z][a-z-]*)/g)].map((m) => ({
      at: m.index ?? 0,
      verb: m[1],
    }));
    for (const m of line.matchAll(/--field\s+(\/[^\s`'")\]]*)/g)) {
      const pointer = m[1];
      const at = m.index ?? 0;
      const before = tokens.filter((t) => t.at < at);
      if (before.length === 0) {
        unpaired.push({ line: i + 1, pointer });
        continue;
      }
      pairs.push({ line: i + 1, verb: before[before.length - 1].verb, pointer });
    }
  }
  return { pairs, unpaired };
}

/** A pointer is reachable if it IS a contracted pointer or extends one. */
function isReachable(pointer, contracted) {
  return contracted.some((c) => pointer === c || pointer.startsWith(`${c}/`));
}

const contracts = await loadContracts();
let doc;
try {
  doc = readFileSync(DOC, 'utf-8');
} catch (err) {
  console.error(`FATAL: cannot read ${DOC}: ${err.message}`);
  process.exit(2);
}

const { pairs, unpaired } = extractPairs(doc);
if (pairs.length === 0 && unpaired.length === 0) {
  console.error('FATAL: found no `--field` pointers at all in CLEO-INJECTION.md.');
  console.error('The document documents the flag extensively; zero matches means the');
  console.error('extractor is broken, not that the document is clean. Failing closed.');
  process.exit(2);
}

const violations = [];
const skipped = [];
let checked = 0;

for (const { line, verb, pointer } of pairs) {
  const operation = VERB_TO_OPERATION[verb];
  if (!operation) {
    skipped.push({ line, verb, pointer, why: 'verb not mapped to an operation' });
    continue;
  }
  const contract = contracts[operation];
  if (!contract || !Array.isArray(contract.fieldPointers) || contract.fieldPointers.length === 0) {
    skipped.push({ line, verb, pointer, why: `${operation} has no explicit contract` });
    continue;
  }
  checked++;
  if (!isReachable(pointer, contract.fieldPointers)) {
    violations.push({ line, verb, pointer, operation, valid: contract.fieldPointers });
  }
}

console.log(`lint-injection-field-pointers: scanned ${DOC.replace(`${REPO}/`, '')}`);
console.log(
  `  ${pairs.length} verb+pointer pair(s) found · ${checked} checked · ${skipped.length} skipped · ${unpaired.length} unpaired`,
);

if (skipped.length > 0) {
  console.log('  SKIPPED (no explicit output contract — widen OUTPUT_CONTRACTS to cover these):');
  for (const s of skipped)
    console.log(`    L${s.line}  cleo ${s.verb} --field ${s.pointer}  (${s.why})`);
}
if (unpaired.length > 0) {
  console.log('  UNPAIRED (a --field with no `cleo <verb>` on the same line):');
  for (const u of unpaired) console.log(`    L${u.line}  --field ${u.pointer}`);
}

if (violations.length > 0) {
  console.error(
    `\nlint-injection-field-pointers: FAIL — ${violations.length} pointer(s) cannot resolve.\n`,
  );
  for (const v of violations) {
    console.error(`  L${v.line}  cleo ${v.verb} --field ${v.pointer}`);
    console.error(`        operation: ${v.operation}`);
    console.error(`        valid    : ${v.valid.join(', ')}\n`);
  }
  console.error('CLEO-INJECTION.md is injected verbatim into every spawned agent, so a');
  console.error('pointer that cannot resolve is an instruction every agent is handed and');
  console.error('every agent burns a turn on. Fix the document, or add the pointer to the');
  console.error("operation's contract if the document is right and the contract is stale.");
  process.exit(1);
}

console.log('lint-injection-field-pointers: OK');
process.exit(0);

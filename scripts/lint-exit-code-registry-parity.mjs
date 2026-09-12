#!/usr/bin/env node

/**
 * Exit-Code / Error-Registry Parity (T12171 · gh#1273)
 *
 * Two SSoTs describe the same thing and nothing asserts they agree:
 *
 *   packages/contracts/src/exit-codes.ts   the `ExitCode` enum — what a command EXITS with
 *   packages/core/src/error-registry.ts    `CLEO_ERROR_REGISTRY` — how that code RENDERS
 *
 * A code present in the enum and absent from the registry still works as an
 * exit status, so nothing fails. But `getRegistryEntry()` returns `undefined`
 * for it, so it carries no category, no LAFS code, no retryable flag and no
 * HTTP status — and a deliberate policy guard renders as though it were an
 * internal fault.
 *
 * That is the reported symptom (gh#1273): `ExitCode.AC_LOCKED = 48` is a
 * considered policy decision with a documented override and a real audit trail,
 * and it renders like a crash because the registry has never heard of it.
 *
 * ## The gap is much larger than the report
 *
 * Measured 2026-09-12: the enum declares **97** members and the registry covers
 * **40**. Fifty-six error codes render without metadata. The reported one is
 * not special — it is the one somebody happened to hit.
 *
 * This gate does not demand all 56 be written today: inventing a category,
 * retryability and HTTP status for 56 codes in one pass would produce 56
 * guesses, which is worse than 56 absences. It baselines the current gap and
 * fails on a NET-NEW enum member added without a registry entry — so the set
 * can only shrink, and a new code arrives with its metadata or not at all.
 *
 * `SUCCESS = 0` is exempt: it is not an error and has nothing to render.
 *
 * Modes:
 *   (default)           fail on any enum member missing from the registry and not baselined
 *   --update-baseline   re-record after entries are added
 *   --strict            zero tolerance: every non-zero exit code must be registered
 *
 * @task T12171
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ENUM_FILE = resolve(REPO_ROOT, 'packages/contracts/src/exit-codes.ts');
const REGISTRY_FILE = resolve(REPO_ROOT, 'packages/core/src/error-registry.ts');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-exit-code-registry-parity-baseline.json');

/** `SUCCESS` is not an error; it has no metadata to carry. */
const EXEMPT = new Set(['SUCCESS']);

/** Strip block/line comments so a docblock example is never parsed as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (_m, indent) => indent);
}

/** `ExitCode` members, as `[name, value]`. */
function enumMembers() {
  const code = stripComments(readFileSync(ENUM_FILE, 'utf-8'));
  return [...code.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*,/gm)].map((m) => [
    m[1],
    Number(m[2]),
  ]);
}

/** Enum member names referenced by a registry entry. */
function registeredNames() {
  const code = stripComments(readFileSync(REGISTRY_FILE, 'utf-8'));
  return new Set([...code.matchAll(/exitCode:\s*ExitCode\.([A-Z0-9_]+)/g)].map((m) => m[1]));
}

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update-baseline');
const STRICT = args.has('--strict');

const members = enumMembers();
const registered = registeredNames();
const missing = members
  .filter(([name]) => !EXEMPT.has(name) && !registered.has(name))
  .map(([name, value]) => `${name}=${value}`)
  .sort();

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'ExitCode members with no CLEO_ERROR_REGISTRY entry (gh#1273). This list may only SHRINK. ' +
          'A NET-NEW exit code without a registry entry fails the gate.',
        enumMembers: members.length,
        registered: registered.size,
        missing,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log(
    `lint-exit-code-registry-parity: baseline written — ${missing.length} unregistered of ${members.length} member(s).`,
  );
  process.exit(0);
}

if (STRICT) {
  if (missing.length === 0) {
    console.log('lint-exit-code-registry-parity: STRICT OK — every exit code is registered.');
    process.exit(0);
  }
  console.error(
    `lint-exit-code-registry-parity: STRICT FAIL — ${missing.length} exit code(s) unregistered:`,
  );
  for (const m of missing) console.error(`    ${m}`);
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
} catch {
  console.error(
    `lint-exit-code-registry-parity: no baseline at ${relative(REPO_ROOT, BASELINE)}.\n` +
      '  Create it with: node scripts/lint-exit-code-registry-parity.mjs --update-baseline',
  );
  process.exit(1);
}

const known = new Set(baseline.missing ?? []);
const added = missing.filter((m) => !known.has(m));
const fixed = [...known].filter((m) => !missing.includes(m));

if (added.length === 0) {
  const suffix =
    fixed.length > 0 ? ` (${fixed.length} newly registered — run --update-baseline)` : '';
  console.log(
    `lint-exit-code-registry-parity: OK — ${missing.length} unregistered of ${members.length}, none net-new${suffix}.`,
  );
  process.exit(0);
}

console.error(
  `lint-exit-code-registry-parity: FAIL — ${added.length} exit code(s) declared with no registry entry:\n`,
);
for (const m of added) console.error(`    ${m}`);
console.error(
  '\nAn exit code with no `CLEO_ERROR_REGISTRY` entry still works as an exit status,\n' +
    'so nothing fails — but `getRegistryEntry()` returns undefined for it, so it renders\n' +
    'with no category, no LAFS code, no retryable flag and no HTTP status. A deliberate\n' +
    'policy guard then reads to the caller like an internal fault (gh#1273).\n\n' +
    '  FIX: add an entry to CLEO_ERROR_REGISTRY in packages/core/src/error-registry.ts\n' +
    '       with a category, lafsCode, description, retryable and httpStatus.\n',
);
process.exit(1);

#!/usr/bin/env node

/**
 * scripts/lint-lafs-envelope-conformance.mjs
 *
 * CI conformance gate (T11422 · E7-LAFS-CANONICAL): validates representative
 * CLEO CLI output fixtures against the LAFS envelope JSON Schema (Draft-07).
 *
 * This gate enforces that the CLEO CLI canonical envelope shape (`meta/data`)
 * is accepted by the unified `envelope.schema.json` which now covers both the
 * LAFS SDK shape (`_meta/result`) and the CLEO CLI shape (ADR-039 / T11419).
 *
 * Fixtures under `packages/lafs/fixtures/valid-cleo-cli-*.json` are the
 * representative captured CLEO outputs. Adding a fixture here automatically
 * includes it in the gate.
 *
 * Exit codes:
 *   0  all fixtures pass schema validation
 *   1  one or more fixtures failed schema validation or fixture load error
 *
 * Usage:
 *   node scripts/lint-lafs-envelope-conformance.mjs            # report only
 *   node scripts/lint-lafs-envelope-conformance.mjs --verbose  # show checks
 *
 * @task T11422
 * @epic T11394 E7-LAFS-CANONICAL
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const REPO = process.cwd();
const FIXTURES_DIR = resolve(REPO, 'packages/lafs/fixtures');
const SCHEMA_PATH = resolve(REPO, 'packages/lafs/schemas/v1/envelope.schema.json');
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');

function fail(msg) {
  process.stderr.write(`[lint-lafs-envelope-conformance] ERROR: ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`[lint-lafs-envelope-conformance] ${msg}\n`);
}

// ─── Load schema via require (CommonJS-compatible, no top-level await needed) ─
// We resolve ajv/ajv-formats from packages/lafs/ (they are lafs dependencies)
// to avoid the workspace:* protocol issue when running npm install at the repo root.
const LAFS_PKG = resolve(REPO, 'packages/lafs');
const require = createRequire(`${LAFS_PKG}/`);

if (!existsSync(SCHEMA_PATH)) {
  fail(`Schema not found: ${SCHEMA_PATH}`);
}

const envelopeSchema = require(SCHEMA_PATH);

// ─── Load AJV (from packages/lafs/node_modules — lafs lists ajv as a dependency) ─
const AjvModule = require('ajv');
const AddFormatsModule = require('ajv-formats');

const AjvCtor = typeof AjvModule === 'function' ? AjvModule : AjvModule.default;
const addFormats =
  typeof AddFormatsModule === 'function' ? AddFormatsModule : AddFormatsModule.default;

const ajv = new AjvCtor({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(envelopeSchema);

// ─── Collect CLEO CLI fixtures ───────────────────────────────────────────────
// Validate all fixtures whose filenames start with "valid-cleo-cli-"
let fixtureFiles;
try {
  fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith('valid-cleo-cli-') && f.endsWith('.json'))
    .map((f) => resolve(FIXTURES_DIR, f));
} catch (err) {
  fail(`Cannot read fixtures directory ${FIXTURES_DIR}: ${err.message}`);
}

if (fixtureFiles.length === 0) {
  fail(
    `No CLEO CLI fixtures found in ${FIXTURES_DIR} (expected files matching valid-cleo-cli-*.json)`,
  );
}

log(`Validating ${fixtureFiles.length} CLEO CLI envelope fixture(s) against envelope.schema.json`);

let failCount = 0;
const results = [];

for (const fixturePath of fixtureFiles) {
  const shortName = fixturePath.replace(REPO + '/', '');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  } catch (err) {
    results.push({ name: shortName, ok: false, errors: [`parse error: ${err.message}`] });
    failCount++;
    continue;
  }

  const valid = validate(parsed);
  if (valid) {
    results.push({ name: shortName, ok: true, errors: [] });
  } else {
    const errors = (validate.errors ?? []).map(
      (e) => `  ${e.instancePath || '/'} [${e.keyword}] ${e.message}`,
    );
    results.push({ name: shortName, ok: false, errors });
    failCount++;
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────
for (const { name, ok, errors } of results) {
  if (ok) {
    log(`  ✓ ${name}`);
  } else {
    log(`  ✗ ${name}`);
    for (const e of errors) {
      process.stderr.write(`      ${e}\n`);
    }
  }
}

if (VERBOSE) {
  log(`Schema: ${SCHEMA_PATH}`);
  log(`Fixtures directory: ${FIXTURES_DIR}`);
}

if (failCount > 0) {
  process.stderr.write(
    `\n[lint-lafs-envelope-conformance] FAILED: ${failCount}/${fixtureFiles.length} fixture(s) failed schema validation.\n`,
  );
  process.stderr.write(
    `  To investigate: node scripts/lint-lafs-envelope-conformance.mjs --verbose\n`,
  );
  process.stderr.write(
    `  To reconcile the schema: see T11419 and packages/lafs/schemas/v1/envelope.schema.json\n`,
  );
  process.exit(1);
} else {
  log(`OK — all ${fixtureFiles.length} CLEO CLI fixture(s) pass schema validation.`);
  process.exit(0);
}

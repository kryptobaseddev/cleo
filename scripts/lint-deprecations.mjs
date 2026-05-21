#!/usr/bin/env node

/**
 * Lint rule: .cleo/deprecations.yml is the source-of-truth for legacy
 * code paths bearing TSDoc `@deprecated` markers.
 *
 * Verifies:
 *   1. `.cleo/deprecations.yml` parses cleanly and conforms to
 *      `.cleo/deprecations.schema.json`.
 *   2. Every TSDoc `@deprecated` symbol-comment in a path/paths listed in
 *      the registry — the file MUST contain at least one @deprecated tag.
 *   3. Every registered path EXISTS on disk (catches stale entries after
 *      file moves).
 *   4. IDs are unique.
 *
 * Exits non-zero on any drift, printing every failure to stderr.
 *
 * @task T9795
 * @saga T9787
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';

// ─── Configuration ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const REGISTRY_PATH = join(REPO_ROOT, '.cleo/deprecations.yml');
const SCHEMA_PATH = join(REPO_ROOT, '.cleo/deprecations.schema.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const failures = [];

/**
 * Push a failure with a stable shape; we surface all of them at the end.
 *
 * @param {string} message
 */
function fail(message) {
  failures.push(message);
}

// ─── Load registry + schema ───────────────────────────────────────────────────

if (!existsSync(REGISTRY_PATH)) {
  fail(`Registry missing: ${REGISTRY_PATH}`);
  printAndExit();
}
if (!existsSync(SCHEMA_PATH)) {
  fail(`Schema missing: ${SCHEMA_PATH}`);
  printAndExit();
}

/** @type {unknown} */
let registry;
try {
  registry = parseYaml(readFileSync(REGISTRY_PATH, 'utf-8'));
} catch (err) {
  fail(`Failed to parse YAML: ${REGISTRY_PATH} — ${/** @type {Error} */ (err).message}`);
  printAndExit();
}

/** @type {object} */
let schema;
try {
  schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
} catch (err) {
  fail(`Failed to parse JSON schema: ${SCHEMA_PATH} — ${/** @type {Error} */ (err).message}`);
  printAndExit();
}

// ─── 1. Schema validation ─────────────────────────────────────────────────────

const ajv = new Ajv.default({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const valid = validate(registry);
if (!valid) {
  for (const e of validate.errors ?? []) {
    fail(
      `Schema violation @ ${e.instancePath || '(root)'}: ${e.message} ${JSON.stringify(e.params)}`,
    );
  }
}

// Type-narrow after schema validation succeeds — if it failed, we still want
// to attempt the structural checks so authors see all problems in one pass.
const reg =
  /** @type {{ version: number, deprecations: Array<{ id: string, path?: string, paths?: string[], since: string, remove: string, replacement: string, note: string }> }} */ (
    registry
  );

// ─── 2. Path existence + collect all registered files ─────────────────────────

/** @type {Map<string, string>} */
const fileToEntryId = new Map();

if (Array.isArray(reg?.deprecations)) {
  /** @type {Set<string>} */
  const seenIds = new Set();

  for (const entry of reg.deprecations) {
    if (!entry || typeof entry.id !== 'string') continue;

    if (seenIds.has(entry.id)) {
      fail(`Duplicate deprecation id: ${entry.id}`);
    }
    seenIds.add(entry.id);

    /** @type {string[]} */
    const filesForEntry = [];
    if (typeof entry.path === 'string') filesForEntry.push(entry.path);
    if (Array.isArray(entry.paths)) filesForEntry.push(...entry.paths);

    if (filesForEntry.length === 0) {
      fail(`Entry ${entry.id} has no path/paths`);
      continue;
    }

    for (const f of filesForEntry) {
      // We skip glob expansion — `paths` may contain wildcards used for
      // coverage scoping but the lint asserts the LITERAL path exists OR
      // a clearly-globbed pattern (contains '**' / '*') is left alone.
      const isGlob = f.includes('*');
      if (isGlob) continue;
      const absPath = join(REPO_ROOT, f);
      if (!existsSync(absPath)) {
        fail(`Entry ${entry.id} → path does not exist: ${f}`);
        continue;
      }
      fileToEntryId.set(f, entry.id);
    }
  }
}

// ─── 3. Every registered file MUST contain a @deprecated TSDoc tag ────────────

for (const [file, entryId] of fileToEntryId.entries()) {
  const absPath = join(REPO_ROOT, file);
  let contents = '';
  try {
    contents = readFileSync(absPath, 'utf-8');
  } catch {
    fail(`Entry ${entryId} → cannot read ${file}`);
    continue;
  }
  if (!/@deprecated\b/.test(contents)) {
    fail(
      `Entry ${entryId} → file lacks @deprecated TSDoc: ${file}\n` +
        `  Fix: add a TSDoc /** @deprecated Since v…  */ block, or remove the registry entry.`,
    );
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printAndExit() {
  if (failures.length === 0) {
    process.stdout.write(
      `lint-deprecations: OK — ${reg?.deprecations?.length ?? 0} entries validated\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `lint-deprecations: FAILED — ${failures.length} issue(s):\n` +
      failures.map((m) => `  ✗ ${m}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

printAndExit();

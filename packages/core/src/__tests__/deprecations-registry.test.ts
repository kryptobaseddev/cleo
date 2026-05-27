/**
 * Deprecation registry coverage tests (T9795 / Saga T9787).
 *
 * Asserts:
 *   1. `.cleo/deprecations.yml` parses + matches the JSON Schema.
 *   2. Every listed source file actually carries a TSDoc `@deprecated` tag
 *      (catches drift when the legacy file is removed without the
 *      registry entry being deleted).
 *   3. `pushWarning` fires when a deprecated function is invoked — proves
 *      the runtime warning machinery is wired (T9795 hard rule:
 *      "runtime warning emitted on stderr human-mode only" depends on the
 *      warning being queued onto the LAFS envelope first).
 *
 * @task T9795
 * @saga T9787
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { drainWarnings, pushWarning } from '../output.js';

// T9784 / Saga T9782: `release/changelog-writer.ts` and `ui/changelog.ts`
// were deleted in the "single canonical CHANGELOG system" rip-out. The
// runtime W_DEPRECATED emission tests for those modules are removed below
// (subject is gone). The registry coverage tests for the YAML+schema still
// apply — they now operate on the remaining `cleo-release-changelog-verb-
// git-log` and `agent-output-raw-md-write` entries.

// ─── Locate registry + schema relative to the monorepo root ────────────────

// vitest runs from the package root; the repo root is two levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');
const REGISTRY_PATH = resolve(REPO_ROOT, '.cleo/deprecations.yml');
const SCHEMA_PATH = resolve(REPO_ROOT, '.cleo/deprecations.schema.json');

interface DeprecationEntry {
  id: string;
  path?: string;
  paths?: string[];
  since: string;
  remove: string;
  replacement: string;
  note: string;
}

interface Registry {
  version: number;
  deprecations: DeprecationEntry[];
}

describe('T9795: Deprecation registry (.cleo/deprecations.yml)', () => {
  it('registry + schema files exist', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('registry conforms to the JSON Schema', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const registry = parseYaml(readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
    const ajv = new (Ajv as unknown as typeof Ajv.default)({
      allErrors: true,
      strict: false,
    });
    const validate = ajv.compile(schema);
    const valid = validate(registry);
    if (!valid) {
      // Surface every violation for fast triage.
      throw new Error(
        `Schema violations:\n${(validate.errors ?? [])
          .map((e) => `  ${e.instancePath || '(root)'}: ${e.message}`)
          .join('\n')}`,
      );
    }
    expect(registry.version).toBe(1);
    expect(Array.isArray(registry.deprecations)).toBe(true);
    expect(registry.deprecations.length).toBeGreaterThan(0);
  });

  it('every registered source file carries a TSDoc @deprecated tag', () => {
    const registry = parseYaml(readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
    const failures: string[] = [];

    for (const entry of registry.deprecations) {
      const filesForEntry: string[] = [];
      if (typeof entry.path === 'string') filesForEntry.push(entry.path);
      if (Array.isArray(entry.paths)) filesForEntry.push(...entry.paths);

      for (const file of filesForEntry) {
        // Skip globs — the lint script enforces non-glob path existence.
        if (file.includes('*')) continue;
        const absPath = resolve(REPO_ROOT, file);
        if (!existsSync(absPath)) {
          failures.push(`Entry ${entry.id}: missing file ${file}`);
          continue;
        }
        const contents = readFileSync(absPath, 'utf-8');
        if (!/@deprecated\b/.test(contents)) {
          failures.push(`Entry ${entry.id}: ${file} lacks @deprecated TSDoc`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join('\n'));
    }
  });

  it('IDs are unique', () => {
    const registry = parseYaml(readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
    const ids = registry.deprecations.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('T9795: Runtime W_DEPRECATED warning emission', () => {
  it('pushWarning queues a structured warning that drainWarnings returns', () => {
    // Sanity check the queue plumbing in isolation so deprecation-fire tests
    // below can rely on it.
    drainWarnings(); // clear any pending residue
    pushWarning({
      code: 'W_DEPRECATED',
      message: 'test',
      severity: 'warn',
      deprecated: 'foo',
      replacement: 'bar',
      removeBy: 'v2026.6.0',
    });
    const drained = drainWarnings();
    expect(drained?.length).toBe(1);
    expect(drained?.[0]?.code).toBe('W_DEPRECATED');
  });

  // T9784 / Saga T9782: the two W_DEPRECATED firing tests below were
  // deleted alongside their subjects (writeChangelogSection in
  // changelog-writer.ts; generateChangelog in ui/changelog.ts). Both
  // source files are gone — there is no live deprecation to assert.
});

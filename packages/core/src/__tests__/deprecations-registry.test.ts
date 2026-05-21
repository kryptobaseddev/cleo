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
import { writeChangelogSection } from '../release/changelog-writer.js';
import { generateChangelog } from '../ui/changelog.js';

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

  it('writeChangelogSection emits W_DEPRECATED (changelog-writer-custom-log)', async () => {
    drainWarnings();
    // The function writes via atomicWrite — give it a path inside /tmp so
    // we don't pollute the repo. We only care about the warning side-effect.
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpPath = join(tmpdir(), `T9795-changelog-${Date.now()}.md`);
    await writeChangelogSection('v0.0.0-test', '- entry', [], tmpPath);
    const drained = drainWarnings();
    const codes = (drained ?? []).map((w) => w.code);
    expect(codes).toContain('W_DEPRECATED');
    const ctx = (drained ?? []).find((w) => w.code === 'W_DEPRECATED')?.context as
      | { registryId?: string }
      | undefined;
    expect(ctx?.registryId).toBe('changelog-writer-custom-log');
  });

  it('generateChangelog emits W_DEPRECATED (ui-changelog-label-grouping)', async () => {
    drainWarnings();
    // Pass an accessor stub that returns no tasks so the function short-
    // circuits without touching the filesystem.
    const stubAccessor = {
      queryTasks: async () => ({ tasks: [] }),
      loadArchive: async () => ({ archivedTasks: [] }),
    } as unknown as Parameters<typeof generateChangelog>[3];
    await generateChangelog('v0.0.0-test', {}, undefined, stubAccessor);
    const drained = drainWarnings();
    const dep = (drained ?? []).find((w) => w.code === 'W_DEPRECATED');
    expect(dep).toBeDefined();
    const ctx = dep?.context as { registryId?: string } | undefined;
    expect(ctx?.registryId).toBe('ui-changelog-label-grouping');
  });
});

/**
 * The legacy flat-file manifest readers in `memory/index.ts` (`showManifestEntry`,
 * `validateManifestEntries`) resolve a stored `file` reference through the
 * contained-file helper, so neither can read or probe a path outside the
 * project — not via `../`, an absolute path, or an in-project symlink (T12829).
 *
 * @task T12829
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { showManifestEntry, validateManifestEntries } from '../index.js';

let env: TestDbEnv;
let outsideDir: string;

const BASE = {
  title: 'Legacy entry',
  date: '2026-09-29',
  status: 'completed',
  agent_type: 'implementation',
  topics: ['t'],
  key_findings: ['a'],
  actionable: false,
  needs_followup: [],
  linked_tasks: ['T1'],
};

/** Write the legacy flat-file manifest (name built from parts, ADR-027). */
function writeLegacy(entries: Array<Record<string, unknown>>): void {
  const dir = join(env.cleoDir, 'agent-outputs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ['MANIFEST', 'jsonl'].join('.')),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
}

beforeEach(async () => {
  env = await createTestDb();
  // The vitest sandbox pins CLEO_ROOT; point the legacy readers at this fixture.
  vi.stubEnv('CLEO_ROOT', env.tempDir);
  vi.stubEnv('CLEO_DIR', env.cleoDir);
  outsideDir = join(env.tempDir, '..', `outside-${Date.now()}-${Math.random()}`);
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET-LEGACY');
  mkdirSync(join(env.tempDir, 'out'), { recursive: true });
  writeFileSync(join(env.tempDir, 'out', 'real.md'), 'IN-PROJECT');
  symlinkSync(outsideDir, join(env.tempDir, 'link'));
  symlinkSync('out/real.md', join(env.tempDir, 'alias.md'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('showManifestEntry', () => {
  it('refuses escaping references without reading them', async () => {
    writeLegacy([
      { ...BASE, id: 'T1-sym', file: 'link/secret.txt' },
      { ...BASE, id: 'T1-dotdot', file: `../${outsideDir.split('/').pop()}/secret.txt` },
      { ...BASE, id: 'T1-abs', file: join(outsideDir, 'secret.txt') },
    ]);
    for (const id of ['T1-sym', 'T1-dotdot', 'T1-abs']) {
      await expect(showManifestEntry(id, env.tempDir)).rejects.toThrow(/unsafe file reference/);
    }
  });

  it('reads an in-project symlink target and reports a missing file as absent', async () => {
    writeLegacy([
      { ...BASE, id: 'T1-alias', file: 'alias.md' },
      { ...BASE, id: 'T1-missing', file: 'out/missing.md' },
    ]);
    expect(await showManifestEntry('T1-alias', env.tempDir)).toMatchObject({
      fileContent: 'IN-PROJECT',
      fileExists: true,
    });
    expect(await showManifestEntry('T1-missing', env.tempDir)).toMatchObject({
      fileContent: null,
      fileExists: false,
    });
  });
});

describe('validateManifestEntries', () => {
  it('flags an escaping reference as an error instead of probing it', async () => {
    writeLegacy([
      { ...BASE, id: 'T1-sym', file: 'link/secret.txt' },
      { ...BASE, id: 'T1-missing', file: 'out/missing.md' },
      { ...BASE, id: 'T1-alias', file: 'alias.md' },
    ]);
    const result = await validateManifestEntries('T1', env.tempDir);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryId: 'T1-sym', severity: 'error' }),
        expect.objectContaining({ entryId: 'T1-missing', severity: 'warning' }),
      ]),
    );
    expect(result.issues.some((i) => i.entryId === 'T1-alias')).toBe(false);
  });
});

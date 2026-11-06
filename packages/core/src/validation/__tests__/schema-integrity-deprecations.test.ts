/**
 * A retired project-context key stays valid and warns once (T14260):
 * `evidence.ciChecks.covering` is ignored since CI's own change-filter skip
 * replaced it, so an old config still validates and `cleo doctor` names the
 * key so it can be removed.
 *
 * @task T14260
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSchema } from '../../json-schema-validator.js';
import { checkSchemaIntegrity, projectContextDeprecations } from '../schema-integrity.js';

const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8'));

/** This repository's own context, with an old covering block put back. */
function withCovering(): Record<string, unknown> {
  const context = read('../../../../../.cleo/project-context.json');
  const evidence = context['evidence'] as { ciChecks: Record<string, unknown> };
  evidence.ciChecks['covering'] = {
    tests: [{ paths: ['scripts/**'], jobs: ['Scripts Tests'] }],
  };
  return context;
}

afterEach(() => {
  vi.doUnmock('../schema-integrity.js');
  vi.unstubAllEnvs();
});

describe('a deprecated evidence.ciChecks.covering block (T14260)', () => {
  it('still validates against the shipped schema', () => {
    expect(
      checkSchema(withCovering(), read('../../../schemas/project-context.schema.json')),
    ).toEqual([]);
  });

  it('is named once as deprecated; a context without it names nothing', () => {
    expect(projectContextDeprecations(withCovering())).toEqual([
      expect.stringMatching(/evidence\.ciChecks\.covering is ignored since T14260.*remove it/),
    ]);
    const clean = read('../../../../../.cleo/project-context.json');
    expect(projectContextDeprecations(clean)).toEqual([]);
  });

  it('the integrity check keeps the file ok and carries the deprecation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'covering-deprecated-'));
    try {
      mkdirSync(join(root, '.cleo'), { recursive: true });
      writeFileSync(join(root, '.cleo', 'project-context.json'), JSON.stringify(withCovering()));
      // The test environment's CLEO_DIR would win over the root's own .cleo/.
      vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
      const report = await checkSchemaIntegrity(root);
      const file = report.files.find((f) => f.label === 'project-context.json');
      expect(file?.status).toBe('ok');
      expect(file?.deprecations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleo doctor warns once, naming the key', async () => {
    vi.resetModules();
    vi.doMock('../schema-integrity.js', () => ({
      checkSchemaIntegrity: async () => ({
        files: [
          {
            label: 'project-context.json',
            status: 'ok',
            errors: [],
            deprecations: projectContextDeprecations(withCovering()),
          },
        ],
        sqliteVersion: null,
        allOk: true,
      }),
    }));
    const { checkJsonSchemaIntegrity } = await import('../doctor/checks.js');
    const result = await checkJsonSchemaIntegrity('/unused');
    expect(result.status).toBe('warning');
    expect(result.message).toMatch(/Deprecated config keys: .*evidence\.ciChecks\.covering/);
  });
});

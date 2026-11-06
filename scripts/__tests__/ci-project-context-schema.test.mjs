/**
 * T13279 — the tracked `.cleo/project-context.json` is validated against its
 * schema in Lint & Format.
 *
 * Biome ignores `.cleo/`, so without this step a change to the evidence,
 * release and testing rules ran no check at all and could not be attested
 * from CI.
 *
 * @task T13279
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const lint = Object.values(ci.jobs).find((j) => j.name === 'Lint & Format');
const context = JSON.parse(
  readFileSync(path.join(REPO_ROOT, '.cleo/project-context.json'), 'utf8'),
);

describe('project-context schema check (T13279)', () => {
  it('Lint & Format validates .cleo/project-context.json against its schema', () => {
    const step = (lint?.steps ?? []).find((s) => /ajv validate/.test(String(s.run ?? '')));
    expect(step, 'a validation step').toBeDefined();
    expect(step.run).toContain('-s packages/core/schemas/project-context.schema.json');
    expect(step.run).toContain('-d .cleo/project-context.json');
  });

  it('the covering table is gone: a filter skip outside the package code roots stands in (T14260)', () => {
    expect(context.evidence.ciChecks.covering).toBeUndefined();
  });
});

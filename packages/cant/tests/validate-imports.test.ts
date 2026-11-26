/**
 * Import-graph validation through the native binding (T14642): a missing
 * import yields S04, and a diagnostic raised in an imported file is reported
 * at that file with its own line/col by `validateDocument` and
 * `compileBundle`.
 *
 * @task T14642
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileBundle } from '../src/bundle';
import { validateDocument } from '../src/document';
import { cantLegacyEntryPointWalksImports } from '../src/native-loader';

let dir: string;

/** Writes `content` to `rel` under the test project and returns its path. */
function write(rel: string, content: string): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cant-validate-imports-'));
  mkdirSync(join(dir, '.cleo'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('import-graph validation (T14642)', () => {
  it('detects that the current addon walks imports through cantValidateDocument', () => {
    expect(cantLegacyEntryPointWalksImports()).toBe(true);
  });

  it('reports a missing import with S04 naming it', async () => {
    const main = write('missing/main.cant', '@import "./nowhere.cant"\n');
    const result = await validateDocument(main);
    expect(result.importRulesRun).toBe(true);
    expect(result.importRuleCoverage).toBe('full');
    const s04 = result.diagnostics.filter((d) => d.ruleId === 'S04');
    expect(s04).toHaveLength(1);
    expect(s04[0]?.message).toContain("Import target './nowhere.cant' does not exist");
    expect(s04[0]?.line).toBe(1);
    expect(s04[0]?.file ?? null).toBeNull();
  });

  it('reports diagnostics raised in an imported file at that file and its own line/col', async () => {
    const main = write(
      'located/main.cant',
      '@import "./agents/worker.cant"\n\nagent coordinator:\n  model: opus\n  permissions:\n    tasks: read\n',
    );
    const worker = write(
      'located/agents/worker.cant',
      '@import "./gone.cant"\n\nagent worker:\n  model: opus\n  permissions:\n    tasks: write\n',
    );
    const workerPath = realpathSync(worker);

    const result = await validateDocument(main);
    const s12 = result.diagnostics.find((d) => d.ruleId === 'S12');
    expect(s12?.file).toBe(workerPath);
    expect(s12?.line).toBe(6);
    const s04 = result.diagnostics.find((d) => d.ruleId === 'S04');
    expect(s04?.file).toBe(workerPath);
    expect(s04?.line).toBe(1);

    const bundle = await compileBundle([main]);
    const bundled = bundle.diagnostics.filter((d) => d.ruleId === 'S12' || d.ruleId === 'S04');
    expect(bundled.length).toBeGreaterThanOrEqual(2);
    for (const d of bundled) expect(d.sourcePath).toBe(workerPath);
    expect(bundled.find((d) => d.ruleId === 'S12')?.line).toBe(6);
    expect(bundled.find((d) => d.ruleId === 'S04')?.line).toBe(1);
  });
});

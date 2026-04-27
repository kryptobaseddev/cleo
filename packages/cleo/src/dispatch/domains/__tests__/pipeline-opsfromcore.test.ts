/**
 * Regression coverage for the T1441 pipeline dispatch OpsFromCore migration.
 *
 * Verifies that pipeline.ts derives PipelineOps from coreOps via OpsFromCore
 * inference instead of importing per-op contract param types directly.
 *
 * @task T1441 — OpsFromCore inference migration
 * @task T1435 — Wave 1 dispatch refactor
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../pipeline.ts');

describe('pipeline dispatch OpsFromCore inference', () => {
  it('infers PipelineOps from coreOps instead of importing per-op contract params', async () => {
    const source = await readFile(sourcePath, 'utf-8');

    // Must use OpsFromCore pattern
    expect(source).toContain('const coreOps = {');
    expect(source).toContain('type PipelineOps = OpsFromCore<typeof coreOps>;');
    expect(source).toContain('defineTypedHandler<PipelineOps>');
    expect(source).toContain('typedDispatch');
  });

  it('exports PipelineOps type', async () => {
    const source = await readFile(sourcePath, 'utf-8');
    expect(source).toContain('export type PipelineOps');
  });

  it('covers all 34 pipeline operations in coreOps', async () => {
    const source = await readFile(sourcePath, 'utf-8');

    // Stage ops
    expect(source).toContain("'stage.validate'");
    expect(source).toContain("'stage.status'");
    expect(source).toContain("'stage.history'");
    expect(source).toContain("'stage.guidance'");
    expect(source).toContain("'stage.record'");
    expect(source).toContain("'stage.skip'");
    expect(source).toContain("'stage.reset'");
    expect(source).toContain("'stage.gate.pass'");
    expect(source).toContain("'stage.gate.fail'");

    // Release ops
    expect(source).toContain("'release.list'");
    expect(source).toContain("'release.show'");
    expect(source).toContain("'release.channel.show'");
    expect(source).toContain("'release.changelog.since'");
    expect(source).toContain("'release.ship'");
    expect(source).toContain("'release.cancel'");
    expect(source).toContain("'release.rollback'");
    expect(source).toContain("'release.rollback.full'");

    // Manifest ops
    expect(source).toContain("'manifest.show'");
    expect(source).toContain("'manifest.list'");
    expect(source).toContain("'manifest.find'");
    expect(source).toContain("'manifest.stats'");
    expect(source).toContain("'manifest.append'");
    expect(source).toContain("'manifest.archive'");

    // Phase ops
    expect(source).toContain("'phase.show'");
    expect(source).toContain("'phase.list'");
    expect(source).toContain("'phase.set'");
    expect(source).toContain("'phase.advance'");
    expect(source).toContain("'phase.rename'");
    expect(source).toContain("'phase.delete'");

    // Chain ops
    expect(source).toContain("'chain.show'");
    expect(source).toContain("'chain.list'");
    expect(source).toContain("'chain.add'");
    expect(source).toContain("'chain.instantiate'");
    expect(source).toContain("'chain.advance'");
  });

  it('preserves getSupportedOperations list', async () => {
    const source = await readFile(sourcePath, 'utf-8');
    expect(source).toContain('getSupportedOperations');
    // Spot-check required query ops
    expect(source).toContain("'stage.guidance'");
    expect(source).toContain("'release.channel.show'");
    expect(source).toContain("'chain.list'");
    // Spot-check required mutate ops
    expect(source).toContain("'release.ship'");
    expect(source).toContain("'chain.advance'");
  });
});

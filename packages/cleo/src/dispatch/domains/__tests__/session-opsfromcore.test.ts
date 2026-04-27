/**
 * Regression coverage for the T1444 session dispatch type-source migration
 * and the T1489 sole-source Params aliases via contracts re-exports.
 *
 * @task T1444
 * @task T1489
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../session.ts');

describe('session dispatch OpsFromCore inference', () => {
  it('infers SessionOps from coreOps via OpsFromCore (T1444)', async () => {
    const source = await readFile(sourcePath, 'utf-8');

    expect(source).toContain('const coreOps = {');
    expect(source).toContain('type SessionOps = OpsFromCore<typeof coreOps>;');
  });

  it('sole-sources per-op Params types via import from @cleocode/contracts (T1489)', async () => {
    const source = await readFile(sourcePath, 'utf-8');

    // T1489: Params types must be imported from contracts, not defined locally.
    expect(source).toMatch(/from ['"]@cleocode\/contracts['"]/);
    expect(source).toContain('SessionShowParams');
    expect(source).toContain('SessionStartParams');
    expect(source).toContain('SessionEndParams');
    expect(source).toContain('SessionResumeParams');
    expect(source).toContain('SessionSuspendParams');
    expect(source).toContain('SessionGcParams');
    expect(source).toContain('SessionHandoffShowParams');

    // No local re-definition of these types (no `type Session*OpParams =`)
    expect(source).not.toMatch(/type Session\w+OpParams\s*=/);
  });
});

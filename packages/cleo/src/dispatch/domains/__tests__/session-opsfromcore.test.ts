/**
 * Regression coverage for the T1444 session dispatch type-source migration.
 *
 * @task T1444
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../session.ts');

describe('session dispatch OpsFromCore inference', () => {
  it('infers SessionOps from coreOps instead of importing per-op contract params', async () => {
    const source = await readFile(sourcePath, 'utf-8');

    expect(source).toContain('const coreOps = {');
    expect(source).toContain('type SessionOps = OpsFromCore<typeof coreOps>;');
    expect(source).not.toMatch(/from ['"]@cleocode\/contracts['"]/);
  });
});

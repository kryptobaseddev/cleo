/** T14062: the packed install resolves what the lockfile tested and parses fixtures as CI does. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real capture path, without kernel memory/task limits on a CI host
// (the same substitution assert-cleo-tarball.test.mjs makes).
vi.mock('../../packages/core/dist/resources/spawn-wrapper.js', async () => {
  const source = await import('../../packages/core/src/resources/spawn-wrapper.ts');
  return {
    ...source,
    captureWrapped: (command, args, options) =>
      source.captureWrapped(command, args, {
        ...options,
        memoryMaxMb: undefined,
        tasksMax: undefined,
      }),
  };
});

import {
  installedDependencyVersion,
  lockedRuntimeVersions,
  packedLockDrift,
  verifyPackedSchemas,
} from '../packed-install-smoke.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'packed-lock-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `node_modules/<name>/package.json` (and optional files) under `dir`. */
function installPackage(dir, name, version, files = {}) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, ...files.manifest }));
  for (const [file, text] of Object.entries(files.sources ?? {}))
    writeFileSync(join(pkgDir, file), text);
  return pkgDir;
}

const LOCK = `lockfileVersion: '9.0'
importers:
  packages/contracts:
    dependencies:
      '@cleocode/lafs':
        specifier: workspace:*
        version: link:../lafs
      zod:
        specifier: 4.3.6
        version: 4.3.6
      zod-to-json-schema:
        specifier: ^3.25.2
        version: 3.25.2(zod@4.3.6)
`;

describe('lockfile comparison (T14062)', () => {
  it('reads the tested versions, dropping workspace links and peer suffixes', () => {
    expect(lockedRuntimeVersions(LOCK, 'packages/contracts')).toEqual({
      zod: '4.3.6',
      'zod-to-json-schema': '3.25.2',
    });
    expect(() => lockedRuntimeVersions(LOCK, 'packages/core')).toThrow(/packages\/core/);
  });

  it('resolves a dependency as Node does: nested first, then hoisted', () => {
    const contracts = installPackage(root, '@cleocode/contracts', '1.0.0');
    installPackage(root, 'zod', '4.6.7');
    expect(installedDependencyVersion(contracts, 'zod', root)).toBe('4.6.7');
    installPackage(contracts, 'zod', '4.3.6');
    expect(installedDependencyVersion(contracts, 'zod', root)).toBe('4.3.6');
    expect(installedDependencyVersion(contracts, 'absent', root)).toBeNull();
  });

  it('fails on the T14061 repro: zod ^4.3.6 resolving to 4.6.7', () => {
    const locked = lockedRuntimeVersions(LOCK, 'packages/contracts');
    const installed = { zod: '4.6.7', 'zod-to-json-schema': '3.25.2' };
    const drift = packedLockDrift(
      '@cleocode/contracts',
      { '@cleocode/lafs': '1.0.0', zod: '^4.3.6', 'zod-to-json-schema': '^3.25.2' },
      locked,
      (name) => installed[name] ?? null,
    );
    expect(drift.failures).toEqual([
      '@cleocode/contracts -> zod: installed 4.6.7, lockfile tested 4.3.6',
    ]);
    expect(drift.untested).toEqual([]);
  });

  it('passes when every resolution is the tested one', () => {
    const drift = packedLockDrift(
      '@cleocode/contracts',
      { zod: '4.3.6', 'zod-to-json-schema': '^3.25.2' },
      { zod: '4.3.6', 'zod-to-json-schema': '3.25.2' },
      (name) => ({ zod: '4.3.6', 'zod-to-json-schema': '3.25.2' })[name],
    );
    expect(drift).toEqual({ failures: [], untested: [] });
  });

  it('core: zod drift fails, other drift is recorded as untested', () => {
    const drift = packedLockDrift(
      '@cleocode/core',
      { zod: '4.3.6', yaml: '^2.8.3', '@cleocode/contracts': '1.0.0' },
      { zod: '4.3.6', yaml: '2.8.3' },
      (name) => ({ zod: '4.4.0', yaml: '2.9.1' })[name],
    );
    expect(drift.failures).toEqual([
      '@cleocode/core -> zod: installed 4.4.0, lockfile tested 4.3.6',
    ]);
    expect(drift.untested).toEqual([
      '@cleocode/core -> yaml: installed 2.9.1, lockfile tested 2.8.3',
    ]);
  });
});

describe('fixtures parsed through the installed contracts (T14062)', () => {
  /** A stand-in `@cleocode/contracts` whose summary schema accepts iff `summaryOk`. */
  function fakeContracts(summaryOk) {
    const accept = { success: true };
    const reject = { success: false, error: { issues: [{ message: 'nonoptional' }] } };
    installPackage(root, '@cleocode/contracts', '1.0.0', {
      manifest: { type: 'module', exports: './index.js' },
      sources: {
        'index.js': `export const acceptanceGateSchema = { safeParse: () => (${JSON.stringify(accept)}) };
export const testCountSummarySchema = { safeParse: (s) => ('testResults' in s ? ${JSON.stringify(reject)} : ${JSON.stringify(summaryOk ? accept : reject)}) };
`,
      },
    });
  }

  it('passes when the installed package parses every fixture as CI does', async () => {
    fakeContracts(true);
    await expect(verifyPackedSchemas(root, { ...process.env })).resolves.toHaveLength(3);
  });

  it('fails naming the fixture when a summary without testResults is rejected (T14061)', async () => {
    fakeContracts(false);
    await expect(verifyPackedSchemas(root, { ...process.env })).rejects.toThrow(
      /count summary without testResults/,
    );
  });
});

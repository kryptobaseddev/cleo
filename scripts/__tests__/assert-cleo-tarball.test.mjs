/** Independent npm-produced fixtures exercise both operational packaging wrappers. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Source tests exercise the real CAAMP leaf. Built export/install checks remain separate.
vi.mock('@cleocode/caamp', () => import('../../packages/caamp/src/core/artifacts/validation.ts'));

import { checkCleoTarball } from '../../packages/cleo/scripts/check-cleo-tarball-size.mjs';
import { assertCleoTarball } from '../assert-cleo-tarball.mjs';
import {
  assertPackedTaskResponse,
  assertPackedVersion,
  packedEnvironment,
  runPackedCommand,
} from '../packed-install-smoke.mjs';

const required = [
  'dist/cli/index.js',
  'studio-dist/index.js',
  'studio-dist/handler.js',
  'studio-dist/server/index.js',
  'studio-dist/server/manifest.js',
  'studio-dist/client/_app/immutable/entry/start.fixture.js',
  'studio-dist/client/_app/immutable/entry/app.fixture.js',
];
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-package-wrappers-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function put(path, bytes = 'export const fixture = true;\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function manifest(files = ['dist', 'studio-dist', '!dist/**/*.map']) {
  put('package.json', JSON.stringify({ name: 'cleo-wrapper-fixture', version: '1.0.0', files }));
}
function complete() {
  manifest();
  for (const path of required) put(path);
}

describe('real npm inventory through release wrappers', () => {
  it('accepts tiny complete content and preserves the negated files entry', () => {
    complete();
    put('dist/cli/index.js.map', 'excluded map');
    expect(assertCleoTarball(root)).toBe(true);
    expect(checkCleoTarball(root)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    const receipt = JSON.parse(console.log.mock.calls[0][0]);
    expect(receipt.inventory.source).toBe('npm-pack-dry-run');
    expect(receipt.runtime).toBe('not-assessed');
    expect(receipt.inventory.tarballSha256).toBeUndefined();
    expect(receipt.inventory.files.some((file) => file.path.endsWith('.map'))).toBe(false);
  });

  it('rejects empty directories that previously passed existence checks', () => {
    manifest();
    mkdirSync(join(root, 'dist/cli'), { recursive: true });
    mkdirSync(join(root, 'studio-dist/client/_app'), { recursive: true });
    expect(assertCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('Required resource');
  });

  it('rejects missing server content despite padding above both old floors', () => {
    complete();
    rmSync(join(root, 'studio-dist/server/manifest.js'));
    for (let index = 0; index < 601; index++)
      put(`studio-dist/padding/${index}.dat`, Buffer.alloc(40_000, 65));
    expect(checkCleoTarball(root)).toBe(false);
    const receipt = JSON.parse(console.log.mock.calls[0][0]);
    expect(receipt.unpackedBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(receipt.inventory.files.length).toBeGreaterThan(600);
    expect(receipt.issues.filter((issue) => issue.code === 'budget')).toEqual([]);
    expect(receipt.issues).toContainEqual(
      expect.objectContaining({ code: 'missing', subject: 'studio-manifest' }),
    );
  });

  it('rejects required resources excluded by npm despite complete staging', () => {
    complete();
    manifest(['dist', 'studio-dist', '!studio-dist/server/manifest.js']);
    expect(assertCleoTarball(root)).toBe(false);
  });

  it('retains declaration/stray JavaScript build-shape rejection', () => {
    complete();
    put('dist/cli/index.d.ts', 'export declare const fixture: boolean;');
    put('dist/not-shipped.js');
    expect(checkCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('E_DEV_TREE');
  });

  it('retains actual selected sourcemap rejection', () => {
    complete();
    put('studio-dist/server/index.js.map', '{}');
    expect(checkCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('forbidden');
  });

  it('retains literal staging promises beyond the semantic entrypoints', () => {
    complete();
    manifest(['dist', 'studio-dist', 'missing-promised.json']);
    expect(assertCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('missing-promised.json');
  });

  it('rejects malformed files declarations instead of skipping validation', () => {
    manifest([]);
    expect(() => assertCleoTarball(root)).toThrow('nonempty array');
    expect(() => checkCleoTarball(root)).toThrow('nonempty array');
  });
});

describe('packed operational execution', () => {
  it('rejects a failed child even when it prints a plausible version', () => {
    expect(() =>
      runPackedCommand(process.execPath, [
        '-e',
        "process.stdout.write('2026.9.8'); process.exit(7)",
      ]),
    ).toThrow();
    expect(runPackedCommand(process.execPath, ['-e', "process.stdout.write('fixture')"])).toBe(
      'fixture',
    );
  });
  it('does not inherit credentials, preloads, or host runtime aliases', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-must-not-copy');
    vi.stubEnv('NODE_OPTIONS', '--import=/host/guard.mjs');
    vi.stubEnv('CLEO_DIR', '/host/project/.cleo');
    vi.stubEnv('TMPDIR', '/host/tmp');
    const env = packedEnvironment(root);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=2048');
    expect(env.CLEO_DIR).toBe(join(root, 'project/.cleo'));
    expect(env.TMPDIR).toBe(join(root, 'tmp'));
    for (const key of [
      'HOME',
      'XDG_DATA_HOME',
      'NEXUS_HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'KIMI_HOME',
    ])
      expect(env[key].startsWith(root + '/')).toBe(true);
  });
});

describe('independent installed response oracles', () => {
  it('requires an exact successful version envelope, not arbitrary nonempty stdout', () => {
    expect(assertPackedVersion('{"success":true,"data":{"version":"2026.9.8"}}', '2026.9.8')).toBe(
      '2026.9.8',
    );
    for (const output of [
      '2026.9.8',
      '{"success":false,"data":{"version":"2026.9.8"}}',
      '{"success":true,"data":{"version":"wrong"}}',
      '{"success":true,"data":{"version":"2026.9.8"}}\nnoise',
    ])
      expect(() => assertPackedVersion(output, '2026.9.8')).toThrow();
  });
  it('requires canonical task identity and content, not merely HTTP success or an unrelated row', () => {
    expect(() =>
      assertPackedTaskResponse({ tasks: [{ id: 'T002', title: 'expected' }] }, 'T002', 'expected'),
    ).not.toThrow();
    for (const body of [
      { tasks: [] },
      { tasks: [{ id: 'T001', title: 'expected' }] },
      { tasks: [{ id: 'T002', title: 'wrong' }] },
      { error: 'tasks.db unavailable' },
    ])
      expect(() => assertPackedTaskResponse(body, 'T002', 'expected')).toThrow();
  });
});

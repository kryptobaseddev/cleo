import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderMatrix } from '../provider-matrix.js';

vi.mock('node:fs/promises', { spy: true });

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'provider-source-inspection-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('ProviderMatrix evidence boundaries', () => {
  it('reports absent source separately from diagnostic failure and live capability', async () => {
    const rows = await new ProviderMatrix(join(root, 'absent')).getMatrix();
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.source).toMatchObject({ status: 'missing', diagnostics: [] });
      expect(row.installed).toBe(false);
      for (const report of [row.externalCli, row.programmaticSpawn]) {
        expect(report.identity).toBeNull();
        for (const assessment of Object.values(report.levels)) {
          expect(assessment.status).toBe('unverified');
          expect(assessment.evidence).toEqual([]);
        }
      }
    }
    expect(await new ProviderMatrix(join(root, 'absent')).listInstalledProviderIds()).toEqual([]);
  });

  it('does not certify source stubs, comment-only hooks, versions, or self-authored certificates', async () => {
    const provider = join(root, 'claude-code');
    await fs.mkdir(provider);
    await fs.writeFile(join(provider, 'spawn.ts'), '// Not an implementation; version 2.1.274\n');
    await fs.writeFile(join(provider, 'hooks.ts'), '// PreToolUse Stop StopEvent\n');
    await fs.writeFile(
      join(provider, 'certification.json'),
      JSON.stringify({
        installed: true,
        workflow: 'passed',
        lifecycle: 'passed',
        receipts: ['invented'],
      }),
    );
    const row = (await new ProviderMatrix(root).getMatrix()).find(
      (r) => r.providerId === 'claude-code',
    );
    expect(row).toMatchObject({
      installed: true,
      spawnImplemented: true,
      hookSupport: 2,
      source: { status: 'present', directory: provider, hookNameMentions: 2, diagnostics: [] },
    });
    expect(row?.externalCli.channel).toBe('external-cli');
    expect(row?.programmaticSpawn.channel).toBe('programmatic-spawn');
    for (const report of [row?.externalCli, row?.programmaticSpawn]) {
      expect(report?.identity).toBeNull();
      expect(Object.values(report?.levels ?? {}).map((level) => level.status)).toEqual(
        Array(5).fill('unverified'),
      );
      expect(report?.limitations.join(' ')).toContain('Permission policy');
    }
  });

  it('does not confuse Kimi API adapter source with external Kimi CLI installation', async () => {
    await fs.mkdir(join(root, 'kimi'));
    await fs.writeFile(join(root, 'kimi', 'spawn.ts'), '// Moonshot API adapter\n');
    const row = (await new ProviderMatrix(root).getMatrix()).find((r) => r.providerId === 'kimi');
    expect(row?.source.spawnFilePresent).toBe(true);
    expect(row?.externalCli.levels.installed.status).toBe('unverified');
    expect(row?.externalCli.identity).toBeNull();
    expect(row?.programmaticSpawn.levels.workflow.status).toBe('unverified');
  });

  it('reports wrong provider path type as a failed diagnostic', async () => {
    await fs.writeFile(join(root, 'codex'), 'not a directory');
    const row = (await new ProviderMatrix(root).getMatrix()).find((r) => r.providerId === 'codex');
    expect(row?.source.status).toBe('failed');
    expect(row?.source.diagnostics[0]).toContain('Expected directory');
    expect(row?.externalCli.levels.workflow.status).toBe('unverified');
  });

  it('does not treat a directory called spawn.ts as executable source', async () => {
    await fs.mkdir(join(root, 'codex', 'spawn.ts'), { recursive: true });
    const row = (await new ProviderMatrix(root).getMatrix()).find((r) => r.providerId === 'codex');
    expect(row?.source).toMatchObject({
      status: 'failed',
      directoryPresent: true,
      spawnFilePresent: false,
    });
    expect(row?.source.diagnostics[0]).toContain('Expected file');
  });

  it('retains hook read failure explicitly rather than claiming zero supported hooks', async () => {
    await fs.mkdir(join(root, 'codex'));
    await fs.writeFile(join(root, 'codex', 'hooks.ts'), 'PreToolUse');
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('injected hook read failure'));
    const row = (await new ProviderMatrix(root).getMatrix()).find((r) => r.providerId === 'codex');
    expect(row?.source).toMatchObject({
      status: 'failed',
      diagnostics: ['injected hook read failure'],
    });
    expect(row?.programmaticSpawn.levels.lifecycle.status).toBe('unverified');
  });

  it('does not convert a broken inventory root into an empty healthy list', async () => {
    const badRoot = join(root, 'file');
    await fs.writeFile(badRoot, 'not a directory');
    const matrix = new ProviderMatrix(badRoot);
    await expect(matrix.listInstalledProviderIds()).rejects.toMatchObject({ code: 'ENOTDIR' });
    const rows = await matrix.getMatrix();
    expect(rows.every((row) => row.source.status === 'failed')).toBe(true);
    expect(rows.every((row) => row.source.diagnostics.length === 1)).toBe(true);
  });

  it('preserves discovery of unknown source directories without claiming live support', async () => {
    await fs.mkdir(join(root, 'experimental'));
    await fs.writeFile(join(root, 'README'), 'source inventory');
    expect(await new ProviderMatrix(root).listInstalledProviderIds()).toEqual(['experimental']);
    expect(
      (await new ProviderMatrix(root).getMatrix()).some((row) => row.providerId === 'experimental'),
    ).toBe(false);
  });
});

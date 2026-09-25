/**
 * Automatic refresh of stale global provider instructions and the doctor's
 * `caamp` binary check (T12378).
 *
 * Runs against a temp HOME with explicit providers; `force` opts in past the
 * Vitest guard that otherwise keeps the refresh away from real provider files.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@cleocode/caamp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCaampBinary, refreshStaleGlobalInstructions } from '../injection.js';

let home: string;
let originalHome: string | undefined;

async function targets(): Promise<Provider[]> {
  const { getProvider, resetRegistry } = await import('@cleocode/caamp');
  resetRegistry();
  return ['claude-code', 'pi'].map((id) => {
    const provider = getProvider(id);
    if (!provider) throw new Error(`unknown provider ${id}`);
    return provider;
  });
}

async function writeHub(body: string): Promise<void> {
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeFile(join(home, '.agents', 'protocol.md'), '# Protocol\nCheck authority first.\n');
  await writeFile(
    join(home, '.agents', 'AGENTS.md'),
    `<!-- CAAMP:START -->\n@protocol.md\n<!-- CAAMP:END -->\n${body}`,
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cleo-global-refresh-'));
  originalHome = process.env['HOME'];
  process.env['HOME'] = home;
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  delete process.env['CLEO_INSTRUCTION_AUTOREFRESH'];
  const { resetRegistry } = await import('@cleocode/caamp');
  resetRegistry();
  await rm(home, { recursive: true, force: true });
});

describe('refreshStaleGlobalInstructions', () => {
  it('is skipped under Vitest unless forced, and when disabled by env', async () => {
    expect((await refreshStaleGlobalInstructions()).status).toBe('skipped');
    process.env['CLEO_INSTRUCTION_AUTOREFRESH'] = '0';
    const report = await refreshStaleGlobalInstructions({ force: true });
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('CLEO_INSTRUCTION_AUTOREFRESH=0');
  });

  it('regenerates a stale embedded source and then reports current', async () => {
    const providers = await targets();
    await writeHub('');
    const { syncGlobalInstructions } = await import('@cleocode/caamp');
    await syncGlobalInstructions({ providers });

    await writeHub('\n- A new owner rule that every provider must receive at once.\n');
    const refreshed = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(refreshed.status).toBe('refreshed');
    expect(refreshed.stale).toHaveLength(2);
    expect(refreshed.updated).toHaveLength(2);
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(
      'A new owner rule that every provider must receive at once.',
    );

    const again = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(again.status).toBe('current');
    expect(again.updated).toEqual([]);
  });

  it('reports failure with the exact remedy when the hub cannot be resolved', async () => {
    const providers = await targets();
    await writeFile(
      join(home, '.claude', 'CLAUDE.md'),
      `<!-- CAAMP:START -->\n<!-- CAAMP:SOURCE ${encodeURIComponent(join(home, 'gone.md'))} ${'0'.repeat(64)} -->\nold\n<!-- CAAMP:END -->\n`,
    );
    const report = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(report.status).toBe('failed');
    expect(report.remedy).toBe('cleo install-global');
  });
});

describe('checkCaampBinary', () => {
  it('passes for a working binary, fails for a dead symlink, warns when absent', async () => {
    const bin = join(home, 'bin');
    await mkdir(bin, { recursive: true });
    expect(checkCaampBinary(bin).status).toBe('warning');
    expect(checkCaampBinary(bin).fix).toBe('npm install -g @cleocode/caamp');

    await symlink(join(home, 'missing', 'cli.js'), join(bin, 'caamp'));
    const dead = checkCaampBinary(bin);
    expect(dead.status).toBe('failed');
    expect(dead.fix).toBe(`rm ${join(bin, 'caamp')} && npm install -g @cleocode/caamp`);

    await rm(join(bin, 'caamp'));
    await writeFile(join(bin, 'caamp'), '#!/bin/sh\n');
    await chmod(join(bin, 'caamp'), 0o755);
    expect(checkCaampBinary(bin).status).toBe('passed');
  });
});

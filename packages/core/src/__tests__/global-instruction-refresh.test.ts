/**
 * Automatic staleness check of global provider instructions and the doctor's
 * `caamp` binary check (T12378). Since T13409 the check only reports: CLEO
 * never rewrites a user-global instruction file.
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

  it('reports a stale embedded source and never rewrites the file (T13409)', async () => {
    const providers = await targets();
    await writeHub('');
    const { syncGlobalInstructions } = await import('@cleocode/caamp');
    // Seed the delivery the way the owner would: an explicit user command.
    await syncGlobalInstructions({ providers, userRequested: true });
    const delivered = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');

    await writeHub('\n- A new owner rule that every provider must receive at once.\n');
    const report = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(report.status).toBe('skipped');
    expect(report.stale).toHaveLength(2);
    expect(report.updated).toEqual([]);
    expect(report.remedy).toBe('caamp instructions update --global');
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(delivered);
  });

  it('reports current when nothing is stale', async () => {
    const providers = await targets();
    await writeHub('');
    const { syncGlobalInstructions } = await import('@cleocode/caamp');
    await syncGlobalInstructions({ providers, userRequested: true });
    const report = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(report.status).toBe('current');
    expect(report.updated).toEqual([]);
  });

  it('leaves an unresolvable delivery untouched and names the owner command', async () => {
    const providers = await targets();
    const stale = `<!-- CAAMP:START -->\n<!-- CAAMP:SOURCE ${encodeURIComponent(join(home, 'gone.md'))} ${'0'.repeat(64)} -->\nold\n<!-- CAAMP:END -->\n`;
    await writeFile(join(home, '.claude', 'CLAUDE.md'), stale);
    const report = await refreshStaleGlobalInstructions({ force: true, providers });
    expect(report.status).toBe('skipped');
    expect(report.remedy).toBe('caamp instructions update --global');
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(stale);
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

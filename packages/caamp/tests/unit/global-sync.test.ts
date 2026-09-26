/**
 * The single global regenerator and its staleness scan (T12377 · T12378).
 *
 * Every test runs against a temp HOME: `os.homedir()` honours `HOME`, and the
 * provider registry is reset so `$HOME/...` paths resolve inside it. No real
 * provider file is ever touched.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGlobalInstructionStaleness,
  syncGlobalInstructions,
} from '../../src/core/instructions/global-sync.js';
import { inject, injectAll } from '../../src/core/instructions/injector.js';
import {
  EmbeddedDeliveryDowngradeError,
  isEmbeddedDelivery,
  parseBlocks,
} from '../../src/core/instructions/markers.js';
import { generateInjectionContent } from '../../src/core/instructions/templates.js';
import { getProvider, resetRegistry } from '../../src/core/registry/providers.js';
import type { Provider } from '../../src/types.js';

const OWNER_RULE =
  '- Whenever you need the owner to decide anything, use the ask tool with selectable options.';

let home: string;
let originalHome: string | undefined;

function providers(...ids: string[]): Provider[] {
  return ids.map((id) => {
    const provider = getProvider(id);
    if (!provider) throw new Error(`unknown provider ${id}`);
    return provider;
  });
}

async function writeHub(extra = ''): Promise<void> {
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeFile(join(home, '.agents', 'protocol.md'), '# CLEO Protocol\nCheck authority first.\n');
  await writeFile(
    join(home, '.agents', 'AGENTS.md'),
    `<!-- CAAMP:START -->\n@protocol.md\n<!-- CAAMP:END -->\n${extra}`,
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'caamp-global-sync-'));
  originalHome = process.env['HOME'];
  process.env['HOME'] = home;
  resetRegistry();
  for (const dir of ['.claude', '.codex', join('.pi', 'agent')]) {
    await mkdir(join(home, dir), { recursive: true });
  }
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  resetRegistry();
  await rm(home, { recursive: true, force: true });
});

describe('syncGlobalInstructions (T12377)', () => {
  it('embeds the hub into every provider file and preserves user text', async () => {
    await writeHub();
    const claude = join(home, '.claude', 'CLAUDE.md');
    await writeFile(claude, '# My own notes\nKeep me.\n');

    const result = await syncGlobalInstructions({ providers: providers('claude-code', 'codex', 'pi') });

    expect(result.status).toBe('synced');
    expect(result.files.map((f) => f.action).sort()).toEqual(['added', 'created', 'created']);
    for (const file of result.files) {
      const content = await readFile(file.path, 'utf8');
      expect(content).toContain('Check authority first.');
      expect(isEmbeddedDelivery(parseBlocks(content)[0]?.content ?? '')).toBe(true);
    }
    expect(await readFile(claude, 'utf8')).toContain('# My own notes\nKeep me.');

    const again = await syncGlobalInstructions({ providers: providers('claude-code', 'codex', 'pi') });
    expect(again.files.every((f) => f.action === 'intact')).toBe(true);
  });

  it('refreshes a stale embedded delivery after the hub changes', async () => {
    await writeHub();
    const targets = providers('claude-code', 'pi');
    await syncGlobalInstructions({ providers: targets });

    await writeHub(`\n# Owner rule\n${OWNER_RULE}\n`);
    const before = await checkGlobalInstructionStaleness({ providers: targets });
    expect(before.needsSync.sort()).toEqual(
      [join(home, '.claude', 'CLAUDE.md'), join(home, '.pi', 'agent', 'AGENTS.md')].sort(),
    );

    const result = await syncGlobalInstructions({ providers: targets });
    expect(result.files.every((f) => f.action === 'updated')).toBe(true);
    expect(await readFile(join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8')).toContain(OWNER_RULE);
    expect((await checkGlobalInstructionStaleness({ providers: targets })).needsSync).toEqual([]);
  });

  it('writes nothing when the hub cannot be resolved', async () => {
    const result = await syncGlobalInstructions({ providers: providers('claude-code') });
    expect(result.status).toBe('unresolved');
    expect(result.findings[0]?.kind).toBe('missing-reference');
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('dry run plans without writing', async () => {
    await writeHub();
    const result = await syncGlobalInstructions({ providers: providers('codex'), dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.files).toEqual([
      { path: join(home, '.codex', 'AGENTS.md'), providers: ['codex'], action: 'planned' },
    ]);
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false);
  });
});

describe('embedded delivery is never downgraded (T12377 regression)', () => {
  it('refuses to replace an embedded block with the generic stub, in inject and injectAll', async () => {
    await writeHub();
    await syncGlobalInstructions({ providers: providers('pi') });
    const pi = join(home, '.pi', 'agent', 'AGENTS.md');
    const embedded = await readFile(pi, 'utf8');

    await expect(inject(pi, generateInjectionContent())).rejects.toBeInstanceOf(
      EmbeddedDeliveryDowngradeError,
    );
    await expect(
      injectAll(providers('pi'), home, 'global', '@~/.agents/AGENTS.md'),
    ).rejects.toBeInstanceOf(EmbeddedDeliveryDowngradeError);
    expect(await readFile(pi, 'utf8')).toBe(embedded);
  });

  it('repairs a stub-only (unembedded) block through the regenerator', async () => {
    await writeHub();
    const pi = join(home, '.pi', 'agent', 'AGENTS.md');
    await inject(pi, generateInjectionContent());
    const targets = providers('pi');

    expect((await checkGlobalInstructionStaleness({ providers: targets })).files[0]?.state).toBe(
      'unembedded',
    );
    const result = await syncGlobalInstructions({ providers: targets });
    expect(result.files[0]?.action).toBe('updated');
    expect(await readFile(pi, 'utf8')).not.toContain('CAAMP Managed Configuration');
  });
});

describe('checkGlobalInstructionStaleness (T12378)', () => {
  it('reports absent, no-block and current files', async () => {
    await writeHub();
    await writeFile(join(home, '.codex', 'AGENTS.md'), '# user only\n');
    await syncGlobalInstructions({ providers: providers('claude-code') });

    const report = await checkGlobalInstructionStaleness({
      providers: providers('claude-code', 'codex', 'pi'),
    });
    const states = Object.fromEntries(report.files.map((f) => [f.providers[0], f.state]));
    expect(states).toEqual({ 'claude-code': 'current', codex: 'no-block', pi: 'absent' });
    expect(report.needsSync).toEqual([]);
  });

  it('reports a hand-appended copy of managed content outside CAAMP:END as a duplicate', async () => {
    const rule = `# Owner rule\n${OWNER_RULE}\n- Each option carries enough detail to act on and a clear way to select it.\n`;
    await writeHub(`\n${rule}`);
    const claude = join(home, '.claude', 'CLAUDE.md');
    await syncGlobalInstructions({ providers: providers('claude-code', 'codex') });
    const synced = await readFile(claude, 'utf8');
    await writeFile(claude, `${synced}\n${rule}`);

    const report = await checkGlobalInstructionStaleness({
      providers: providers('claude-code', 'codex'),
    });
    expect(report.duplicates).toEqual([claude]);
    expect(report.files.find((f) => f.path === claude)?.duplicateLines).toBe(2);

    // Reported only: a sync never deletes user text outside the block.
    await syncGlobalInstructions({ providers: providers('claude-code') });
    expect(await readFile(claude, 'utf8')).toContain(`${rule}`);
  });
});

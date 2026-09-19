import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureProviderInstructionFile } from '../../src/core/instructions/injector.js';
import { resolveInstructionDelivery } from '../../src/core/instructions/templates.js';

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cleo-delivery-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('self-contained instruction delivery (static, live providers unverified)', () => {
  it.each(['codex', 'claude-code', 'kimi'])('%s receives authority, uncertainty, repair and verification protocol', async () => {
    const protocol = await readFile(new URL('../../../core/templates/CLEO-INJECTION.md', import.meta.url), 'utf8');
    const dir = await fixture();
    await writeFile(join(dir, 'protocol.md'), protocol);
    await writeFile(join(dir, 'hub.md'), '<!-- CAAMP:START -->\n@protocol.md\n<!-- CAAMP:END -->');
    const result = await resolveInstructionDelivery('@hub.md', dir);
    expect(result.findings).toEqual([]);
    expect(result.liveEvaluation).toBe('unverified');
    for (const required of ['current evidence', '`UNKNOWN`', 'repair matrix', '**Verify.**', 'sourced successors']) {
      expect(result.content).toContain(required);
    }
    expect(result.content).not.toContain('@protocol.md');
    expect(result.content).not.toContain('<!-- CAAMP:START -->');
  });

  it('reports broken references and cycles without hiding them as healthy', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'a.md'), '@b.md');
    await writeFile(join(dir, 'b.md'), '@a.md\n@missing.md');
    const result = await resolveInstructionDelivery('@a.md', dir);
    expect(result.findings.map(f => f.kind)).toEqual(['cycle', 'missing-reference']);
  });

  it('deduplicates shared sources and preserves fenced examples', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'a.md'), 'Current authority');
    const result = await resolveInstructionDelivery('@a.md\n@a.md\n```\n@missing.md\n```', dir);
    expect(result.content.match(/Current authority/g)).toHaveLength(1);
    expect(result.content).toContain('@missing.md');
    expect(result.findings.map(f => f.kind)).toEqual(['duplicate']);
  });
});


describe('managed bootstrap writes', () => {
  it('reports an absent generated bridge while delivering the available protocol', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'protocol.md'), 'Check authority and coverage before acting.');
    const result = await ensureProviderInstructionFile('codex', dir, {
      references: ['@protocol.md', '@.cleo/memory-bridge.md'],
    });
    const content = await readFile(result.filePath, 'utf8');
    expect(content).toContain('Check authority and coverage before acting.');
    expect(content).toContain('Project memory bridge unavailable.');
    expect(content).toContain('cleo memory digest');
    expect(content).not.toContain('@.cleo/memory-bridge.md');
    await expect(readFile(join(dir, '.cleo', 'memory-bridge.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('embeds by default, refreshes changed sources, and preserves authored content', async () => {
    const dir = await fixture();
    const destination = join(dir, 'AGENTS.md');
    await writeFile(destination, '# User instructions\nKeep these.\n');
    await writeFile(join(dir, 'source.md'), 'Current sourced guidance');
    const first = await ensureProviderInstructionFile('codex', dir, {references: ['@source.md']});
    expect(await readFile(destination, 'utf8')).toContain('Current sourced guidance');
    expect(await readFile(destination, 'utf8')).toContain('# User instructions\nKeep these.');
    expect(first.action).toBe('added');
    expect((await ensureProviderInstructionFile('codex', dir, {references: ['@source.md']})).action).toBe('intact');
    await writeFile(join(dir, 'source.md'), 'Corrected sourced guidance');
    expect((await ensureProviderInstructionFile('codex', dir, {references: ['@source.md']})).action).toBe('updated');
    expect(await readFile(destination, 'utf8')).not.toContain('Current sourced guidance');
  });

  it.each(['cycle', 'oversized', 'missing'])('refuses %s without modifying destination', async (defect) => {
    const dir = await fixture();
    const destination = join(dir, 'AGENTS.md');
    const original = '# User instructions\nKeep these.\n';
    await writeFile(destination, original);
    if (defect === 'cycle') await writeFile(join(dir, 'source.md'), '@source.md');
    if (defect === 'oversized') await writeFile(join(dir, 'source.md'), 'x'.repeat(524289));
    await expect(ensureProviderInstructionFile('kimi', dir, {references: ['@source.md']})).rejects.toThrow('Instruction delivery failed');
    expect(await readFile(destination, 'utf8')).toBe(original);
  });
});


it('detects source drift in an already embedded bootstrap without relying on provider expansion', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'source.md'), 'Earlier authority');
  const original = await resolveInstructionDelivery('@source.md', dir);
  await writeFile(join(dir, 'AGENTS.md'), original.content);
  await writeFile(join(dir, 'source.md'), 'Sourced corrected authority');
  const checked = await resolveInstructionDelivery('@AGENTS.md', dir);
  expect(checked.findings).toContainEqual(expect.objectContaining({kind: 'stale', path: join(dir, 'source.md')}));
});

/**
 * Unit tests for `core/mcp/remover` — removeMcpServer and
 * removeMcpServerFromAll.
 *
 * @remarks
 * Exercises the idempotency contract (missing entries return
 * `removed: false` rather than throwing) and the all-providers fan-out.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installMcpServer,
  listMcpServers,
  removeMcpServer,
  removeMcpServerFromAll,
} from '../../src/core/mcp/index.js';
import { getProvider, resetRegistry } from '../../src/core/registry/providers.js';

let projectDir: string;

beforeEach(async () => {
  resetRegistry();
  const unique = `caamp-mcp-remover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = join(tmpdir(), unique);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
});

describe('removeMcpServer', () => {
  it('removes an installed entry and reports removed=true', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    await installMcpServer(
      provider,
      'github',
      { command: 'npx', args: ['-y', '@mcp/github'] },
      { scope: 'project', projectDir },
    );
    const result = await removeMcpServer(provider, 'github', { scope: 'project', projectDir });
    expect(result.removed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.providerId).toBe('claude-code');
    expect(result.serverName).toBe('github');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries.find((e) => e.name === 'github')).toBeUndefined();
  });

  it('returns removed=false with reason="file-missing" when no config exists', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const result = await removeMcpServer(provider, 'ghost', { scope: 'project', projectDir });
    expect(result.removed).toBe(false);
    expect(result.reason).toBe('file-missing');
  });

  it('returns removed=false with reason="entry-missing" when the file exists but the entry does not', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'a' } } }), 'utf8');
    const result = await removeMcpServer(provider, 'ghost', { scope: 'project', projectDir });
    expect(result.removed).toBe(false);
    expect(result.reason).toBe('entry-missing');
  });

  it('returns removed=false with reason="no-mcp-capability" for pi', async () => {
    const provider = getProvider('pi');
    if (provider === undefined) throw new Error('pi missing from registry');
    const result = await removeMcpServer(provider, 'github', { scope: 'project', projectDir });
    expect(result.removed).toBe(false);
    expect(result.reason).toBe('no-mcp-capability');
    expect(result.sourcePath).toBeNull();
  });

  it('preserves unrelated entries when removing one', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          a: { command: 'cmd-a' },
          b: { command: 'cmd-b' },
          c: { command: 'cmd-c' },
        },
      }),
      'utf8',
    );
    await removeMcpServer(provider, 'b', { scope: 'project', projectDir });
    const entries = await listMcpServers(provider, 'project', projectDir);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a', 'c']);
  });
});

describe('removeMcpServerFromAll', () => {
  it('returns one result per MCP-capable provider in the registry', async () => {
    const results = await removeMcpServerFromAll('ghost', { scope: 'project', projectDir });
    expect(results.length).toBeGreaterThan(1);
    // Every result should refer to an MCP-capable provider id.
    for (const r of results) {
      const p = getProvider(r.providerId);
      expect(p?.capabilities.mcp).not.toBeNull();
    }
  });

  it('reports removed=true for the matching provider only', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    await installMcpServer(
      provider,
      'github',
      { command: 'npx' },
      { scope: 'project', projectDir },
    );
    const results = await removeMcpServerFromAll('github', { scope: 'project', projectDir });
    const claudeResult = results.find((r) => r.providerId === 'claude-code');
    expect(claudeResult?.removed).toBe(true);
    // Other providers had no config file, so they should report removed=false.
    const otherRemovals = results.filter((r) => r.providerId !== 'claude-code');
    expect(otherRemovals.every((r) => r.removed === false)).toBe(true);
  });

  it('is idempotent — calling twice does not throw', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    await installMcpServer(
      provider,
      'github',
      { command: 'npx' },
      { scope: 'project', projectDir },
    );
    await removeMcpServerFromAll('github', { scope: 'project', projectDir });
    // Second call should not throw and should report removed=false everywhere.
    const second = await removeMcpServerFromAll('github', { scope: 'project', projectDir });
    expect(second.every((r) => r.removed === false)).toBe(true);
  });
});

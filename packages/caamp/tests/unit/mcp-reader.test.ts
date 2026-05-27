/**
 * Unit tests for `core/mcp/reader` — listMcpServers, listAllMcpServers,
 * detectMcpInstallations, resolveMcpConfigPath.
 *
 * @remarks
 * Uses the real provider registry (no mocks) and writes fixture files
 * into a temporary project directory so the format-agnostic readers
 * exercise the same code paths the CLI does.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectMcpInstallations,
  listAllMcpServers,
  listMcpServers,
  resolveMcpConfigPath,
} from '../../src/core/mcp/index.js';
import { getProvider, resetRegistry } from '../../src/core/registry/providers.js';

let projectDir: string;

beforeEach(async () => {
  resetRegistry();
  const unique = `caamp-mcp-reader-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = join(tmpdir(), unique);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
});

describe('resolveMcpConfigPath', () => {
  it('returns the project-scoped config path for claude-code', () => {
    const provider = getProvider('claude-code');
    expect(provider).toBeDefined();
    if (provider === undefined) return;
    const path = resolveMcpConfigPath(provider, 'project', projectDir);
    expect(path).toBe(join(projectDir, '.mcp.json'));
  });

  it('returns the global config path for claude-code', () => {
    const provider = getProvider('claude-code');
    expect(provider).toBeDefined();
    if (provider === undefined) return;
    const path = resolveMcpConfigPath(provider, 'global');
    expect(path).not.toBeNull();
    expect(path).toContain('.claude.json');
  });
});

describe('listMcpServers', () => {
  it('returns [] when the config file does not exist', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries).toEqual([]);
  });

  it('parses a JSON config and returns one entry per server', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@mcp/github'] },
          fs: { command: 'node', args: ['./fs.js'] },
        },
      }),
      'utf8',
    );
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['fs', 'github']);
    const github = entries.find((e) => e.name === 'github');
    expect(github?.providerId).toBe('claude-code');
    expect(github?.providerName).toBe('Claude Code');
    expect(github?.scope).toBe('project');
    expect(github?.configPath).toBe(file);
    expect(github?.config).toEqual({ command: 'npx', args: ['-y', '@mcp/github'] });
  });

  it('returns [] when the config file is empty', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(file, '', 'utf8');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries).toEqual([]);
  });

  it('returns [] when the config file is malformed', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(file, '{this is not valid json', 'utf8');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries).toEqual([]);
  });

  it('returns [] when the config file has no servers section', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(file, JSON.stringify({ otherKey: { foo: 1 } }), 'utf8');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries).toEqual([]);
  });
});

describe('listAllMcpServers', () => {
  it('returns a map keyed by provider id with one entry per MCP-capable provider', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { github: { command: 'npx' } } }),
      'utf8',
    );
    const map = await listAllMcpServers('project', projectDir);
    // claude-code must be present and have one entry
    const claudeEntries = map.get('claude-code');
    expect(claudeEntries).toBeDefined();
    expect(claudeEntries?.length).toBe(1);
    // every key in the map must point at an MCP-capable provider
    for (const id of map.keys()) {
      const p = getProvider(id);
      expect(p).toBeDefined();
      expect(p?.capabilities.mcp).not.toBeNull();
    }
  });

  it('skips providers without an MCP capability', async () => {
    const map = await listAllMcpServers('project', projectDir);
    // pi is not MCP-capable, so it must NOT be in the map
    expect(map.has('pi')).toBe(false);
  });
});

describe('detectMcpInstallations', () => {
  it('reports exists=false and serverCount=null for missing config files', async () => {
    const entries = await detectMcpInstallations('project', projectDir);
    const claudeEntry = entries.find((e) => e.providerId === 'claude-code');
    expect(claudeEntry).toBeDefined();
    if (claudeEntry === undefined) return;
    expect(claudeEntry.exists).toBe(false);
    expect(claudeEntry.serverCount).toBeNull();
    expect(claudeEntry.lastModified).toBeNull();
  });

  it('reports exists=true and an accurate serverCount for existing files', async () => {
    const file = join(projectDir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          a: { command: 'a' },
          b: { command: 'b' },
          c: { command: 'c' },
        },
      }),
      'utf8',
    );
    const entries = await detectMcpInstallations('project', projectDir);
    const claudeEntry = entries.find((e) => e.providerId === 'claude-code');
    expect(claudeEntry).toBeDefined();
    if (claudeEntry === undefined) return;
    expect(claudeEntry.exists).toBe(true);
    expect(claudeEntry.serverCount).toBe(3);
    expect(claudeEntry.lastModified).not.toBeNull();
  });

  it('only enumerates MCP-capable providers', async () => {
    const entries = await detectMcpInstallations('project', projectDir);
    for (const entry of entries) {
      const provider = getProvider(entry.providerId);
      expect(provider?.capabilities.mcp).not.toBeNull();
    }
  });
});

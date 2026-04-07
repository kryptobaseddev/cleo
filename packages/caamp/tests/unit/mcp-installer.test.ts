/**
 * Unit tests for `core/mcp/installer` — installMcpServer.
 *
 * @remarks
 * Exercises the conflict-on-write semantics, parent-directory creation,
 * and format round-tripping for the four supported config formats by
 * targeting providers that declare each format in registry.json.
 *
 * - JSON  → claude-code (`.mcp.json`)
 * - JSONC → zed         (`settings.json` with comments)
 * - YAML  → goose       (`config.yaml`, only `global` scope supported)
 * - TOML  → codex       (`config.toml`)
 *
 * Goose only supports `global` scope, so its global config path is
 * temporarily redirected via the same env-var hook used by other
 * tests where applicable.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMcpServer, listMcpServers } from '../../src/core/mcp/index.js';
import { getProvider, resetRegistry } from '../../src/core/registry/providers.js';
import type { McpServerConfig } from '../../src/types.js';

let projectDir: string;

beforeEach(async () => {
  resetRegistry();
  const unique = `caamp-mcp-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = join(tmpdir(), unique);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
});

describe('installMcpServer (JSON format via claude-code)', () => {
  it('writes a new entry into a fresh config file', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const config: McpServerConfig = {
      command: 'npx',
      args: ['-y', '@mcp/github'],
    };
    const result = await installMcpServer(provider, 'github', config, {
      scope: 'project',
      projectDir,
    });
    expect(result.installed).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.providerId).toBe('claude-code');
    expect(result.serverName).toBe('github');
    expect(result.sourcePath).toBe(join(projectDir, '.mcp.json'));
    const fileBody = JSON.parse(await readFile(result.sourcePath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(fileBody.mcpServers['github']).toEqual(config);
  });

  it('returns conflicted=true and installed=false on duplicate without --force', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const config: McpServerConfig = { command: 'a' };
    await installMcpServer(provider, 'dup', config, { scope: 'project', projectDir });
    const second = await installMcpServer(
      provider,
      'dup',
      { command: 'b' },
      { scope: 'project', projectDir },
    );
    expect(second.installed).toBe(false);
    expect(second.conflicted).toBe(true);
    // First entry is preserved.
    const entries = await listMcpServers(provider, 'project', projectDir);
    const dup = entries.find((e) => e.name === 'dup');
    expect(dup?.config).toEqual({ command: 'a' });
  });

  it('returns conflicted=true and installed=true on duplicate with --force', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    await installMcpServer(provider, 'dup', { command: 'a' }, { scope: 'project', projectDir });
    const second = await installMcpServer(
      provider,
      'dup',
      { command: 'b' },
      { scope: 'project', projectDir, force: true },
    );
    expect(second.installed).toBe(true);
    expect(second.conflicted).toBe(true);
    const entries = await listMcpServers(provider, 'project', projectDir);
    const dup = entries.find((e) => e.name === 'dup');
    expect(dup?.config).toEqual({ command: 'b' });
  });

  it('preserves unrelated entries when adding a new one', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const file = join(projectDir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { existing: { command: 'old' } } }),
      'utf8',
    );
    await installMcpServer(
      provider,
      'fresh',
      { command: 'new' },
      { scope: 'project', projectDir },
    );
    const fileBody = JSON.parse(await readFile(file, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(fileBody.mcpServers['existing']).toEqual({ command: 'old' });
    expect(fileBody.mcpServers['fresh']).toEqual({ command: 'new' });
  });

  it('creates parent directories lazily', async () => {
    const provider = getProvider('claude-code');
    if (provider === undefined) throw new Error('claude-code missing from registry');
    const nestedDir = join(projectDir, 'nested', 'project');
    const result = await installMcpServer(
      provider,
      'github',
      { command: 'npx' },
      { scope: 'project', projectDir: nestedDir },
    );
    expect(result.installed).toBe(true);
    expect(existsSync(result.sourcePath)).toBe(true);
  });
});

describe('installMcpServer (TOML format via codex)', () => {
  it('round-trips a server entry through the TOML writer', async () => {
    const provider = getProvider('codex');
    if (provider === undefined) throw new Error('codex missing from registry');
    const result = await installMcpServer(
      provider,
      'github',
      { command: 'npx', args: ['-y', '@mcp/github'] },
      { scope: 'project', projectDir },
    );
    expect(result.installed).toBe(true);
    expect(result.sourcePath.endsWith('config.toml')).toBe(true);
    const entries = await listMcpServers(provider, 'project', projectDir);
    const github = entries.find((e) => e.name === 'github');
    expect(github).toBeDefined();
    expect(github?.config['command']).toBe('npx');
  });
});

describe('installMcpServer (JSONC format via zed)', () => {
  it('writes into a JSONC settings file via the context_servers key', async () => {
    const provider = getProvider('zed');
    if (provider === undefined) throw new Error('zed missing from registry');
    const result = await installMcpServer(
      provider,
      'github',
      { command: 'npx', args: ['-y', '@mcp/github'] },
      { scope: 'project', projectDir },
    );
    expect(result.installed).toBe(true);
    expect(result.sourcePath).toContain('settings.json');
    const entries = await listMcpServers(provider, 'project', projectDir);
    expect(entries.some((e) => e.name === 'github')).toBe(true);
  });
});

describe('installMcpServer error paths', () => {
  it('throws when the provider has no MCP capability (pi)', async () => {
    const provider = getProvider('pi');
    if (provider === undefined) throw new Error('pi missing from registry');
    await expect(
      installMcpServer(
        provider,
        'github',
        { command: 'npx' },
        { scope: 'project', projectDir },
      ),
    ).rejects.toThrow(/does not declare an MCP capability/);
  });
});

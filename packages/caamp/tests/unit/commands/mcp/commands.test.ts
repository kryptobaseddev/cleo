/**
 * Integration-style tests for the `caamp mcp <verb>` commands.
 *
 * @remarks
 * Construct fresh Commander programs with just the `mcp` command
 * group attached and drive each verb through `parseAsync`. Stdout,
 * stderr, and `process.exit` are spied so the LAFS envelope output
 * can be parsed and asserted against in isolation.
 *
 * Each test runs against a temporary project directory and uses the
 * `claude-code` provider's `--scope project` mode (which writes
 * `<projectDir>/.mcp.json`) to keep the assertions provider-agnostic.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMcpCommands } from '../../../../src/commands/mcp/index.js';
import { resetDetectionCache } from '../../../../src/core/registry/detection.js';
import { resetRegistry } from '../../../../src/core/registry/providers.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Build a fresh Commander program with just the `mcp` group attached,
 * swap stdout/stderr/process.exit with capture hooks, and run argv
 * through `parseAsync`.
 */
async function runMcp(argv: string[]): Promise<CapturedOutput> {
  const captured: CapturedOutput = { stdout: [], stderr: [], exitCode: null };
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    captured.stdout.push(
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    captured.stderr.push(
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
  });
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number | string | null | undefined) => {
      captured.exitCode = typeof code === 'number' ? code : code === undefined ? null : Number(code);
      throw new Error(`__caamp_test_exit_${captured.exitCode ?? '0'}`);
    }) as unknown as (code?: number | string | null | undefined) => never);

  const program = new Command();
  program.exitOverride();
  registerMcpCommands(program);
  try {
    await program.parseAsync(['node', 'caamp', ...argv]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith('__caamp_test_exit_')) {
      captured.stderr.push(message);
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return captured;
}

function parseEnvelope(lines: string[]): unknown {
  const joined = lines.join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}

let projectDir: string;

beforeEach(async () => {
  resetRegistry();
  resetDetectionCache();
  const unique = `caamp-mcp-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = join(tmpdir(), unique);
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
  resetDetectionCache();
});

describe('caamp mcp install', () => {
  it('writes a new server entry from inline command + args', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: {
        installed: boolean;
        sourcePath: string;
        config: { command: string; args: string[] };
      };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.installed).toBe(true);
    expect(env.result.sourcePath).toBe(join(projectDir, '.mcp.json'));
    expect(env.result.config.command).toBe('npx');
    expect(env.result.config.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(existsSync(env.result.sourcePath)).toBe(true);
    const fileBody = JSON.parse(await readFile(env.result.sourcePath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(fileBody.mcpServers['github']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
  });

  it('attaches --env KEY=VALUE pairs into the env field', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--env',
      'GITHUB_TOKEN=ghp_xxx',
      '--env',
      'LOG_LEVEL=debug',
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { config: { env: Record<string, string> } };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.config.env).toEqual({
      GITHUB_TOKEN: 'ghp_xxx',
      LOG_LEVEL: 'debug',
    });
  });

  it('reads a server config from --from <json file>', async () => {
    const fromPath = join(projectDir, 'spec.json');
    await writeFile(
      fromPath,
      JSON.stringify({ command: 'node', args: ['./server.js'], env: { FOO: 'bar' } }),
      'utf8',
    );
    const out = await runMcp([
      'mcp',
      'install',
      'fromfile',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--from',
      fromPath,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { config: { command: string; args: string[]; env: Record<string, string> } };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.config.command).toBe('node');
    expect(env.result.config.args).toEqual(['./server.js']);
    expect(env.result.config.env).toEqual({ FOO: 'bar' });
  });

  it('errors with E_CONFLICT_VERSION when entry exists without --force', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as {
      success: boolean;
      error: { code: string; category: string };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(false);
    expect(env.error.code).toBe('E_CONFLICT_VERSION');
    expect(env.error.category).toBe('CONFLICT');
  });

  it('overwrites existing entry when --force is set', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/old',
    ]);
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--force',
      '--',
      'npx',
      '-y',
      '@mcp/new',
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { installed: boolean; conflicted: boolean };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.installed).toBe(true);
    expect(env.result.conflicted).toBe(true);
  });

  it('errors with E_NOT_FOUND_RESOURCE when --provider is unknown', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'definitely-not-a-real-provider',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/test',
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_NOT_FOUND_RESOURCE');
  });

  it('errors with E_VALIDATION_SCHEMA when --provider is omitted', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/test',
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_VALIDATION_SCHEMA');
  });

  it('errors with E_VALIDATION_SCHEMA when --env value is malformed', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--env',
      'NO_EQUALS_SIGN',
      '--',
      'npx',
      '-y',
      '@mcp/test',
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_VALIDATION_SCHEMA');
  });

  it('errors with E_VALIDATION_SCHEMA when neither --from nor inline command is given', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_VALIDATION_SCHEMA');
  });

  it('errors with E_NOT_FOUND_RESOURCE when --from path is missing', async () => {
    const out = await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--from',
      join(projectDir, 'does-not-exist.json'),
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_NOT_FOUND_RESOURCE');
  });
});

describe('caamp mcp list', () => {
  it('returns count=0 and an empty entries array for an empty config', async () => {
    const out = await runMcp([
      'mcp',
      'list',
      '--provider',
      'claude-code',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { count: number; entries: unknown[] };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.count).toBe(0);
    expect(env.result.entries).toEqual([]);
  });

  it('lists installed servers for a single provider', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    await runMcp([
      'mcp',
      'install',
      'fs',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/fs',
    ]);
    const out = await runMcp([
      'mcp',
      'list',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { count: number; entries: Array<{ name: string }> };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.result.count).toBe(2);
    const names = env.result.entries.map((e) => e.name).sort();
    expect(names).toEqual(['fs', 'github']);
  });

  it('errors with E_NOT_FOUND_RESOURCE for an unknown --provider', async () => {
    const out = await runMcp([
      'mcp',
      'list',
      '--provider',
      'not-a-real-provider',
      '--project-dir',
      projectDir,
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_NOT_FOUND_RESOURCE');
  });

  it('without --provider, fans out across all MCP-capable providers', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    const out = await runMcp([
      'mcp',
      'list',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { providers: Record<string, number>; count: number };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.providers['claude-code']).toBe(1);
    expect(env.result.count).toBeGreaterThanOrEqual(1);
  });
});

describe('caamp mcp remove', () => {
  it('removes an installed entry and reports removed=true', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    const out = await runMcp([
      'mcp',
      'remove',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { removed: boolean; reason: string | null };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.removed).toBe(true);
    expect(env.result.reason).toBeNull();
  });

  it('is idempotent when the entry is missing', async () => {
    const out = await runMcp([
      'mcp',
      'remove',
      'ghost',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { removed: boolean; reason: string | null };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.removed).toBe(false);
    // file-missing or entry-missing — both are valid no-op outcomes
    expect(['file-missing', 'entry-missing']).toContain(env.result.reason);
  });

  it('errors when neither --provider nor --all-providers is set', async () => {
    const out = await runMcp([
      'mcp',
      'remove',
      'github',
      '--project-dir',
      projectDir,
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_VALIDATION_SCHEMA');
  });

  it('errors when both --provider and --all-providers are set', async () => {
    const out = await runMcp([
      'mcp',
      'remove',
      'github',
      '--provider',
      'claude-code',
      '--all-providers',
      '--project-dir',
      projectDir,
    ]);
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as { error: { code: string } } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.error.code).toBe('E_VALIDATION_SCHEMA');
  });

  it('--all-providers reports a per-provider results array', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    const out = await runMcp([
      'mcp',
      'remove',
      'github',
      '--all-providers',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: {
        mode: string;
        removedCount: number;
        providersProbed: number;
        results: Array<{ providerId: string; removed: boolean }>;
      };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.mode).toBe('all-providers');
    expect(env.result.removedCount).toBeGreaterThanOrEqual(1);
    expect(env.result.providersProbed).toBeGreaterThan(1);
    const claudeResult = env.result.results.find((r) => r.providerId === 'claude-code');
    expect(claudeResult?.removed).toBe(true);
  });
});

describe('caamp mcp detect', () => {
  it('reports per-provider entries with exists/serverCount', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    const out = await runMcp([
      'mcp',
      'detect',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: {
        providersProbed: number;
        existingCount: number;
        totalServers: number;
        entries: Array<{
          providerId: string;
          exists: boolean;
          serverCount: number | null;
        }>;
      };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.success).toBe(true);
    expect(env.result.providersProbed).toBeGreaterThan(1);
    expect(env.result.existingCount).toBeGreaterThanOrEqual(1);
    const claudeEntry = env.result.entries.find((e) => e.providerId === 'claude-code');
    expect(claudeEntry?.exists).toBe(true);
    expect(claudeEntry?.serverCount).toBe(1);
  });

  it('--only-existing filters out providers with no config file', async () => {
    await runMcp([
      'mcp',
      'install',
      'github',
      '--provider',
      'claude-code',
      '--project-dir',
      projectDir,
      '--',
      'npx',
      '-y',
      '@mcp/github',
    ]);
    const out = await runMcp([
      'mcp',
      'detect',
      '--scope',
      'project',
      '--project-dir',
      projectDir,
      '--only-existing',
    ]);
    const env = parseEnvelope(out.stdout) as {
      success: boolean;
      result: { entries: Array<{ exists: boolean }> };
    } | null;
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.result.entries.every((e) => e.exists)).toBe(true);
  });
});

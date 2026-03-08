import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execMock, spawnMock, providerSupportsByIdMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  spawnMock: vi.fn(),
  providerSupportsByIdMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: execMock,
  spawn: spawnMock,
}));

vi.mock('@cleocode/caamp', () => ({
  providerSupportsById: providerSupportsByIdMock,
}));

import { buildOpenCodeAgentMarkdown, OpenCodeSpawnAdapter } from '../opencode-adapter.js';

describe('OpenCodeSpawnAdapter', () => {
  let testRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testRoot = await mkdtemp(join(tmpdir(), 'cleo-opencode-'));
    providerSupportsByIdMock.mockReturnValue(true);
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('builds OpenCode markdown agent content', () => {
    const content = buildOpenCodeAgentMarkdown(
      'CLEO task executor',
      '# Protocol\nFollow the CLEO rules.',
    );

    expect(content).toContain('description: "CLEO task executor"');
    expect(content).toContain('mode: subagent');
    expect(content).toContain('hidden: true');
    expect(content).toContain('# Protocol');
  });

  it('reports spawn availability when binary and provider capability exist', async () => {
    execMock.mockImplementation(
      (
        _cmd: string,
        callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: '/usr/bin/opencode', stderr: '' });
      },
    );

    const adapter = new OpenCodeSpawnAdapter();
    await expect(adapter.canSpawn()).resolves.toBe(true);
    expect(providerSupportsByIdMock).toHaveBeenCalledWith('opencode', 'spawn.supportsSubagents');
  });

  it('returns false from canSpawn when the binary is unavailable', async () => {
    execMock.mockImplementation((_cmd: string, callback: (err: Error | null) => void) => {
      callback(new Error('not found'));
    });

    const adapter = new OpenCodeSpawnAdapter();
    await expect(adapter.canSpawn()).resolves.toBe(false);
  });

  it('writes a project-local OpenCode agent and spawns with it', async () => {
    await mkdir(join(testRoot, 'agents', 'cleo-subagent'), { recursive: true });
    await writeFile(
      join(testRoot, 'agents', 'cleo-subagent', 'AGENT.md'),
      `---
name: cleo-subagent
description: CLEO task executor
---

# CLEO Base Protocol

Follow the manifest and completion rules.
`,
      'utf-8',
    );

    const child = {
      pid: 4242,
      unref: vi.fn(),
      on: vi.fn(),
    };
    spawnMock.mockReturnValue(child);

    const adapter = new OpenCodeSpawnAdapter();
    const result = await adapter.spawn({
      taskId: 'T123',
      protocol: 'implementation',
      prompt: 'Implement the feature.',
      provider: { id: 'opencode' } as never,
      options: { prompt: 'Implement the feature.' },
      workingDirectory: testRoot,
    });

    expect(result.status).toBe('running');
    expect(spawnMock).toHaveBeenCalledWith(
      'opencode',
      [
        'run',
        '--format',
        'json',
        '--agent',
        'cleo-subagent',
        '--title',
        'CLEO T123',
        'Implement the feature.',
      ],
      expect.objectContaining({
        cwd: testRoot,
        detached: true,
        stdio: 'ignore',
      }),
    );

    const generated = await readFile(
      join(testRoot, '.opencode', 'agent', 'cleo-subagent.md'),
      'utf-8',
    );
    expect(generated).toContain('mode: subagent');
    expect(generated).toContain('hidden: true');
    expect(generated).toContain('# CLEO Base Protocol');
  });

  it('falls back to the built-in general agent when no CLEO agent exists', async () => {
    const child = {
      pid: 5252,
      unref: vi.fn(),
      on: vi.fn(),
    };
    spawnMock.mockReturnValue(child);

    const adapter = new OpenCodeSpawnAdapter();
    const result = await adapter.spawn({
      taskId: 'T124',
      protocol: 'implementation',
      prompt: 'Do the work.',
      provider: { id: 'opencode' } as never,
      options: { prompt: 'Do the work.' },
      workingDirectory: testRoot,
    });

    expect(result.status).toBe('running');
    expect(spawnMock).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--agent', 'general', '--title', 'CLEO T124', 'Do the work.'],
      expect.objectContaining({
        cwd: testRoot,
      }),
    );
  });
});

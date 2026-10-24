/**
 * `cleo memory quarantine-auto-rows` at the CLI surface (T13951): the dry run
 * reports counts and a digest, an apply with mismatched approved counts is
 * refused, and contradictory flags are rejected before any store is touched.
 *
 * @task T13951
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cliOutput, cliError, projectRoot } = vi.hoisted(() => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  projectRoot: { current: '' },
}));

vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  cliOutput,
  cliError,
}));

vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: () => projectRoot.current,
}));

import { memoryCommand } from '../memory.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-quarantine-cli-'));
  projectRoot.current = join(dir, 'project');
  mkdirSync(join(projectRoot.current, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'home'));
  vi.stubEnv('CLEO_DIR', join(projectRoot.current, '.cleo'));
  vi.stubEnv('CLEO_ROOT', projectRoot.current);
  cliOutput.mockReset();
  cliError.mockReset();
});

afterEach(async () => {
  const { closeBrainDb } = await import('@cleocode/core/store/memory-sqlite');
  const { _resetDualScopeDbCache } = await import('@cleocode/core/store/dual-scope-db');
  closeBrainDb();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Run the subcommand with parsed args. */
async function run(args: Record<string, unknown>): Promise<void> {
  const subs =
    typeof memoryCommand.subCommands === 'function'
      ? await memoryCommand.subCommands()
      : memoryCommand.subCommands;
  const command = (subs as Record<string, CommandDef>)['quarantine-auto-rows'];
  await command?.run?.({ args, rawArgs: [], cmd: command } as Parameters<
    NonNullable<CommandDef['run']>
  >[0]);
}

describe('cleo memory quarantine-auto-rows (T13951)', () => {
  it('dry run reports counts and a digest; a mismatched --expect is refused', async () => {
    await run({});
    expect(cliError).not.toHaveBeenCalled();
    const report = cliOutput.mock.calls[0]?.[0] as {
      dryRun: boolean;
      digest: string;
      counts: { project: { patterns: { count: number } } };
    };
    expect(report.dryRun).toBe(true);
    expect(report.counts.project.patterns.count).toBe(0);
    expect(report.digest).toMatch(/^[a-f0-9]{16}$/);

    await run({
      apply: true,
      expect: 'project:patterns=5,project:observations=0,global:patterns=0,global:observations=0',
      'expect-digest': report.digest,
    });
    expect(cliError).toHaveBeenCalledWith(
      expect.stringContaining('project:patterns now matches 0 rows'),
      6,
      expect.objectContaining({ name: 'E_QUARANTINE_EXPECT_MISMATCH' }),
    );
  });

  it('rejects --restore with --apply, and --expect without --apply', async () => {
    await run({ apply: true, restore: '/tmp/receipt.json' });
    expect(cliError).toHaveBeenLastCalledWith(
      '--restore and --apply cannot be combined',
      6,
      expect.objectContaining({ name: 'E_INVALID_INPUT' }),
    );
    await run({ expect: 'project:patterns=0' });
    expect(cliError).toHaveBeenLastCalledWith(
      '--expect and --expect-digest only apply with --apply',
      6,
      expect.objectContaining({ name: 'E_INVALID_INPUT' }),
    );
    expect(cliOutput).not.toHaveBeenCalled();
  });
});

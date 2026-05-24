/**
 * Integration test: stdout = LAFS envelope only.
 *
 * Saga T9855 / E9.1 / T9928 — agents and shell pipelines downstream of
 * `cleo` MUST be able to `JSON.parse(stdout)` without log-line
 * contamination. This test spawns the built CLI as a real subprocess and
 * asserts that:
 *
 *   1. STDOUT parses cleanly as a single JSON object (the LAFS envelope).
 *   2. The parsed envelope has the canonical `success` + `meta.operation`
 *      shape declared by ADR-039.
 *   3. STDERR is unconstrained — Pino warnings, the `node:sqlite`
 *      ExperimentalWarning, daemon ticks, and other operational logging
 *      may appear there freely.
 *
 * The test deliberately spawns commands that do NOT require a populated
 * `.cleo/tasks.db` (`--version`, and `show <nonexistent-id>` which
 * returns an error envelope) so it remains hermetic and stable across
 * CI environments.
 *
 * @task T9928
 * @epic T9927
 * @saga T9855
 * @adr ADR-039
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);

/**
 * Absolute path to the built CLI bundle. Resolved from the test file so
 * the test works regardless of the cwd vitest is invoked under.
 *
 * `packages/cleo/__tests__/integration/stdout-envelope-only.test.ts`
 * → `packages/cleo/dist/cli/index.js`
 */
const CLI_BUNDLE = resolve(__filename, '..', '..', '..', 'dist', 'cli', 'index.js');

/**
 * Skip the suite when the bundle is not present (e.g. a fresh worktree
 * before `pnpm run build`). The suite is opt-in: CI always builds first,
 * so it always runs there.
 */
const HAS_BUNDLE = existsSync(CLI_BUNDLE);

/**
 * Spawn the CLI in a child Node process and capture stdout + stderr.
 *
 * Uses `--disable-warning=ExperimentalWarning` so the noisy `node:sqlite`
 * banner does not pollute stderr assertions in tests that want to
 * inspect what the CLI itself printed there.
 */
function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', CLI_BUNDLE, ...args],
    {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!HAS_BUNDLE)(
  'stdout discipline — single LAFS envelope, no log-line contamination',
  () => {
    it('cleo --version: stdout is exactly one JSON envelope', () => {
      const { status, stdout } = runCli(['--version']);

      expect(status).toBe(0);

      const parsed = JSON.parse(stdout) as { success: boolean; meta?: { operation?: string } };
      expect(parsed.success).toBe(true);
      expect(parsed.meta?.operation).toBe('cli.output');
    });

    it('cleo show <invalid-id>: stdout is exactly one JSON envelope (error envelope)', () => {
      const { stdout, status } = runCli(['show', 'T_NONEXISTENT_ID_T9928_TEST']);

      expect(status).not.toBe(0);

      const parsed = JSON.parse(stdout) as {
        success: boolean;
        error?: { codeName?: string };
        meta?: { operation?: string };
      };
      expect(parsed.success).toBe(false);
      expect(parsed.meta?.operation).toBe('tasks.show');
      expect(typeof parsed.error?.codeName).toBe('string');
    });

    it('stdout contains no [CLEO ...] log-prefix lines from daemon/logger sources', () => {
      const { stdout } = runCli(['--version']);

      const forbiddenPrefixes = [
        '[CLEO STUDIO]',
        '[CLEO DAEMON]',
        '[CLEO SENTIENT]',
        '[CLEO SENTIENT T2]',
        '[CLEO SENTIENT CURATOR]',
        '[CLEO SENTIENT HYGIENE]',
        '[LocalBackend]',
      ];
      for (const prefix of forbiddenPrefixes) {
        expect(stdout).not.toContain(prefix);
      }
    });

    it('stdout is a single line (one trailing newline, no interleaving)', () => {
      const { stdout } = runCli(['--version']);

      const trimmed = stdout.replace(/\n+$/, '');
      expect(trimmed.includes('\n')).toBe(false);
    });
  },
);

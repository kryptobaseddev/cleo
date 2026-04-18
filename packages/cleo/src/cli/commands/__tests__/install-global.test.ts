/**
 * Tests for `cleo install-global` command.
 *
 * Covers:
 *   1. Command is exported and has the correct name/description
 *   2. Dry-run mode calls bootstrapGlobalCleo with dryRun:true and does not error
 *   3. JSON output includes created[] and warnings[] keys
 *   4. Human output renders created items and warnings
 *
 * @task T929
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalCommand } from '../install-global.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBootstrap = vi.fn();

vi.mock('@cleocode/core/internal', () => ({
  bootstrapGlobalCleo: (...args: unknown[]) => mockBootstrap(...args),
}));

const mockCliOutput = vi.fn();

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
}));

// Suppress process.stdout.write in tests — we verify cliOutput instead.
const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke the install-global command with the given argument overrides.
 *
 * @param opts - CLI arg overrides
 */
async function invokeInstallGlobal(
  opts: { dryRun?: boolean; json?: boolean; human?: boolean; quiet?: boolean } = {},
): Promise<void> {
  await installGlobalCommand.run?.({
    args: {
      'dry-run': opts.dryRun ?? false,
      json: opts.json ?? false,
      human: opts.human ?? false,
      quiet: opts.quiet ?? false,
    },
    rawArgs: [],
    cmd: installGlobalCommand,
  } as Parameters<NonNullable<typeof installGlobalCommand.run>>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo install-global command (T929)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default bootstrap response — empty context
    mockBootstrap.mockResolvedValue({ created: [], warnings: [], isDryRun: false });
  });

  // ── 1. Command metadata ────────────────────────────────────────────────────

  describe('command metadata', () => {
    it('is exported with the correct name', () => {
      expect(installGlobalCommand.meta?.name).toBe('install-global');
    });

    it('description mentions bootstrap and postinstall', () => {
      const desc = installGlobalCommand.meta?.description ?? '';
      expect(desc).toMatch(/bootstrap/i);
      expect(desc).toMatch(/postinstall/i);
    });

    it('declares a --dry-run boolean arg', () => {
      const dryRunArg = (installGlobalCommand.args as Record<string, unknown>)?.['dry-run'];
      expect(dryRunArg).toBeDefined();
      expect((dryRunArg as { type: string }).type).toBe('boolean');
    });
  });

  // ── 2. Dry-run behaviour ───────────────────────────────────────────────────

  describe('dry-run mode', () => {
    it('calls bootstrapGlobalCleo with dryRun:true', async () => {
      await invokeInstallGlobal({ dryRun: true, quiet: true });

      expect(mockBootstrap).toHaveBeenCalledOnce();
      expect(mockBootstrap).toHaveBeenCalledWith({ dryRun: true });
    });

    it('does not throw when bootstrapGlobalCleo resolves', async () => {
      mockBootstrap.mockResolvedValue({
        created: ['~/.cleo → ~/.local/share/cleo (dir link)'],
        warnings: [],
        isDryRun: true,
      });

      await expect(invokeInstallGlobal({ dryRun: true, quiet: true })).resolves.toBeUndefined();
    });

    it('passes dryRun:true into the cliOutput payload', async () => {
      mockBootstrap.mockResolvedValue({ created: [], warnings: [], isDryRun: true });

      await invokeInstallGlobal({ dryRun: true, quiet: true });

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [{ dryRun: boolean }, unknown];
      expect(data.dryRun).toBe(true);
    });
  });

  // ── 3. JSON output shape ───────────────────────────────────────────────────

  describe('JSON output', () => {
    it('cliOutput receives created[] and warnings[] arrays', async () => {
      mockBootstrap.mockResolvedValue({
        created: ['item-a', 'item-b'],
        warnings: ['warn-1'],
        isDryRun: false,
      });

      await invokeInstallGlobal({ quiet: true });

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [
        { created: string[]; warnings: string[] },
        unknown,
      ];

      expect(data.created).toEqual(['item-a', 'item-b']);
      expect(data.warnings).toEqual(['warn-1']);
    });

    it('cliOutput metadata includes command:"install-global"', async () => {
      await invokeInstallGlobal({ quiet: true });

      const [, meta] = mockCliOutput.mock.calls[0] as [unknown, { command: string }];
      expect(meta.command).toBe('install-global');
    });
  });

  // ── 4. Human output ────────────────────────────────────────────────────────

  describe('human output', () => {
    it('writes created items to stdout in human mode', async () => {
      mockBootstrap.mockResolvedValue({
        created: ['templates/CLEO-INJECTION.md (refreshed)'],
        warnings: [],
        isDryRun: false,
      });

      await invokeInstallGlobal({ human: true });

      const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('templates/CLEO-INJECTION.md (refreshed)');
    });

    it('writes warning items to stdout in human mode', async () => {
      mockBootstrap.mockResolvedValue({
        created: [],
        warnings: ['No AI provider installations detected'],
        isDryRun: false,
      });

      await invokeInstallGlobal({ human: true });

      const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('No AI provider installations detected');
    });

    it('does not write to stdout in quiet mode', async () => {
      mockBootstrap.mockResolvedValue({
        created: ['something'],
        warnings: [],
        isDryRun: false,
      });

      stdoutSpy.mockClear();
      await invokeInstallGlobal({ human: true, quiet: true });

      // stdout.write should not have been called (quiet suppresses human render)
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  // ── 5. Normal (non-dry) run ────────────────────────────────────────────────

  describe('normal run', () => {
    it('calls bootstrapGlobalCleo with dryRun:false by default', async () => {
      await invokeInstallGlobal({ quiet: true });

      expect(mockBootstrap).toHaveBeenCalledWith({ dryRun: false });
    });

    it('message reflects action count', async () => {
      mockBootstrap.mockResolvedValue({
        created: ['a', 'b', 'c'],
        warnings: ['w1'],
        isDryRun: false,
      });

      await invokeInstallGlobal({ quiet: true });

      const [, meta] = mockCliOutput.mock.calls[0] as [unknown, { message: string }];
      expect(meta.message).toContain('3');
      expect(meta.message).toContain('1');
    });
  });
});

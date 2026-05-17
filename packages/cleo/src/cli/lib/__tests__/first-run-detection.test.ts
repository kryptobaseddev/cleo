/**
 * Unit tests for the first-run detection + setup-prompt helper (T9422).
 *
 * The detector reads three signals:
 *   1. Existence of the XDG global config (`config.json` under
 *      `getCleoPlatformPaths().config`).
 *   2. Whether the unified credential pool has any entries.
 *   3. Whether `process.env.ANTHROPIC_API_KEY` is set.
 *
 * Tests mock the platform-paths SSoT (`@cleocode/paths`) and the
 * credential pool (`@cleocode/core/llm/credential-pool.js`) and drive
 * the config file existence by writing into a per-test tmp directory.
 *
 * The prompter additionally checks `process.stdin.isTTY` and either
 * waits for Enter or times out after 10s — these tests stub stdin
 * with a minimal EventEmitter so the timer / data resolution can be
 * driven deterministically without actually opening a TTY.
 *
 * @task T9422
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-3)
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE importing the SUT so vitest hoists them
// above the dynamic imports inside the helper.
// ---------------------------------------------------------------------------

const mockGetCleoPlatformPaths = vi.fn();
vi.mock('@cleocode/paths', () => ({
  getCleoPlatformPaths: () => mockGetCleoPlatformPaths(),
}));

const mockList = vi.fn();
const mockGetCredentialPool = vi.fn(() => ({ list: mockList }));
vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => mockGetCredentialPool(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so the dynamic imports inside the SUT resolve to the
// mocked modules.
// ---------------------------------------------------------------------------

import { detectFirstRun, maybePromptFirstRun } from '../first-run-detection.js';

// ---------------------------------------------------------------------------
// Per-test scratch dir + env / stdin restoration helpers.
// ---------------------------------------------------------------------------

let scratchDir: string;
let originalEnvKey: string | undefined;
let originalStdin: typeof process.stdin;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'cleo-first-run-'));
  mockGetCleoPlatformPaths.mockReset().mockReturnValue({ config: scratchDir });
  mockList.mockReset().mockResolvedValue([]);
  mockGetCredentialPool.mockClear();

  originalEnvKey = process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];

  originalStdin = process.stdin;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  if (originalEnvKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalEnvKey;
  Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  stderrSpy.mockRestore();
});

/**
 * Install a stub stdin on `process.stdin`. The stub is an EventEmitter
 * with the methods the SUT uses (`on`, `removeListener`, `resume`,
 * `pause`) plus an `isTTY` field controllable per test.
 */
function installStubStdin(opts: { isTTY: boolean }): EventEmitter & {
  isTTY: boolean;
  resume: () => void;
  pause: () => void;
} {
  const ee = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    resume: () => void;
    pause: () => void;
  };
  ee.isTTY = opts.isTTY;
  ee.resume = vi.fn();
  ee.pause = vi.fn();
  Object.defineProperty(process, 'stdin', { value: ee, configurable: true });
  return ee;
}

// ---------------------------------------------------------------------------
// detectFirstRun
// ---------------------------------------------------------------------------

describe('detectFirstRun', () => {
  it('returns true when no config file, empty pool, and env key unset', async () => {
    // scratchDir has no config.json, mockList → [], env key deleted.
    const result = await detectFirstRun();
    expect(result).toBe(true);
  });

  it('returns false when ANTHROPIC_API_KEY env var is set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const result = await detectFirstRun();
    expect(result).toBe(false);
    // Pool/file checks must be short-circuited — env is cheapest signal.
    expect(mockGetCleoPlatformPaths).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns false when the global config.json exists', async () => {
    writeFileSync(join(scratchDir, 'config.json'), '{}', 'utf8');
    const result = await detectFirstRun();
    expect(result).toBe(false);
  });

  it('returns false when the credential pool has at least one entry', async () => {
    mockList.mockResolvedValueOnce([
      {
        provider: 'anthropic',
        label: 'default',
        source: 'manual',
        authType: 'api_key',
      },
    ]);
    const result = await detectFirstRun();
    expect(result).toBe(false);
  });

  it('treats an empty-string env key as unset', async () => {
    process.env['ANTHROPIC_API_KEY'] = '';
    const result = await detectFirstRun();
    expect(result).toBe(true);
  });

  it('treats credential-pool failures as "no entries"', async () => {
    mockList.mockRejectedValueOnce(new Error('store unavailable'));
    // No config, no env key, pool throws → still considered first-run.
    const result = await detectFirstRun();
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybePromptFirstRun
// ---------------------------------------------------------------------------

describe('maybePromptFirstRun', () => {
  it('writes the reminder to stderr when detection is true AND stdin is a TTY (Enter skips)', async () => {
    const stdin = installStubStdin({ isTTY: true });

    const prompt = maybePromptFirstRun();
    // Allow the async detection chain to settle before emitting Enter.
    await new Promise((r) => setImmediate(r));
    stdin.emit('data', Buffer.from('\n'));
    await prompt;

    expect(stderrSpy).toHaveBeenCalledOnce();
    const msg = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('CLEO is not configured');
    expect(msg).toContain('cleo setup');
    expect(msg).toContain('Press Enter to skip');
  });

  it('returns after the 10s timeout if Enter is never pressed', async () => {
    vi.useFakeTimers();
    try {
      installStubStdin({ isTTY: true });
      const prompt = maybePromptFirstRun();
      // Let the dynamic imports + detection promise chain settle so the
      // setTimeout is actually registered before we advance the clock.
      await vi.advanceTimersByTimeAsync(0);
      // Advancing 9.999s must NOT resolve the prompt yet.
      await vi.advanceTimersByTimeAsync(9_999);
      // Advance one more ms to fire the timeout.
      await vi.advanceTimersByTimeAsync(1);
      await prompt;
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('silently skips when stdin is not a TTY (CI / piped automation)', async () => {
    installStubStdin({ isTTY: false });
    await maybePromptFirstRun();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('no-ops when detection returns false (env key set)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-already-configured';
    installStubStdin({ isTTY: true });
    await maybePromptFirstRun();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('no-ops when detection returns false (pool has entries)', async () => {
    mockList.mockResolvedValueOnce([
      { provider: 'anthropic', label: 'default', source: 'env', authType: 'api_key' },
    ]);
    installStubStdin({ isTTY: true });
    await maybePromptFirstRun();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('never throws when detection itself throws', async () => {
    // Force the platform-paths mock to throw — this propagates through
    // dynamic import resolution back into detectFirstRun → maybePromptFirstRun.
    mockGetCleoPlatformPaths.mockImplementationOnce(() => {
      throw new Error('paths broke');
    });
    installStubStdin({ isTTY: true });
    await expect(maybePromptFirstRun()).resolves.toBeUndefined();
  });
});

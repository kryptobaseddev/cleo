/**
 * Regression tests for T337: add command description=title fallback removal.
 *
 * Before T337 the `add` command contained an `else` branch that silently set
 * `description = title` when neither `--description` nor `--desc` was
 * supplied.  This collided with the anti-hallucination guard in
 * `packages/core/src/tasks/add.ts:432-440` which throws
 * `E_VALIDATION_FAILED` when `description === title`, making every
 * `cleo add <title>` (without an explicit description) fail with exit 6.
 *
 * After the fix, omitting both flags leaves `description` undefined and
 * core short-circuits the guard (`!options.description` → skip check).
 *
 * These tests mock the dispatcher layer so they never touch the real
 * SQLite database. The addCommand.run function is invoked directly.
 *
 * @task T337
 * @epic T335
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../add.js';

// ---------------------------------------------------------------------------
// Mock the dispatch adapter so no real DB is touched
// ---------------------------------------------------------------------------

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

// Mock cliOutput so we don't need a full renderer stack
vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke addCommand.run with the given title and optional arg overrides.
 */
async function invokeAdd(title: string, extraArgs: Record<string, unknown> = {}): Promise<void> {
  const runFn = addCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { title, ...extraArgs }, rawArgs: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('add command — description=title fallback removal (T337)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: dispatcher returns success so the happy path runs
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T001', title: 'My task' },
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        timestamp: '',
        duration_ms: 0,
        source: 'cli',
        requestId: 'r1',
      },
    });
  });

  it('does NOT set description when neither --description nor --desc is provided', async () => {
    await invokeAdd('My task');

    expect(mockDispatchRaw).toHaveBeenCalledOnce();
    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    // description must be absent (undefined) — the key should not be set at all
    expect(params['description']).toBeUndefined();
  });

  it('sets description from --description flag', async () => {
    await invokeAdd('My task', { description: 'A different description' });

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['description']).toBe('A different description');
  });

  it('sets description from --desc alias', async () => {
    await invokeAdd('My task', { desc: 'Short desc' });

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['description']).toBe('Short desc');
  });

  it('--description takes priority over --desc when both are supplied', async () => {
    // add.ts checks args['description'] before args['desc'], so --description wins.
    await invokeAdd('My task', { description: 'Long form', desc: 'Short form' });

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['description']).toBe('Long form');
  });

  it('surfaces an error when the dispatcher returns E_VALIDATION_FAILED with description === title', async () => {
    // Simulate the anti-hallucination guard firing when an explicit --desc
    // that equals the title is passed
    mockDispatchRaw.mockResolvedValue({
      success: false,
      data: undefined,
      error: {
        code: 'E_VALIDATION_FAILED',
        exitCode: 6,
        message: 'description must be different from title (anti-hallucination rule)',
        fix: 'Provide a description that is meaningfully different from the title',
      },
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        timestamp: '',
        duration_ms: 0,
        source: 'cli',
        requestId: 'r2',
      },
    });

    // handleRawError is mocked — capture what was passed to it
    await invokeAdd('same', { desc: 'same' });

    expect(mockHandleRawError).toHaveBeenCalledOnce();
    const [response] = mockHandleRawError.mock.calls[0] as [
      { success: boolean; error: { code: string; message: string } },
    ];
    expect(response.success).toBe(false);
    expect(response.error.code).toBe('E_VALIDATION_FAILED');
    expect(response.error.message).toContain('anti-hallucination');
  });
});

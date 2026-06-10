/**
 * Tests for the `cleo init` first-run credential nudge (T11727 · AC2/AC3).
 *
 * Verifies that an EMPTY credential pool yields the `cleo login` nextStep (and,
 * on a TTY, the opt-in prompt that launches the front door), while a POPULATED
 * pool yields neither. The credential pool, front-door, and format context are
 * mocked so the test never touches the real pool or prompts a real terminal.
 *
 * @task T11727
 * @epic T11671
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the init module.
// ---------------------------------------------------------------------------

const mockPoolList = vi.fn<() => Promise<unknown[]>>(async () => []);
vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => ({ list: mockPoolList }),
}));

// The front-door is mocked so the prompt-accept branch never runs a real login.
const mockRunFrontDoor = vi.fn(async () => ({ validated: true, steps: [], provider: 'anthropic' }));
vi.mock('../login.js', () => ({
  runLoginFrontDoor: (...a: unknown[]) => mockRunFrontDoor(...(a as [])),
  emitLoginResult: vi.fn(),
  makeOAuthAcquirer: vi.fn(),
}));

// isHumanOutput() gates the prompt; control it per-test.
const mockIsHumanOutput = vi.fn(() => false);
vi.mock('../../renderers/index.js', () => ({
  isHumanOutput: () => mockIsHumanOutput(),
  cliError: vi.fn(),
  cliOutput: vi.fn(),
}));

// Avoid constructing a real readline interface.
const mockConfirm = vi.fn(async () => true);
const mockClose = vi.fn();
vi.mock('../../lib/readline-wizard-io.js', () => ({
  ReadlineWizardIO: class {
    confirm = mockConfirm;
    close = mockClose;
  },
}));

import { isCredentialPoolEmpty, maybeNudgeFirstRunLogin } from '../init.js';

describe('cleo init — first-run credential nudge (T11727)', () => {
  const originalTTY = process.stdin.isTTY;

  beforeEach(() => {
    mockPoolList.mockReset();
    mockPoolList.mockResolvedValue([]);
    mockRunFrontDoor.mockClear();
    mockIsHumanOutput.mockReturnValue(false);
    mockConfirm.mockClear();
    mockConfirm.mockResolvedValue(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true });
  });

  it('isCredentialPoolEmpty reports true on an empty pool, false when populated', async () => {
    mockPoolList.mockResolvedValue([]);
    expect(await isCredentialPoolEmpty()).toBe(true);
    mockPoolList.mockResolvedValue([{ provider: 'anthropic', label: 'x' }]);
    expect(await isCredentialPoolEmpty()).toBe(false);
  });

  it('AC2 — empty pool appends the cleo login nextStep (non-TTY: no prompt)', async () => {
    const nextSteps: Array<{ action: string; command: string }> = [];
    const launched = await maybeNudgeFirstRunLogin(nextSteps);
    expect(launched).toBe(false);
    expect(nextSteps.some((s) => s.command === 'cleo login')).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('AC3 — populated pool yields NO nextStep and NO prompt', async () => {
    mockPoolList.mockResolvedValue([{ provider: 'anthropic', label: 'x' }]);
    const nextSteps: Array<{ action: string; command: string }> = [];
    const launched = await maybeNudgeFirstRunLogin(nextSteps);
    expect(launched).toBe(false);
    expect(nextSteps).toHaveLength(0);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('AC3 — on a TTY the empty-pool nextStep becomes an opt-in prompt that launches the front door', async () => {
    mockIsHumanOutput.mockReturnValue(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(true);

    const nextSteps: Array<{ action: string; command: string }> = [];
    const launched = await maybeNudgeFirstRunLogin(nextSteps);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockRunFrontDoor).toHaveBeenCalledTimes(1);
    expect(launched).toBe(true);
    // nextStep still surfaced (data path) even though we launched.
    expect(nextSteps.some((s) => s.command === 'cleo login')).toBe(true);
  });

  it('AC3 — declining the TTY prompt does not launch the front door', async () => {
    mockIsHumanOutput.mockReturnValue(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockConfirm.mockResolvedValue(false);

    const nextSteps: Array<{ action: string; command: string }> = [];
    const launched = await maybeNudgeFirstRunLogin(nextSteps);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockRunFrontDoor).not.toHaveBeenCalled();
    expect(launched).toBe(false);
  });
});

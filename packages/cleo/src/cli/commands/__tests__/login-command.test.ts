/**
 * CLI wiring tests for the onboarding front door (T11725 · M3).
 *
 * The headline assertion (AC5): all THREE entry points — `cleo login`,
 * `cleo auth login`, and `cleo llm login` — dispatch to the SAME core engine
 * function ({@link runFrontDoorLogin}) with identical arguments. There is no
 * duplicated handler logic; the three commands are thin shells over the single
 * shared handler.
 *
 * Also verifies the thin-handler contract: `--json` yields the canonical LAFS
 * envelope, and a failed engine result exits non-zero.
 *
 * @task T11725
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type { OnboardingResult } from '@cleocode/contracts';
import type { CommandDef } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command modules.
// ---------------------------------------------------------------------------

const VALIDATED_RESULT: OnboardingResult = {
  steps: [
    { step: 'connect', status: 'ok', detail: 'connected' },
    { step: 'select', status: 'ok', detail: 'selected' },
    { step: 'bind', status: 'ok', detail: 'bound' },
    { step: 'validate', status: 'ok', detail: 'validated' },
  ],
  provider: 'anthropic',
  accountLabel: 'oauth-login',
  authMode: 'api_key',
  modelId: 'claude-test-1',
  profileName: 'default',
  validated: true,
};

const mockRunFrontDoorLogin = vi.fn(async (): Promise<OnboardingResult> => VALIDATED_RESULT);

vi.mock('@cleocode/core/llm/onboarding/front-door.js', () => ({
  runFrontDoorLogin: (...args: unknown[]) => mockRunFrontDoorLogin(...(args as [])),
}));

// The provider registry is consulted for auth-method inference; stub it so the
// api_key path is deterministic and no real catalog/registry is touched. The
// command lazy-imports the `/index.js` subpath.
vi.mock('@cleocode/core/llm/provider-registry/index.js', () => ({
  getProviderProfile: vi.fn(async () => ({ name: 'anthropic', oauth: undefined })),
  listProviders: vi.fn(async () => [{ name: 'anthropic' }, { name: 'openai' }]),
}));

// The OAuth browser flow must never run in the api_key path; stub it anyway.
vi.mock('../llm-login.js', () => ({
  runLlmLogin: vi.fn(async () => ({
    success: true,
    data: { provider: 'anthropic', label: 'oauth-login', expiresIn: 3600 },
  })),
}));

// `cleo llm` pulls the dispatch adapter (→ runtime gateway graph) for its other
// subcommands; the login subcommand under test does not use it. Stub it so the
// heavy graph never loads in this thin-wiring test.
vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn(async () => undefined),
}));

import { authLoginCommand } from '../auth/login.js';
import { llmCommand } from '../llm.js';
import { loginCommand } from '../login.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCmd(cmd: CommandDef, args: Record<string, unknown>): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('command has no run function');
  await runFn({ args, rawArgs: [], cmd: resolved });
}

async function getLlmLoginSub(): Promise<CommandDef> {
  const resolved =
    typeof llmCommand.subCommands === 'function'
      ? await llmCommand.subCommands()
      : llmCommand.subCommands;
  const sub = resolved?.['login'];
  if (!sub) throw new Error('cleo llm login subcommand not found');
  return sub as CommandDef;
}

function captureStdout(): { restore: () => void; lines: string[] } {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => (process.stdout.write = orig) };
}

// Common api_key args — avoids the interactive picker + OAuth path entirely.
const API_KEY_ARGS = {
  provider: 'anthropic',
  auth: 'api_key',
  'api-key': 'sk-test-1234',
  json: true,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo login front door (T11725)', () => {
  beforeEach(() => {
    mockRunFrontDoorLogin.mockClear();
    mockRunFrontDoorLogin.mockResolvedValue(VALIDATED_RESULT);
    process.env['CLEO_FORMAT'] = 'json';
  });

  it('AC5 — all three entry points dispatch to the SAME engine function', async () => {
    const cap = captureStdout();
    try {
      await runCmd(loginCommand, { ...API_KEY_ARGS });
      await runCmd(authLoginCommand, { ...API_KEY_ARGS });
      await runCmd(await getLlmLoginSub(), { ...API_KEY_ARGS });
    } finally {
      cap.restore();
    }

    // Exactly one engine call per entry point — no duplicated handler logic.
    expect(mockRunFrontDoorLogin).toHaveBeenCalledTimes(3);

    // Every call targeted the same provider with the same api_key flow.
    for (const call of mockRunFrontDoorLogin.mock.calls) {
      const [provider, opts] = call as [string, { authMode?: string; token?: string }];
      expect(provider).toBe('anthropic');
      expect(opts.authMode).toBe('api_key');
      expect(opts.token).toBe('sk-test-1234');
    }
  });

  it("AC4 — --json yields the canonical envelope with the engine's result", async () => {
    const cap = captureStdout();
    try {
      await runCmd(loginCommand, { ...API_KEY_ARGS });
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('');
    expect(out).toContain('"success"');
    const parsed = JSON.parse(out) as { success: boolean; data?: { validated?: boolean } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.validated).toBe(true);
  });

  it('exits non-zero when the engine result did not validate', async () => {
    mockRunFrontDoorLogin.mockResolvedValueOnce({
      ...VALIDATED_RESULT,
      validated: false,
      steps: [
        { step: 'connect', status: 'failed', detail: 'no credential', code: 'E_X' },
        { step: 'select', status: 'skipped', detail: 'skipped' },
        { step: 'bind', status: 'skipped', detail: 'skipped' },
        { step: 'validate', status: 'skipped', detail: 'skipped' },
      ],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const cap = captureStdout();
    try {
      await expect(runCmd(loginCommand, { ...API_KEY_ARGS })).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
  });
});

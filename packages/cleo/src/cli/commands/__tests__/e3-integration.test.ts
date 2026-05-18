/**
 * E3 closure — end-to-end integration tests for the E-CONFIG-AUTH-UNIFY
 * Phase 3 surface (T9428 — E-CONFIG-AUTH-UNIFY §5.3 T-E3-9).
 *
 * Unlike the wiring tests in `setup-command.test.ts` and `status-command.test.ts`
 * (which mock the wizard runner + `getCleoStatus()` so the *citty wiring* can
 * be exercised in isolation), this file exercises the **real** modules
 * end-to-end with `CLEO_HOME` redirected at a fresh tmpdir. Four
 * closure-grade scenarios cover the spec's E3 ACs:
 *
 *   1. `cleo setup --non-interactive --provider anthropic --api-key sk-ant-test-key`
 *      exits 0 and the new credential lands in the **real** credential pool
 *      (verified via `getCredentialPool().list()`).
 *
 *   2. `cleo status --json` outputs a valid `CleoStatus` envelope containing
 *      ALL six blocks (Identity / Credentials / Config / Session / Harness
 *      / Daemon) — proves the snapshot aggregator wires every dependency.
 *
 *   3. `cleo status` completes in under 2 seconds (spec §3.3 perf contract).
 *
 *   4. `cleo setup` LLM section writes to the pool, NOT to `config.json` —
 *      the cleaned global config MUST NOT contain the literal `apiKey` field
 *      or the raw key string. This is the strongest possible restatement of
 *      the E-CONFIG-AUTH-UNIFY invariant: "secrets live in the pool, never
 *      in config".
 *
 * Isolation strategy follows `auth-e2b.test.ts` — every test redirects
 * `CLEO_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `HOME` to fresh
 * tmpdirs so neither developer state nor parallel test workers collide.
 *
 * @task T9428
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-9 — closes Epic T9402)
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalConfigPath } from '@cleocode/core';
import {
  _resetCredentialPoolSingletonForTests,
  getCredentialPool,
} from '@cleocode/core/llm/credential-pool.js';
import { clearAnthropicKeyCache } from '@cleocode/core/llm/credentials.js';
import {
  _resetPermsWarningForTests,
  credentialsStorePath,
} from '@cleocode/core/llm/credentials-store.js';
import { StubWizardIO } from '@cleocode/core/setup';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { runSetup } from '../setup.js';
import { statusCommand } from '../status.js';

// ---------------------------------------------------------------------------
// Environment isolation — mirrors auth-e2b.test.ts
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_DIR',
  'CLEO_FORMAT',
  'CLEO_HARNESS',
  'CLEO_ROOT',
  'HOME',
];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/**
 * Point CLEO_HOME / XDG_DATA_HOME / XDG_CONFIG_HOME / HOME at fresh tmpdirs
 * so the on-disk credentials store and global config cannot collide with
 * developer data or parallel workers.
 */
function isolateHomes(): { cleoHome: string; home: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-e3-xdg-${stamp}`);
  const xdgConfig = join(tmpdir(), `cleo-e3-xdgcfg-${stamp}`);
  const home = join(tmpdir(), `cleo-e3-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(xdgConfig, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfig;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  return { cleoHome, home };
}

// ---------------------------------------------------------------------------
// CLI helpers — match status-command.test.ts wiring
// ---------------------------------------------------------------------------

function captureStdout(): { restore: () => void; lines: string[] } {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

async function runStatus(args: Record<string, unknown>): Promise<void> {
  const resolved = (
    typeof statusCommand === 'function'
      ? await (statusCommand as () => Promise<CommandDef>)()
      : statusCommand
  ) as CommandDef;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('status command has no run function');
  await runFn({ args, rawArgs: [], cmd: resolved });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
  // E3 status surface emits LAFS JSON via the global format context. Reset
  // to the documented default so individual tests can opt in/out.
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
});

// ---------------------------------------------------------------------------
// 1. `cleo setup --non-interactive --provider --api-key` → exits 0 + pool entry
// ---------------------------------------------------------------------------

describe('cleo setup — non-interactive adds credential to the real pool (T9428 §5.3 T-E3-9 AC1)', () => {
  it('exits 0 and persists the entry to the unified credential pool', async () => {
    const { cleoHome } = isolateHomes();

    // Pool MUST be empty before setup runs.
    const before = await getCredentialPool().list();
    expect(before).toHaveLength(0);

    // Drive the real wizard runner against a stub WizardIO (no readline).
    const io = new StubWizardIO();
    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-ant-test-key',
        label: 'e3-integration',
      },
      io,
    );

    // `ok: true` is the CLI's exit-0 contract.
    expect(result.ok).toBe(true);
    expect(result.sectionsRun).toContain('llm');
    // The llm-section summary records the pool write.
    expect(result.summary.join(' ')).toMatch(/anthropic:e3-integration to pool/i);

    // The credentials store MUST live under our isolated CLEO_HOME.
    expect(credentialsStorePath().startsWith(cleoHome)).toBe(true);

    // And the *real* pool list() now contains the entry.
    const after = await getCredentialPool().list();
    const anthropic = after.find((c) => c.provider === 'anthropic' && c.label === 'e3-integration');
    expect(anthropic).toBeDefined();
    expect(anthropic?.accessToken).toBe('sk-ant-test-key');
    expect(anthropic?.authType).toBe('api_key');
    expect(anthropic?.source).toBe('cli-input');
  });
});

// ---------------------------------------------------------------------------
// 2. `cleo status --json` → valid CleoStatus envelope with all six blocks
// ---------------------------------------------------------------------------

describe('cleo status --json — emits a complete CleoStatus envelope (T9428 §5.3 T-E3-9 AC2)', () => {
  it('outputs the LAFS envelope with all six top-level blocks', async () => {
    isolateHomes();
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    process.env['NO_COLOR'] = '1';

    const stdout = captureStdout();
    try {
      await runStatus({ json: true });
    } finally {
      stdout.restore();
    }

    // Parse the last line — LAFS envelope is the final stdout write.
    const lastLine = stdout.lines[stdout.lines.length - 1];
    expect(lastLine).toBeDefined();
    const env = JSON.parse(lastLine!);

    expect(env.success).toBe(true);
    expect(env.meta?.operation).toBe('status.show');

    // Every documented status block MUST be present (spec §3.3.6).
    const data = env.data as Record<string, unknown>;
    expect(data).toHaveProperty('identity');
    expect(data).toHaveProperty('credentials');
    expect(data).toHaveProperty('config');
    expect(data).toHaveProperty('session');
    expect(data).toHaveProperty('harness');
    expect(data).toHaveProperty('daemon');

    // Spot-check field-level invariants the spec calls out:
    //   - identity.loggedIn is a boolean
    //   - credentials is an array (may be empty)
    //   - config.globalConfigPath is a non-empty string
    //   - harness.active is one of pi | claude-code | unknown
    //   - daemon.killSwitchActive is a boolean
    const identity = data['identity'] as Record<string, unknown>;
    expect(typeof identity['loggedIn']).toBe('boolean');
    expect(Array.isArray(data['credentials'])).toBe(true);
    const config = data['config'] as Record<string, unknown>;
    expect(typeof config['globalConfigPath']).toBe('string');
    expect((config['globalConfigPath'] as string).length).toBeGreaterThan(0);
    const harness = data['harness'] as Record<string, unknown>;
    expect(['pi', 'claude-code', 'unknown']).toContain(harness['active']);
    const daemon = data['daemon'] as Record<string, unknown>;
    expect(typeof daemon['killSwitchActive']).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 3. `cleo status` completes in under 2 seconds (spec perf contract)
// ---------------------------------------------------------------------------

describe('cleo status — performance contract (T9428 §5.3 T-E3-9 AC3)', () => {
  it('completes in under 2000ms even with the real status aggregator', async () => {
    isolateHomes();
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    process.env['NO_COLOR'] = '1';

    const stdout = captureStdout();
    const t0 = Date.now();
    try {
      await runStatus({ json: true });
    } finally {
      stdout.restore();
    }
    const elapsed = Date.now() - t0;

    // Spec §3.3 perf contract: `getCleoStatus()` (and therefore the CLI
    // command that wraps it) must return in under 2 seconds. We assert
    // strictly against the documented bound — local machines run an
    // order of magnitude faster, so a regression that doubles cost still
    // catches.
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// 4. `cleo setup` LLM section writes to pool, NOT to config.json
// ---------------------------------------------------------------------------

describe('cleo setup — LLM section writes to pool not config.json (T9428 §5.3 T-E3-9 AC4)', () => {
  it('the global config.json MUST NOT contain the apiKey after non-interactive setup', async () => {
    isolateHomes();

    const io = new StubWizardIO();
    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-ant-secret-do-not-leak',
        label: 'no-leak-check',
      },
      io,
    );
    expect(result.ok).toBe(true);

    // The credential is in the pool (sanity check — confirms the call
    // actually ran end-to-end).
    const stored = await getCredentialPool().list();
    expect(
      stored.find((c) => c.provider === 'anthropic' && c.label === 'no-leak-check'),
    ).toBeDefined();

    // The global config path — if the file exists, it MUST NOT contain
    // either the literal `apiKey` field name or the raw secret. If the
    // file does NOT exist, that is *also* a pass for this AC (the wizard
    // never wrote to config at all). Both outcomes satisfy the invariant.
    const globalCfg = getGlobalConfigPath();
    if (existsSync(globalCfg)) {
      const raw = readFileSync(globalCfg, 'utf-8');
      expect(raw).not.toContain('apiKey');
      expect(raw).not.toContain('sk-ant-secret-do-not-leak');
    }
  });
});

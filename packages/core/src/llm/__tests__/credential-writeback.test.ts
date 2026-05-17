/**
 * Unit tests for `credential-writeback.ts` (E-CONFIG-AUTH-UNIFY E2a / T9411).
 *
 * Each test isolates the filesystem by setting `CLEO_HOME`, `XDG_DATA_HOME`,
 * and `HOME` to per-test temp directories before invoking the writeback.
 * This is the same pattern used by `credential-removal.test.ts`.
 *
 * The test surface covers:
 *
 * - default (cooperativeWriteBack=true): both files written
 * - Claude Code file absent + no consent: only CLEO file written
 * - Claude Code file absent + consent given: both files written
 * - cooperativeWriteBack=false: only CLEO file written
 * - scopes preservation: existing on-disk scopes carried forward
 * - scopes override: refresh-supplied scopes win over disk
 * - file permissions: 0o600 on both
 * - atomic write: no orphaned `.tmp` files left behind
 *
 * @task T9411
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBackAnthropicTokens } from '../credential-writeback.js';

// ---------------------------------------------------------------------------
// Environment isolation helpers
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['XDG_DATA_HOME', 'CLEO_HOME', 'HOME', 'USERPROFILE'];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

interface IsolatedHomes {
  cleoHome: string;
  home: string;
  claudeDir: string;
  claudePath: string;
  cleoPath: string;
}

function isolateHomes(): IsolatedHomes {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-wb-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-wb-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  const claudeDir = join(home, '.claude');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  // Windows fallback used by `os.homedir()` in some envs.
  process.env['USERPROFILE'] = home;
  return {
    cleoHome,
    home,
    claudeDir,
    claudePath: join(claudeDir, '.credentials.json'),
    cleoPath: join(cleoHome, 'anthropic-oauth.json'),
  };
}

/** Write a global config with the given auth block to `<cleoHome>/config.json`. */
function writeGlobalConfig(cleoHome: string, auth: Record<string, unknown>): void {
  const cfg = { auth };
  writeFileSync(join(cleoHome, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
}

/** Seed a Claude Code credential file with given scopes. */
function seedClaudeCodeFile(path: string, scopes?: string[]): void {
  const envelope = {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-old-claude-code',
      refreshToken: 'sk-ant-ort-old-claude-code',
      expiresAt: Date.now() + 60_000,
      ...(scopes !== undefined ? { scopes } : {}),
    },
  };
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

beforeEach(() => {
  saveEnv();
});

afterEach(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function refreshedTokens(): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} {
  return {
    accessToken: 'sk-ant-oat-NEW-tokens-from-refresh',
    refreshToken: 'sk-ant-ort-NEW-tokens-from-refresh',
    expiresAt: Date.now() + 3_600_000,
  };
}

// ---------------------------------------------------------------------------
// Always-write-CLEO behavior
// ---------------------------------------------------------------------------

describe('writeBackAnthropicTokens — CLEO file (always written)', () => {
  it('writes refreshed tokens to <CLEO_HOME>/anthropic-oauth.json', async () => {
    const { cleoPath, cleoHome } = isolateHomes();
    // Default: no explicit config — DEFAULTS govern. cooperativeWriteBack=true.
    // claudeCodeConsentGiven=false, Claude Code file absent → only CLEO file.
    writeGlobalConfig(cleoHome, {});

    const result = await writeBackAnthropicTokens(refreshedTokens());

    expect(result.written).toContain(cleoPath);
    expect(existsSync(cleoPath)).toBe(true);
    const written = JSON.parse(readFileSync(cleoPath, 'utf-8')) as {
      claudeAiOauth: Record<string, unknown>;
    };
    expect(written.claudeAiOauth.accessToken).toBe('sk-ant-oat-NEW-tokens-from-refresh');
    expect(written.claudeAiOauth.refreshToken).toBe('sk-ant-ort-NEW-tokens-from-refresh');
    expect(typeof written.claudeAiOauth.expiresAt).toBe('number');
  });

  it('persists CLEO file with mode 0o600', async () => {
    const { cleoPath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});

    await writeBackAnthropicTokens(refreshedTokens());

    const mode = statSync(cleoPath).mode & 0o777;
    // POSIX: must be exactly 0o600. Windows: chmod is best-effort, so we
    // accept 0o600 OR 0o666 (typical Windows file mode echoed back by
    // statSync). Either way we MUST NOT see group/other bits leaking.
    if (process.platform === 'win32') {
      expect(mode & 0o077).toBe(0); // no group/other bits
    } else {
      expect(mode).toBe(0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// Cooperative write-back — Claude Code file
// ---------------------------------------------------------------------------

describe('writeBackAnthropicTokens — Claude Code file (cooperative)', () => {
  it('writes BOTH files by default (cooperativeWriteBack=true) when claude file exists', async () => {
    const { cleoPath, claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    seedClaudeCodeFile(claudePath, ['user:inference']);

    const result = await writeBackAnthropicTokens(refreshedTokens());

    expect(result.written).toContain(cleoPath);
    expect(result.written).toContain(claudePath);
    expect(result.skipped).toEqual([]);

    const claudeWritten = JSON.parse(readFileSync(claudePath, 'utf-8')) as {
      claudeAiOauth: { accessToken: string; scopes?: string[] };
    };
    expect(claudeWritten.claudeAiOauth.accessToken).toBe('sk-ant-oat-NEW-tokens-from-refresh');
  });

  it('skips claude file when cooperativeWriteBack=false', async () => {
    const { cleoPath, claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, { cooperativeWriteBack: false });
    seedClaudeCodeFile(claudePath, ['user:inference']);

    const claudeBefore = readFileSync(claudePath, 'utf-8');
    const result = await writeBackAnthropicTokens(refreshedTokens());

    expect(result.written).toEqual([cleoPath]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe(claudePath);
    expect(result.skipped[0]?.reason).toContain('cooperativeWriteBack=false');
    // Original claude file MUST be untouched.
    expect(readFileSync(claudePath, 'utf-8')).toBe(claudeBefore);
  });

  it('skips claude file when absent AND no consent (does NOT create it)', async () => {
    const { cleoPath, claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, { cooperativeWriteBack: true });
    // Note: no seedClaudeCodeFile — file absent. consent default = false.
    expect(existsSync(claudePath)).toBe(false);

    const result = await writeBackAnthropicTokens(refreshedTokens());

    expect(result.written).toEqual([cleoPath]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe(claudePath);
    expect(result.skipped[0]?.reason).toContain('claude-code file absent');
    expect(existsSync(claudePath)).toBe(false);
  });

  it('creates claude file when absent BUT consent has been given', async () => {
    const { cleoPath, claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {
      cooperativeWriteBack: true,
      claudeCodeConsentGiven: true,
    });
    expect(existsSync(claudePath)).toBe(false);

    const result = await writeBackAnthropicTokens(refreshedTokens());

    expect(result.written).toContain(cleoPath);
    expect(result.written).toContain(claudePath);
    expect(result.skipped).toEqual([]);
    expect(existsSync(claudePath)).toBe(true);
  });

  it('persists claude file with mode 0o600', async () => {
    const { claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    seedClaudeCodeFile(claudePath, ['user:inference']);

    await writeBackAnthropicTokens(refreshedTokens());

    const mode = statSync(claudePath).mode & 0o777;
    if (process.platform === 'win32') {
      expect(mode & 0o077).toBe(0);
    } else {
      expect(mode).toBe(0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// Scopes preservation — critical for Claude Code >= 2.1.81
// ---------------------------------------------------------------------------

describe('writeBackAnthropicTokens — scopes preservation', () => {
  it('preserves existing claudeAiOauth.scopes when refresh omits scopes', async () => {
    const { claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    seedClaudeCodeFile(claudePath, ['user:inference']);

    await writeBackAnthropicTokens(refreshedTokens());

    const written = JSON.parse(readFileSync(claudePath, 'utf-8')) as {
      claudeAiOauth: { scopes?: string[] };
    };
    expect(written.claudeAiOauth.scopes).toEqual(['user:inference']);
  });

  it('overrides on-disk scopes with refresh-supplied scopes', async () => {
    const { claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    seedClaudeCodeFile(claudePath, ['user:inference']);

    await writeBackAnthropicTokens({
      ...refreshedTokens(),
      scopes: ['user:inference', 'user:profile'],
    });

    const written = JSON.parse(readFileSync(claudePath, 'utf-8')) as {
      claudeAiOauth: { scopes?: string[] };
    };
    expect(written.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile']);
  });

  it('omits scopes when neither disk nor refresh provide them', async () => {
    const { cleoPath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    // No claude file, no scopes on refresh, no prior cleo file.

    await writeBackAnthropicTokens(refreshedTokens());

    const written = JSON.parse(readFileSync(cleoPath, 'utf-8')) as {
      claudeAiOauth: Record<string, unknown>;
    };
    expect(written.claudeAiOauth).not.toHaveProperty('scopes');
  });

  it('preserves on-disk scopes even when the existing token is expired', async () => {
    const { claudePath, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    // Write an expired Claude Code file with scopes attached.
    const expiredEnvelope = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-expired',
        refreshToken: 'sk-ant-ort-expired',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:inference'],
      },
    };
    writeFileSync(claudePath, `${JSON.stringify(expiredEnvelope, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });

    await writeBackAnthropicTokens(refreshedTokens());

    const written = JSON.parse(readFileSync(claudePath, 'utf-8')) as {
      claudeAiOauth: { scopes?: string[] };
    };
    expect(written.claudeAiOauth.scopes).toEqual(['user:inference']);
  });
});

// ---------------------------------------------------------------------------
// Atomicity — no orphaned temp files left behind
// ---------------------------------------------------------------------------

describe('writeBackAnthropicTokens — atomicity', () => {
  it('leaves no .tmp files behind after successful writes', async () => {
    const { claudeDir, cleoHome } = isolateHomes();
    writeGlobalConfig(cleoHome, {});
    seedClaudeCodeFile(join(claudeDir, '.credentials.json'), ['user:inference']);

    await writeBackAnthropicTokens(refreshedTokens());

    const cleoEntries = readdirSync(cleoHome).filter((n) => n.endsWith('.tmp'));
    const claudeEntries = readdirSync(claudeDir).filter((n) => n.endsWith('.tmp'));
    expect(cleoEntries).toEqual([]);
    expect(claudeEntries).toEqual([]);
  });
});

/**
 * Unit tests for `rate-limit-guard.ts` (T9273 — cross-session rate-limit guard).
 *
 * Isolation strategy: each test sets `XDG_DATA_HOME` to a unique temp directory
 * so state files never collide with developer data or between parallel workers.
 *
 * Fake timers (`vi.useFakeTimers`) are used for expiry / cooldown assertions
 * to avoid real-time waits and keep tests deterministic.
 *
 * @task T9273
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRateLimit,
  rateLimitRemaining,
  rateLimitStatePath,
  recordRateLimit,
} from '../rate-limit-guard.js';

// ---------------------------------------------------------------------------
// Environment isolation helpers
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
// T9403: getCleoHome() honours CLEO_HOME first; save/restore here.
const ENV_KEYS = ['XDG_DATA_HOME', 'CLEO_HOME', 'HOME'];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function isolateHomes(): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-rlg-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-rlg-home-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  // T9403: mirror XDG layout under CLEO_HOME for getCleoHome().
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  return xdgRoot;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimitStatePath', () => {
  it('produces a path inside the cleo home directory', () => {
    isolateHomes();
    const p = rateLimitStatePath('anthropic', 'personal');
    expect(p).toContain('rate-limit-state');
    expect(p).toContain('anthropic-personal.json');
  });

  it('sanitizes slashes in provider and label to prevent path traversal', () => {
    isolateHomes();
    const p = rateLimitStatePath('../../evil', '../bad');
    const filename = p.split('/').pop()!;
    // The filename must not contain any path separator characters.
    expect(filename).not.toContain('..');
    expect(filename).not.toContain('/');
    // Slashes should be replaced with underscores.
    // '../../evil' → 6 chars '../../' → 6 underscores; '../bad' → 3 chars '../' → 3 underscores
    expect(filename).toContain('______evil-___bad.json');
  });
});

describe('recordRateLimit — default cooldown', () => {
  it('writes state file with resetAt ~300 s in the future by default', async () => {
    isolateHomes();
    vi.useFakeTimers();
    const now = Date.now();

    await recordRateLimit('anthropic', 'personal');

    const remaining = await rateLimitRemaining('anthropic', 'personal');
    // Should be close to 300 s.
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(299);
    expect(remaining!).toBeLessThanOrEqual(300);

    void now; // suppress unused-var lint
  });

  it('respects a custom defaultCooldownSeconds option', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await recordRateLimit('anthropic', 'personal', { defaultCooldownSeconds: 60 });

    const remaining = await rateLimitRemaining('anthropic', 'personal');
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(59);
    expect(remaining!).toBeLessThanOrEqual(60);
  });
});

describe('rateLimitRemaining', () => {
  it('returns a positive number when the guard is active', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await recordRateLimit('anthropic', 'personal');

    const remaining = await rateLimitRemaining('anthropic', 'personal');
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
  });

  it('returns null for an unknown provider+label combination', async () => {
    isolateHomes();

    const remaining = await rateLimitRemaining('openai', 'nonexistent');
    expect(remaining).toBeNull();
  });

  it('returns null after fake-time advances past resetAt', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await recordRateLimit('anthropic', 'personal', { defaultCooldownSeconds: 300 });

    // Advance time past the 300-second cooldown window.
    vi.advanceTimersByTime(301_000);

    const remaining = await rateLimitRemaining('anthropic', 'personal');
    expect(remaining).toBeNull();
  });
});

describe('clearRateLimit', () => {
  it('removes the state so rateLimitRemaining returns null', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await recordRateLimit('anthropic', 'personal');
    // Verify active before clear.
    expect(await rateLimitRemaining('anthropic', 'personal')).not.toBeNull();

    await clearRateLimit('anthropic', 'personal');

    expect(await rateLimitRemaining('anthropic', 'personal')).toBeNull();
  });

  it('is idempotent — does not throw when no state file exists', async () => {
    isolateHomes();

    await expect(clearRateLimit('anthropic', 'no-state')).resolves.toBeUndefined();
  });
});

describe('recordRateLimit — header parsing', () => {
  it('uses retry-after delta seconds header when present', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await recordRateLimit('anthropic', 'personal', {
      headers: { 'retry-after': '120' },
    });

    const remaining = await rateLimitRemaining('anthropic', 'personal');
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(119);
    expect(remaining!).toBeLessThanOrEqual(120);
  });

  it('uses x-ratelimit-reset-requests header (epoch seconds)', async () => {
    isolateHomes();
    vi.useFakeTimers();

    const nowSec = Math.floor(Date.now() / 1000);
    const resetEpoch = nowSec + 180; // 3 minutes from now.

    await recordRateLimit('openai', 'work', {
      headers: { 'x-ratelimit-reset-requests': String(resetEpoch) },
    });

    const remaining = await rateLimitRemaining('openai', 'work');
    expect(remaining).not.toBeNull();
    // Should be ~180 s — allow 1s tolerance for rounding.
    expect(remaining!).toBeGreaterThan(178);
    expect(remaining!).toBeLessThanOrEqual(180);
  });

  it('parses an ISO 8601 date string in x-ratelimit-reset', async () => {
    isolateHomes();
    vi.useFakeTimers();

    // 240 seconds in the future as an ISO timestamp.
    const isoDate = new Date(Date.now() + 240_000).toISOString();

    await recordRateLimit('anthropic', 'iso-test', {
      headers: { 'x-ratelimit-reset': isoDate },
    });

    const remaining = await rateLimitRemaining('anthropic', 'iso-test');
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(238);
    expect(remaining!).toBeLessThanOrEqual(240);
  });

  it('falls back to default cooldown when headers are past timestamps', async () => {
    isolateHomes();
    vi.useFakeTimers();

    // Provide a retry-after that is a past date — should be ignored.
    const pastDate = new Date(Date.now() - 60_000).toUTCString();

    await recordRateLimit('anthropic', 'stale-header', {
      defaultCooldownSeconds: 300,
      headers: { 'retry-after': pastDate },
    });

    const remaining = await rateLimitRemaining('anthropic', 'stale-header');
    expect(remaining).not.toBeNull();
    // Falls back to 300s default.
    expect(remaining!).toBeGreaterThan(299);
    expect(remaining!).toBeLessThanOrEqual(300);
  });
});

describe('sanitization — path traversal', () => {
  it('prevents provider with slashes from escaping the state dir', async () => {
    isolateHomes();
    vi.useFakeTimers();

    // Should not throw and should write to a sanitized path inside state dir.
    await expect(
      recordRateLimit('../../evil-provider', 'label', { defaultCooldownSeconds: 60 }),
    ).resolves.toBeUndefined();

    // The path must stay inside the rate-limit-state directory.
    const p = rateLimitStatePath('../../evil-provider', 'label');
    expect(p).toContain('rate-limit-state');
    expect(p).not.toContain('../..');
  });

  it('prevents label with slashes from escaping the state dir', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await expect(
      recordRateLimit('anthropic', '../../../etc/passwd', { defaultCooldownSeconds: 60 }),
    ).resolves.toBeUndefined();

    const p = rateLimitStatePath('anthropic', '../../../etc/passwd');
    expect(p).toContain('rate-limit-state');
    expect(p).not.toContain('../..');
  });
});

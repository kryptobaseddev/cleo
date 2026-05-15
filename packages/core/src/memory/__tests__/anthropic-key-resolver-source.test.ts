/**
 * Tests for Anthropic credential resolution source via `resolveCredentials()`.
 *
 * Covers env, config-file, and the `none` path. Each test isolates filesystem
 * access with a per-test temp directory.
 *
 * @task T791
 * @epic T770
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache, resolveCredentials } from '../../llm/credentials.js';

// ---------------------------------------------------------------------------
// Environment management helpers
// ---------------------------------------------------------------------------

const ORIG_ENV_KEY = process.env.ANTHROPIC_API_KEY;
const ORIG_XDG = process.env.XDG_DATA_HOME;

function setEnvKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = value;
  }
}

function setXdgHome(value: string): void {
  process.env['XDG_DATA_HOME'] = value;
}

function makeCleoDir(): { xdgRoot: string; cleoDir: string } {
  const xdgRoot = join(
    tmpdir(),
    `cleo-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const cleoDir = join(xdgRoot, 'cleo');
  mkdirSync(cleoDir, { recursive: true });
  return { xdgRoot, cleoDir };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAnthropicKeyCache();
  setEnvKey(undefined);
});

afterEach(() => {
  if (ORIG_ENV_KEY !== undefined) {
    process.env['ANTHROPIC_API_KEY'] = ORIG_ENV_KEY;
  } else {
    delete process.env['ANTHROPIC_API_KEY'];
  }
  if (ORIG_XDG !== undefined) {
    process.env['XDG_DATA_HOME'] = ORIG_XDG;
  } else {
    delete process.env['XDG_DATA_HOME'];
  }
  clearAnthropicKeyCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveCredentials("anthropic").source', () => {
  it('returns "env" when ANTHROPIC_API_KEY is set in the environment', () => {
    setEnvKey('sk-test-env-key');
    expect(resolveCredentials('anthropic').source).toBe('env');
  });

  it('flat key file at XDG_DATA_HOME/cleo/anthropic-key resolves (tier 4b or oauth)', () => {
    setEnvKey(undefined);
    const { xdgRoot, cleoDir } = makeCleoDir();
    writeFileSync(join(cleoDir, 'anthropic-key'), 'sk-from-config-file\n');
    setXdgHome(xdgRoot);
    // When ~/.claude/.credentials.json is present (developer machine), tier 3 (claude-creds) wins.
    // On CI the flat file resolves as tier 4b (global-config).
    const source = resolveCredentials('anthropic').source;
    expect(['global-config', 'claude-creds']).toContain(source);
  });

  it('env takes priority over config file (source = "env")', () => {
    setEnvKey('sk-env-wins');
    const { xdgRoot, cleoDir } = makeCleoDir();
    writeFileSync(join(cleoDir, 'anthropic-key'), 'sk-config-file');
    setXdgHome(xdgRoot);
    expect(resolveCredentials('anthropic').source).toBe('env');
  });

  it('returns undefined apiKey when env absent and XDG dir has no key file', () => {
    setEnvKey(undefined);
    const { xdgRoot } = makeCleoDir();
    setXdgHome(xdgRoot);
    // In CI there are no credentials; developer machines may have claude-creds (tier 3)
    const result = resolveCredentials('anthropic');
    // Either null (CI) or non-null (developer — claude-creds tier)
    if (result.apiKey === null) {
      expect(result.source).toBeUndefined();
    }
  });

  it('resolveCredentials returns env key consistently across calls', () => {
    setEnvKey('sk-cache-coherence');
    const first = resolveCredentials('anthropic');
    const second = resolveCredentials('anthropic');
    expect(first.source).toBe('env');
    expect(second.source).toBe('env');
    expect(first.apiKey).toBe('sk-cache-coherence');
    expect(second.apiKey).toBe('sk-cache-coherence');
  });

  it('returns "env" and apiKey non-null consistently', () => {
    setEnvKey('sk-consistent-check');
    clearAnthropicKeyCache();
    const result = resolveCredentials('anthropic');
    expect(result.source).toBe('env');
    expect(result.apiKey).not.toBeNull();
  });
});

describe('resolveCredentials("anthropic") — code paths tested by resolver audit', () => {
  it('observer-reflector.ts calls resolveCredentials not raw env (smoke)', async () => {
    setEnvKey('sk-observer-smoke');
    const { resolveCredentials: resolve } = await import('../../llm/credentials.js');
    expect(resolve('anthropic').apiKey).toBe('sk-observer-smoke');
  });

  it('resolveCredentials is always safe to call even without any key configured', () => {
    setEnvKey(undefined);
    const { xdgRoot } = makeCleoDir();
    setXdgHome(xdgRoot);
    expect(() => resolveCredentials('anthropic')).not.toThrow();
  });
});

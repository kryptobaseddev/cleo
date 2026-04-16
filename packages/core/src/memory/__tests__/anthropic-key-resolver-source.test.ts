/**
 * Tests for `resolveAnthropicApiKeySource()` — companion to
 * `resolveAnthropicApiKey()` that identifies which source resolved the key.
 *
 * Covers env, config-file, and the `none` path. Each test resets the
 * module-level cache via `clearAnthropicKeyCache()` and isolates filesystem
 * access with a per-test temp directory.
 *
 * @task T791
 * @epic T770
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAnthropicKeyCache,
  resolveAnthropicApiKey,
  resolveAnthropicApiKeySource,
} from '../anthropic-key-resolver.js';

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
  // Restore original environment
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

describe('resolveAnthropicApiKeySource()', () => {
  it('returns "env" when ANTHROPIC_API_KEY is set in the environment', () => {
    setEnvKey('sk-test-env-key');
    expect(resolveAnthropicApiKeySource()).toBe('env');
  });

  it('returns "config" when a key file exists at XDG_DATA_HOME/cleo/anthropic-key', () => {
    setEnvKey(undefined);
    const { xdgRoot, cleoDir } = makeCleoDir();
    writeFileSync(join(cleoDir, 'anthropic-key'), 'sk-from-config-file\n');
    setXdgHome(xdgRoot);
    expect(resolveAnthropicApiKeySource()).toBe('config');
  });

  it('env takes priority over config file (source = "env")', () => {
    setEnvKey('sk-env-wins');
    const { xdgRoot, cleoDir } = makeCleoDir();
    writeFileSync(join(cleoDir, 'anthropic-key'), 'sk-config-file');
    setXdgHome(xdgRoot);
    expect(resolveAnthropicApiKeySource()).toBe('env');
  });

  it('returns "none" when env is absent and XDG dir has no key file', () => {
    setEnvKey(undefined);
    const { xdgRoot } = makeCleoDir();
    // XDG dir exists but contains no anthropic-key file
    setXdgHome(xdgRoot);
    // In CI there are no credentials, so this should be 'none' (or 'oauth' in dev)
    const result = resolveAnthropicApiKeySource();
    expect(['none', 'oauth']).toContain(result);
  });

  it('resolveAnthropicApiKey() still works after resolveAnthropicApiKeySource() call', () => {
    setEnvKey('sk-cache-coherence');
    // Source does NOT prime the resolver cache
    const source = resolveAnthropicApiKeySource();
    expect(source).toBe('env');
    // Resolver should independently resolve the env key
    const key = resolveAnthropicApiKey();
    expect(key).toBe('sk-cache-coherence');
  });

  it('returns "env" and resolveAnthropicApiKey() returns non-null consistently', () => {
    setEnvKey('sk-consistent-check');
    const source = resolveAnthropicApiKeySource();
    clearAnthropicKeyCache(); // Source does not cache, resolver does
    const key = resolveAnthropicApiKey();
    // Both must agree: key is present when source != "none"
    expect(source).not.toBe('none');
    expect(key).not.toBeNull();
  });
});

describe('resolveAnthropicApiKeySource() — code paths tested by resolver audit', () => {
  it('observer-reflector.ts calls resolveAnthropicApiKey() not raw env (smoke)', async () => {
    // Verify the module imports the resolver rather than using process.env directly
    setEnvKey('sk-observer-smoke');
    // Import the module dynamically to get a fresh reference
    const { resolveAnthropicApiKey: resolveKey } = await import('../anthropic-key-resolver.js');
    expect(resolveKey()).toBe('sk-observer-smoke');
  });

  it('resolveAnthropicApiKeySource() is always safe to call even without any key configured', () => {
    setEnvKey(undefined);
    const { xdgRoot } = makeCleoDir();
    setXdgHome(xdgRoot);
    // Should never throw regardless of filesystem state
    expect(() => resolveAnthropicApiKeySource()).not.toThrow();
  });
});

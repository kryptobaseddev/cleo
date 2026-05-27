/**
 * Tests for configLlmDaemonProvider / configLlmDaemonModel engine-ops (T1677).
 *
 * Validates that valid providers/models are written to the global config and
 * that invalid inputs are rejected with E_INVALID_INPUT.
 *
 * Uses a temporary XDG_DATA_HOME to isolate filesystem writes.
 *
 * @task T1677
 * @epic T1676
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configLlmDaemonModel, configLlmDaemonProvider } from '../engine-ops.js';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

const SAVED_XDG = process.env['XDG_DATA_HOME'];

function makeTempXdg(): string {
  const xdgRoot = join(
    tmpdir(),
    `cleo-llm-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  return xdgRoot;
}

beforeEach(() => {
  makeTempXdg();
});

afterEach(() => {
  if (SAVED_XDG === undefined) {
    delete process.env['XDG_DATA_HOME'];
  } else {
    process.env['XDG_DATA_HOME'] = SAVED_XDG;
  }
});

// ---------------------------------------------------------------------------
// configLlmDaemonProvider
// ---------------------------------------------------------------------------

describe('configLlmDaemonProvider()', () => {
  it('accepts "anthropic" and returns success', async () => {
    const result = await configLlmDaemonProvider('anthropic');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe('llm.daemon.provider');
      expect(result.data.value).toBe('anthropic');
    }
  });

  it('accepts "openai" and returns success', async () => {
    const result = await configLlmDaemonProvider('openai');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toBe('openai');
    }
  });

  it('accepts "gemini" and returns success', async () => {
    const result = await configLlmDaemonProvider('gemini');
    expect(result.success).toBe(true);
  });

  it('accepts "moonshot" and returns success', async () => {
    const result = await configLlmDaemonProvider('moonshot');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toBe('moonshot');
    }
  });

  it('rejects unknown provider with E_INVALID_INPUT', async () => {
    const result = await configLlmDaemonProvider('unknown-provider');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
      expect(result.error.message).toMatch(/unknown-provider/);
    }
  });

  it('rejects empty string with E_INVALID_INPUT', async () => {
    const result = await configLlmDaemonProvider('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
    }
  });
});

// ---------------------------------------------------------------------------
// configLlmDaemonModel
// ---------------------------------------------------------------------------

describe('configLlmDaemonModel()', () => {
  it('accepts "claude-sonnet-4-6" and returns success', async () => {
    const result = await configLlmDaemonModel('claude-sonnet-4-6');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe('llm.daemon.model');
      expect(result.data.value).toBe('claude-sonnet-4-6');
    }
  });

  it('accepts any non-empty model string (no model validation done in engine-op)', async () => {
    const result = await configLlmDaemonModel('gpt-4o-mini');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toBe('gpt-4o-mini');
    }
  });

  it('trims leading/trailing whitespace from the model string', async () => {
    const result = await configLlmDaemonModel('  claude-sonnet-4-6  ');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toBe('claude-sonnet-4-6');
    }
  });

  it('rejects empty string with E_INVALID_INPUT', async () => {
    const result = await configLlmDaemonModel('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
    }
  });

  it('rejects whitespace-only string with E_INVALID_INPUT', async () => {
    const result = await configLlmDaemonModel('   ');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
    }
  });
});

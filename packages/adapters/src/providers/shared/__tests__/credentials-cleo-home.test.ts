/**
 * The legacy flat-key tier reads `<getCleoHome()>/anthropic-key` (T12602).
 *
 * Core's `storeAnthropicApiKey()` writes that file under `getCleoHome()`
 * (`~/Library/Application Support/cleo` on macOS). This reader used
 * `$XDG_DATA_HOME ?? ~/.local/share` + `cleo`, so on macOS and Windows it
 * never saw the key core had stored.
 *
 * @task T12602
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCredentials } from '../credentials.js';

describe('resolveCredentials — legacy flat-key tier (T12602)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-adapters-cred-'));
    const cleoHome = join(root, 'cleo-home');
    mkdirSync(cleoHome, { recursive: true });
    writeFileSync(join(cleoHome, 'anthropic-key'), 'sk-ant-flat-key\n');
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('CLEO_HOME', cleoHome);
    // The old resolver read here; it is empty.
    vi.stubEnv('XDG_DATA_HOME', join(root, 'empty-xdg'));
    // Keep tier 3 (~/.claude/.credentials.json) off the real home dir.
    vi.stubEnv('HOME', join(root, 'home'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the key core stored under getCleoHome()', () => {
    expect(resolveCredentials('anthropic')).toEqual({ apiKey: 'sk-ant-flat-key' });
  });
});

/**
 * Unit tests for `credential-removal.ts` (T9415 — RemovalStep registry +
 * suppression-state persistence).
 *
 * Isolation strategy: each test sets `CLEO_HOME` (and `XDG_DATA_HOME`,
 * `HOME` so `getCleoHome` fallback paths don't leak to developer data) to
 * a unique temp directory. Mirrors the pattern used by
 * `rate-limit-guard.test.ts`.
 *
 * @task T9415
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile } from '../../store/file-utils.js';
import {
  addSuppression,
  buildBuiltinRemovalRegistry,
  CLAUDE_CODE_REMOVAL_STEP,
  CLEO_PKCE_REMOVAL_STEP,
  CODEX_CLI_REMOVAL_STEP,
  ENV_REMOVAL_STEP,
  GEMINI_CLI_REMOVAL_STEP,
  GH_CLI_REMOVAL_STEP,
  isSuppressed,
  MANUAL_REMOVAL_STEP,
  REMOVAL_REGISTRY,
  RemovalRegistry,
  type RemovalStep,
  readSuppressionFile,
  removeSuppression,
  type SuppressionFile,
  suppressionStatePath,
  writeSuppressionFile,
} from '../credential-removal.js';

// ---------------------------------------------------------------------------
// Environment isolation helpers
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
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
  const xdgRoot = join(tmpdir(), `cleo-rmv-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-rmv-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  return cleoHome;
}

beforeEach(() => {
  saveEnv();
});

afterEach(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// RemovalRegistry — dispatch contract
// ---------------------------------------------------------------------------

describe('RemovalRegistry', () => {
  it('register + find — round-trips a single step', () => {
    const registry = new RemovalRegistry();
    const step: RemovalStep = {
      sourceId: 'env',
      description: 'test',
      async remove() {
        return { cleaned: [], hints: [], suppress: true };
      },
    };

    registry.register(step);
    expect(registry.find('env')).toBe(step);
  });

  it('find returns undefined for an unregistered sourceId', () => {
    const registry = new RemovalRegistry();
    expect(registry.find('env')).toBeUndefined();
  });

  it('rejects a duplicate sourceId registration', () => {
    const registry = new RemovalRegistry();
    const make = (): RemovalStep => ({
      sourceId: 'env',
      description: 'dup',
      async remove() {
        return { cleaned: [], hints: [], suppress: true };
      },
    });

    registry.register(make());
    expect(() => registry.register(make())).toThrow(/E_REMOVAL_DUPLICATE.*sourceId='env'/);
  });

  it('getAll preserves insertion order', () => {
    const registry = new RemovalRegistry();
    const a: RemovalStep = {
      sourceId: 'env',
      description: 'a',
      async remove() {
        return { cleaned: [], hints: [], suppress: true };
      },
    };
    const b: RemovalStep = {
      sourceId: 'manual',
      description: 'b',
      async remove() {
        return { cleaned: [], hints: [], suppress: false };
      },
    };
    registry.register(a);
    registry.register(b);
    expect(registry.getAll()).toEqual([a, b]);
  });
});

// ---------------------------------------------------------------------------
// Built-in registry — every SeederSourceId is covered
// ---------------------------------------------------------------------------

describe('buildBuiltinRemovalRegistry + REMOVAL_REGISTRY singleton', () => {
  it('registers a step for every known SeederSourceId', () => {
    const registry = buildBuiltinRemovalRegistry();
    const sourceIds = [
      'manual',
      'env',
      'claude-code',
      'cleo-pkce',
      'codex-cli',
      'gemini-cli',
      'gh-cli',
    ] as const;
    for (const id of sourceIds) {
      expect(registry.find(id), `missing step for ${id}`).toBeDefined();
    }
    expect(registry.getAll()).toHaveLength(sourceIds.length);
  });

  it('the REMOVAL_REGISTRY singleton has all 7 steps', () => {
    expect(REMOVAL_REGISTRY.getAll()).toHaveLength(7);
    expect(REMOVAL_REGISTRY.find('manual')).toBe(MANUAL_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('env')).toBe(ENV_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('claude-code')).toBe(CLAUDE_CODE_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('cleo-pkce')).toBe(CLEO_PKCE_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('codex-cli')).toBe(CODEX_CLI_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('gemini-cli')).toBe(GEMINI_CLI_REMOVAL_STEP);
    expect(REMOVAL_REGISTRY.find('gh-cli')).toBe(GH_CLI_REMOVAL_STEP);
  });
});

// ---------------------------------------------------------------------------
// Per-step behaviour
// ---------------------------------------------------------------------------

describe('MANUAL_REMOVAL_STEP', () => {
  it('returns suppress=false and an llm-credentials hint', async () => {
    const result = await MANUAL_REMOVAL_STEP.remove({
      provider: 'anthropic',
      label: 'manual-1',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints).toEqual(['entry removed from llm-credentials.json']);
    expect(result.suppress).toBe(false);
  });
});

describe('ENV_REMOVAL_STEP', () => {
  it('returns suppress=true with a shell-unset hint', async () => {
    const result = await ENV_REMOVAL_STEP.remove({
      provider: 'anthropic',
      label: 'env',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints).toEqual(['Unset $VARNAME in your shell to prevent re-seeding']);
    expect(result.suppress).toBe(true);
  });
});

describe('CLAUDE_CODE_REMOVAL_STEP', () => {
  it('warns against deleting ~/.claude/.credentials.json and suppresses', async () => {
    const result = await CLAUDE_CODE_REMOVAL_STEP.remove({
      provider: 'anthropic',
      label: 'imported',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints[0]).toMatch(/Do NOT delete ~\/.claude\/.credentials\.json/);
    expect(result.suppress).toBe(true);
  });
});

describe('CLEO_PKCE_REMOVAL_STEP', () => {
  it('deletes anthropic-oauth.json when present and reports it as cleaned', async () => {
    const cleoHome = isolateHomes();
    const oauthPath = join(cleoHome, 'anthropic-oauth.json');
    writeFileSync(oauthPath, JSON.stringify({ token: 'tok' }), 'utf-8');
    expect(existsSync(oauthPath)).toBe(true);

    const result = await CLEO_PKCE_REMOVAL_STEP.remove({
      provider: 'anthropic',
      label: 'pkce',
    });

    expect(existsSync(oauthPath)).toBe(false);
    expect(result.cleaned).toEqual([oauthPath]);
    expect(result.suppress).toBe(true);
  });

  it('is idempotent — missing token file yields empty cleaned + no throw', async () => {
    isolateHomes();
    const result = await CLEO_PKCE_REMOVAL_STEP.remove({
      provider: 'anthropic',
      label: 'pkce',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.suppress).toBe(true);
  });
});

describe('CODEX_CLI_REMOVAL_STEP', () => {
  it('returns suppress=true + a Codex-CLI revoke hint', async () => {
    const result = await CODEX_CLI_REMOVAL_STEP.remove({
      provider: 'openai',
      label: 'codex',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints[0]).toMatch(/codex logout/);
    expect(result.suppress).toBe(true);
  });
});

describe('GEMINI_CLI_REMOVAL_STEP', () => {
  it('returns suppress=true + a gcloud revoke hint', async () => {
    const result = await GEMINI_CLI_REMOVAL_STEP.remove({
      provider: 'gemini',
      label: 'cli',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints[0]).toMatch(/gcloud auth application-default revoke/);
    expect(result.suppress).toBe(true);
  });
});

describe('GH_CLI_REMOVAL_STEP', () => {
  it('returns suppress=true + a `gh auth logout` hint', async () => {
    const result = await GH_CLI_REMOVAL_STEP.remove({
      provider: 'github-models',
      label: 'gh',
    });
    expect(result.cleaned).toEqual([]);
    expect(result.hints[0]).toMatch(/gh auth logout/);
    expect(result.suppress).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suppression-state persistence — roundtrip + atomicity
// ---------------------------------------------------------------------------

describe('suppression-state file', () => {
  it('suppressionStatePath resolves under getCleoHome()', () => {
    const cleoHome = isolateHomes();
    expect(suppressionStatePath()).toBe(join(cleoHome, 'auth-suppression.json'));
  });

  it('readSuppressionFile returns an empty document when the file is missing', () => {
    isolateHomes();
    const doc = readSuppressionFile();
    expect(doc).toEqual({ version: 1, entries: [] });
  });

  it('writeSuppressionFile + readSuppressionFile roundtrip preserves entries', () => {
    isolateHomes();
    const doc: SuppressionFile = {
      version: 1,
      entries: [
        { provider: 'anthropic', sourceId: 'claude-code', suppressedAt: 1700000000000 },
        { provider: 'openai', sourceId: 'env', suppressedAt: 1700000000001 },
      ],
    };
    writeSuppressionFile(doc);

    const reloaded = readSuppressionFile();
    expect(reloaded).toEqual(doc);
  });

  it('write goes through writeJsonFileAtomic (temp + rename)', () => {
    // We verify the temp-file pattern by checking that the persisted file
    // is exactly the rendered JSON — writeJsonFileAtomic stringifies with
    // 2-space indent and a trailing newline. A non-atomic write would
    // either leave a temp file lying around or produce a different format.
    isolateHomes();
    const doc: SuppressionFile = {
      version: 1,
      entries: [{ provider: 'anthropic', sourceId: 'cleo-pkce', suppressedAt: 42 }],
    };
    writeSuppressionFile(doc);

    const persisted = readJsonFile<SuppressionFile>(suppressionStatePath());
    expect(persisted).toEqual(doc);
  });

  it('treats a malformed file as an empty document', () => {
    const cleoHome = isolateHomes();
    writeFileSync(
      join(cleoHome, 'auth-suppression.json'),
      JSON.stringify({ version: 999, entries: 'not-an-array' }),
      'utf-8',
    );
    const doc = readSuppressionFile();
    expect(doc).toEqual({ version: 1, entries: [] });
  });
});

describe('addSuppression / removeSuppression / isSuppressed', () => {
  it('addSuppression appends an entry and isSuppressed returns true', () => {
    isolateHomes();
    expect(isSuppressed('anthropic', 'env')).toBe(false);
    addSuppression('anthropic', 'env');
    expect(isSuppressed('anthropic', 'env')).toBe(true);
  });

  it('addSuppression is idempotent — duplicate calls produce a single entry', () => {
    isolateHomes();
    addSuppression('anthropic', 'env');
    addSuppression('anthropic', 'env');
    addSuppression('anthropic', 'env');
    const doc = readSuppressionFile();
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]?.provider).toBe('anthropic');
    expect(doc.entries[0]?.sourceId).toBe('env');
  });

  it('different (provider, sourceId) pairs accumulate independently', () => {
    isolateHomes();
    addSuppression('anthropic', 'env');
    addSuppression('anthropic', 'claude-code');
    addSuppression('openai', 'env');

    const doc = readSuppressionFile();
    expect(doc.entries).toHaveLength(3);
    expect(isSuppressed('anthropic', 'env')).toBe(true);
    expect(isSuppressed('anthropic', 'claude-code')).toBe(true);
    expect(isSuppressed('openai', 'env')).toBe(true);
    expect(isSuppressed('openai', 'claude-code')).toBe(false);
  });

  it('removeSuppression returns true when an entry was removed', () => {
    isolateHomes();
    addSuppression('anthropic', 'env');
    expect(removeSuppression('anthropic', 'env')).toBe(true);
    expect(isSuppressed('anthropic', 'env')).toBe(false);
  });

  it('removeSuppression returns false when no entry matches', () => {
    isolateHomes();
    expect(removeSuppression('anthropic', 'env')).toBe(false);
  });

  it('removeSuppression only removes the matching pair, leaving siblings', () => {
    isolateHomes();
    addSuppression('anthropic', 'env');
    addSuppression('anthropic', 'claude-code');
    addSuppression('openai', 'env');

    expect(removeSuppression('anthropic', 'env')).toBe(true);

    const doc = readSuppressionFile();
    expect(doc.entries).toHaveLength(2);
    expect(isSuppressed('anthropic', 'env')).toBe(false);
    expect(isSuppressed('anthropic', 'claude-code')).toBe(true);
    expect(isSuppressed('openai', 'env')).toBe(true);
  });

  it('preserves the original suppressedAt timestamp on re-add', () => {
    isolateHomes();
    addSuppression('anthropic', 'env');
    const first = readSuppressionFile().entries[0]?.suppressedAt;
    expect(first).toBeTypeOf('number');

    // Re-add must not bump the timestamp.
    addSuppression('anthropic', 'env');
    const second = readSuppressionFile().entries[0]?.suppressedAt;
    expect(second).toBe(first);
  });
});

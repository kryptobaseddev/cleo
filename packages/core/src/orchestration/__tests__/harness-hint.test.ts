/**
 * Tests for the harness-hint cascade (T889 / T893 / W3-2).
 *
 * Verifies:
 *  - Explicit option wins over every other source.
 *  - CLEO_HARNESS env wins over auto-detect.
 *  - Auto-detect requires BOTH `CLAUDECODE=1` AND `CLAUDE_CODE_ENTRYPOINT`.
 *  - `claude-code` resolution populates the dedup budget.
 *  - `generic` / `bare` resolution leave the dedup budget at zero.
 *  - `persistHarnessProfile` + `loadHarnessProfile` round-trip on disk.
 *
 * All tests use a real tmpdir — no filesystem mocks, no environment mutation
 * beyond the options.env escape hatch.
 *
 * @task T889 / T893 / W3-2
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEDUP_EMBED_CHARS,
  loadHarnessProfile,
  persistHarnessProfile,
  resolveHarnessHint,
} from '../harness-hint.js';

describe('resolveHarnessHint — cascade precedence', () => {
  it('explicit option wins over CLEO_HARNESS env', () => {
    const result = resolveHarnessHint({
      explicit: 'bare',
      env: { CLEO_HARNESS: 'claude-code' },
    });
    expect(result.hint).toBe('bare');
    expect(result.source).toBe('option');
    expect(result.dedupSavedChars).toBe(0);
  });

  it('explicit option wins over auto-detect markers', () => {
    const result = resolveHarnessHint({
      explicit: 'generic',
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    expect(result.hint).toBe('generic');
    expect(result.source).toBe('option');
  });

  it('CLEO_HARNESS env wins over auto-detect', () => {
    const result = resolveHarnessHint({
      env: {
        CLEO_HARNESS: 'bare',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
    });
    expect(result.hint).toBe('bare');
    expect(result.source).toBe('env');
  });

  it('CLAUDECODE=1 alone does NOT trigger auto-detect (both markers required)', () => {
    const result = resolveHarnessHint({
      env: { CLAUDECODE: '1' },
    });
    expect(result.hint).toBe('generic');
    expect(result.source).toBe('default');
  });

  it('CLAUDE_CODE_ENTRYPOINT alone does NOT trigger auto-detect', () => {
    const result = resolveHarnessHint({
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    expect(result.hint).toBe('generic');
    expect(result.source).toBe('default');
  });

  it('CLAUDECODE=1 + CLAUDE_CODE_ENTRYPOINT set → claude-code auto-detected', () => {
    const result = resolveHarnessHint({
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    expect(result.hint).toBe('claude-code');
    expect(result.source).toBe('auto-detect');
    expect(result.dedupSavedChars).toBe(DEDUP_EMBED_CHARS);
  });

  it('falls through to default when env has no markers', () => {
    const result = resolveHarnessHint({ env: {} });
    expect(result.hint).toBe('generic');
    expect(result.source).toBe('default');
    expect(result.dedupSavedChars).toBe(0);
  });

  it('unknown CLEO_HARNESS value is ignored and cascade continues', () => {
    const result = resolveHarnessHint({
      env: { CLEO_HARNESS: 'malformed-value' },
    });
    // Falls through to default since env value didn't match the allowed set.
    expect(result.hint).toBe('generic');
    expect(result.source).toBe('default');
  });
});

describe('resolveHarnessHint — dedup budget accounting', () => {
  it('claude-code explicit → dedupSavedChars = DEDUP_EMBED_CHARS', () => {
    const result = resolveHarnessHint({ explicit: 'claude-code' });
    expect(result.dedupSavedChars).toBe(DEDUP_EMBED_CHARS);
  });

  it('generic explicit → dedupSavedChars = 0', () => {
    const result = resolveHarnessHint({ explicit: 'generic' });
    expect(result.dedupSavedChars).toBe(0);
  });

  it('bare explicit → dedupSavedChars = 0', () => {
    const result = resolveHarnessHint({ explicit: 'bare' });
    expect(result.dedupSavedChars).toBe(0);
  });
});

describe('persistHarnessProfile + loadHarnessProfile — round trip', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-harness-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('persists then loads the same harness value', async () => {
    await persistHarnessProfile(tmpRoot, 'claude-code');
    const loaded = await loadHarnessProfile(tmpRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.harness).toBe('claude-code');
    expect(loaded?.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates the .cleo directory when absent', async () => {
    await persistHarnessProfile(tmpRoot, 'bare');
    expect(existsSync(join(tmpRoot, '.cleo'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.cleo', 'harness-profile.json'))).toBe(true);
  });

  it('writes atomically via .tmp then rename (no tmp file remains)', async () => {
    await persistHarnessProfile(tmpRoot, 'generic');
    expect(existsSync(join(tmpRoot, '.cleo', 'harness-profile.json.tmp'))).toBe(false);
    const raw = readFileSync(join(tmpRoot, '.cleo', 'harness-profile.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { harness: string; detectedAt: string };
    expect(parsed.harness).toBe('generic');
  });

  it('loadHarnessProfile returns null when profile missing', async () => {
    const loaded = await loadHarnessProfile(tmpRoot);
    expect(loaded).toBeNull();
  });

  it('resolveHarnessHint picks up persisted profile before auto-detect', async () => {
    await persistHarnessProfile(tmpRoot, 'bare');
    const result = resolveHarnessHint({
      projectRoot: tmpRoot,
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    expect(result.hint).toBe('bare');
    expect(result.source).toBe('profile');
  });

  it('loadHarnessProfile returns null for a malformed JSON payload', async () => {
    const path = join(tmpRoot, '.cleo', 'harness-profile.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(tmpRoot, '.cleo'), { recursive: true });
    writeFileSync(path, '{ "harness": not-json', 'utf-8');
    const loaded = await loadHarnessProfile(tmpRoot);
    expect(loaded).toBeNull();
  });
});

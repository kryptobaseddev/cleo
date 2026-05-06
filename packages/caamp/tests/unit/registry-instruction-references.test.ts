/**
 * Tests for getProviderInstructionReferences() and the registry-default
 * fallback in ensureProviderInstructionFile().
 *
 * T9014 — B1-api: Expose getProviderInstructionReferences + registry default
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProviderInstructionFile,
} from '../../src/core/instructions/injector.js';
import {
  getProviderInstructionReferences,
  resetRegistry,
} from '../../src/core/registry/providers.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const KNOWN_PROVIDER_ID = 'claude-code';
const EXPECTED_REFS = [
  '@~/.cleo/templates/CLEO-INJECTION.md',
  '@.cleo/memory-bridge.md',
];

// ── Suite: getProviderInstructionReferences ────────────────────────────

describe('getProviderInstructionReferences()', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('returns the registry instructionReferences for a known provider', () => {
    const refs = getProviderInstructionReferences(KNOWN_PROVIDER_ID);
    expect(refs).toEqual(EXPECTED_REFS);
  });

  it('resolves aliases — "claude" returns same refs as "claude-code"', () => {
    const byAlias = getProviderInstructionReferences('claude');
    const byId = getProviderInstructionReferences(KNOWN_PROVIDER_ID);
    expect(byAlias).toEqual(byId);
  });

  it('returns [] for an unknown provider ID', () => {
    const refs = getProviderInstructionReferences('no-such-provider-xyzzy');
    expect(refs).toEqual([]);
  });

  it('returns a fresh copy — mutating the result does not affect the registry', () => {
    const refs1 = getProviderInstructionReferences(KNOWN_PROVIDER_ID);
    refs1.push('@mutated');
    const refs2 = getProviderInstructionReferences(KNOWN_PROVIDER_ID);
    expect(refs2).toEqual(EXPECTED_REFS);
  });

  it('returns refs for all 7 providers populated by T9013', () => {
    const populated = [
      'claude-code',
      'cursor',
      'codex',
      'gemini-cli',
      'opencode',
      'kimi',
      'pi',
    ];
    for (const id of populated) {
      const refs = getProviderInstructionReferences(id);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs).toEqual(EXPECTED_REFS);
    }
  });
});

// ── Suite: ensureProviderInstructionFile registry default ──────────────

describe('ensureProviderInstructionFile() — registry default references', () => {
  let testDir: string;

  beforeEach(async () => {
    resetRegistry();
    testDir = join(tmpdir(), `caamp-T9014-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true }).catch(() => {});
  });

  it('uses registry defaults when references is omitted', async () => {
    const result = await ensureProviderInstructionFile(KNOWN_PROVIDER_ID, testDir, {});

    expect(result.providerId).toBe(KNOWN_PROVIDER_ID);
    expect(result.instructFile).toBe('CLAUDE.md');
    expect(result.action).toBe('created');

    const content = await readFile(result.filePath, 'utf-8');
    // Both registry refs should appear in the written file
    for (const ref of EXPECTED_REFS) {
      expect(content).toContain(ref);
    }
  });

  it('explicit references take precedence over registry defaults', async () => {
    const explicit = ['@CUSTOM_FILE.md'];
    const result = await ensureProviderInstructionFile(KNOWN_PROVIDER_ID, testDir, {
      references: explicit,
    });

    const content = await readFile(result.filePath, 'utf-8');
    expect(content).toContain('@CUSTOM_FILE.md');
    // Registry-default refs should NOT appear when caller provides explicit refs
    for (const ref of EXPECTED_REFS) {
      expect(content).not.toContain(ref);
    }
  });

  it('uses registry defaults when references is undefined (explicit)', async () => {
    const result = await ensureProviderInstructionFile(KNOWN_PROVIDER_ID, testDir, {
      references: undefined,
    });

    const content = await readFile(result.filePath, 'utf-8');
    for (const ref of EXPECTED_REFS) {
      expect(content).toContain(ref);
    }
  });

  it('throws for an unknown provider ID', async () => {
    await expect(
      ensureProviderInstructionFile('no-such-provider-xyzzy', testDir, {}),
    ).rejects.toThrow(/Unknown provider/);
  });

  it('writes file to correct location using registry instructFile', async () => {
    const result = await ensureProviderInstructionFile(KNOWN_PROVIDER_ID, testDir, {});
    // claude-code uses CLAUDE.md
    expect(result.filePath).toBe(join(testDir, 'CLAUDE.md'));
  });
});

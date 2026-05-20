/**
 * Tests for canonical skills root resolver + is_canonical predicate.
 *
 * Post-T9746: legacy fallback (`~/.local/share/agents/skills/`) and env-paths
 * fallback have been purged. `resolveSkillsRoot()` always returns
 * `~/.cleo/skills/` and `is_canonical()` no longer consults legacy path
 * prefixes — only db row + manifest membership.
 *
 * @task T9746
 * @epic T9740
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs surface used by the module under test.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
  };
});

// Stable homedir for deterministic path resolution.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

import { realpathSync } from 'node:fs';
import { is_canonical, resolveSkillsRoot } from '../skill-root.js';

describe('resolveSkillsRoot — canonical SSoT path helper', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(realpathSync).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('always returns ~/.cleo/skills (no fallback resolution)', () => {
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.cleo/skills');
  });

  it('never emits a deprecation warning to stderr', () => {
    resolveSkillsRoot();
    resolveSkillsRoot();
    resolveSkillsRoot();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns an absolute path', () => {
    const root = resolveSkillsRoot();
    expect(root.startsWith('/')).toBe(true);
  });
});

describe('is_canonical — Sphere A write-guard predicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(realpathSync).mockImplementation((p: string) => p);
  });

  it('returns true when dbSourceType === "canonical" (short-circuit)', () => {
    expect(
      is_canonical('/home/test/.cleo/skills/ct-orchestrator', {
        dbSourceType: 'canonical',
      }),
    ).toBe(true);
  });

  it('does NOT short-circuit on dbSourceType === "user"', () => {
    expect(
      is_canonical('/home/test/.cleo/skills/my-skill', {
        dbSourceType: 'user',
      }),
    ).toBe(false);
  });

  it('returns true on manifest membership match', () => {
    expect(
      is_canonical('/home/test/.cleo/skills/ct-lead', {
        manifestNames: ['ct-lead', 'ct-orchestrator', 'ct-cleo'],
      }),
    ).toBe(true);
  });

  it('returns false when skill name is NOT in manifest', () => {
    expect(
      is_canonical('/home/test/.cleo/skills/community-skill', {
        manifestNames: ['ct-lead', 'ct-orchestrator'],
      }),
    ).toBe(false);
  });

  it('returns false for legacy ~/.local/share/agents/skills/* paths (no path fallback)', () => {
    // Legacy path-prefix fallback was removed in T9746 — db row + manifest are
    // now the only signals. A bare legacy path with no DI options is NOT canonical.
    expect(is_canonical('/home/test/.local/share/agents/skills/ct-foo')).toBe(false);
  });

  it('returns false for the legacy root itself with no options', () => {
    expect(is_canonical('/home/test/.local/share/agents/skills')).toBe(false);
  });

  it('returns false for non-canonical paths with no DI options', () => {
    expect(is_canonical('/home/test/.cleo/skills/random-user-skill')).toBe(false);
  });

  it('resolves symlinks via realpathSync before basename comparison', () => {
    // Simulate ~/.claude/skills/agents-shared/ct-foo → ~/.cleo/skills/ct-foo
    vi.mocked(realpathSync).mockImplementation((p) => {
      if (p === '/home/test/.claude/skills/agents-shared/ct-foo') {
        return '/home/test/.cleo/skills/ct-foo';
      }
      return String(p);
    });

    expect(
      is_canonical('/home/test/.claude/skills/agents-shared/ct-foo', {
        manifestNames: ['ct-foo'],
      }),
    ).toBe(true);
    expect(realpathSync).toHaveBeenCalledWith('/home/test/.claude/skills/agents-shared/ct-foo');
  });

  it('does not throw when realpathSync rejects on missing path', () => {
    vi.mocked(realpathSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() =>
      is_canonical('/home/test/.cleo/skills/does-not-exist', {
        manifestNames: ['does-not-exist'],
      }),
    ).not.toThrow();
    // The basename check still works against the un-resolved input.
    expect(
      is_canonical('/home/test/.cleo/skills/does-not-exist', {
        manifestNames: ['does-not-exist'],
      }),
    ).toBe(true);
  });

  it('treats empty manifestNames array as a no-op (no manifest check)', () => {
    expect(
      is_canonical('/home/test/.cleo/skills/ct-lead', {
        manifestNames: [],
      }),
    ).toBe(false);
  });

  it('db short-circuit beats manifest miss', () => {
    // dbSourceType is the strongest signal.
    expect(
      is_canonical('/home/test/random/path/elsewhere', {
        dbSourceType: 'canonical',
        manifestNames: ['some-other-skill'],
      }),
    ).toBe(true);
  });
});

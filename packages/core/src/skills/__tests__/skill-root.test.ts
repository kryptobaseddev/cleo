/**
 * Tests for canonical skills root resolver + is_canonical predicate.
 *
 * @task T9650
 * @epic T9571
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs surface used by the module under test.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    realpathSync: vi.fn((p: string) => p),
  };
});

// Stable homedir + getCleoHome for deterministic path resolution.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

vi.mock('@cleocode/paths', () => ({
  getCleoHome: vi.fn(() => '/home/test/.local/share/cleo'),
}));

import { existsSync, realpathSync } from 'node:fs';
import { _resetLegacyWarningCache, is_canonical, resolveSkillsRoot } from '../skill-root.js';

describe('resolveSkillsRoot — canonical SSoT path helper', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetLegacyWarningCache();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(realpathSync).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns ~/.cleo/skills when no candidate path exists (fresh install)', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.cleo/skills');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns ~/.cleo/skills when present (preferred SSoT wins)', () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/home/test/.cleo/skills');
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.cleo/skills');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('falls back to env-paths XDG when ~/.cleo/skills is absent', () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/home/test/.local/share/cleo/skills');
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.local/share/cleo/skills');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('falls back to legacy ~/.local/share/agents/skills with deprecation warning', () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/home/test/.local/share/agents/skills');
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.local/share/agents/skills');
    expect(stderrSpy).toHaveBeenCalledOnce();
    const msg = stderrSpy.mock.calls[0]?.[0];
    expect(String(msg)).toContain('legacy path');
    expect(String(msg)).toContain('cleo skills doctor');
  });

  it('emits deprecation warning only once per process (cached)', () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/home/test/.local/share/agents/skills');
    resolveSkillsRoot();
    resolveSkillsRoot();
    resolveSkillsRoot();
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('prefers ~/.cleo/skills over BOTH legacy and env-paths when all exist', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const root = resolveSkillsRoot();
    expect(root).toBe('/home/test/.cleo/skills');
    expect(stderrSpy).not.toHaveBeenCalled();
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

  it('returns true for legacy ~/.local/share/agents/skills/* paths', () => {
    expect(is_canonical('/home/test/.local/share/agents/skills/ct-foo')).toBe(true);
  });

  it('returns true for the legacy root itself (boundary)', () => {
    expect(is_canonical('/home/test/.local/share/agents/skills')).toBe(true);
  });

  it('returns false for non-canonical paths with no DI options', () => {
    expect(is_canonical('/home/test/.cleo/skills/random-user-skill')).toBe(false);
  });

  it('resolves symlinks via realpathSync before comparison', () => {
    // Simulate ~/.claude/skills/agents-shared/ct-foo → ~/.local/share/agents/skills/ct-foo
    vi.mocked(realpathSync).mockImplementation((p) => {
      if (p === '/home/test/.claude/skills/agents-shared/ct-foo') {
        return '/home/test/.local/share/agents/skills/ct-foo';
      }
      return String(p);
    });

    expect(is_canonical('/home/test/.claude/skills/agents-shared/ct-foo')).toBe(true);
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

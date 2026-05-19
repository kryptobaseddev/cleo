/**
 * Unit tests for the T9584 `resolveOrCwd` DRY helper.
 *
 * The helper centralizes the long-tail `opts.root ?? process.cwd()` pattern
 * flagged by the T9580 project-root audit. It MUST:
 *
 *  1. Return a caller-provided non-empty string verbatim (no validation, no
 *     walk-up — orchestrate spawn passes canonical roots and a re-walk would
 *     change semantics for explicit overrides).
 *  2. Fall through to {@link getProjectRoot} when the caller passes
 *     `undefined`, `null`, or the empty string — so a missing override
 *     still honours the canonical 5-tier resolution chain
 *     (worktreeScope > CLEO_ROOT > CLEO_DIR > gitlink walk-up > ancestor
 *     walk) instead of silently materialising a rogue `<subdir>/.cleo/`.
 *
 * Tests use real tempdir fixtures + `CLEO_ROOT` overrides; no mocks.
 *
 * @task T9584
 * @related T9580 audit, T9581, T9582, T9583
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectRoot, resolveOrCwd } from '../paths.js';

/**
 * Snapshot + restore the CLEO env vars `resolveOrCwd → getProjectRoot` reads,
 * so tests do not leak state into one another.
 */
function useCleanEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) {
          process.env[key] = val;
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

describe('resolveOrCwd (T9584)', () => {
  let tempBase: string;
  let envGuard: { restore: () => void };

  beforeEach(() => {
    envGuard = useCleanEnv();
    tempBase = join(
      tmpdir(),
      `cleo-resolve-or-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempBase, { recursive: true });
    // Materialise a real project root: .cleo/ + project-info.json + .git/ sibling
    // so `getProjectRoot()` accepts it via the canonical primary path.
    mkdirSync(join(tempBase, '.cleo'), { recursive: true });
    mkdirSync(join(tempBase, '.git'), { recursive: true });
    writeFileSync(
      join(tempBase, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'resolve-or-cwd-fixture' }),
      'utf-8',
    );
  });

  afterEach(() => {
    envGuard.restore();
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('returns the caller-provided root verbatim when non-empty', () => {
    const explicit = '/some/explicit/absolute/path';
    expect(resolveOrCwd(explicit)).toBe(explicit);
  });

  it('does not validate or normalise the caller-provided root', () => {
    // The helper trusts the caller — even a non-existent path is returned
    // as-is. Validation belongs in the caller, not the resolver, because
    // orchestrate spawn already passes canonical roots.
    const fake = '/this/path/does/not/exist/anywhere';
    expect(resolveOrCwd(fake)).toBe(fake);
  });

  it('falls through to getProjectRoot when caller passes undefined', () => {
    process.env['CLEO_ROOT'] = tempBase;
    expect(resolveOrCwd(undefined)).toBe(getProjectRoot());
    expect(resolveOrCwd()).toBe(tempBase);
  });

  it('falls through to getProjectRoot when caller passes null', () => {
    process.env['CLEO_ROOT'] = tempBase;
    expect(resolveOrCwd(null)).toBe(tempBase);
  });

  it('falls through to getProjectRoot when caller passes empty string', () => {
    process.env['CLEO_ROOT'] = tempBase;
    expect(resolveOrCwd('')).toBe(tempBase);
  });

  it('honours an explicit root even when CLEO_ROOT is set', () => {
    // The whole point of the helper: an explicit caller-provided root MUST
    // win over the env-var fallback. This is the "spawn passes canonical
    // root" case — the caller already resolved the root and we must trust
    // it without re-walking.
    process.env['CLEO_ROOT'] = '/some/other/canonical/root';
    const explicit = '/caller/supplied/root';
    expect(resolveOrCwd(explicit)).toBe(explicit);
  });

  it("does not silently swallow a missing project (contract: throws are the caller's problem)", () => {
    // resolveOrCwd is a thin wrapper — when getProjectRoot would throw,
    // resolveOrCwd is allowed to throw too. We only assert that the helper
    // does NOT silently fall back to process.cwd() when an explicit value
    // IS provided (which is the contract that prevents the T9550 bug class).
    delete process.env['CLEO_ROOT'];
    delete process.env['CLEO_PROJECT_ROOT'];
    delete process.env['CLEO_DIR'];
    expect(resolveOrCwd('/explicit')).toBe('/explicit');
  });
});

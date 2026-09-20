/**
 * Guard: every vitest project must actually resolve test files.
 *
 * ## The regression this locks (T12067)
 *
 * Vitest resolves a project's `include` globs against that project's root,
 * which defaults to the directory holding its config. `@cleocode/cleo`
 * declared root-relative globs (`packages/cleo/src/**`) without declaring a
 * `root`, so they expanded to `packages/cleo/packages/cleo/src/**` and matched
 * NOTHING.
 *
 * The failure is silent and total: the project still loads, still appears in
 * `vitest list`, still counts as a member of the run, and contributes zero
 * tests. **281 test files never executed** under `pnpm test`, `pnpm test:pkg`,
 * or the sharded CI job — while CI reported green.
 *
 * Third occurrence of the class:
 *
 *   - T10177 — `scripts/__tests__/*.test.mjs` "silently stopped running in CI shards"
 *   - T11414 — `@cleocode/utils` "silently did not run in CI shards"
 *   - T12067 — `@cleocode/cleo`, 281 files
 *
 * The first two were a missing `projects:` entry, fixable by adding one. This
 * one HAD the entry and still ran nothing — which is why the invariant worth
 * asserting is not "the globs look right" but **"the globs match something"**.
 * That single check catches all three shapes and any future one.
 *
 * @task T12067
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { glob } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Extract the `projects: [...]` entries from the root vitest config.
 *
 * Parsed as text rather than imported: importing the config pulls in the whole
 * vite/svelte plugin chain, which is slow and can fail for reasons unrelated
 * to what this test asserts.
 *
 * @returns project config paths relative to the repo root.
 */
function readProjectPaths() {
  const source = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf-8');
  const block = source.match(/projects:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('vitest.config.ts: no `projects: [...]` array found');
  return [...block[1].matchAll(/['"]([^'"]+vitest\.config\.[cm]?[jt]s)['"]/g)].map((m) => m[1]);
}

/**
 * Extract the string literals of a project config's `include: [...]` array.
 *
 * @param source - the project config source.
 * @returns the glob strings, or `null` when the config declares no `include`.
 */
function readIncludeGlobs(source) {
  const block = source.match(/\n\s*include:\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * Resolve a project's EFFECTIVE root.
 *
 * A config may pin `root: resolve(import.meta.dirname, '../..')` to run from
 * the monorepo root (`@cleocode/cleo` does, because its tests are written
 * against that cwd). Otherwise the root is the config's own directory.
 *
 * @param source     - the project config source.
 * @param projectDir - repo-relative directory holding the config.
 * @returns absolute effective root.
 */
function resolveEffectiveRoot(source, projectDir) {
  const pinned = source.match(/\broot:\s*resolve\(\s*import\.meta\.dirname\s*,\s*'([^']+)'\s*\)/);
  if (pinned) return resolve(repoRoot, projectDir, pinned[1]);
  return join(repoRoot, projectDir);
}

describe('every vitest project resolves test files (T12067)', () => {
  const projectPaths = readProjectPaths();

  it('finds every attached project config', () => {
    expect(projectPaths.length).toBeGreaterThan(15);
  });

  for (const configPath of projectPaths) {
    it(`${configPath} matches at least one test file`, async () => {
      const source = readFileSync(join(repoRoot, configPath), 'utf-8');
      const globs = readIncludeGlobs(source);
      if (globs === null) return; // inherits the root include — nothing to check

      const projectDir = dirname(configPath);
      const cwd = resolveEffectiveRoot(source, projectDir);

      const matches = [];
      for await (const entry of glob(globs, {
        cwd,
        exclude: (name) => name === 'node_modules' || name === 'dist',
      })) {
        matches.push(entry);
      }

      expect(
        matches.length,
        `${configPath} matches NO test files.\n` +
          `  effective root: ${cwd}\n` +
          `  include:        ${JSON.stringify(globs)}\n` +
          "Vitest resolves include against the project root (the config's own\n" +
          'directory unless `root:` is set), so root-relative globs in a config\n' +
          'that does not pin `root` expand to <dir>/<dir>/… and match nothing.\n' +
          'The project then reports as a passing member of the run while\n' +
          'contributing zero tests — the T12067 failure mode.',
      ).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// T12067 — quarantine integrity
// ---------------------------------------------------------------------------

describe('@cleocode/cleo test quarantine (T12067)', () => {
  /**
   * Load the quarantine list by parsing its source. Importing the `.ts` module
   * from a `.mjs` test would need a transform step this project does not run
   * for `scripts/`.
   */
  function readQuarantine() {
    const source = readFileSync(join(repoRoot, 'packages/cleo/vitest.quarantine.ts'), 'utf-8');
    const arr = source.match(/CLEO_TEST_QUARANTINE:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\n\];/);
    const baseline = source.match(/CLEO_TEST_QUARANTINE_BASELINE\s*=\s*(\d+)/);
    // Strip line comments before pairing quotes: an apostrophe inside a
    // comment ("the section's tmp file") desynchronises the quote pairing and
    // turns every subsequent entry into garbage — which reads as "all 74
    // quarantined files are missing" rather than as a parse bug.
    const body = arr ? arr[1].replace(/\/\/[^\n]*/g, '') : '';
    return {
      files: [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]),
      baseline: baseline ? Number(baseline[1]) : Number.NaN,
    };
  }

  it('every quarantined path still exists', () => {
    const { files } = readQuarantine();
    const missing = files.filter((f) => !existsSync(join(repoRoot, f)));
    expect(
      missing,
      'A quarantined test file was deleted or moved without releasing its slot.\n' +
        'Remove the entry (and decrement CLEO_TEST_QUARANTINE_BASELINE) instead of\n' +
        'leaving a dead path that silently keeps the count up.',
    ).toEqual([]);
  });

  it('never grows past the baseline recorded when discovery was fixed', () => {
    const { files, baseline } = readQuarantine();
    expect(
      files.length,
      'The quarantine is closed to additions — it bounds damage that already\n' +
        'existed when the 281 never-run cleo tests were switched on (T12067).\n' +
        'A newly-failing test must be fixed, not quarantined. If you repaired a\n' +
        'file, remove it AND decrement CLEO_TEST_QUARANTINE_BASELINE.',
    ).toBeLessThanOrEqual(baseline);
  });

  it('is referenced by the cleo vitest config', () => {
    const config = readFileSync(join(repoRoot, 'packages/cleo/vitest.config.ts'), 'utf-8');
    expect(config).toContain('CLEO_TEST_QUARANTINE');
  });
});

describe('test runtime store isolation (T9579)', () => {
  it('replaces inherited host roots before imports and keeps sentinels untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-isolation-host-sentinel-'));
    const names = [
      'HOME',
      'USERPROFILE',
      'TMPDIR',
      'TMP',
      'TEMP',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'CLEO_HOME',
      'CLEO_CONFIG_HOME',
      'CLEO_ROOT',
      'CLEO_PROJECT_ROOT',
      'CLEO_DIR',
      'AGENTS_HOME',
      'NEXUS_HOME',
      'NEXUS_CACHE_DIR',
    ];
    const env = { ...process.env };
    for (const name of names) {
      const sentinel = join(root, name);
      mkdirSync(sentinel);
      writeFileSync(join(sentinel, 'sentinel'), 'preserve original bytes');
      env[name] = sentinel;
    }
    let isolated;
    try {
      const script = `
        await import(${JSON.stringify(new URL('../../vitest.setup.ts', import.meta.url).href)});
        delete process.env.VITEST;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const roots = Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]]));
        for (const path of Object.values(roots)) {
          if (typeof path !== 'string') continue;
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, 'probe'), 'isolated write');
        }
        process.stdout.write(JSON.stringify(roots));
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env,
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(child.status, child.stderr).toBe(0);
      isolated = JSON.parse(child.stdout);
      for (const name of names) {
        expect(isolated[name]).not.toBe(env[name]);
        expect(readdirSync(env[name])).toEqual(['sentinel']);
        expect(readFileSync(join(env[name], 'sentinel'), 'utf8')).toBe('preserve original bytes');
      }
      expect(isolated.CLEO_PROJECT_ROOT).toBeUndefined();
      expect(isolated.CLEO_DIR).toBe(join(isolated.CLEO_ROOT, '.cleo'));
    } finally {
      if (isolated?.CLEO_HOME !== env.CLEO_HOME && isolated?.CLEO_HOME)
        rmSync(isolated.CLEO_HOME, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it
    .runIf(process.platform !== 'win32' && existsSync('/var/tmp'))
    .each(['direct', 'nested', 'symlink'])(
    'selects the physical /var/tmp base before sanitizing %s inherited temp aliases',
    (kind) => {
      const base = realpathSync('/var/tmp');
      const root = mkdtempSync(join(base, 'cleo-inherited-temp-test-'));
      const requested = join(root, 'requested');
      const home = join(root, 'host-home');
      mkdirSync(requested);
      mkdirSync(home);
      writeFileSync(join(home, 'sentinel'), 'unchanged host bytes');
      const alias = join(root, 'alias');
      symlinkSync(requested, alias, 'dir');
      const inheritedTemp = kind === 'direct' ? base : kind === 'nested' ? requested : alias;
      const env = {
        ...process.env,
        TMPDIR: inheritedTemp,
        TMP: inheritedTemp,
        TEMP: inheritedTemp,
        HOME: home,
        USERPROFILE: home,
        CLEO_ROOT: home,
        CLEO_PROJECT_ROOT: home,
        CLEO_DIR: home,
      };
      let isolated;
      try {
        const script = `
        await import(${JSON.stringify(new URL('../../vitest.setup.ts', import.meta.url).href)});
        const { realpathSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        process.stdout.write(JSON.stringify({
          root: realpathSync(process.env.CLEO_HOME), tmp: realpathSync(tmpdir()),
          roots: Object.fromEntries(['HOME','USERPROFILE','TMPDIR','TMP','TEMP','XDG_DATA_HOME',
            'XDG_CONFIG_HOME','XDG_CACHE_HOME','CLEO_ROOT','CLEO_DIR','NEXUS_HOME','AGENTS_HOME']
            .map(key => [key,realpathSync(process.env[key])])),
          allowed:process.env.CLEO_TEST_ALLOWED_DB_ROOTS,
          inheritedProjectAlias:process.env.CLEO_PROJECT_ROOT,
          nodeOptions:process.env.NODE_OPTIONS,
        }));
      `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          env,
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(child.status, child.stderr).toBe(0);
        isolated = JSON.parse(child.stdout);
        expect(dirname(isolated.root)).toBe(base);
        expect(isolated.tmp).toBe(join(isolated.root, 'tmp'));
        expect(isolated.allowed).toBe(isolated.root);
        expect(isolated.inheritedProjectAlias).toBeUndefined();
        expect(isolated.nodeOptions).toBe(env.NODE_OPTIONS);
        for (const path of Object.values(isolated.roots))
          expect(path.startsWith(`${isolated.root}/`)).toBe(true);
        expect(readdirSync(requested)).toEqual([]);
        expect(readdirSync(home)).toEqual(['sentinel']);
        expect(readFileSync(join(home, 'sentinel'), 'utf8')).toBe('unchanged host bytes');
      } finally {
        if (isolated?.root) rmSync(isolated.root, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32' && existsSync('/var/tmp'))(
    'resolves symlinks before choosing the permitted temporary filesystem',
    () => {
      const root = mkdtempSync(join(realpathSync('/var/tmp'), 'cleo-temp-alias-test-'));
      const target = mkdtempSync('/tmp/cleo-host-like-temp-');
      const alias = join(root, 'alias');
      symlinkSync(target, alias, 'dir');
      writeFileSync(join(target, 'sentinel'), 'original bytes');
      let isolated;
      try {
        const script = `
        await import(${JSON.stringify(new URL('../../vitest.setup.ts', import.meta.url).href)});
        process.stdout.write(JSON.stringify({root:process.env.CLEO_HOME}));
      `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias },
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(child.status, child.stderr).toBe(0);
        isolated = JSON.parse(child.stdout);
        expect(dirname(realpathSync(isolated.root))).toBe(realpathSync('/tmp'));
        expect(readdirSync(target)).toEqual(['sentinel']);
        expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('original bytes');
      } finally {
        if (isolated?.root) rmSync(isolated.root, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it('allows only the exact sandbox for global SQLite while rejecting an outside host-like path', async () => {
    const { openNativeDatabase } = await import('../../packages/core/src/store/sqlite-native.ts');
    const outside = mkdtempSync(join(dirname(process.env.CLEO_HOME), 'cleo-outside-fork-'));
    const allowed = join(process.env.CLEO_HOME, 'isolation-guard-probe.db');
    try {
      expect(process.env.CLEO_TEST_ALLOWED_DB_ROOTS).toBe(process.env.CLEO_HOME);
      expect(() => openNativeDatabase(join(outside, 'host.db'))).toThrow('test isolation guard');
      expect(existsSync(join(outside, 'host.db'))).toBe(false);
      const db = openNativeDatabase(allowed);
      db.close();
      expect(existsSync(allowed)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${allowed}${suffix}`, { force: true });
    }
  });

  it('delivers an absolute setup path through the shared defaults', async () => {
    const { MEMORY_SAFE_TEST_DEFAULTS } = await import('../../vitest.memory-safe.ts');
    expect(MEMORY_SAFE_TEST_DEFAULTS.setupFiles).toEqual([join(repoRoot, 'vitest.setup.ts')]);
  });
});

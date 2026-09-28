/**
 * `tool:typecheck` must check something (T12633).
 *
 * Measured in this repository: the root `tsconfig.json` is references-only
 * (`"files": []` plus `references`), and `tool:typecheck` resolved to the node
 * default `npx tsc --noEmit` — which, outside build mode, compiles ZERO files
 * for such a config and exits 0 in 0.34s. The project's real typecheck is its
 * `typecheck` script, `tsc -b`. Every `qaPassed` recorded with
 * `tool:typecheck` had been validated against a no-op.
 *
 * These fixtures run the real TypeScript compiler (linked from the workspace),
 * because the defect is a fact about what `tsc` does with a config — a mocked
 * compiler would only restate the assumption under test.
 *
 * @task T12633
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAtom } from '../evidence.js';
import { captureDirtyFingerprint } from '../tool-cache.js';
import { resolveToolCommand } from '../tool-resolver.js';

const TYPESCRIPT_DIR = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'tool-vacuity-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
});

// Each fixture is its own synthetic project root.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_EVIDENCE_FRESH', '1');
});
afterEach(() => vi.unstubAllEnvs());

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tool-vacuity-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Record<string, unknown>): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Link the workspace TypeScript so `npx tsc` resolves locally, offline. */
function linkTypescript(): void {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(TYPESCRIPT_DIR, join(root, 'node_modules', 'typescript'), 'dir');
  symlinkSync('../typescript/bin/tsc', join(root, 'node_modules', '.bin', 'tsc'));
}

function initRepo(): void {
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
  };
  write('.gitignore', 'node_modules\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
}

/**
 * The shape of this repository: a references-only root config over a composite
 * package that contains a type error.
 */
function referencesOnlyMonorepo(): void {
  write('.cleo/project-context.json', { primaryType: 'node' });
  write('package.json', { name: 'fixture', private: true });
  write('tsconfig.json', {
    compilerOptions: { strict: true, noEmit: true },
    files: [],
    references: [{ path: './packages/a' }],
  });
  write('packages/a/tsconfig.json', {
    compilerOptions: { composite: true, strict: true, outDir: 'dist' },
    include: ['src'],
  });
  write('packages/a/src/index.ts', 'export const n: number = "not a number";\n');
  linkTypescript();
}

describe('references-only root tsconfig (the measured defect)', () => {
  it('tool:typecheck FAILS on a type error in a referenced package', async () => {
    referencesOnlyMonorepo();
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);

    // On the broken resolver this was `ok: true` — `npx tsc --noEmit` checked
    // nothing and exited 0.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(r.reason).toContain('TS2322');
  }, 60_000);

  it('the language default switches to build mode', () => {
    referencesOnlyMonorepo();
    const r = resolveToolCommand('typecheck', root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command.source).toBe('language-default');
    // Emitting build mode: `-b --noEmit` breaks composite chains (TS6310).
    expect(r.command.args).toEqual(['tsc', '-b']);
  });
});

/**
 * A composite CHAIN: b references a, the root references both. This is the
 * shape `tsc -b --noEmit` rejects with TS6310 on correct code.
 */
function chainedMonorepo(bSource: string): void {
  write('.cleo/project-context.json', { primaryType: 'node' });
  write('package.json', { name: 'fixture', private: true });
  write('tsconfig.json', {
    files: [],
    references: [{ path: './packages/a' }, { path: './packages/b' }],
  });
  write('packages/a/tsconfig.json', {
    compilerOptions: {
      composite: true,
      strict: true,
      module: 'nodenext',
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src'],
  });
  write('packages/a/src/index.ts', 'export const one: number = 1;\n');
  write('packages/b/tsconfig.json', {
    compilerOptions: {
      composite: true,
      strict: true,
      module: 'nodenext',
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src'],
    references: [{ path: '../a' }],
  });
  write('packages/b/src/index.ts', bSource);
  linkTypescript();
}

describe('chained composite projects', () => {
  it('correct code PASSES (no TS6310 from a no-emit build)', async () => {
    chainedMonorepo(
      'import { one } from "../../a/dist/index.js";\nexport const two: number = one + 1;\n',
    );
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r).toMatchObject({ ok: true });
  }, 60_000);

  it('a type error in the dependent project still FAILS', async () => {
    chainedMonorepo(
      'import { one } from "../../a/dist/index.js";\nexport const two: string = one;\n',
    );
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  }, 60_000);

  it('untracked build output does not move the dirty-tree fingerprint', async () => {
    chainedMonorepo('export const two: number = 2;\n');
    initRepo();
    const before = await captureDirtyFingerprint(root);

    await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);

    expect(await captureDirtyFingerprint(root)).toBe(before);
  }, 60_000);
});

describe('package.json scripts are preferred over language defaults', () => {
  it('runs the typecheck script through the declared package manager', () => {
    write('.cleo/project-context.json', { primaryType: 'node' });
    write('package.json', {
      name: 'fixture',
      packageManager: 'pnpm@10.30.0',
      scripts: { pretypecheck: 'node prep.js', typecheck: 'tsc -b' },
    });
    write('tsconfig.json', {});

    const r = resolveToolCommand('typecheck', root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command.cmd).toBe('pnpm');
    expect(r.command.args).toEqual(['run', 'typecheck']);
    expect(r.command.source).toBe('package-script');
  });

  it('picks the package manager from the lockfile', () => {
    write('.cleo/project-context.json', { primaryType: 'node' });
    write('package.json', { name: 'fixture', scripts: { lint: 'eslint .' } });
    write('yarn.lock', '');

    const r = resolveToolCommand('lint', root);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.command.cmd, ...r.command.args]).toEqual(['yarn', 'run', 'lint']);
  });

  it('reads scripts from the execution root, not the store root', () => {
    write('.cleo/project-context.json', { primaryType: 'node' });
    write('package.json', { name: 'store' });
    const tree = mkdtempSync(join(tmpdir(), 'tool-vacuity-tree-'));
    try {
      writeFileSync(
        join(tree, 'package.json'),
        JSON.stringify({ name: 'tree', scripts: { build: 'make' } }),
      );
      const r = resolveToolCommand('build', root, { executionRoot: tree });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.command.source).toBe('package-script');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('falls back to npm when the declared package manager is not installed', () => {
    write('.cleo/project-context.json', { primaryType: 'node' });
    write('package.json', {
      name: 'fixture',
      packageManager: 'pnpm@10.30.0',
      scripts: { test: 'vitest run' },
    });
    const bin = join(root, 'fake-bin');
    mkdirSync(bin);
    vi.stubEnv('PATH', bin);

    const missing = resolveToolCommand('test', root);
    expect(missing.ok && missing.command.cmd).toBe('npm');

    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\n');
    chmodSync(join(bin, 'pnpm'), 0o755);
    const present = resolveToolCommand('test', root);
    expect(present.ok && present.command.cmd).toBe('pnpm');
  });

  it('an explicit project-context command still wins over the script', () => {
    write('.cleo/project-context.json', {
      primaryType: 'node',
      typecheck: { command: 'make typecheck' },
    });
    write('package.json', { name: 'fixture', scripts: { typecheck: 'tsc -b' } });

    const r = resolveToolCommand('typecheck', root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command.cmd).toBe('make');
    expect(r.command.source).toBe('project-context');
  });
});

describe('vacuity guard (E_EVIDENCE_TOOL_VACUOUS)', () => {
  it('fires for a declared non-build tsc against a references-only config', async () => {
    referencesOnlyMonorepo();
    write('.cleo/project-context.json', {
      primaryType: 'node',
      typecheck: { command: 'npx tsc --noEmit' },
    });
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TOOL_VACUOUS');
    expect(r.reason).toContain('tsc -b');
  }, 60_000);

  it('fires for a package script whose tsc step is vacuous', async () => {
    referencesOnlyMonorepo();
    write('package.json', { name: 'fixture', scripts: { typecheck: 'tsc --noEmit' } });
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_TOOL_VACUOUS');
  }, 60_000);

  it('does NOT fire when the script also has a build-mode tsc step', async () => {
    chainedMonorepo('export const two: number = 2;\n');
    write('package.json', {
      name: 'fixture',
      scripts: { typecheck: 'tsc --noEmit -p tsconfig.json && tsc -b' },
    });
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r).toMatchObject({ ok: true });
  }, 60_000);

  it('fires via the --listFilesOnly probe when the config is not statically provable', async () => {
    // `extends` names a PACKAGE, so the static check cannot follow it and
    // fails open; the probe asks tsc itself and gets zero files.
    referencesOnlyMonorepo();
    write('node_modules/@fixture/base/tsconfig.json', { compilerOptions: { strict: true } });
    write('tsconfig.json', {
      extends: '@fixture/base/tsconfig.json',
      files: [],
      references: [{ path: './packages/a' }],
    });
    write('.cleo/project-context.json', {
      primaryType: 'node',
      typecheck: { command: 'npx tsc --noEmit' },
    });
    initRepo();

    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TOOL_VACUOUS');
    expect(r.reason).toContain('--listFilesOnly');
  }, 60_000);
});

describe('a normal single-tsconfig project is unchanged', () => {
  function singleProject(source: string): void {
    write('.cleo/project-context.json', { primaryType: 'node' });
    write('package.json', { name: 'fixture', private: true });
    write('tsconfig.json', { compilerOptions: { strict: true, noEmit: true }, include: ['src'] });
    write('src/index.ts', source);
    linkTypescript();
    initRepo();
  }

  it('still resolves to `npx tsc --noEmit`', () => {
    singleProject('export const n: number = 1;\n');
    const r = resolveToolCommand('typecheck', root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.command.cmd, ...r.command.args]).toEqual(['npx', 'tsc', '--noEmit']);
    expect(r.command.source).toBe('language-default');
  });

  it('passes clean code', async () => {
    singleProject('export const n: number = 1;\n');
    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r).toMatchObject({ ok: true });
  }, 60_000);

  it('fails a type error', async () => {
    singleProject('export const n: number = "x";\n');
    const r = await validateAtom({ kind: 'tool', tool: 'typecheck' }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  }, 60_000);
});

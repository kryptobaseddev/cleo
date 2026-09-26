/**
 * Native vs WebAssembly (WASI) parity for the cant-napi addon (T12382).
 *
 * `@cleocode/cant` ships one native binary per OS/CPU plus a
 * `wasm32-wasip1-threads` build of the SAME crate, and the napi-rs generated
 * loader falls back to the WASI build when no native binary matches. This
 * test proves the fallback is not a degraded parser: every `.cant` and
 * `.cantbook` file tracked in the repository parses, validates and extracts
 * to byte-identical JSON through both backends.
 *
 * Each backend runs in a fresh child process (see
 * `fixtures/cant-addon-probe.cjs`), because Node caches `require()` per
 * process and the backend choice is made once, at load time.
 *
 * Needs both artifacts in `packages/cant/napi/`
 * (`pnpm --filter @cleocode/cant build:napi` and `build:napi:wasi`). When
 * they are absent the suite is skipped, UNLESS `CANT_REQUIRE_WASI_PARITY=1`
 * (set by `.github/workflows/cant-napi-build.yml`), where absence fails.
 *
 * @task T12382
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const NAPI_DIR = join(PACKAGE_ROOT, 'napi');
const PROBE = join(__dirname, 'fixtures', 'cant-addon-probe.cjs');
const WASM = join(NAPI_DIR, 'cant.wasm32-wasi.wasm');

const artifactsPresent = existsSync(join(NAPI_DIR, 'index.cjs')) && existsSync(WASM);
const required = process.env['CANT_REQUIRE_WASI_PARITY'] === '1';

/** A file handed to the probe. */
interface ProbeFile {
  relative: string;
  absolute: string;
}

/** What the probe prints. */
interface ProbeOutput {
  backend: string;
  buildInfo: string;
  classify: string[];
  results: Record<string, unknown>;
  pipeline: { success: boolean; error?: string | null };
}

const scratch = mkdtempSync(join(tmpdir(), 'cant-parity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Directories never searched when git is unavailable (build output, deps). */
const WALK_SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'napi']);

/**
 * Walk the tree for `.cant` / `.cantbook` files. Used only when the checkout
 * has no git metadata (e.g. an exported source tree).
 *
 * @param dir - Absolute directory to walk.
 */
function walkCantFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkCantFiles(path));
    else if (/\.(cant|cantbook)$/.test(entry.name)) found.push(relative(REPO_ROOT, path));
  }
  return found;
}

/** Every tracked `.cant` / `.cantbook` file, repo-relative and sorted. */
function trackedCantFiles(): ProbeFile[] {
  let paths: string[];
  try {
    paths = execFileSync('git', ['ls-files', '-z', '--', '*.cant', '*.cantbook'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    paths = walkCantFiles(REPO_ROOT);
  }
  return paths.sort().map((rel) => ({ relative: rel, absolute: join(REPO_ROOT, rel) }));
}

/**
 * Run the probe in a child process with the given WASI mode.
 *
 * @param files - Files to parse and validate.
 * @param forceWasi - When true, `NAPI_RS_FORCE_WASI=error` forces the WASI build.
 */
function runProbe(files: ProbeFile[], forceWasi: boolean): ProbeOutput {
  const listFile = join(scratch, 'files.json');
  writeFileSync(listFile, JSON.stringify(files));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env['NAPI_RS_FORCE_WASI'];
  if (forceWasi) env['NAPI_RS_FORCE_WASI'] = 'error';
  const stdout = execFileSync(process.execPath, [PROBE, listFile], {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed: ProbeOutput = JSON.parse(stdout);
  return parsed;
}

describe.skipIf(!artifactsPresent && !required)('cant-napi native vs WASI parity (T12382)', () => {
  it('has both the native binary and the WASI build available', () => {
    expect(existsSync(join(NAPI_DIR, 'index.cjs'))).toBe(true);
    expect(existsSync(WASM)).toBe(true);
  });

  const files = artifactsPresent ? trackedCantFiles() : [];
  const native = artifactsPresent ? runProbe(files, false) : null;
  const wasi = artifactsPresent ? runProbe(files, true) : null;

  it('covers every tracked .cant and .cantbook file', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.relative.endsWith('.cantbook'))).toBe(true);
    expect(Object.keys(native?.results ?? {})).toEqual(files.map((f) => f.relative));
  });

  it('loads the native binary by default and the WASI build under NAPI_RS_FORCE_WASI=error', () => {
    expect(native?.backend).toBe('native');
    expect(wasi?.backend).toBe('wasi');
    // Same source, same stamp: the two artifacts come from one build of one crate.
    expect(wasi?.buildInfo).toBe(native?.buildInfo);
  });

  it('parses, validates and extracts every file identically', () => {
    for (const file of files) {
      expect(wasi?.results[file.relative], file.relative).toEqual(native?.results[file.relative]);
    }
    expect(JSON.stringify(wasi?.results)).toBe(JSON.stringify(native?.results));
  });

  it('classifies directives identically', () => {
    expect(wasi?.classify).toEqual(native?.classify);
  });

  it('reports pipelines as unsupported under WASI instead of throwing', () => {
    expect(wasi?.pipeline.success).toBe(false);
    expect(wasi?.pipeline.error).toMatch(/unavailable in the WebAssembly \(WASI\) build/);
  });
});

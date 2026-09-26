/**
 * The two user-facing `.cant` consumers work with NO native binary (T12382).
 *
 * Before T12382 only `cant.linux-x64-gnu.node` shipped, so on macOS, Windows
 * and ARM Linux every `.cant` parse threw, breaking `cleo cant *` and CAAMP's
 * Pi harness (`PiHarness.validateCantProfile`, used by `caamp pi cant
 * validate|install`). This suite runs both through the BUILT packages in a
 * child process with `NAPI_RS_FORCE_WASI=error`, under which the napi-rs
 * generated loader never touches a native binary and fails unless the
 * WebAssembly build loads: exactly the situation of a platform with no
 * matching `.node`. Each run is compared with the native run of the same
 * input, so "works" means "gives the same answer", not merely "exits 0".
 *
 * Needs the built CLI/CAAMP (`pnpm run build`) and both addon artifacts
 * (`pnpm --filter @cleocode/cant build:napi` + `build:napi:wasi`). Skipped
 * when they are absent, unless `CANT_REQUIRE_WASI_PARITY=1` (set by
 * `.github/workflows/cant-napi-build.yml`), where absence fails.
 *
 * Every child runs with HOME/XDG/CLEO_HOME pointed at a scratch directory
 * and a scratch cwd, so no real CLEO store or user config is touched.
 *
 * @task T12382
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const CLEO_BIN = join(REPO_ROOT, 'packages', 'cleo', 'bin', 'cleo.js');
const CAAMP_DIST = join(REPO_ROOT, 'packages', 'caamp', 'dist', 'index.js');
const CANT_DIST = join(PACKAGE_ROOT, 'dist', 'index.js');
const WASM = join(PACKAGE_ROOT, 'napi', 'cant.wasm32-wasi.wasm');
/** A real agent that parses and validates cleanly. */
const REAL_AGENT = join(
  REPO_ROOT,
  'crates',
  'cant-core',
  'tests',
  'fixtures',
  'render-round-trip',
  'sample-agent-worker.cant',
);
/** A real shipped agent that currently FAILS to parse: exercises the error path. */
const UNPARSEABLE_AGENT = join(REPO_ROOT, 'packages', 'agents', 'cleo-subagent.cant');
/** Child processes start Node and load a WASM module; allow for slow runners. */
const CHILD_TIMEOUT_MS = 120_000;

const prerequisites = [
  join(PACKAGE_ROOT, 'napi', 'index.cjs'),
  WASM,
  join(REPO_ROOT, 'packages', 'cleo', 'dist'),
  CAAMP_DIST,
  CANT_DIST,
  REAL_AGENT,
  UNPARSEABLE_AGENT,
];
const ready = prerequisites.every((p) => existsSync(p));
const required = process.env['CANT_REQUIRE_WASI_PARITY'] === '1';

const scratch = mkdtempSync(join(tmpdir(), 'cant-wasi-consumers-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A minimal agent that fails one validation rule, so diagnostics are exercised. */
const INVALID_AGENT = [
  '---',
  'kind: agent',
  'version: 1',
  '---',
  '',
  'agent wasi-probe:',
  '  role: worker',
  '  description: "Probe agent without a parent (TEAM-003)"',
  '',
].join('\n');

/**
 * Build an isolated environment: no real HOME, XDG dirs or CLEO store.
 *
 * @param forceWasi - Force the WebAssembly build via `NAPI_RS_FORCE_WASI=error`.
 */
function isolatedEnv(forceWasi: boolean): NodeJS.ProcessEnv {
  const home = join(scratch, forceWasi ? 'home-wasi' : 'home-native');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CLEO_HOME: join(home, '.cleo-home'),
    NODE_NO_WARNINGS: '1',
  };
  delete env['NAPI_RS_FORCE_WASI'];
  if (forceWasi) env['NAPI_RS_FORCE_WASI'] = 'error';
  return env;
}

/** Shape of the LAFS envelope `cleo` prints (the part this test reads). */
interface Envelope {
  success: boolean;
  data?: Record<string, unknown>;
  error?: unknown;
}

/**
 * Run `cleo cant <verb> <file>` and return its envelope.
 *
 * @param verb - `parse` or `validate`.
 * @param file - Absolute path of the `.cant` file.
 * @param forceWasi - Force the WebAssembly build.
 */
function runCleoCant(verb: string, file: string, forceWasi: boolean): Envelope {
  const cwd = join(scratch, 'cwd');
  mkdirSync(cwd, { recursive: true });
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [CLEO_BIN, 'cant', verb, file], {
      cwd,
      env: isolatedEnv(forceWasi),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit still prints an envelope; surface it for the assertion.
    stdout =
      err !== null && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string'
        ? err.stdout
        : '';
  }
  const envelope: Envelope = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
  return envelope;
}

/** What the CAAMP child prints. */
interface HarnessProbe {
  backend: string | null;
  results: Record<string, unknown>;
}

/**
 * Run `PiHarness.validateCantProfile` from the built CAAMP package.
 *
 * @param files - Absolute `.cant` paths to validate.
 * @param forceWasi - Force the WebAssembly build.
 */
function runPiHarnessValidate(files: string[], forceWasi: boolean): HarnessProbe {
  const script = [
    `const caamp = await import(${JSON.stringify(pathToFileURL(CAAMP_DIST).href)});`,
    `const cant = await import(${JSON.stringify(pathToFileURL(CANT_DIST).href)});`,
    "const harness = new caamp.PiHarness(caamp.getProvider('pi'));",
    'const results = {};',
    `for (const f of ${JSON.stringify(files)}) results[f] = await harness.validateCantProfile(f);`,
    'process.stdout.write(JSON.stringify({ backend: cant.cantAddonBackend(), results }));',
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(scratch, 'cwd'),
    env: isolatedEnv(forceWasi),
    encoding: 'utf8',
  });
  const parsed: HarnessProbe = JSON.parse(stdout);
  return parsed;
}

describe.skipIf(!ready && !required)('.cant consumers without a native binary (T12382)', () => {
  const invalidAgent = join(scratch, 'wasi-probe.cant');
  writeFileSync(invalidAgent, INVALID_AGENT);
  mkdirSync(join(scratch, 'cwd'), { recursive: true });

  it('has every prerequisite built', () => {
    for (const p of prerequisites) expect(existsSync(p), p).toBe(true);
  });

  it('cleo cant validate works under WASI and matches native', () => {
    for (const file of [REAL_AGENT, UNPARSEABLE_AGENT, invalidAgent]) {
      const wasi = runCleoCant('validate', file, true);
      const native = runCleoCant('validate', file, false);
      expect(wasi.success, JSON.stringify(wasi.error)).toBe(true);
      expect(wasi.data).toEqual(native.data);
      expect(wasi.data).toHaveProperty('valid');
    }
    // The invalid probe really produces diagnostics through WASI.
    const probe = runCleoCant('validate', invalidAgent, true);
    expect(probe.data?.['valid']).toBe(false);
    expect(JSON.stringify(probe.data)).toContain('TEAM-003');
  }, CHILD_TIMEOUT_MS);

  it('cleo cant parse works under WASI and matches native', () => {
    const wasi = runCleoCant('parse', REAL_AGENT, true);
    const native = runCleoCant('parse', REAL_AGENT, false);
    expect(wasi.success, JSON.stringify(wasi.error)).toBe(true);
    expect(wasi.data?.['success']).toBe(true);
    expect(wasi.data).toEqual(native.data);
  }, CHILD_TIMEOUT_MS);

  it('the Pi harness validate path works under WASI and matches native', () => {
    const files = [REAL_AGENT, UNPARSEABLE_AGENT, invalidAgent];
    const wasi = runPiHarnessValidate(files, true);
    const native = runPiHarnessValidate(files, false);
    expect(wasi.backend).toBe('wasi');
    expect(native.backend).toBe('native');
    expect(wasi.results).toEqual(native.results);
    expect(JSON.stringify(wasi.results[invalidAgent])).toContain('TEAM-003');
  }, CHILD_TIMEOUT_MS);
});

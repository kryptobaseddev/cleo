#!/usr/bin/env node
/**
 * release-canary-soak.mjs — install a published version into a sandbox and check its health (T13144).
 *
 * ## Where it sits
 *
 * A stable release publishes a release candidate `<version>-rc.<n>` to the
 * `canary` dist-tag first, and `<version>` reaches `latest` only once that
 * candidate passes this gate (release.yml Publish, T13181). The registry checks
 * (execute-payload.mjs, release-installability-watch.mjs) prove that each
 * package RESOLVES (metadata, tarball, dist-tag) and say plainly that the
 * installed contents remain unverified. This script covers the installed
 * contents: it installs `@cleocode/cleo@<version>` the way users do
 * (`npm install --global`) into a throwaway prefix, then runs the installed
 * binary against throwaway stores.
 *
 * release.yml's Publish job runs it against the release candidate installed
 * from npm, so a candidate that installs but cannot start, or that pulls a
 * mixed set of @cleocode versions, never becomes `latest`. Run it locally too:
 *
 *   node scripts/release-canary-soak.mjs                      # the current canary
 *   node scripts/release-canary-soak.mjs --version 2026.10.5
 *
 * ## Isolation
 *
 * Everything lives under one mkdtemp directory: the npm prefix and cache, HOME,
 * CLEO_HOME, the provider homes and the project (lib/sandbox-env.mjs). Nothing
 * from the caller's environment reaches the installed CLI except PATH. The
 * directory is removed afterwards unless `--keep` is passed. POSIX only: the
 * global-install layout (`<prefix>/bin`, `<prefix>/lib/node_modules`) differs
 * on Windows.
 *
 * Exit codes: 0 every check passed; 1 a check failed; 2 bad arguments, or the
 * version could not be resolved.
 *
 * @task T13144
 * @epic T13139
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { REGISTRY } from './execute-payload.mjs';
import { isMain } from './lib/is-main.mjs';
import { sandboxEnvironment } from './lib/sandbox-env.mjs';

/** A CalVer version, stable or prerelease. Anything else never reaches npm. */
export const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** Budget for the global install: about 300 packages, some with install scripts. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Budget for each installed-CLI command. */
export const CLI_TIMEOUT_MS = 120_000;

/** Title of the epic the soak writes and reads back. */
export const SOAK_EPIC_TITLE = 'Canary soak epic';

const SOAK_ACCEPTANCE = 'installs|starts|writes|reads|finds';

/**
 * @typedef {object} RunResult
 * @property {number | null} status - Exit code, null when killed.
 * @property {string | null} signal - Terminating signal, if any.
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error} [error] - Spawn failure or timeout.
 */

/**
 * @typedef {object} SoakContext
 * @property {string} version - The version under test.
 * @property {string} root - The sandbox root.
 * @property {string} prefix - The npm global prefix inside the sandbox.
 * @property {string} bin - The installed `cleo` executable.
 * @property {string} installDir - The installed `@cleocode/cleo` package directory.
 * @property {string} project - The sandbox project directory.
 * @property {NodeJS.ProcessEnv} env - The child environment.
 * @property {string} [sagaId] - Set by the `saga-create` check.
 * @property {string} [epicId] - Set by the `epic-create` check.
 */

/**
 * @typedef {object} SoakCheck
 * @property {string} name
 * @property {(ctx: SoakContext) => [string, string[], number?]} [command] - File, arguments
 *   and optional timeout. A check without a command only inspects the sandbox.
 * @property {(result: RunResult | null, ctx: SoakContext) => string} verify - Returns a
 *   one-line detail, throws when the check fails.
 */

/**
 * Run one command without a shell, bounded by a timeout.
 *
 * @param {string} file - Executable.
 * @param {string[]} args - Literal argument vector.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }} options
 * @returns {RunResult}
 */
export function runCommand(file, args, { cwd, env, timeoutMs }) {
  const r = spawnSync(file, args, {
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * Parse the single LAFS envelope a cleo command prints on stdout.
 *
 * @param {string} stdout
 * @returns {{ success?: boolean, data?: Record<string, unknown>, error?: { message?: string } }}
 */
function envelope(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`stdout is not one JSON envelope: ${stdout.trim().slice(0, 300)}`);
  }
}

/**
 * Require a successful envelope.
 *
 * @param {RunResult | null} result
 * @returns {Record<string, unknown>} The envelope's `data`.
 */
function successData(result) {
  const env = envelope(result?.stdout ?? '');
  if (env.success !== true)
    throw new Error(`envelope reports failure: ${env.error?.message ?? 'no message'}`);
  return env.data ?? {};
}

/**
 * Require a task ID printed by `--output id`.
 *
 * @param {RunResult | null} result
 * @returns {string}
 */
function taskId(result) {
  const id = (result?.stdout ?? '').trim();
  if (!/^T\d+$/.test(id)) throw new Error(`expected a task ID, got: ${id.slice(0, 300)}`);
  return id;
}

/**
 * List every @cleocode package installed under a package directory, its own
 * manifest included, walking the whole `node_modules` tree beneath it.
 *
 * @param {string} packageDir - An installed package directory.
 * @returns {Array<{ name: string, version: string, path: string }>} Sorted by name, then path.
 */
export function installedCleocodePackages(packageDir) {
  /** @type {Array<{ name: string, version: string, path: string }>} */
  const found = [];
  const entries = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && !e.name.startsWith('.'),
      );
    } catch {
      return [];
    }
  };
  const stack = [packageDir];
  while (stack.length > 0) {
    const dir = /** @type {string} */ (stack.pop());
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@cleocode/'))
        found.push({ name: manifest.name, version: String(manifest.version), path: dir });
    }
    const modules = join(dir, 'node_modules');
    for (const entry of entries(modules)) {
      if (entry.name.startsWith('@')) {
        for (const scoped of entries(join(modules, entry.name)))
          stack.push(join(modules, entry.name, scoped.name));
      } else {
        stack.push(join(modules, entry.name));
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/**
 * The health checks, in order. Each later check depends on the earlier ones.
 *
 * @type {readonly SoakCheck[]}
 */
export const SOAK_CHECKS = Object.freeze([
  {
    name: 'install',
    command: (ctx) => [
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        ctx.prefix,
        '--no-audit',
        '--no-fund',
        '--loglevel',
        'error',
        `@cleocode/cleo@${ctx.version}`,
      ],
      INSTALL_TIMEOUT_MS,
    ],
    verify: (_result, ctx) => {
      if (!existsSync(ctx.bin)) throw new Error(`npm exited 0 but ${ctx.bin} does not exist`);
      return `@cleocode/cleo@${ctx.version} installed globally into the sandbox prefix`;
    },
  },
  {
    // Every @cleocode package pins its @cleocode dependencies to its own exact
    // version. A mixed tree means a pin is wrong, and moving `latest` would
    // then hand users a combination nobody tested.
    name: 'coherent-versions',
    verify: (_result, ctx) => {
      const found = installedCleocodePackages(ctx.installDir);
      const wrong = found.filter((p) => p.version !== ctx.version);
      if (wrong.length > 0)
        throw new Error(
          `installed @cleocode packages at another version: ${wrong.map((p) => `${p.name}@${p.version}`).join(', ')}`,
        );
      if (found.length < 2)
        throw new Error('found only @cleocode/cleo itself; its @cleocode dependencies are missing');
      return `${found.length} installed @cleocode packages, all at ${ctx.version}`;
    },
  },
  {
    name: 'version',
    command: (ctx) => [ctx.bin, ['--version']],
    verify: (result, ctx) => {
      const data = successData(result);
      if (data.version !== ctx.version)
        throw new Error(`cleo --version reports ${String(data.version)}, not ${ctx.version}`);
      return `cleo --version reports ${ctx.version}`;
    },
  },
  {
    name: 'git-init',
    command: (ctx) => ['git', ['init', '--quiet', ctx.project]],
    verify: () => 'sandbox project is a git repository',
  },
  {
    name: 'init',
    command: (ctx) => [ctx.bin, ['init']],
    verify: (result) => {
      const data = successData(result);
      if (data.initialized !== true) throw new Error('cleo init did not report initialized');
      return 'cleo init initialized the sandbox project';
    },
  },
  {
    name: 'session-start',
    command: (ctx) => [ctx.bin, ['session', 'start', '--scope', 'global', '--name', 'Canary soak']],
    verify: (result) => {
      const data = successData(result);
      return `session ${String(data.id)} started`;
    },
  },
  {
    name: 'saga-create',
    command: (ctx) => [
      ctx.bin,
      [
        'saga',
        'create',
        '--title',
        'Canary soak',
        '--description',
        'Installed canary health check',
        '--acceptance',
        SOAK_ACCEPTANCE,
        '--output',
        'id',
      ],
    ],
    verify: (result, ctx) => {
      ctx.sagaId = taskId(result);
      return `saga ${ctx.sagaId} created`;
    },
  },
  {
    name: 'epic-create',
    command: (ctx) => [
      ctx.bin,
      [
        'add',
        '--type',
        'epic',
        '--parent',
        String(ctx.sagaId),
        '--title',
        SOAK_EPIC_TITLE,
        '--description',
        'Installed CLI write and readback',
        '--acceptance',
        SOAK_ACCEPTANCE,
        '--output',
        'id',
      ],
    ],
    verify: (result, ctx) => {
      ctx.epicId = taskId(result);
      return `epic ${ctx.epicId} created under ${ctx.sagaId}`;
    },
  },
  {
    name: 'show',
    command: (ctx) => [ctx.bin, ['show', String(ctx.epicId), '--field', '/data/task/title']],
    verify: (result, ctx) => {
      const title = (result?.stdout ?? '').trim();
      if (title !== SOAK_EPIC_TITLE)
        throw new Error(`cleo show read back "${title.slice(0, 200)}"`);
      return `cleo show read ${ctx.epicId} back`;
    },
  },
  {
    name: 'find',
    command: (ctx) => [ctx.bin, ['find', SOAK_EPIC_TITLE, '--output', 'id']],
    verify: (result, ctx) => {
      const ids = (result?.stdout ?? '').split('\n').map((line) => line.trim());
      if (!ids.includes(String(ctx.epicId)))
        throw new Error(`cleo find did not return ${ctx.epicId}: ${ids.join(' ').slice(0, 200)}`);
      return `cleo find returned ${ctx.epicId}`;
    },
  },
  {
    name: 'doctor',
    command: (ctx) => [ctx.bin, ['doctor']],
    verify: (result) => {
      const data = successData(result);
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const failed = checks.filter((c) => c?.status === 'fail').map((c) => c.name);
      if (failed.length > 0) throw new Error(`cleo doctor failed: ${failed.join(', ')}`);
      const warned = checks.filter((c) => c?.status === 'warn').map((c) => c.name);
      return `cleo doctor: ${checks.length} checks, none failed${warned.length ? ` (warnings: ${warned.join(', ')})` : ''}`;
    },
  },
]);

/**
 * Describe a command that did not exit 0.
 *
 * @param {RunResult} result
 * @returns {string | null} Null when the command exited 0.
 */
function exitProblem(result) {
  if (result.error) return `could not run: ${result.error.message}`;
  if (result.status === 0) return null;
  const tail = (s) => s.trim().slice(-500);
  return `exited ${result.status ?? `by ${result.signal}`}; stdout: ${tail(result.stdout)}; stderr: ${tail(result.stderr)}`;
}

/**
 * Install `version` into a sandbox under `root` and run every check, stopping at
 * the first failure.
 *
 * @param {object} opts
 * @param {string} opts.version - Version to install.
 * @param {string} opts.root - Owned, empty sandbox directory.
 * @param {typeof runCommand} [opts.run] - Injected for tests.
 * @param {readonly SoakCheck[]} [opts.checks] - Injected for tests.
 * @param {(line: string) => void} [opts.log] - Progress sink.
 * @returns {{ version: string, ok: boolean, checks: Array<{ name: string, ok: boolean, skipped?: true, detail: string, durationMs: number }> }}
 */
export function soak({ version, root, run = runCommand, checks = SOAK_CHECKS, log = () => {} }) {
  const env = sandboxEnvironment(root);
  const prefix = join(root, 'prefix');
  mkdirSync(prefix, { recursive: true });
  /** @type {SoakContext} */
  const ctx = {
    version,
    root,
    prefix,
    bin: join(prefix, 'bin', 'cleo'),
    installDir: join(prefix, 'lib', 'node_modules', '@cleocode', 'cleo'),
    project: /** @type {string} */ (env.CLEO_ROOT),
    env: { ...env, PATH: `${join(prefix, 'bin')}${delimiter}${env.PATH ?? ''}` },
  };
  const results = [];
  let failed = false;
  for (const check of checks) {
    if (failed) {
      results.push({
        name: check.name,
        ok: false,
        skipped: /** @type {const} */ (true),
        detail: 'skipped: an earlier check failed',
        durationMs: 0,
      });
      continue;
    }
    const started = Date.now();
    try {
      let result = null;
      if (check.command) {
        const [file, args, timeoutMs = CLI_TIMEOUT_MS] = check.command(ctx);
        result = run(file, args, { cwd: ctx.project, env: ctx.env, timeoutMs });
        const problem = exitProblem(result);
        if (problem) throw new Error(problem);
      }
      const detail = check.verify(result, ctx);
      results.push({ name: check.name, ok: true, detail, durationMs: Date.now() - started });
      log(`ok   ${check.name}: ${detail}`);
    } catch (error) {
      failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: check.name, ok: false, detail, durationMs: Date.now() - started });
      log(`FAIL ${check.name}: ${detail}`);
    }
  }
  return { version, ok: !failed, checks: results };
}

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv
 * @returns {{ version?: string, tag: string, keep: boolean, out?: string, error?: string }}
 */
export function parseArgs(argv) {
  /** @type {{ version?: string, tag: string, keep: boolean, out?: string, error?: string }} */
  const args = { tag: 'canary', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = String(argv[++i] ?? '').replace(/^v/, '');
    else if (a === '--tag') args.tag = String(argv[++i] ?? '');
    else if (a === '--out') args.out = String(argv[++i] ?? '');
    else if (a === '--keep') args.keep = true;
    else return { ...args, error: `unknown argument: ${a}` };
  }
  if (args.version !== undefined && !VERSION_PATTERN.test(args.version))
    return { ...args, error: `not a CalVer version: ${args.version}` };
  if (!/^[a-z][a-z0-9-]*$/.test(args.tag)) return { ...args, error: `not a dist-tag: ${args.tag}` };
  return args;
}

/**
 * Resolve a dist-tag of @cleocode/cleo to a version.
 *
 * @param {string} tag
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<string>}
 */
export async function resolveTag(tag, fetchImpl = fetch) {
  const res = await fetchImpl(`${REGISTRY}/-/package/@cleocode%2fcleo/dist-tags`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`dist-tags HTTP ${res.status}`);
  const tags = await res.json();
  const version = tags?.[tag];
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version))
    throw new Error(`dist-tag "${tag}" of @cleocode/cleo is ${String(version ?? '(absent)')}`);
  return version;
}

/**
 * Render the report as a Markdown table.
 *
 * @param {ReturnType<typeof soak>} report
 * @returns {string}
 */
export function renderReport(report) {
  const rows = report.checks.map(
    (c) =>
      `| ${c.name} | ${c.skipped ? 'skipped' : c.ok ? 'pass' : '**FAIL**'} | ${(c.durationMs / 1000).toFixed(1)}s | ${c.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
  );
  return [
    `## Canary soak: v${report.version} ${report.ok ? 'passed' : 'FAILED'}`,
    '',
    '| check | result | time | detail |',
    '|---|---|--:|---|',
    ...rows,
    '',
  ].join('\n');
}

/**
 * Run the soak from the command line.
 *
 * @returns {Promise<number>} Process exit code.
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`release-canary-soak: ${args.error}\n`);
    return 2;
  }
  if (process.platform === 'win32') {
    process.stderr.write('release-canary-soak: POSIX only (global-install layout)\n');
    return 2;
  }
  let version = args.version;
  if (!version) {
    try {
      version = await resolveTag(args.tag);
    } catch (error) {
      process.stderr.write(
        `release-canary-soak: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'cleo-canary-soak-'));
  let report;
  try {
    report = soak({ version, root, log: (line) => process.stderr.write(`${line}\n`) });
  } finally {
    if (!args.keep) rmSync(root, { recursive: true, force: true });
  }
  const out = { ...report, sandbox: args.keep ? root : null };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderReport(report));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await main());

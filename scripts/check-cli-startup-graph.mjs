#!/usr/bin/env node
/**
 * CLI startup-cost ratchet on the BUILT bundle (T13126).
 *
 * ## Why the built bundle, and not the source
 *
 * Gates 19 and 25 check the CLI SOURCE graph, and they were green while every
 * `cleo` call evaluated all of CORE: the CLI was bundled without esbuild code
 * splitting, and esbuild then turns each lazy `import('@cleocode/core')` it
 * inlines into a top-level static import of the single output file. On
 * 2026-10-03 `cleo --version` loaded ~3,900 modules and peaked at ~440 MB RSS
 * while the source said "lazy". The only measurement that cannot be fooled
 * that way is the one this script takes: what the built CLI actually loads.
 *
 * ## What it checks
 *
 * 1. Static graph. Walks `packages/cleo/dist/cli/index.js` and the chunks it
 *    imports statically (dynamic `import()` is not followed) and fails when that
 *    graph names a forbidden external, such as the CORE or contracts barrel.
 * 2. Runtime probes. Runs the built CLI for each probe in {@link PROBES} inside a
 *    throwaway HOME, CLEO_HOME and project (never a real store), with a module
 *    load tracer, and fails when a probe:
 *      - loads a module matching one of its `forbid` patterns,
 *      - loads more file modules than its `maxModules` budget, or
 *      - peaks above its `maxRssMb` ceiling.
 *
 * ## The ratchet
 *
 * Module counts are deterministic for a given lockfile, so they are the
 * ratchet; RSS ceilings are generous and catch only gross regressions. When a
 * change lowers a probe's count, lower its `maxModules` in the same PR (keep
 * ~10% headroom for dependency bumps). Raising a budget needs a reason in the
 * PR that says what the new modules buy.
 *
 * Usage (after `pnpm run build`):
 *   node scripts/check-cli-startup-graph.mjs          # check
 *   node scripts/check-cli-startup-graph.mjs --json   # print measurements as JSON
 *
 * `--check` and `--strict` (passed by `cleo check arch`, gate 39) behave the
 * same: the budgets are already the ratchet. A missing build fails, and so does
 * a build older than the CLI or CORE source it would be measuring: a stale
 * dist reports on code that is no longer there.
 *
 * @task T13126
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The built CLI entry this gate measures. */
export const CLI_ENTRY = join(REPO_ROOT, 'packages/cleo/dist/cli/index.js');

/**
 * Bare specifiers the entry's STATIC graph must never import: each one drags a
 * barrel (and everything it re-exports) into every invocation.
 */
export const FORBIDDEN_STATIC_EXTERNALS = Object.freeze([
  '@cleocode/core',
  '@cleocode/core/internal',
  '@cleocode/contracts',
]);

/** Loaded-module URL patterns that mean "a barrel or a heavy subsystem loaded". */
const CORE_BARREL = /\/core\/dist\/(index|internal)\.js$/;
const CONTRACTS_BARREL = /\/contracts\/dist\/index\.js$/;
const STORE_STACK = /\/drizzle-orm\/|^node:sqlite$/;
const MODEL_SDKS = /\/(@anthropic-ai|openai|@ai-sdk|@aws-sdk|@google|js-tiktoken)\//;
/** CORE's human-renderer entry point: JSON output (`--version`, agents) never needs it. */
const CORE_RENDER = /\/core\/dist\/render\/index\.js$/;
/** The operation describer `--describe` loads (its output contracts pull in zod schemas). */
const DESCRIBE_OPERATION = /\/core\/dist\/dispatch\/describe-operation\.js$/;
/** The output-contract table a failed `--field` pointer loads for its remedy. */
const OUTPUT_CONTRACTS = /\/core\/dist\/dispatch\/contracts\/output-contracts\.js$/;
/** drizzle's ES module `node-sqlite` driver, the build the store loads (T13126). */
const DRIZZLE_ESM_DRIVER = /\/drizzle-orm\/node-sqlite\/driver\.js$/;
/** Any file of drizzle's CommonJS build: the store falls back to it only when require(esm) fails. */
const DRIZZLE_CJS = /\/drizzle-orm\/.*\.cjs$/;

/**
 * @typedef {object} Probe
 * @property {string} name - Label used in reports.
 * @property {string[]} args - CLI arguments.
 * @property {boolean} [needsProject] - Run inside an initialised throwaway project.
 * @property {RegExp[]} forbid - Module URL patterns this probe must not load.
 * @property {RegExp[]} [require] - Module URL patterns this probe must load:
 *   proof that it still exercises the code path it guards.
 * @property {number} [expectExit] - Exit code the command must return.
 * @property {number} maxModules - Budget of loaded `file:` modules (the ratchet).
 * @property {number} maxRssMb - Ceiling on peak resident set size, in MB.
 */

/**
 * Probes and their budgets, measured 2026-10-03 on macOS / Node 24.21 after code
 * splitting (T13126). Before it, every probe loaded ~3,900 modules:
 *
 * | probe   | modules | peak RSS (traced) |
 * |---------|---------|-------------------|
 * | version |     214 |  87 MB            |
 * | help    |      75 |  64 MB            |
 * | show    |   2,412 | 396 MB            |
 *
 * Loading CORE's human renderers only for human output (T13126) took
 * `--version` to 64 modules / 55 MB. Then the dispatch layer stopped loading
 * the CORE barrel for the hot reads (lazy domain handlers,
 * `@cleocode/runtime/gateway/dispatch`, narrow imports): `show` and `find`
 * load ~1,050 modules. With contracts values imported from their leaf modules
 * and the read-path leaves, `show` and `find` load ~820 modules (~190 MB) and
 * `list --human` ~880. With the tasks domain handlers loaded per operation,
 * the token recorder loaded only for mutations and `cleo current` on a leaf,
 * `show`, `find` and `current` load ~450 modules (~135 MB). `session status`
 * (a leaf, ~540 modules, ~175 MB) and `briefing` (~710 modules, ~190 MB; it
 * loaded the whole CORE barrel, ~3,000 modules) dispatch barrel-free (T13166).
 * `describe` covers
 * the `--describe` path, which loads the operation describer through
 * `require(esm)`. Lower each budget in the PR that lowers its count.
 *
 * Three CLI paths load ES modules through `require(esm)`, which throws
 * `ERR_REQUIRE_ASYNC_MODULE` when the loaded graph uses top-level await: the
 * store's drizzle driver (`core/src/store/drizzle-node-sqlite.ts`), CORE's
 * human renderers, the output-contract table behind a failed `--field` pointer
 * and the operation describer behind `--describe` (all three through
 * `cleo/src/cli/lib/load-esm-sync.ts`). `list-human` and
 * `field-miss` run the last two and must exit as expected, so top-level await
 * reaching either graph fails this gate. The drizzle driver falls back to its
 * CommonJS build instead of failing, so every store-opening probe forbids
 * drizzle's `.cjs` files and requires the ES module driver.
 *
 * @type {readonly Probe[]}
 */
export const PROBES = Object.freeze([
  {
    name: 'version',
    args: ['--version'],
    forbid: [CORE_BARREL, CONTRACTS_BARREL, STORE_STACK, MODEL_SDKS, CORE_RENDER],
    maxModules: 80,
    maxRssMb: 120,
  },
  {
    name: 'help',
    args: ['--help'],
    forbid: [CORE_BARREL, CONTRACTS_BARREL, STORE_STACK, MODEL_SDKS, CORE_RENDER],
    maxModules: 85,
    maxRssMb: 120,
  },
  {
    name: 'show',
    args: ['show', 'T001'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    require: [DRIZZLE_ESM_DRIVER],
    maxModules: 500,
    maxRssMb: 200,
  },
  {
    name: 'find',
    args: ['find', 'probe'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    require: [DRIZZLE_ESM_DRIVER],
    maxModules: 500,
    maxRssMb: 200,
  },
  {
    name: 'list-human',
    args: ['list', '--human'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    require: [CORE_RENDER, DRIZZLE_ESM_DRIVER],
    // ExitCode.NO_DATA: the throwaway project has no tasks; the renderer still runs.
    expectExit: 100,
    maxModules: 565,
    maxRssMb: 200,
  },
  {
    name: 'field-miss',
    args: ['list', '--field', '/data/no-such-field'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    require: [OUTPUT_CONTRACTS],
    // ExitCode.NOT_FOUND: E_FIELD_NOT_FOUND, with the contract's valid pointers as the fix.
    expectExit: 4,
    maxModules: 505,
    maxRssMb: 200,
  },
  {
    name: 'current',
    args: ['current'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    maxModules: 500,
    maxRssMb: 200,
  },
  {
    name: 'session-status',
    args: ['session', 'status'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    maxModules: 600,
    maxRssMb: 240,
  },
  {
    name: 'briefing',
    args: ['briefing'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    maxModules: 785,
    maxRssMb: 260,
  },
  {
    name: 'describe',
    args: ['list', '--describe'],
    needsProject: true,
    forbid: [CORE_BARREL, MODEL_SDKS, DRIZZLE_CJS],
    require: [DESCRIBE_OPERATION],
    expectExit: 0,
    maxModules: 465,
    maxRssMb: 200,
  },
]);

// ---------------------------------------------------------------------------
// 1. Static graph of the built entry
// ---------------------------------------------------------------------------

/**
 * Specifiers of a module's STATIC imports and re-exports (`import ... from`,
 * `import "x"`, `export ... from`). Dynamic `import("x")` is excluded: it costs
 * nothing until the code that calls it runs.
 *
 * @param {string} source - JavaScript module source (esbuild ESM output).
 * @returns {string[]} Specifiers in source order.
 */
export function staticImportSpecifiers(source) {
  const specifiers = [];
  const statement =
    /(?:^|[\n;])[ \t]*(?:import|export)\b(?![ \t]*\()[^'"`;]*?(?:\bfrom[ \t]*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Walk the static graph of `entry` through relative imports.
 *
 * @param {string} entry - Absolute path of the entry module.
 * @param {(path: string) => string} [read] - Source reader (injectable for tests).
 * @returns {{ files: string[], bytes: number, externals: string[] }} Files in
 *   the graph, their total size, and the bare specifiers they import.
 */
export function walkStaticGraph(entry, read = (path) => readFileSync(path, 'utf8')) {
  const seen = new Set();
  const externals = new Set();
  const queue = [entry];
  let bytes = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    bytes += Buffer.byteLength(source);
    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(resolve(dirname(file), specifier));
      } else if (!specifier.startsWith('node:')) {
        externals.add(specifier);
      }
    }
  }
  return { files: [...seen], bytes, externals: [...externals].sort() };
}

// ---------------------------------------------------------------------------
// 2. Runtime probes
// ---------------------------------------------------------------------------

/** Module-load tracer injected with `--import`; writes its findings at exit. */
const TRACER_SOURCE = `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const urls = [];
registerHooks({ load(url, context, nextLoad) { urls.push(url); return nextLoad(url, context); } });
process.on('exit', () => {
  writeFileSync(process.env.CLEO_STARTUP_TRACE_OUT, JSON.stringify({
    urls, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }));
});
`;

/**
 * @typedef {object} ProbeResult
 * @property {string} name
 * @property {number | null} exitCode
 * @property {number} modules - Loaded `file:` modules.
 * @property {number} maxRssMb
 * @property {string[]} urls - Every loaded module URL.
 * @property {string} stderr - The command's stderr, for failure reports.
 */

/**
 * Run the built CLI once under the tracer, in a sandbox.
 *
 * @param {Probe} probe
 * @param {{ sandbox: string, tracer: string, project: string }} env
 * @returns {ProbeResult}
 */
function runProbe(probe, env) {
  const traceOut = join(env.sandbox, `${probe.name}.trace.json`);
  const home = join(env.sandbox, 'home');
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=1536',
      '--disable-warning=ExperimentalWarning',
      '--import',
      pathToFileURL(env.tracer).href,
      CLI_ENTRY,
      ...probe.args,
    ],
    {
      cwd: probe.needsProject ? env.project : env.sandbox,
      encoding: 'utf8',
      timeout: 120_000,
      env: sandboxEnv(home, traceOut),
    },
  );
  if (!existsSync(traceOut)) {
    throw new Error(
      `probe ${probe.name}: the CLI wrote no trace (exit ${child.status}).\n${child.stderr}`,
    );
  }
  const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
  const urls = trace.urls;
  return {
    name: probe.name,
    exitCode: child.status,
    modules: urls.filter((url) => url.startsWith('file:')).length,
    maxRssMb: trace.maxRssMb,
    urls,
    stderr: child.stderr ?? '',
  };
}

/**
 * Environment for a sandboxed CLI run: a throwaway HOME and CLEO_HOME, no
 * inherited session binding, and no NODE_OPTIONS (an operator heap flag would
 * change what is measured).
 *
 * @param {string} home
 * @param {string} traceOut
 * @returns {NodeJS.ProcessEnv}
 */
function sandboxEnv(home, traceOut) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLEO_') || key.startsWith('CLAUDE_')) delete env[key];
  }
  delete env.NODE_OPTIONS;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CLEO_HOME: join(home, '.cleo'),
    // Sandbox-only: the throwaway stores below may be migrated by this build.
    CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1',
    CLEO_STARTUP_TRACE_OUT: traceOut,
  };
}

/**
 * Create the throwaway project the `needsProject` probes run in.
 *
 * @param {string} sandbox
 * @returns {string} Project directory.
 */
function initSandboxProject(sandbox) {
  const project = join(sandbox, 'project');
  const home = join(sandbox, 'home');
  spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  const init = spawnSync(process.execPath, [CLI_ENTRY, 'init'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120_000,
    env: sandboxEnv(home, join(sandbox, 'init.trace.json')),
  });
  if (init.status !== 0) {
    throw new Error(`cleo init failed in the sandbox (exit ${init.status}):\n${init.stderr}`);
  }
  return project;
}

/**
 * Judge one probe against its budgets.
 *
 * @param {Probe} probe
 * @param {Pick<ProbeResult, 'modules' | 'maxRssMb' | 'urls'> & Partial<Pick<ProbeResult, 'exitCode' | 'stderr'>>} result
 * @returns {string[]} Failure reasons; empty when the probe passes.
 */
export function judgeProbe(probe, result) {
  const reasons = [];
  if (probe.expectExit !== undefined && result.exitCode !== probe.expectExit) {
    const stderr = (result.stderr ?? '').trim().slice(-600);
    reasons.push(
      `${probe.name}: exited ${result.exitCode}, expected ${probe.expectExit}${stderr ? `\n${stderr}` : ''}`,
    );
  }
  for (const pattern of probe.forbid) {
    const hit = result.urls.find((url) => pattern.test(url));
    if (hit) reasons.push(`${probe.name}: loads a forbidden module (${pattern}): ${hit}`);
  }
  for (const pattern of probe.require ?? []) {
    if (!result.urls.some((url) => pattern.test(url))) {
      reasons.push(`${probe.name}: never loads ${pattern}, so it no longer tests that path`);
    }
  }
  if (result.modules > probe.maxModules) {
    reasons.push(
      `${probe.name}: loads ${result.modules} modules, over its budget of ${probe.maxModules}`,
    );
  }
  if (result.maxRssMb > probe.maxRssMb) {
    reasons.push(
      `${probe.name}: peaks at ${result.maxRssMb} MB RSS, over its ceiling of ${probe.maxRssMb} MB`,
    );
  }
  return reasons;
}

/**
 * Largest contributors of a probe, by package directory, for failure reports.
 *
 * @param {string[]} urls
 * @param {number} [limit]
 * @returns {string[]} `count package` lines, largest first.
 */
export function topPackages(urls, limit = 12) {
  const counts = new Map();
  for (const url of urls) {
    if (!url.startsWith('file:')) continue;
    const parts = decodeURIComponent(url).split('/node_modules/');
    const tail = parts[parts.length - 1] ?? url;
    const segments = tail.split('/');
    const name =
      parts.length > 1
        ? segments[0]?.startsWith('@')
          ? `${segments[0]}/${segments[1]}`
          : (segments[0] ?? tail)
        : (tail.match(/packages\/([^/]+)\//)?.[1] ?? 'other');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${String(count).padStart(6)} ${name}`);
}

/** Source trees the built CLI is made from; a newer file here means a stale build. */
const SOURCE_ROOTS = ['packages/cleo/src', 'packages/core/src', 'packages/contracts/src'];

/**
 * The newest non-test source file under `roots`, or `null` when none exist.
 *
 * @param {string[]} roots - Directories relative to the repository root.
 * @returns {{ path: string, mtimeMs: number } | null}
 */
export function newestSource(roots) {
  let newest = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const { mtimeMs } = statSync(path);
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      }
    }
  };
  for (const root of roots) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walk(abs);
  }
  return newest;
}

function main() {
  const json = process.argv.includes('--json');
  if (!existsSync(CLI_ENTRY)) {
    console.error(
      `check-cli-startup-graph: ${CLI_ENTRY} is missing; run \`pnpm run build\` first.`,
    );
    process.exit(2);
  }
  const newest = newestSource(SOURCE_ROOTS);
  if (newest !== null && newest.mtimeMs > statSync(CLI_ENTRY).mtimeMs) {
    console.error(
      `check-cli-startup-graph: the build is older than ${newest.path.slice(REPO_ROOT.length + 1)}; ` +
        'run `pnpm run build` so the gate measures the current source.',
    );
    process.exit(2);
  }

  const failures = [];
  const graph = walkStaticGraph(CLI_ENTRY);
  for (const forbidden of FORBIDDEN_STATIC_EXTERNALS) {
    if (graph.externals.includes(forbidden)) {
      failures.push(`static graph of dist/cli/index.js imports the barrel '${forbidden}'`);
    }
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'cleo-startup-graph-'));
  const results = [];
  try {
    const tracer = join(sandbox, 'tracer.mjs');
    writeFileSync(tracer, TRACER_SOURCE);
    const project = PROBES.some((probe) => probe.needsProject) ? initSandboxProject(sandbox) : '';
    for (const probe of PROBES) {
      const result = runProbe(probe, { sandbox, tracer, project });
      results.push(result);
      const reasons = judgeProbe(probe, result);
      if (reasons.length > 0) {
        failures.push(...reasons, ...topPackages(result.urls).map((line) => `    ${line}`));
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const summary = {
    staticGraph: { files: graph.files.length, bytes: graph.bytes, externals: graph.externals },
    probes: results.map(({ name, exitCode, modules, maxRssMb }) => ({
      name,
      exitCode,
      modules,
      maxRssMb,
    })),
  };
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `static graph: ${summary.staticGraph.files} files, ${summary.staticGraph.bytes} bytes, ` +
        `${summary.staticGraph.externals.length} external specifiers`,
    );
    for (const probe of summary.probes) {
      const budget = PROBES.find((entry) => entry.name === probe.name);
      console.log(
        `  ${probe.name.padEnd(8)} ${String(probe.modules).padStart(5)} modules (budget ${budget?.maxModules}), ` +
          `${probe.maxRssMb} MB peak RSS (ceiling ${budget?.maxRssMb}), exit ${probe.exitCode}`,
      );
    }
  }
  if (failures.length > 0) {
    console.error('\ncheck-cli-startup-graph: FAILED');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main();

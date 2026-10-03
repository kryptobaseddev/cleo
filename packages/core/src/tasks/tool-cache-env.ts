/**
 * Environment fingerprint for the evidence tool cache (T12958, review of #1774).
 *
 * The tree hash identifies the SOURCE a run measured. Tools that read build
 * output or installed dependencies also depend on per-checkout state git does
 * not see: `node_modules`, gitignored `dist/` directories that workspace
 * packages resolve through, and `.env*` files. Two worktrees with identical
 * source but a stale `dist/` in one of them must not share a `test` result.
 *
 * The fingerprint is cheap and content-shaped, so two checkouts that were
 * installed and built from the same source compare EQUAL (sharing works) while
 * a missing install, a different install or a stale build compares different:
 *
 *   - the installed-lockfile snapshot the package manager keeps inside
 *     `node_modules` (`.pnpm/lock.yaml`, `.package-lock.json`,
 *     `.yarn-state.yml`, `.yarn-integrity`) — hashed by content, because
 *     pnpm's `.modules.yaml` carries a per-install timestamp;
 *   - for every workspace package (each tracked `package.json`), the
 *     relative path and SIZE of every file under its `dist/` — sizes rather
 *     than mtimes, which differ between two equally fresh builds;
 *   - the content of untracked `.env*` files at the execution root.
 *
 * Sizes are a heuristic: a rebuild from different source that produces
 * byte-for-byte equal sizes everywhere would collide. When the `dist/` walk
 * exceeds {@link MAX_DIST_FILES} the fingerprint falls back to the execution
 * root itself, which disables cross-worktree sharing rather than guessing.
 *
 * Only {@link ENV_SENSITIVE_TOOLS} pay for this; other tools get a constant.
 *
 * ## Resource environment (T12989)
 *
 * {@link captureResourceEnv} is a second, separate key input: the resource
 * limits the run is spawned with. A run that fits in a 6 GB heap and one that
 * does not fit in 3 GB are different runs of the same code, and keying only on
 * source and installed state let a retry with a larger heap replay the cached
 * 3 GB result (axiom field report, T963). It covers only what decides whether a
 * run fits, never the whole environment, so an unrelated variable or
 * `NODE_OPTIONS` flag never moves the key:
 *
 *   - the V8 heap flags in `NODE_OPTIONS` ({@link effectiveHeapFlags}), for
 *     every tool, because every Node process a tool starts inherits them;
 *   - every variable `heavyToolEnv` manages for the tool (for heavy tools the
 *     per-runner worker counts, `npm_config_workspace_concurrency` and
 *     `MAKEFLAGS`; for `typecheck`/`lint` the workspace concurrency, T13123);
 *   - for heavy tools, the cgroup ceiling overrides (`CLEO_TOOL_MEMORY_MAX_MB`,
 *     `CLEO_NO_TOOL_CGROUP`).
 *
 * The variable list is derived from `heavyToolEnv` itself, so a lever added
 * there is keyed with no second list to keep in step.
 *
 * @task T12958
 * @task T12989
 * @task T13123
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type HeavyToolEnv, heavyToolEnv, isHeavyTool, parseHeapFlags } from './heavy-tool-env.js';
import { DISABLE_ENV, MEMORY_MAX_ENV } from './heavy-tool-limit.js';
import type { CanonicalTool } from './tool-resolver.js';

/** Canonical tools whose result depends on installed deps or build output. */
export const ENV_SENSITIVE_TOOLS: ReadonlySet<string> = new Set(['test', 'build', 'typecheck']);

/** Fingerprint for tools that read only source. */
export const ENV_FINGERPRINT_NONE = 'none';

/** Most `dist/` files walked before falling back to the execution root. */
export const MAX_DIST_FILES = 100_000;

const INSTALL_SNAPSHOTS = [
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
  'node_modules/.yarn-integrity',
];

/** Directories of every tracked `package.json`, relative to `root`. */
function workspacePackageDirs(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'package.json', '**/package.json'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split('\0')
      .filter(Boolean)
      .map((f) => dirname(f))
      .sort();
  } catch {
    return ['.'];
  }
}

/**
 * Append `relpath:size` for every file under `dir` to `out`, without following
 * symlinks. Returns `false` once `out` exceeds {@link MAX_DIST_FILES}.
 */
function walkSizes(dir: string, rel: string, out: string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!walkSizes(abs, `${rel}/${name}`, out)) return false;
    } else {
      out.push(`${rel}/${name}:${st.isSymbolicLink() ? 'link' : st.size}`);
      if (out.length > MAX_DIST_FILES) return false;
    }
  }
  return true;
}

/**
 * Fingerprint the per-checkout environment a tool run depends on.
 *
 * @param root - The execution root.
 * @param canonical - Canonical tool name.
 * @returns 32 hex chars, or {@link ENV_FINGERPRINT_NONE} for tools outside
 *   {@link ENV_SENSITIVE_TOOLS}.
 *
 * @task T12958
 */
export function captureEnvFingerprint(root: string, canonical: string): string {
  if (!ENV_SENSITIVE_TOOLS.has(canonical)) return ENV_FINGERPRINT_NONE;
  const hash = createHash('sha256');

  const snapshot = INSTALL_SNAPSHOTS.find((p) => existsSync(join(root, p)));
  hash.update(`install:${snapshot ?? 'none'}\n`);
  if (snapshot) hash.update(readFileSync(join(root, snapshot)));

  const files: string[] = [];
  for (const pkg of workspacePackageDirs(root)) {
    if (!walkSizes(join(root, pkg, 'dist'), `${pkg}/dist`, files)) {
      // Too large to fingerprint cheaply: do not share across checkouts.
      let real = root;
      try {
        real = realpathSync(root);
      } catch {
        // keep the lexical root
      }
      return createHash('sha256').update(`root:${real}`).digest('hex').slice(0, 32);
    }
  }
  hash.update(files.join('\n'));

  let entries: string[] = [];
  try {
    entries = readdirSync(root)
      .filter((n) => n.startsWith('.env'))
      .sort();
  } catch {
    // unreadable root: no env files
  }
  for (const name of entries) {
    const st = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    hash.update(`\nenv:${name}\n`);
    hash.update(readFileSync(join(root, name)));
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * The V8 heap flags in effect for a `NODE_OPTIONS` value, as `--name=value`
 * sorted by name and joined with a space; `''` when none is set.
 *
 * Only the heap flags decide whether a run fits in memory. Every other flag
 * (`--enable-source-maps`, `--experimental-*`, `--require`, …) is left out of
 * the key: it does not change whether the run fits, and keying it would make
 * every harness that sets one miss every other's results. Parsing (last
 * occurrence wins, underscores read as dashes, the space-separated spelling) is
 * {@link parseHeapFlags}, shared with the heavy-tool planner so the key and the
 * plan read a heap the same way.
 *
 * @param nodeOptions - A `NODE_OPTIONS` value, if any.
 * @returns The effective heap flags, e.g. `--max-old-space-size=6144`.
 *
 * @example
 * ```ts
 * effectiveHeapFlags('--enable-source-maps --max-old-space-size=3072 --max_old_space_size=6144');
 * // → '--max-old-space-size=6144'
 * effectiveHeapFlags('--enable-source-maps'); // → ''
 * ```
 *
 * @task T12989
 */
export function effectiveHeapFlags(nodeOptions: string | undefined): string {
  const values = parseHeapFlags(nodeOptions);
  return [...values.keys()]
    .sort()
    .map((name) => `--${name}=${values.get(name)}`)
    .join(' ');
}

/** The keyed form of one resource variable's value. */
function resourceValue(name: string, raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (name === 'NODE_OPTIONS') return effectiveHeapFlags(value);
  // Inside a `make` recipe, MAKEFLAGS carries the parent's jobserver handle
  // (`--jobserver-auth=fifo:/tmp/GMfifo<pid>`), which names the invocation,
  // not a limit.
  if (name === 'MAKEFLAGS') {
    return value
      .split(/\s+/)
      .filter((t) => t !== '' && !t.startsWith('--jobserver-'))
      .join(' ');
  }
  return value;
}

/**
 * The resource limits a tool run is spawned with, as readable `NAME=value`
 * pairs sorted by name and joined with `;` (T12989). Part of the tool-cache key
 * and recorded on the entry, so a cached result says which heap and worker
 * count produced it, and a retry with different limits is a different run.
 *
 * Reads the EFFECTIVE environment — `env` with the heavy-tool `overlay`
 * applied, exactly as `spawnCmd` merges it — so a limit the caller exported
 * and one `heavyToolEnv` supplied key the same way. Covers:
 *
 *   - `NODE_OPTIONS`, reduced to its heap flags ({@link effectiveHeapFlags}),
 *     for every tool;
 *   - every variable `heavyToolEnv` can set for the tool (derived by asking it
 *     what it sets for an empty environment): a heavy tool's worker counts,
 *     and the workspace concurrency of every memory-bound tool (T13123);
 *   - for heavy tools only, the cgroup ceiling overrides
 *     `CLEO_TOOL_MEMORY_MAX_MB` and `CLEO_NO_TOOL_CGROUP`.
 *
 * A variable outside this set does not move the key; force a fresh run with
 * `CLEO_EVIDENCE_FRESH=1` when one matters.
 *
 * @param canonical - Canonical tool name.
 * @param env - The environment the child inherits.
 * @param overlay - The heavy-tool overlay the child is spawned with; defaults
 *   to `heavyToolEnv(canonical, env)`. `runToolCached` passes the overlay it
 *   spawns with, so the key and the spawn read one value.
 * @returns e.g. `NODE_OPTIONS=--max-old-space-size=4096;VITEST_MAX_WORKERS=6;…`
 *
 * @task T12989
 */
export function captureResourceEnv(
  canonical: CanonicalTool,
  env: NodeJS.ProcessEnv = process.env,
  overlay: HeavyToolEnv = heavyToolEnv(canonical, env),
): string {
  const effective: NodeJS.ProcessEnv = { ...env, ...overlay };
  const names = new Set<string>(['NODE_OPTIONS']);
  // Every lever the overlay manages for this tool: a heavy tool's worker
  // counts, and since T13123 a memory-bound typecheck/lint's workspace
  // concurrency.
  for (const name of Object.keys(heavyToolEnv(canonical, {}))) names.add(name);
  if (isHeavyTool(canonical)) {
    names.add(MEMORY_MAX_ENV);
    names.add(DISABLE_ENV);
  }
  return [...names]
    .sort()
    .map((name) => `${name}=${resourceValue(name, effective[name])}`)
    .join(';');
}

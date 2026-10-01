/**
 * What a command is, for `cleo run` and the provider hook (T12983): the
 * governor class it needs, whether it is heavy at all, and whether it may be
 * paused. Pure and dependency-free (type-only imports, plus `node:fs` for the
 * workspace-root check), so a hook that runs on every Bash call can import it
 * cheaply.
 *
 * Only the COMMAND WORD counts: the tool (`argv[0]` after `env`/`nice`/
 * `time` and `NAME=value` prefixes), or for a package manager its script
 * (`pnpm build`, `npm run test:unit`) or exec'd tool (`npx vitest`,
 * `pnpm exec tsc`, `pnpm dlx`). A tool name inside an argument never counts
 * (`git commit -m "fix vitest"`, `grep -rn tsc .`, `cd packages/next`).
 * `--version`/`--help` and watch/dev/serve modes are never heavy: a watcher
 * would hold a slot forever.
 *
 * @module resources/run-class
 * @task T12979
 * @epic T12978
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ResourceClass } from '@cleocode/contracts';
import type { CanonicalTool } from '../tasks/tool-resolver.js';

/** Short class names accepted by `cleo run --class`. */
export const RUN_CLASS_ALIASES: Readonly<Record<string, ResourceClass>> = Object.freeze({
  test: 'test-run',
  'test-run': 'test-run',
  build: 'scoped-build',
  'scoped-build': 'scoped-build',
  typecheck: 'scoped-build',
  install: 'scoped-build',
  scan: 'scoped-build',
  'full-build': 'full-build',
  db: 'db-heavy',
  'db-heavy': 'db-heavy',
});

const TEST_RUNNERS = /^(vitest|jest|mocha|ava|tap|playwright|pytest|rspec|phpunit)$/;
const BUILD_TOOLS =
  /^(tsc|tsup|turbo|vite|esbuild|webpack|rollup|next|nx|biome|eslint|svelte-check)$/;
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
const EXEC_RUNNERS = /^(npx|pnpx|bunx)$/;
const PREFIX_COMMANDS = /^(env|nice|time|nohup)$/;
const INSTALL_VERBS = /^(install|i|ci|add|update|up|upgrade)$/;
const HEAVY_SCRIPTS = /^(test|t|build|typecheck|lint|check|install|i|ci)(:|$)/;
const WATCH_SCRIPTS = /^(dev|start|serve|preview|watch)(:|$)/;
const WATCH_FLAGS = new Set(['--watch', '--watchAll', 'watch', 'dev', 'serve', 'start', 'preview']);
const INFO_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);
/** Package-manager flags that take a value. */
const PM_VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--workspace',
  '-w',
  '--cwd',
]);
/** Flags that scope a package-manager command to some packages. */
const SCOPING_FLAGS = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--workspace',
  '-w',
  '--cwd',
]);
/** Flags that run a script across every workspace package. */
const RECURSIVE_FLAGS = new Set(['-r', '--recursive', '--workspaces', '-ws']);

function base(token: string): string {
  return token.split('/').pop() ?? token;
}

/** What an argv runs: its tool, or a package manager's script / exec target. */
export interface CommandTarget {
  /** The program that runs the work (`vitest`, `tsc`, `cargo`, or the pm). */
  readonly tool: string;
  /** The package-manager verb or script (`build`, `test:unit`, `install`), else null. */
  readonly script: string | null;
  /** The package manager, when the command went through one. */
  readonly pm: string | null;
  /** Arguments after the tool or script. */
  readonly rest: readonly string[];
  /** A workspace-scoping flag was given (`--filter`, `-C`, …). */
  readonly scoped: boolean;
  /** A run-everywhere flag was given (`-r`, `--workspaces`, `yarn workspaces foreach`). */
  readonly recursive: boolean;
}

/**
 * Resolve the command word of `argv`.
 *
 * @example
 * ```ts
 * commandTarget(['pnpm', '--filter', 'x', 'run', 'test:unit']).script; // 'test:unit'
 * commandTarget(['npx', '-y', 'vitest', 'run']).tool;                  // 'vitest'
 * commandTarget(['env', 'CI=1', 'tsc', '-b']).tool;                    // 'tsc'
 * ```
 */
export function commandTarget(argv: readonly string[]): CommandTarget {
  let i = 0;
  while (i < argv.length) {
    const w = argv[i] as string;
    const b = base(w);
    if (PREFIX_COMMANDS.test(b)) {
      i++;
      // The prefix's own flags: `nice -n 10`, `env -i`, `time -p`.
      while (i < argv.length && (argv[i] as string).startsWith('-')) {
        i += b === 'nice' && argv[i] === '-n' ? 2 : 1;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    break;
  }
  const first = base(argv[i] ?? '');
  const after = argv.slice(i + 1);

  if (EXEC_RUNNERS.test(first)) {
    const at = after.findIndex((w) => !w.startsWith('-'));
    return {
      tool: at < 0 ? first : base(after[at] as string),
      script: null,
      pm: null,
      rest: at < 0 ? [] : after.slice(at + 1),
      scoped: false,
      recursive: false,
    };
  }

  if (PACKAGE_MANAGERS.test(first)) {
    let scoped = false;
    let recursive = false;
    let j = 0;
    while (j < after.length && (after[j] as string).startsWith('-')) {
      const f = after[j] as string;
      if (SCOPING_FLAGS.has(f) || f.startsWith('--filter=') || f.startsWith('--dir='))
        scoped = true;
      if (RECURSIVE_FLAGS.has(f)) recursive = true;
      // pnpm's `-w` is the boolean --workspace-root; npm's `-w <name>` takes a value.
      const takesValue = PM_VALUE_FLAGS.has(f) && !(first === 'pnpm' && f === '-w');
      j += takesValue ? 2 : 1;
    }
    let verb = after[j] ?? null;
    let k = j + 1;
    // yarn workspaces foreach [-A …] run <script>
    if (verb === 'workspaces' && after[k] === 'foreach') {
      recursive = true;
      k += 1;
      while (k < after.length && (after[k] as string).startsWith('-')) k++;
      verb = after[k] ?? null;
      k += 1;
    }
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      while (k < after.length && (after[k] as string).startsWith('-')) k++;
      const tool = after[k];
      return {
        tool: tool ? base(tool) : first,
        script: null,
        pm: first,
        rest: after.slice(k + 1),
        scoped,
        recursive,
      };
    }
    if (verb === 'run' || verb === 'run-script') {
      while (k < after.length && (after[k] as string).startsWith('-')) {
        const f = after[k] as string;
        if (RECURSIVE_FLAGS.has(f)) recursive = true;
        k++;
      }
      verb = after[k] ?? null;
      k += 1;
    }
    for (const f of after.slice(k)) if (RECURSIVE_FLAGS.has(f)) recursive = true;
    // `pnpm vitest run`, `yarn tsc -b`: the package manager runs a bin directly.
    if (verb !== null && (TEST_RUNNERS.test(verb) || BUILD_TOOLS.test(verb))) {
      return { tool: verb, script: null, pm: first, rest: after.slice(k), scoped, recursive };
    }
    return { tool: first, script: verb, pm: first, rest: after.slice(k), scoped, recursive };
  }

  return { tool: first, script: null, pm: null, rest: after, scoped: false, recursive: false };
}

function infoOnly(t: CommandTarget): boolean {
  return t.rest.some((w) => INFO_FLAGS.has(w));
}

/** A watcher or server: never heavy, never admitted (it would hold a slot forever). */
function watching(t: CommandTarget): boolean {
  if (t.script !== null && WATCH_SCRIPTS.test(t.script)) return true;
  if (t.rest.some((w) => WATCH_FLAGS.has(w))) return true;
  if ((t.tool === 'tsc' || t.tool === 'jest') && t.rest.includes('-w')) return true;
  // `vite` / `next` without a build subcommand serve.
  if ((t.tool === 'vite' || t.tool === 'next') && !t.rest.includes('build')) return true;
  return false;
}

/**
 * Whether `argv` is a heavy command: a test runner, compiler, bundler or
 * linter as the command word, or a package-manager test/build/typecheck/lint/
 * install script, or `cargo`/`go` build or test. Never `--version`/`--help`,
 * never a watch/dev/serve mode.
 *
 * @example
 * ```ts
 * looksHeavy(['npx', 'vitest', 'run']);              // true
 * looksHeavy(['git', 'commit', '-m', 'fix vitest']);  // false
 * looksHeavy(['pnpm', 'dev']);                       // false
 * looksHeavy(['tsc', '--version']);                  // false
 * ```
 */
export function looksHeavy(argv: readonly string[]): boolean {
  const t = commandTarget(argv);
  if (infoOnly(t) || watching(t)) return false;
  if (TEST_RUNNERS.test(t.tool) || BUILD_TOOLS.test(t.tool)) return true;
  if (t.pm !== null) {
    if (t.script === null) return false;
    if (t.pm === 'bun' && t.script === 'test') return true;
    return HEAVY_SCRIPTS.test(t.script) || INSTALL_VERBS.test(t.script);
  }
  return (t.tool === 'cargo' || t.tool === 'go') && /^(build|test)$/.test(t.rest[0] ?? '');
}

function isWorkspaceRoot(cwd: string): boolean {
  return (
    existsSync(join(cwd, 'pnpm-workspace.yaml')) ||
    existsSync(join(cwd, 'turbo.json')) ||
    existsSync(join(cwd, 'nx.json'))
  );
}

/**
 * The governor class for a command.
 *
 * An explicit `--class` wins (aliases above). Otherwise: a test runner, a
 * `test` script, `npm t`, `bun test` or `cargo|go test` is `test-run`; a build
 * that spans the workspace (`-r`, `--workspaces`, `yarn workspaces foreach`,
 * `turbo run build`, `nx run-many`, or an unscoped build at a workspace root)
 * is `full-build`; anything else is `scoped-build`.
 *
 * @param explicit - the `--class` value, if given.
 * @param argv - the command.
 * @param cwd - where it runs (for the workspace-root check).
 * @throws {Error} when `explicit` is not a known class or alias.
 */
export function resolveRunClass(
  explicit: string | undefined,
  argv: readonly string[],
  cwd: string,
): ResourceClass {
  if (explicit !== undefined) {
    const cls = RUN_CLASS_ALIASES[explicit];
    if (!cls) {
      throw new Error(
        `unknown --class '${explicit}' (expected one of: ${Object.keys(RUN_CLASS_ALIASES).join(', ')})`,
      );
    }
    return cls;
  }
  const t = commandTarget(argv);
  if (TEST_RUNNERS.test(t.tool)) return 'test-run';
  if (t.pm !== null && t.script !== null && (/^test(:|$)/.test(t.script) || t.script === 't')) {
    return 'test-run';
  }
  if ((t.tool === 'cargo' || t.tool === 'go') && t.rest[0] === 'test') return 'test-run';
  const builds =
    (t.script !== null && /^build(:|$)/.test(t.script)) ||
    (t.tool === 'turbo' && t.rest.includes('build')) ||
    (t.tool === 'nx' && t.rest[0] === 'run-many');
  if (builds) {
    if (t.scoped) return 'scoped-build';
    if (t.recursive || t.tool === 'turbo' || t.tool === 'nx') return 'full-build';
    if (t.pm !== null && isWorkspaceRoot(cwd)) return 'full-build';
  }
  return 'scoped-build';
}

/** The `heavyToolEnv` canonical tool a run class sizes its env from. */
export function canonicalForClass(cls: ResourceClass): CanonicalTool {
  return cls === 'test-run' ? 'test' : 'build';
}

/**
 * Whether a job may be SIGSTOPped under pressure. Installs, db-heavy work and
 * cargo (which holds the registry cache and target-dir locks) hold shared
 * locks the oldest job may need, so pausing them can stall the one job that
 * is meant to keep the machine moving.
 */
export function isPausable(cls: ResourceClass, argv: readonly string[]): boolean {
  if (cls === 'db-heavy') return false;
  const t = commandTarget(argv);
  if (t.pm !== null && t.script !== null && INSTALL_VERBS.test(t.script)) return false;
  if (t.tool === 'cargo') return false;
  return true;
}

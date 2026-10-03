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
  typecheck: 'typecheck',
  lint: 'typecheck',
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
/** Tools that build one TypeScript program (or lint) in a single process (T13123). */
const TYPECHECK_TOOLS = /^(tsc|vue-tsc|svelte-check|eslint|biome)$/;
/** Package-manager scripts that typecheck or lint (T13123). */
const TYPECHECK_SCRIPTS = /^(typecheck|type-check|tsc|lint|check)(:|$)/;
/** Serve/dev words that count only as a name's FIRST segment (`dev:web`, not `build:dev`). */
const LEADING_WATCH_WORD = /^(dev|start|preview)$/;
/** Watch/serve words that count in any segment (`test:watch`, `docs:serve`). */
const ANY_WATCH_WORD = /^(watch|serve)$/;
/** Watch-mode flags (`-w` is per tool: maxWorkers for jest; `--ui` per tool: a value for turbo). */
const WATCH_FLAGS = new Set(['--watch', '--watchAll', '--serve']);
/** Tools whose `-w` is `--watch` (for jest it is --maxWorkers, for prettier and gofmt --write). */
const SHORT_WATCH_TOOLS =
  /^(tsc|rollup|webpack|vite|vitest|mocha|ava|sass|babel|tailwindcss|swc|tsx)$/;
/** Tools whose `--ui` opens a long-lived UI server. */
const UI_SERVES = /^(vitest|playwright)$/;
/** Subcommands that serve or watch (only as the first positional word). */
const WATCH_SUBCOMMANDS = new Set(['watch', 'dev', 'serve', 'start', 'preview']);
/**
 * Known tools with no serve/watch subcommand: their first positional word is a
 * path or a flag value, never a mode (`pytest -k dev`, `jest -t start`,
 * `mocha -g watch`, `tsc -p dev`). Any other tool keeps the subcommand rule.
 */
const NO_WATCH_SUBCOMMAND =
  /^(jest|mocha|ava|tap|playwright|pytest|rspec|phpunit|tsc|tsup|esbuild|rollup|eslint|biome|svelte-check|go|prettier|gofmt)$/;
/** Short flags that take a value, for tools that do have serve/watch subcommands (`vitest -t serve`). */
const SHORT_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  vitest: ['-t', '-c', '-r'],
  vite: ['-c', '-m', '-l', '-f'],
  webpack: ['-c', '-o', '-t', '-d', '-e'],
  next: ['-p', '-H'],
};
/** `next` subcommands that run once (`next lint`); with no subcommand, `dev` or `start` it serves. */
const NEXT_ONESHOT = /^(build|lint|info|export|telemetry|typegen|experimental-[\w-]+)$/;
/** `next` subcommands that build nothing either: never heavy. */
const NEXT_ADMIN = /^(info|telemetry)$/;
/** `vite` subcommands that run once; anything else serves (`vite`, `vite dev`, `vite preview`). */
const VITE_ONESHOT = /^(build|optimize)$/;
/**
 * CLEO's own CLI as a command word: `cleo`, `ct`, a versioned package
 * (`@cleocode/cleo@latest`), or a script path (`…/bin/cleo.js`,
 * `packages/cleo/dist/cli/index.js`).
 */
const CLEO_BIN = /^(cleo|ct)(@[\w.-]+|\.[cm]?js)?$/;
const CLEO_SCRIPT = /(^|\/)(cleo|ct)(\.[cm]?js)?$|(^|\/)cleo\/dist\/cli\/index\.js$/;
/** node flags that take a value, so the value is never read as the script. */
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
]);
const INFO_FLAGS = new Set(['--version', '--help', '-h']);
/**
 * Short flags that mean `--version`, per tool; any other tool: both. `-v` is
 * verbose for go, pytest and cargo; jest and vitest have no `-V`.
 */
const SHORT_VERSION_FLAGS: Readonly<Record<string, readonly string[]>> = {
  jest: ['-v'],
  vitest: ['-v'],
  pytest: ['-V'],
  mocha: ['-V'],
  cargo: ['-V'],
  go: [],
};
/** turbo flags that take a value (so the value is never read as a task). */
const TURBO_VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--concurrency',
  '--cache',
  '--cache-dir',
  '--cache-workers',
  '--output-logs',
  '--log-order',
  '--log-prefix',
  '--env-mode',
  '--global-deps',
  '--ui',
  '--cwd',
  '--team',
  '--token',
  '--api',
  '--login',
  '--heap',
  '--trace',
  '--cpuprofile',
  '--profile',
  '--anon-profile',
  '--remote-cache-timeout',
  '--pkg-inference-root',
  '--root-turbo-json',
]);
/** turbo subcommands that run no task (`turbo login`, `turbo prune`). `turbo watch` watches. */
const TURBO_ADMIN = new Set([
  'login',
  'logout',
  'link',
  'unlink',
  'prune',
  'gen',
  'generate',
  'daemon',
  'info',
  'ls',
  'query',
  'scan',
  'telemetry',
  'bin',
  'completion',
  'boundaries',
]);
/** nx subcommands that run no target (`nx graph`, `nx show`). `nx watch` watches. */
const NX_ADMIN = new Set([
  'graph',
  'show',
  'report',
  'list',
  'migrate',
  'g',
  'generate',
  'reset',
  'daemon',
  'init',
  'add',
  'release',
  'connect',
  'connect-to-nx-cloud',
  'login',
  'logout',
  'repair',
  'sync',
  'view-logs',
  'import',
]);
/** nx flags that take a value. `-t`/`--target(s)` are read as tasks. */
const NX_VALUE_FLAGS = new Set([
  '--configuration',
  '-c',
  '--projects',
  '-p',
  '--exclude',
  '--parallel',
  '--base',
  '--head',
  '--output-style',
  '--files',
]);
/** nx flags that name the tasks of `run-many` / `affected`. */
const NX_TARGET_FLAGS = new Set(['-t', '--target', '--targets']);
/** Package-manager flags that take a value. */
const PM_VALUE_FLAGS = new Set([
  '--workspace-concurrency',
  '--reporter',
  '--loglevel',
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
        const f = argv[i] as string;
        i +=
          (b === 'nice' && f === '-n') || (b === 'env' && (f === '-u' || f === '--unset')) ? 2 : 1;
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
    // `npx -p pkg cmd`, `npx --package=pkg cmd`: skip value-taking flags.
    let at = -1;
    for (let x = 0; x < after.length; x++) {
      const w = after[x] as string;
      if (w === '-p' || w === '--package') {
        x++;
        continue;
      }
      if (!w.startsWith('-')) {
        at = x;
        break;
      }
    }
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
      // `pnpm dlx -p typescript tsc`: `-p`/`--package` take a value.
      while (k < after.length && (after[k] as string).startsWith('-')) {
        const f = after[k] as string;
        k += f === '-p' || f === '--package' ? 2 : 1;
      }
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
      // `pnpm run --filter x build`: flags (and their values) before the script.
      while (k < after.length && (after[k] as string).startsWith('-')) {
        const f = after[k] as string;
        if (RECURSIVE_FLAGS.has(f)) recursive = true;
        if (SCOPING_FLAGS.has(f) || f.startsWith('--filter=') || f.startsWith('--dir='))
          scoped = true;
        k += PM_VALUE_FLAGS.has(f) && !(first === 'pnpm' && f === '-w') ? 2 : 1;
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
  const short = Object.hasOwn(SHORT_VERSION_FLAGS, t.tool)
    ? (SHORT_VERSION_FLAGS[t.tool] as readonly string[])
    : ['-v', '-V'];
  return t.rest.some((w) => INFO_FLAGS.has(w) || short.includes(w));
}

/**
 * Positional words of `rest`: not flags, and not the value right after a
 * long `--flag` given without `=` (so `--mode dev`, `--project dev`,
 * `--profile dev` never read as a `dev` subcommand), nor after one of the
 * tool's value-taking short flags (`vitest -t serve`).
 */
function positionals(
  rest: readonly string[],
  shortTakesValue: (flag: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  rest.forEach((w, x) => {
    if (w.startsWith('-')) return;
    const prev = rest[x - 1];
    if (prev?.startsWith('--') && !prev.includes('=')) return;
    if (prev !== undefined && shortTakesValue(prev)) return;
    out.push(w);
  });
  return out;
}

/**
 * The first positional word after the tool or script. A package-manager
 * script hands its arguments to a command we cannot see, so the word after
 * any single-letter flag is read as that flag's value (`pnpm test -t serve`).
 */
function subcommand(t: CommandTarget): string | undefined {
  if (t.script !== null) return positionals(t.rest, (f) => /^-[A-Za-z]$/.test(f))[0];
  const short = Object.hasOwn(SHORT_VALUE_FLAGS, t.tool)
    ? (SHORT_VALUE_FLAGS[t.tool] as readonly string[])
    : [];
  return positionals(t.rest, (f) => short.includes(f))[0];
}

/**
 * Whether a script or task name serves or watches: `dev`, `start` or
 * `preview` as its first segment (`dev`, `dev:web`), or `watch`/`serve` in
 * any segment (`test:watch`, `docs:serve`). `build:dev`, `build:preview` and
 * `test:dev` are one-shot runs.
 */
export function isWatchName(name: string): boolean {
  const segs = name.split(':');
  return LEADING_WATCH_WORD.test(segs[0] ?? '') || segs.some((seg) => ANY_WATCH_WORD.test(seg));
}

/** The tasks a turbo or nx command runs. */
interface OrchestratorTasks {
  /** Task names (`build`, `test`, `serve`), without a `pkg#` prefix or nx project. */
  readonly tasks: readonly string[];
  /** An admin subcommand that runs no task (`turbo login`, `nx graph`): never heavy. */
  readonly admin: boolean;
  /** `turbo watch` / `nx watch`: a watcher whatever its tasks. */
  readonly watch: boolean;
  /** Runs across the workspace (`turbo run`, `nx run-many`, `nx affected`). */
  readonly many: boolean;
  /** Narrowed to some packages (`--filter`, `--projects`). */
  readonly scoped: boolean;
}

/**
 * The tasks of a turbo or nx command, or null for any other tool.
 *
 * - turbo: `turbo run a b`, `turbo a b` (`web#dev` → `dev`); `--filter` scopes.
 * - nx: `nx run-many|affected -t a b` / `--targets=a,b`; `nx run proj:target[:config]`;
 *   `nx <target> <project>` (`nx serve app`, `nx --verbose test app`).
 */
function orchestratorTasks(t: CommandTarget): OrchestratorTasks | null {
  if (t.tool === 'turbo') {
    const words: string[] = [];
    let scoped = false;
    for (let x = 0; x < t.rest.length; x++) {
      const w = t.rest[x] as string;
      if (w.startsWith('-')) {
        if (w === '--filter' || w === '-F' || w.startsWith('--filter=')) scoped = true;
        if (TURBO_VALUE_FLAGS.has(w)) x++;
        continue;
      }
      words.push(w);
    }
    const sub = words[0];
    if (sub !== undefined && TURBO_ADMIN.has(sub)) {
      return { tasks: [], admin: true, watch: false, many: false, scoped };
    }
    const watch = sub === 'watch';
    if (sub === 'run' || watch) words.shift();
    return {
      tasks: words.map((w) => w.split('#').pop() ?? w),
      admin: false,
      watch,
      many: true,
      scoped,
    };
  }
  if (t.tool === 'nx') {
    const tasks: string[] = [];
    const pos: string[] = [];
    let scoped = false;
    for (let x = 0; x < t.rest.length; x++) {
      const w = t.rest[x] as string;
      const [flag, value] = w.split('=', 2) as [string, string | undefined];
      if (NX_TARGET_FLAGS.has(flag)) {
        if (value !== undefined) tasks.push(...value.split(','));
        else
          while (x + 1 < t.rest.length && !(t.rest[x + 1] as string).startsWith('-')) {
            tasks.push(...(t.rest[++x] as string).split(','));
          }
        continue;
      }
      if (w.startsWith('-')) {
        if (flag === '--projects' || flag === '-p') scoped = true;
        if (value === undefined && NX_VALUE_FLAGS.has(flag)) x++;
        continue;
      }
      pos.push(w);
    }
    const sub = pos[0];
    const none = { admin: false, watch: false } as const;
    if (sub !== undefined && NX_ADMIN.has(sub)) {
      return { tasks: [], admin: true, watch: false, many: false, scoped: true };
    }
    if (sub === 'watch') return { tasks, admin: false, watch: true, many: false, scoped: true };
    if (sub === 'run-many' || sub === 'affected') return { tasks, ...none, many: true, scoped };
    // `nx run web:test:ci`: the target is the second segment.
    if (sub === 'run') {
      const target = (pos[1] ?? '').split(':')[1];
      return { tasks: target ? [target] : [], ...none, many: false, scoped: true };
    }
    return { tasks: sub ? [sub] : [], ...none, many: false, scoped: true };
  }
  return null;
}

/** A watcher or server: never heavy, never admitted (it would hold a slot forever). */
function watching(t: CommandTarget): boolean {
  // `next --help`, `vite --version` print and exit. Not for a package-manager
  // script, which passes the flag on to whatever the script runs.
  if (t.script === null && infoOnly(t)) return false;
  // `pnpm dev`, `npm run test:watch`, `pnpm build:watch`, `pnpm run serve:docs`.
  if (t.script !== null && isWatchName(t.script)) return true;
  if (t.rest.some((w) => WATCH_FLAGS.has(w) || w.startsWith('--serve='))) return true;
  // `vitest --ui`, `playwright test --ui`; for turbo `--ui` takes a value (`--ui stream`).
  if (UI_SERVES.test(t.tool) && t.rest.includes('--ui')) return true;
  // `tsc -w`, `rollup -c -w`; never `jest -w 2`, `prettier -w .` or `gofmt -w .`.
  if (SHORT_WATCH_TOOLS.test(t.tool) && t.rest.includes('-w')) return true;
  // `turbo run dev`, `nx run-many -t serve`, `nx affected -t dev`, `nx run app:serve`.
  const orch = orchestratorTasks(t);
  if (orch) return orch.watch || orch.tasks.some(isWatchName);
  if (NO_WATCH_SUBCOMMAND.test(t.tool)) return false;
  const sub = subcommand(t);
  // `vitest watch`, `next dev`, `webpack serve`.
  if (sub !== undefined && WATCH_SUBCOMMANDS.has(sub)) return true;
  // `next` and `vite` serve unless told to do a one-shot job (`vite preview` serves).
  if (t.tool === 'next') return sub === undefined || !NEXT_ONESHOT.test(sub);
  if (t.tool === 'vite') return sub === undefined || !VITE_ONESHOT.test(sub);
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
  if (orchestratorTasks(t)?.admin === true) return false;
  if (t.tool === 'next' && NEXT_ADMIN.test(subcommand(t) ?? '')) return false;
  if (TEST_RUNNERS.test(t.tool) || BUILD_TOOLS.test(t.tool)) return true;
  if (t.pm !== null) {
    if (t.script === null) return false;
    if (t.pm === 'bun' && t.script === 'test') return true;
    return HEAVY_SCRIPTS.test(t.script) || INSTALL_VERBS.test(t.script);
  }
  return (t.tool === 'cargo' || t.tool === 'go') && /^(build|test)$/.test(t.rest[0] ?? '');
}

/**
 * Whether `argv` is a watcher or server (`pnpm dev`, `turbo run dev`,
 * `vitest --ui`, `vite preview`): it never exits, so `cleo run` refuses it
 * rather than let it hold a slot forever (an explicit `--class` overrides).
 * Never `--version`/`--help`, a flag value (`pytest -k dev`, `vitest -t serve`)
 * or a `-w` that means something else (`jest -w 2`, `prettier -w .`).
 */
export function isWatchCommand(argv: readonly string[]): boolean {
  return watching(commandTarget(argv));
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
 * `test` script, `npm t`, `bun test`, `cargo|go test`, or turbo/nx running
 * only test tasks is `test-run`; `tsc`, `vue-tsc`, `svelte-check`, `eslint`,
 * `biome`, or a non-recursive `typecheck`/`lint`/`check` script is
 * `typecheck` (T13123: one TypeScript program, budgeted per process); a build
 * that spans the workspace (`-r`, `--workspaces`, `yarn workspaces foreach`, an
 * unscoped build at a workspace root, or any non-test turbo /
 * `nx run-many|affected` run, `build test` included) is `full-build`; anything
 * else is `scoped-build`.
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
  // One TypeScript program in one process (T13123). A recursive script fans
  // out across the workspace and stays a build.
  if (TYPECHECK_TOOLS.test(t.tool)) return 'typecheck';
  if (t.pm !== null && t.script !== null && TYPECHECK_SCRIPTS.test(t.script) && !t.recursive) {
    return 'typecheck';
  }
  // turbo / nx: a build (or any non-test task) across the workspace is a full
  // build, checked BEFORE the test rule so `turbo run build test` keeps the
  // single full-build slot; tests only are a test run (`nx run web:test`).
  const orch = orchestratorTasks(t);
  if (orch) {
    const isTest = (x: string): boolean => /^test(:|$)/.test(x);
    if (orch.tasks.length > 0 && orch.tasks.every(isTest)) return 'test-run';
    return orch.many && !orch.scoped && !t.scoped ? 'full-build' : 'scoped-build';
  }
  if (t.script !== null && /^build(:|$)/.test(t.script)) {
    if (t.scoped) return 'scoped-build';
    if (t.recursive) return 'full-build';
    if (t.pm !== null && isWorkspaceRoot(cwd)) return 'full-build';
  }
  return 'scoped-build';
}

/**
 * The `heavyToolEnv` canonical tool a run class sizes its env from: `test`
 * for a test run, `typecheck` (a heap ceiling, no worker pool) for a
 * typecheck, `build` for the rest.
 */
export function canonicalForClass(cls: ResourceClass): CanonicalTool {
  if (cls === 'test-run') return 'test';
  if (cls === 'typecheck') return 'typecheck';
  return 'build';
}

/** The script a `node` command runs (`node --max-old-space-size=4096 bin/cleo.js`), else null. */
function nodeScript(rest: readonly string[]): string | null {
  for (let x = 0; x < rest.length; x++) {
    const w = rest[x] as string;
    if (w === '-e' || w === '--eval' || w === '-p' || w === '--print') return null;
    if (NODE_VALUE_FLAGS.has(w)) {
      x++;
      continue;
    }
    if (!w.startsWith('-')) return w;
  }
  return null;
}

/**
 * Whether the command word is CLEO's own CLI: `cleo …`, `ct …`, `npx cleo`,
 * `pnpm exec cleo`, `pnpm cleo`, `node …/bin/cleo.js`.
 */
function isCleoCommand(t: CommandTarget): boolean {
  if (CLEO_BIN.test(t.tool)) return true;
  if (t.script !== null && CLEO_SCRIPT.test(t.script)) return true;
  if (t.tool !== 'node') return false;
  const script = nodeScript(t.rest);
  return script !== null && CLEO_SCRIPT.test(script);
}

/**
 * Whether a job may be SIGSTOPped under pressure. Installs, db-heavy work and
 * cargo (which holds the registry cache and target-dir locks) hold shared
 * locks the oldest job may need, so pausing them can stall the one job that
 * is meant to keep the machine moving.
 *
 * CLEO's own commands are never paused either (#1777 R7-1): `cleo verify
 * --evidence tool:test` holds the tool-semaphore and tool-cache locks and
 * spawns its heavy tool DETACHED, out of the paused group. A pause would
 * freeze only the lock holder while the test keeps running; its locks stop
 * refreshing, go stale and are taken, and it crashes on resume.
 */
export function isPausable(cls: ResourceClass, argv: readonly string[]): boolean {
  if (cls === 'db-heavy') return false;
  const t = commandTarget(argv);
  if (t.pm !== null && t.script !== null && INSTALL_VERBS.test(t.script)) return false;
  if (t.tool === 'cargo') return false;
  if (isCleoCommand(t)) return false;
  return true;
}

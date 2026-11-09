/**
 * File-level affected test selection (T14366, extends T13148 and T13142).
 *
 * Package-level selection ({@link deriveAffectedPackages}) runs every test of
 * every package that depends on a change, so any core change selects almost
 * the whole suite. This walks the static import graph instead: from each
 * changed module up through the files that import it, to the test files that
 * reach it. It reads only the checkout (no NEXUS index, no build output), so
 * it works in CI on a fresh clone.
 *
 * Re-exports are followed by name: `export { a } from './x.js'` and
 * `export * from './x.js'` bind nothing locally, so an importer of `b` from a
 * barrel does not depend on the module that exports `a`. Loading the barrel
 * still evaluates every module it re-exports, so a module with top-level
 * statements other than declarations (a registration call, an IIFE) counts as
 * affecting every importer of every barrel that re-exports it.
 *
 * Fails closed: it returns `full` with a reason whenever the graph cannot
 * speak for the change, and the caller falls back to package-level selection
 * (which itself goes full for root config, the lockfile and workflows):
 * - a path package-level selection already sends to the full suite;
 * - a changed file that is not an importable module (JSON, SQL, templates,
 *   fixtures, `package.json`, configs and setup files): runtime reads the
 *   graph cannot see;
 * - a changed module no test file reaches;
 * - git cannot list the files, or the selection is too large to pass on.
 *
 * Tests with edges the graph cannot see run with their package, as before:
 * a test that reads files or spawns processes on source or `dist/` paths runs
 * whenever its package is affected, and one naming another package's tree
 * (`packages/…`) whenever any package is. Every test outside every package
 * (the root `scripts` tests) always runs, as package-level selection always
 * appends package-less projects.
 *
 * shortcut: an import whose path is computed at runtime (`import(variable)`)
 * is not followed; the callers in this repo load adapters, plugins and npm
 * modules, not workspace source. Upgrade when one loads workspace source.
 *
 * @task T14366
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { resolveOriginDefault } from '../git/base-ref.js';
import {
  deriveAffectedPackages,
  inPackageDir,
  listVitestProjects,
  listWorkspacePackages,
  TEST_FILE,
  type VitestProject,
  type WorkspacePackage,
} from './affected-packages.js';

/** File-level selection, or why only package-level (or full) selection will do. */
export type AffectedTestSelection =
  | {
      mode: 'affected';
      /** Repo-relative test files to run, sorted. */
      testFiles: string[];
      /** `path#name` for each symbol a changed module exports, sorted. */
      symbols: string[];
      /** Changed modules the walk started from, sorted. */
      changedModules: string[];
      /** Why these files. */
      reason: string;
    }
  | { mode: 'full'; reason: string };

/**
 * Most test files one selection names. Past it the list would not fit one
 * environment variable or argument (128 KiB on Linux), and it is near the
 * package-level set anyway.
 */
export const MAX_SELECTED_TEST_FILES = 1200;

/** Files the graph reads: importable source modules. */
const MODULE_FILE = /\.(?:[cm]?[jt]sx?|svelte)$/;

/** Modules that configure a run rather than being imported by one. */
const CONFIG_MODULE =
  /(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|vitest\.[\w.-]+\.[cm]?[jt]s|setup-global\.[cm]?[jt]s|[\w.-]+\.d\.ts)$/;

/** `import|export <clause> from 'x'`: 1 keyword, 2 clause, 3 specifier. */
const FROM_STATEMENT =
  /(?:^|[;\n}])[ \t]*(import|export)\s+([^'"`;]*?)\s*\bfrom\s*['"]([^'"\n]+)['"]/g;

/** `import 'x'`: a side-effect import. */
const BARE_IMPORT = /(?:^|[;\n])[ \t]*import\s*['"]([^'"\n]+)['"]/g;

/** `import('x')`, `require('x')` and vitest's module mocks with a literal path. */
const CALL_IMPORT =
  /\b(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\s*\(\s*['"`]([^'"`$\n]+)['"`]/g;

/** A name a module declares and exports. */
const EXPORTED_DECLARATION =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

/** `export { a, b as c }` with no `from`. */
const EXPORT_LIST = /(?:^|[;\n])[ \t]*export\s*\{([^}]*)\}(?!\s*from)/g;

/** Top-level code that runs on load, or an export the declaration scan cannot name. */
const LOAD_EFFECT =
  /^(?!(?:export|import|const|let|var|function|async|class|interface|type|enum|declare|abstract|namespace)\b)[A-Za-z_$([`]|^export\s+(?:const|let|var)\s*[{[]/m;

/** Comments and template literal bodies, which hold no top-level statement. */
const NOT_CODE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^\\`])*`/g;

/** A file read or process spawn: the test may depend on files it never imports. */
const HIDDEN_READ =
  /\b(?:readFileSync|readdirSync|globSync|readFile|readdir|execFileSync|execFile|execSync|spawnSync|spawn|fork)\(/;

/** A path into a source or build tree, or a path relative to the test itself. */
const SOURCE_PATH = /['"`/](?:src|dist|bin)['"`/]|import\.meta\.(?:dirname|url)|__dirname/;

/** A path naming another package's tree. */
const OTHER_PACKAGE_PATH = /['"`/]packages\/|\.\.\/\.\.\/\.\./;

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.svelte',
  '/index.ts',
  '/index.js',
];

/** Every name of the target module (namespace, side-effect and dynamic imports). */
const ALL = '*';

/** One module's edges as the walk needs them. */
interface ModuleInfo {
  /** Names it declares and exports (`default` included). */
  exports: Set<string>;
  /** Runs top-level code on load, or exports names the scan cannot list. */
  loadEffect: boolean;
  /** Re-exports: `star` for `export *`, else the source name and the exported name. */
  reexports: Array<{ target: string; star: true } | { target: string; from: string; as: string }>;
  /** Imports: the names it binds from each target, or {@link ALL}. */
  imports: Array<{ target: string; names: string[] }>;
  /** Workspace packages it depends on as a whole (an unresolvable workspace specifier). */
  packages: string[];
}

/** NUL-separated git output as a list, or null when git fails. */
function gitList(root: string, args: readonly string[]): string[] | null {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args, '-z'], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Tracked and untracked (not ignored) files, or null when git fails. */
function listFiles(root: string): string[] | null {
  return gitList(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
}

function readText(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf-8');
  } catch {
    return null; // deleted in the working tree
  }
}

/** The module `base` names: as spelled, `.js` written for `.ts`, or with an extension or index. */
function resolveIn(base: string, files: ReadonlySet<string>): string | null {
  for (const stem of [base, base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')]) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (files.has(stem + suffix)) return stem + suffix;
    }
  }
  return null;
}

/** The names a `{ a, b as c, type D }` list binds: [source, exported] pairs, types dropped. */
function bindings(list: string): Array<[string, string]> {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/^type\s/.test(s))
    .map((s) => {
      const [from, as] = s.split(/\s+as\s+/);
      return [from as string, (as ?? from) as string];
    });
}

function parseModule(
  file: string,
  text: string,
  files: ReadonlySet<string>,
  packages: readonly WorkspacePackage[],
  owner: WorkspacePackage | undefined,
): ModuleInfo {
  const info: ModuleInfo = {
    exports: new Set(),
    loadEffect: false,
    reexports: [],
    imports: [],
    packages: [],
  };
  /** Resolve a specifier; an unresolved workspace one becomes a package edge. */
  const target = (spec: string): string | null => {
    if (spec.startsWith('.')) return resolveIn(posix.join(posix.dirname(file), spec), files);
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (pkg) {
      const sub = spec.slice(pkg.name.length + 1);
      const hit =
        sub === ''
          ? resolveIn(posix.join(pkg.dir, 'src/index'), files)
          : (resolveIn(posix.join(pkg.dir, 'src', sub), files) ??
            resolveIn(posix.join(pkg.dir, sub), files));
      if (!hit) info.packages.push(pkg.name); // an export-map subpath that is not its source path
      return hit;
    }
    // An alias (`$lib/…`) or subpath import (`#x`): depend on the importer's package.
    if ((spec.startsWith('$') || spec.startsWith('#')) && owner) info.packages.push(owner.name);
    // An unresolved relative path is a non-module file (JSON, SQL, assets), and
    // anything else is an npm module: a change to neither is a module change.
    return null;
  };
  for (const m of text.matchAll(FROM_STATEMENT)) {
    const [, keyword, rawClause = '', spec = ''] = m;
    const clause = rawClause.trim();
    if (/^type\s+(?!from\b)/.test(clause)) continue; // erased at runtime
    const to = target(spec);
    if (to === null) continue;
    if (keyword === 'export') {
      const ns = /^\*\s*as\s+([\w$]+)$/.exec(clause);
      if (clause === '*') info.reexports.push({ target: to, star: true });
      else if (ns?.[1]) info.reexports.push({ target: to, from: ALL, as: ns[1] });
      else {
        for (const [from, as] of bindings(clause.replace(/^\{|\}$/g, ''))) {
          info.reexports.push({ target: to, from, as });
        }
      }
      continue;
    }
    if (clause.includes('*')) {
      info.imports.push({ target: to, names: [ALL] });
      continue;
    }
    const brace = /\{([^}]*)\}/.exec(clause);
    const names = brace?.[1] ? bindings(brace[1]).map(([from]) => from) : [];
    if (/^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause)) names.push('default');
    info.imports.push({ target: to, names: names.length > 0 ? names : [ALL] });
  }
  for (const m of text.matchAll(BARE_IMPORT)) {
    const to = m[1] ? target(m[1]) : null;
    if (to) info.imports.push({ target: to, names: [ALL] });
  }
  for (const m of text.matchAll(CALL_IMPORT)) {
    const to = m[1] ? target(m[1]) : null;
    if (to) info.imports.push({ target: to, names: [ALL] });
  }
  for (const m of text.matchAll(EXPORTED_DECLARATION)) if (m[1]) info.exports.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const [, as] of bindings(m[1] ?? '')) info.exports.add(as);
  }
  if (/^export\s+default\b/m.test(text)) info.exports.add('default');
  info.loadEffect = LOAD_EFFECT.test(
    text.replace(NOT_CODE, (m) => (m.startsWith('`') ? "''" : '')),
  );
  return info;
}

/** How a change reaches one module. */
interface Reach {
  /** Its own code depends on the change, so every name it declares does. */
  local: boolean;
  /** Re-exported names that lead to the change. */
  names: Set<string>;
  /** Loading it runs code that depends on the change, so every importer does. */
  onLoad: boolean;
}

/** Who imports, re-exports and package-depends on each module. */
interface ReverseIndex {
  importers: Map<string, Array<{ file: string; names: string[] }>>;
  reexporters: Map<string, Array<{ file: string; edge: ModuleInfo['reexports'][number] }>>;
  packageImporters: Map<string, string[]>;
}

function reverseIndex(modules: ReadonlyMap<string, ModuleInfo>): ReverseIndex {
  const index: ReverseIndex = {
    importers: new Map(),
    reexporters: new Map(),
    packageImporters: new Map(),
  };
  const add = <V>(map: Map<string, V[]>, key: string, value: V): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const [file, info] of modules) {
    for (const i of info.imports) add(index.importers, i.target, { file, names: i.names });
    for (const edge of info.reexports) add(index.reexporters, edge.target, { file, edge });
    for (const p of info.packages) add(index.packageImporters, p, file);
  }
  return index;
}

/**
 * Every module a change to `seed` reaches, through imports and by name through
 * re-exports.
 */
function walk(
  seed: string,
  modules: ReadonlyMap<string, ModuleInfo>,
  index: ReverseIndex,
  ownerOf: (path: string) => WorkspacePackage | undefined,
): Map<string, Reach> {
  const { importers, reexporters, packageImporters } = index;
  const reach = new Map<string, Reach>();
  const queue: string[] = [];
  const state = (file: string): Reach => {
    let r = reach.get(file);
    if (!r) {
      r = { local: false, names: new Set(), onLoad: false };
      reach.set(file, r);
    }
    return r;
  };
  const touch = (file: string, change: (r: Reach) => boolean): void => {
    if (change(state(file))) queue.push(file);
  };
  const makeLocal = (file: string): void =>
    touch(file, (r) => {
      if (r.local) return false;
      r.local = true;
      // A module the scan cannot read (deleted) or that runs code on load.
      r.onLoad ||= modules.get(file)?.loadEffect ?? true;
      return true;
    });
  /** Whether importing `name` from `file` depends on the change. */
  const provides = (file: string, name: string): boolean => {
    const r = reach.get(file);
    if (!r) return false;
    if (r.onLoad || name === ALL) return true;
    const info = modules.get(file);
    if (r.local && (info === undefined || info.exports.has(name))) return true;
    if (r.names.has(name)) return true;
    // A name the module neither declares nor re-exports was not parsed: assume it.
    return (
      info !== undefined &&
      !info.exports.has(name) &&
      !info.reexports.some((e) => 'star' in e || e.as === name)
    );
  };
  const seenPackages = new Set<string>();
  makeLocal(seed);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const r = reach.get(file) as Reach;
    for (const i of importers.get(file) ?? []) {
      if (i.names.some((n) => provides(file, n))) makeLocal(i.file);
    }
    for (const { file: barrel, edge } of reexporters.get(file) ?? []) {
      touch(barrel, (b) => {
        const before = `${b.onLoad}${b.names.size}`;
        if (r.onLoad) b.onLoad = true;
        if ('star' in edge) {
          const own = r.local ? [...(modules.get(file)?.exports ?? [])] : [];
          for (const n of [...own, ...r.names]) if (n !== 'default') b.names.add(n);
        } else if (edge.from === ALL || provides(file, edge.from)) b.names.add(edge.as);
        return `${b.onLoad}${b.names.size}` !== before;
      });
    }
    const pkg = ownerOf(file)?.name;
    if (pkg && !seenPackages.has(pkg)) {
      seenPackages.add(pkg);
      for (const importer of packageImporters.get(pkg) ?? []) makeLocal(importer);
    }
  }
  return reach;
}

/**
 * Select the test files a change reaches through the static import graph.
 *
 * @param root - Workspace root (the git checkout).
 * @param changedPaths - Repo-relative changed paths (deleted ones included).
 * @returns The test files, or `full` with the reason file-level selection
 *   cannot speak for the change (the caller then selects by package).
 * @example
 * ```ts
 * const sel = selectAffectedTestFiles(root, ['packages/core/src/tasks/add.ts']);
 * if (sel.mode === 'affected') console.log(sel.testFiles);
 * ```
 * @task T14366
 */
export function selectAffectedTestFiles(
  root: string,
  changedPaths: readonly string[],
): AffectedTestSelection {
  const changed = changedPaths.map((p) => p.replace(/\\/g, '/'));
  if (changed.length === 0) return { mode: 'full', reason: 'the diff is empty' };
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full') return { mode: 'full', reason: scope.reason };
  const packages = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const ownerOf = (path: string): WorkspacePackage | undefined =>
    packages.find((p) => p.dir !== '' && inPackageDir(path, p.dir));
  const listed = listFiles(root);
  if (listed === null) return { mode: 'full', reason: 'git could not list the module files' };
  const files = new Set(
    listed.filter((f) => MODULE_FILE.test(f) && !/(?:^|\/)(?:node_modules|dist)\//.test(f)),
  );

  const seeds: string[] = [];
  const directTests: string[] = [];
  for (const path of changed) {
    if (!ownerOf(path)) continue; // documents and CLEO config: package-level selection ignores them too
    if (TEST_FILE.test(path)) {
      if (files.has(path)) directTests.push(path);
    } else if (MODULE_FILE.test(path) && !CONFIG_MODULE.test(path)) {
      seeds.push(path);
      files.add(path); // a deleted module still has importers to find
    } else {
      return {
        mode: 'full',
        reason: `the import graph cannot see ${path} (read at runtime or configures the run)`,
      };
    }
  }

  if (seeds.length === 0 && directTests.length === 0) {
    return { mode: 'full', reason: 'no module or test file changed' };
  }

  const modules = new Map<string, ModuleInfo>();
  const alwaysTests: string[] = [];
  for (const file of files) {
    const text = readText(root, file);
    if (text === null) continue;
    const owner = ownerOf(file);
    modules.set(file, parseModule(file, text, files, packages, owner));
    if (!TEST_FILE.test(file) || file.split('/').some((s) => s.startsWith('.'))) continue;
    const hidden = HIDDEN_READ.test(text);
    if (!owner || (hidden && OTHER_PACKAGE_PATH.test(text))) alwaysTests.push(file);
    else if (hidden && SOURCE_PATH.test(text) && scope.packages.includes(owner.name)) {
      alwaysTests.push(file);
    }
  }

  const index = reverseIndex(modules);
  const selected = new Set([...directTests, ...alwaysTests]);
  for (const seed of seeds) {
    const reached = [...walk(seed, modules, index, ownerOf)]
      .filter(([f, r]) => TEST_FILE.test(f) && (r.local || r.onLoad))
      .map(([f]) => f);
    if (reached.length === 0) {
      return { mode: 'full', reason: `no test file reaches ${seed}, directly or transitively` };
    }
    for (const t of reached) selected.add(t);
  }
  const testFiles = [...selected].sort();
  if (testFiles.length > MAX_SELECTED_TEST_FILES) {
    return {
      mode: 'full',
      reason: `${testFiles.length} test files reach the change (over ${MAX_SELECTED_TEST_FILES})`,
    };
  }
  const symbols = seeds.flatMap((seed) =>
    [...(modules.get(seed)?.exports ?? [])].map((name) => `${seed}#${name}`),
  );
  return {
    mode: 'affected',
    testFiles,
    symbols: symbols.sort(),
    changedModules: seeds.sort(),
    reason:
      `${testFiles.length} test file(s): ${seeds.length} changed module(s), ` +
      `${directTests.length} changed test file(s), ${alwaysTests.length} that read files or spawn processes`,
  };
}

/**
 * The vitest projects that collect `testFiles`: each file's project is the one
 * whose root is the longest prefix of its path.
 *
 * @param testFiles - Repo-relative test files.
 * @param projects - Vitest's resolved projects (`listVitestProjects`).
 * @returns Project names, sorted.
 * @task T14366
 */
export function projectsOfTestFiles(
  testFiles: readonly string[],
  projects: readonly VitestProject[],
): string[] {
  const byDepth = [...projects].sort((a, b) => b.dir.length - a.dir.length);
  const names = new Set<string>();
  for (const file of testFiles) {
    const project = byDepth.find((p) => inPackageDir(file, p.dir));
    if (project) names.add(project.name);
  }
  return [...names].sort();
}

/** What `cleo nexus affected` reports: the selection for one checkout against a base. */
export type AffectedTestReport = AffectedTestSelection & {
  /** The ref diffed against. */
  base: string | null;
  /** Its merge base with HEAD, the diff's left side. */
  mergeBase: string | null;
  /** Changed paths: committed since the merge base, uncommitted and untracked. */
  changed: string[];
  /** Vitest projects that collect the selected files (empty for `full`). */
  projects: string[];
  /** Why `projects` is empty for an `affected` selection, when vitest could not list them. */
  projectsUnresolved?: string;
};

/**
 * The file-level selection for the checkout at `root` against `base` (default:
 * origin's default branch), with the vitest projects that collect the files.
 *
 * @param cwd - A directory in the git checkout (a worktree is its own checkout).
 * @param base - Ref to diff against.
 * @returns The report; `mode: 'full'` names why file-level selection cannot speak.
 * @task T14366
 */
export async function affectedTestReport(cwd: string, base?: string): Promise<AffectedTestReport> {
  const line = (args: readonly string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const root = line(['rev-parse', '--show-toplevel']) ?? cwd;
  const ref = base ?? resolveOriginDefault(root);
  const mergeBase = ref ? line(['merge-base', ref, 'HEAD']) : null;
  const diff = mergeBase ? gitList(root, ['diff', '--name-only', '--no-renames', mergeBase]) : null;
  const untracked = gitList(root, ['ls-files', '--others', '--exclude-standard']);
  const head = { base: ref, mergeBase, projects: [] as string[] };
  if (diff === null || untracked === null) {
    const reason = ref
      ? `git could not diff the checkout against ${ref}`
      : "no --base given and origin's default branch is unknown";
    return { mode: 'full', reason, changed: [], ...head };
  }
  const changed = [...new Set([...diff, ...untracked])].sort();
  const selection = selectAffectedTestFiles(root, changed);
  if (selection.mode === 'full') return { ...selection, changed, ...head };
  const listed = await listVitestProjects(root, { wait: true });
  return listed.ok
    ? {
        ...selection,
        changed,
        ...head,
        projects: projectsOfTestFiles(selection.testFiles, listed.projects),
      }
    : { ...selection, changed, ...head, projectsUnresolved: listed.reason };
}

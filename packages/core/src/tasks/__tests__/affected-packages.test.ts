/**
 * Affected-package test runs (owner decision D11150, T12635).
 *
 * Pinned:
 *  1. the affected set is the packages the diff touches plus every workspace
 *     package that depends on them, transitively;
 *  2. a change outside every package that can affect them all (lockfile,
 *     workspace config, root build/test config) demands a full run;
 *  3. documentation outside the code roots is ignored;
 *  4. `tool:test-affected` runs the configured command over that set and
 *     records `scope: 'affected'` plus the packages on the atom.
 *
 * @task T12635
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  affectedTestTargets,
  buildAffectedTestCommand,
  changedPathsSinceDefault,
  deriveAffectedPackages,
  isScopeExcluded,
  listVitestProjects,
  listWorkspacePackages,
  planAffectedTestRun,
  scopedChangedPaths,
} from '../affected-packages.js';
import { validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

let root: string;

function pkg(dir: string, name: string, deps: Record<string, string> = {}): void {
  mkdirSync(join(root, dir, 'src'), { recursive: true });
  writeFileSync(
    join(root, dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts: { test: 'vitest run' }, dependencies: deps }),
  );
  writeFileSync(join(root, dir, 'src', 'index.ts'), `export const n = '${name}';\n`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'affected-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n  - "tools/one"\n',
  );
  pkg('packages/a', '@x/a');
  pkg('packages/b', '@x/b', { '@x/a': 'workspace:*' });
  // A longer directory is visited before packages/b: a single pass would miss
  // this second-order dependent.
  pkg('packages/dependent-of-b', '@x/d', { '@x/b': 'workspace:^' });
  pkg('packages/c', '@x/c', { lodash: '^4' });
  pkg('tools/one', '@x/tool');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Give the fixture the workspace's own vitest, as an installed project has. */
function linkVitest(): void {
  const vitestDir = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(vitestDir, join(root, 'node_modules', 'vitest'), 'dir');
}

function rootConfig(body: string): void {
  writeFileSync(join(root, 'vitest.config.mjs'), `export default { test: ${body} };\n`);
}

function projectConfig(dir: string, body = '{}'): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'vitest.config.mjs'), `export default { test: ${body} };\n`);
}

describe('workspace discovery', () => {
  it('reads packages/* globs and exact entries from pnpm-workspace.yaml', () => {
    const names = listWorkspacePackages(root).map((p) => p.name);
    expect(names.sort()).toEqual(['@x/a', '@x/b', '@x/c', '@x/d', '@x/tool']);
  });
});

describe('deriveAffectedPackages', () => {
  it('includes every dependent, transitively', () => {
    const r = deriveAffectedPackages(root, ['packages/a/src/index.ts']);
    expect(r).toEqual({ scope: 'affected', direct: ['@x/a'], packages: ['@x/a', '@x/b', '@x/d'] });
  });

  it('a leaf change affects only its own package', () => {
    expect(deriveAffectedPackages(root, ['packages/c/src/index.ts'])).toEqual({
      scope: 'affected',
      direct: ['@x/c'],
      packages: ['@x/c'],
    });
  });

  it('ignores documentation outside the code roots', () => {
    const r = deriveAffectedPackages(root, ['README.md', 'docs/x.md', 'packages/c/src/index.ts']);
    expect(r.scope === 'affected' && r.packages).toEqual(['@x/c']);
  });

  it.each([
    ['pnpm-lock.yaml'],
    ['package.json'],
    ['tsconfig.base.json'],
    ['vitest.config.ts'],
    ['scripts/x.mjs'],
  ])('a workspace-wide change (%s) demands a full run', (path) => {
    const r = deriveAffectedPackages(root, [path, 'packages/c/src/index.ts']);
    expect(r.scope).toBe('full');
    expect(r.scope === 'full' && r.reason).toContain(path);
  });

  it('T12657: Windows-style paths map to their packages', () => {
    const changed = win32.join('packages', 'a', 'src', 'index.ts');
    expect(changed).toContain('\\');
    const scope = deriveAffectedPackages(root, [changed]);
    expect(scope.scope === 'affected' && scope.direct).toEqual(['@x/a']);
  });

  it('a documentation-only diff affects nothing', () => {
    expect(deriveAffectedPackages(root, ['README.md'])).toEqual({
      scope: 'affected',
      direct: [],
      packages: [],
    });
  });
});

/**
 * Resolve vitest projects without the machine-global `test` slot. These tests
 * are about how projects are named and selected; the slot has its own test
 * (T12657). With the default resolver, any other process holding the slot made
 * `affectedTestTargets` answer `scope pending: test slot busy` instead.
 */
const resolveProjects = (r: string) =>
  listVitestProjects(r, { acquireSlot: async () => async () => {} });

describe('affectedTestTargets: project names come from vitest itself (T12635 re-review)', () => {
  it('an UNNAMED project is selected by the package.json name vitest gives it, not its directory', async () => {
    linkVitest();
    rootConfig("{ projects: ['packages/a/vitest.config.mjs', 'scripts/vitest.config.mjs'] }");
    projectConfig('packages/a');
    projectConfig('scripts', "{ name: 'scripts' }");
    const t = await affectedTestTargets(root, ['@x/a'], ['@x/a'], resolveProjects);
    expect(t).toEqual({ ok: true, projects: ['@x/a', 'scripts'], untested: [] });
  });

  it('a GLOB entry resolves every matched project, custom names included', async () => {
    linkVitest();
    rootConfig("{ projects: ['packages/*/vitest.config.mjs'] }");
    projectConfig('packages/a');
    projectConfig('packages/b', "{ name: '@x/b-tests' }");
    projectConfig('packages/dependent-of-b');
    const t = await affectedTestTargets(root, ['@x/a', '@x/b', '@x/d'], ['@x/a'], resolveProjects);
    expect(t).toEqual({ ok: true, projects: ['@x/a', '@x/b-tests', '@x/d'], untested: [] });
  });

  it('an INLINE project object, and a `]` inside the list, neither truncate nor drop entries', async () => {
    linkVitest();
    rootConfig(
      [
        '{ projects: [',
        '  // see [docs] — a bracket in a comment',
        "  { test: { name: 'tools-inline', root: './tools/one', include: ['src/**'] } },",
        "  'packages/a/vitest.config.mjs',",
        "  'scripts/vitest.config.mjs',",
        '] }',
      ].join('\n'),
    );
    projectConfig('packages/a');
    projectConfig('scripts', "{ name: 'scripts' }");
    const t = await affectedTestTargets(
      root,
      ['@x/tool', '@x/a'],
      ['@x/tool', '@x/a'],
      resolveProjects,
    );
    expect(t).toEqual({ ok: true, projects: ['tools-inline', '@x/a', 'scripts'], untested: [] });
  });

  it('a vitest.workspace file vitest 4 ignores yields no package project: the scope fails CLOSED', async () => {
    linkVitest();
    writeFileSync(
      join(root, 'vitest.workspace.mjs'),
      "export default ['packages/a/vitest.config.mjs'];\n",
    );
    projectConfig('packages/a');
    const t = await affectedTestTargets(root, ['@x/a'], ['@x/a'], resolveProjects);
    expect(t.ok).toBe(false);
    expect(!t.ok && t.reason).toMatch(/@x\/a/);
  });

  it('a DIRECTLY changed package with no project refuses; an untested dependent is recorded', async () => {
    linkVitest();
    rootConfig("{ projects: ['packages/b/vitest.config.mjs'] }");
    projectConfig('packages/b');
    const refused = await affectedTestTargets(root, ['@x/a', '@x/b'], ['@x/a'], resolveProjects);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/changed package\(s\) @x\/a/);
    const recorded = await affectedTestTargets(root, ['@x/b', '@x/d'], ['@x/b'], resolveProjects);
    expect(recorded).toEqual({ ok: true, projects: ['@x/b'], untested: ['@x/d'] });
  });

  it('without a resolvable vitest the scope fails CLOSED, never a narrower run', async () => {
    rootConfig("{ projects: ['packages/a/vitest.config.mjs'] }");
    projectConfig('packages/a');
    const t = await affectedTestTargets(root, ['@x/a'], ['@x/a'], resolveProjects);
    expect(t.ok).toBe(false);
    expect(!t.ok && t.reason).toMatch(/vitest could not resolve/);
  });

  it('REAL repo: every workspace package with a vitest config resolves to the name vitest assigns', async () => {
    const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
    const resolved = await listVitestProjects(repo);
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    const once = async (): Promise<typeof resolved> => resolved;
    const withConfig = listWorkspacePackages(repo).filter((p) =>
      ['ts', 'mts', 'js', 'mjs'].some((ext) =>
        existsSync(join(repo, p.dir, `vitest.config.${ext}`)),
      ),
    );
    expect(withConfig.map((p) => p.name)).toContain('@cleocode/utils');
    // The package-less projects (`repo-guards`, `scripts`, T13142) are always
    // selected; derive them, so the next one does not break this test.
    const packageNames = new Set(listWorkspacePackages(repo).map((p) => p.name));
    const packageless = resolved.ok
      ? resolved.projects.map((p) => p.name).filter((name) => !packageNames.has(name))
      : [];
    expect(packageless).toEqual(expect.arrayContaining(['repo-guards', 'scripts']));
    for (const p of withConfig) {
      const t = await affectedTestTargets(repo, [p.name], [p.name], once);
      // Its own project, then only the package-less projects — never another
      // package's project, e.g. @cleocode/cleo whose root is the repo.
      expect(t.ok && t.projects, p.name).toEqual([p.name, ...packageless]);
    }
  });
});

describe('buildAffectedTestCommand', () => {
  it('expands {projects}, {filters} and {packages} into separate arguments', () => {
    expect(buildAffectedTestCommand('pnpm exec vitest run {projects}', ['@x/a', '@x/b'])).toEqual({
      cmd: 'pnpm',
      args: ['exec', 'vitest', 'run', '--project', '@x/a', '--project', '@x/b'],
    });
    expect(buildAffectedTestCommand('pnpm {filters} test', ['@x/a']).args).toEqual([
      '--filter',
      '@x/a',
      'test',
    ]);
    expect(buildAffectedTestCommand('run {packages}', ['@x/a', '@x/b']).args).toEqual([
      '@x/a',
      '@x/b',
    ]);
  });

  it('honours sh quoting and still expands {projects} (T12718)', () => {
    expect(
      buildAffectedTestCommand(`pnpm exec vitest run --reporter 'dot' {projects}`, ['@x/a']),
    ).toEqual({
      cmd: 'pnpm',
      args: ['exec', 'vitest', 'run', '--reporter', 'dot', '--project', '@x/a'],
    });
  });

  it('refuses shell syntax instead of passing `&&` to the target (T12718)', () => {
    expect(() =>
      buildAffectedTestCommand('pnpm build && pnpm exec vitest run {projects}', ['@x/a']),
    ).toThrow(/testing\.affectedCommand .*shell syntax \(&\)/);
  });
});

describe('tool:test-affected evidence', () => {
  function initRepo(affectedCommand?: string, testing: Record<string, unknown> = {}): void {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'T']);
    git(root, ['config', 'user.email', 't@e.x']);
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.cleo/\nnode_modules/\n');
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({
        primaryType: 'node',
        testing: {
          command: 'node -e 0',
          ...(affectedCommand ? { affectedCommand } : {}),
          ...testing,
        },
      }),
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'init']);
    const origin = `${root}-origin.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);
    git(root, ['remote', 'set-head', 'origin', 'main']);
    git(root, ['switch', '-q', '-c', 'task/T1']);
  }
  afterEach(() => rmSync(`${root}-origin.git`, { recursive: true, force: true }));

  it('runs the configured command over the affected set and records scope:affected', async () => {
    // The command itself asserts it received exactly the affected packages.
    initRepo(
      `node -e "process.exit(process.argv.slice(1).join(',')==='@x/a,@x/b,@x/d'?0:3)" {packages}`,
    );
    writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.atom).toMatchObject({
      kind: 'tool',
      tool: 'test-affected',
      exitCode: 0,
      scope: 'affected',
      affectedPackages: ['@x/a', '@x/b', '@x/d'],
    });
  });

  it('a {projects} run whose changed package has no vitest project is refused before running', async () => {
    // The command would pass; the refusal must come from the missing project.
    // Configs are committed on main; only the package change is on the branch.
    linkVitest();
    rootConfig("{ projects: ['packages/b/vitest.config.mjs'] }");
    projectConfig('packages/b');
    initRepo('node -e 0 -- {projects}');
    writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(!r.ok && r.reason).toMatch(/@x\/a.*tool:test/s);
  });

  it('a failing affected run is E_EVIDENCE_TOOL_FAILED', async () => {
    initRepo('node -e "process.exit(1)" {packages}');
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  });

  it('refuses a workspace-wide change, pointing at tool:test', async () => {
    initRepo('node -e 0 {packages}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    git(root, ['add', 'pnpm-lock.yaml']);
    git(root, ['commit', '-q', '-m', 'T1: lock']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.reason).toMatch(/pnpm-lock\.yaml.*tool:test/s);
  });

  it('T12657: a git failure is no answer, never an empty diff', async () => {
    initRepo('node -e 0 -- {packages}');
    writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    // Merge-base still resolves (commit objects), but HEAD's tree is unreadable.
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    expect(changedPathsSinceDefault(root)).toBeNull();
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.reason).toMatch(/git failed/);
  });

  it("T13135 (gh#1805): CLEO's own hook files never widen a change, tracked or not", async () => {
    initRepo(`node -e "process.exit(process.argv.slice(1).join(',')==='@x/c'?0:3)" {packages}`);
    // A tracked settings file the hook installer rewrote, and an untracked
    // hand-installed plugin no task touched.
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n');
    git(root, ['add', '.claude/settings.local.json']);
    git(root, ['commit', '-q', '-m', 'T1: settings']);
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
    mkdirSync(join(root, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'plugins', 'cleo-heavy-command.js'), '// hook\n');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'hooks.json'), '{}\n');
    writeFileSync(join(root, 'packages/c/src/new.ts'), 'export const fresh = 1;\n');
    expect(changedPathsSinceDefault(root)).toEqual(['packages/c/src/new.ts']);
    expect(deriveAffectedPackages(root, changedPathsSinceDefault(root) ?? [])).toMatchObject({
      scope: 'affected',
      packages: ['@x/c'],
    });
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ affectedPackages: ['@x/c'] });
  });

  it('T13135 (gh#1805): evidence.scopeExcludes on the default branch keeps declared runtime state out of scope', async () => {
    initRepo(`node -e "process.exit(process.argv.slice(1).join(',')==='@x/c'?0:3)" {packages}`);
    // Declared on the DEFAULT BRANCH (the merge-base), as an exclude must be.
    git(root, ['switch', '-q', 'main']);
    const ctx = join(root, '.cleo', 'project-context.json');
    const context = JSON.parse(readFileSync(ctx, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctx,
      JSON.stringify({ ...context, evidence: { scopeExcludes: ['.opencode/goals/**'] } }),
    );
    git(root, ['add', '-f', '.cleo/project-context.json']);
    git(root, ['commit', '-q', '-m', 'declare excludes']);
    git(root, ['push', '-q', 'origin', 'main']);
    git(root, ['switch', '-q', 'task/T1']);
    git(root, ['merge', '-q', 'main']);
    mkdirSync(join(root, '.opencode', 'goals', 'dogfood'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'goals', 'dogfood', 'goal.yaml'), 'goal: x\n');
    writeFileSync(join(root, 'packages/c/src/new.ts'), 'export const fresh = 1;\n');
    expect(scopedChangedPaths(root)).toEqual({
      paths: ['packages/c/src/new.ts'],
      excluded: ['.opencode/goals/dogfood/goal.yaml'],
    });
  });

  it('T13135 (review of #1823): a change cannot declare its own excludes, nor exclude package code', async () => {
    initRepo(`node -e 0 {packages}`);
    writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
    // review-p0's probe: the SAME change declares packages/a and .cleo out of scope.
    const ctx = join(root, '.cleo', 'project-context.json');
    const context = JSON.parse(readFileSync(ctx, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      ctx,
      JSON.stringify({
        ...context,
        evidence: { scopeExcludes: ['packages/a/**', '.cleo/**', '.opencode/goals/**'] },
      }),
    );
    mkdirSync(join(root, '.opencode', 'goals'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'goals', 'goal.yaml'), 'goal: x\n');
    git(root, ['add', '-f', '.cleo/project-context.json', '.opencode/goals/goal.yaml']);
    git(root, ['commit', '-q', '-am', 'T1: change a, and exclude it']);
    const scoped = scopedChangedPaths(root);
    // Not on the default branch, so not one of these excludes counts — not even
    // the runtime-state one that would be legitimate there.
    expect(scoped?.paths).toEqual([
      '.cleo/project-context.json',
      '.opencode/goals/goal.yaml',
      'packages/a/src/index.ts',
    ]);
    expect(scoped?.excluded).toEqual([]);
    // Even declared on the default branch, a pattern never removes package code
    // or the project context file.
    expect(isScopeExcluded('packages/a/src/index.ts', ['packages/a/**'], ['packages/a'])).toBe(
      false,
    );
    expect(isScopeExcluded('.cleo/project-context.json', ['.cleo/**'], [])).toBe(false);
    expect(isScopeExcluded('.opencode/goals/x.yaml', ['.opencode/goals/**'], ['packages/a'])).toBe(
      true,
    );
  });

  it('T13135 (review of #1823): hook files are excluded at a CLEO root in a subdirectory too', async () => {
    // The CLEO root is <repo>/app; git diff names paths from the repo top.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'scope-subdir-')));
    try {
      const app = join(repo, 'app');
      mkdirSync(join(app, 'src'), { recursive: true });
      writeFileSync(join(app, 'src', 'x.ts'), 'export const x = 1;\n');
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'T']);
      git(repo, ['config', 'user.email', 't@e.x']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'init']);
      const origin = `${repo}-origin.git`;
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git(repo, ['remote', 'add', 'origin', origin]);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);
      git(repo, ['remote', 'set-head', 'origin', 'main']);
      git(repo, ['switch', '-q', '-c', 'task/T1']);
      mkdirSync(join(app, '.claude'), { recursive: true });
      writeFileSync(join(app, '.claude', 'settings.local.json'), '{}\n');
      writeFileSync(join(app, 'src', 'x.ts'), 'export const x = 2;\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'T1: change']);
      expect(scopedChangedPaths(app)).toEqual({
        paths: ['app/src/x.ts'],
        excluded: ['app/.claude/settings.local.json'],
      });
      rmSync(origin, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('T12657: an untracked new file in a package selects that package', async () => {
    initRepo(`node -e "process.exit(process.argv.slice(1).join(',')==='@x/c'?0:3)" {packages}`);
    writeFileSync(join(root, 'packages/c/src/new.ts'), 'export const fresh = 1;\n');
    expect(changedPathsSinceDefault(root)).toEqual(['packages/c/src/new.ts']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ affectedPackages: ['@x/c'] });
  });

  it('T12657: a {packages} run whose changed package has no test script is refused', async () => {
    writeFileSync(join(root, 'packages/c/package.json'), JSON.stringify({ name: '@x/c' }));
    initRepo('node -e 0 -- {packages}');
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(!r.ok && r.reason).toMatch(/no test script in changed package\(s\) @x\/c/);
  });

  it('T12657: vitest resolution runs under the heavy-tool slot, once per tree state', async () => {
    initRepo();
    linkVitest();
    rootConfig("{ projects: ['packages/a/vitest.config.mjs'] }");
    projectConfig('packages/a');
    const acquired: string[] = [];
    let released = 0;
    const acquireSlot = async (canonical: 'test') => {
      acquired.push(canonical);
      return async () => {
        released++;
      };
    };
    const first = await listVitestProjects(root, { acquireSlot });
    const again = await listVitestProjects(root, { acquireSlot });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(again).toBe(first);
    expect(acquired).toEqual(['test']);
    expect(released).toBe(1);
    // A changed tree resolves afresh.
    projectConfig('packages/b');
    const changed = await listVitestProjects(root, { acquireSlot });
    expect(changed).not.toBe(first);
    expect(acquired).toEqual(['test', 'test']);
    // T12656 review: an edit to an EXISTING untracked file is a changed tree too.
    expect(await listVitestProjects(root, { acquireSlot })).toBe(changed);
    projectConfig('packages/b', "{ name: 'b-renamed-project' }");
    const edited = await listVitestProjects(root, { acquireSlot });
    expect(edited).not.toBe(changed);
    expect(acquired).toEqual(['test', 'test', 'test']);
  });

  it('derives the affected command from a workspace-wide testing.command (T13125)', async () => {
    // The VidaPeps shape: no affectedCommand, testing.command = pnpm -r … test.
    initRepo(undefined, { command: 'pnpm -r --no-bail --if-present run test' });
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const run = await planAffectedTestRun(root, root);
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) return;
    expect([run.command.cmd, ...run.command.args]).toEqual([
      'pnpm',
      '--filter',
      '@x/c',
      '--no-bail',
      '--if-present',
      'run',
      'test',
    ]);
    expect(run.template).toEqual({
      template: 'pnpm {filters} --no-bail --if-present run test',
      source: 'derived',
      basis: 'pnpm -r --no-bail --if-present run test',
    });
  });

  it('a shell-chained affectedCommand is a config error, never a pass (T12718)', async () => {
    // Split on whitespace this ran `node -e 0` with `&& exit 1` as ignored
    // arguments: exit 0, and the `exit 1` the author wrote never ran.
    initRepo('node -e 0 && exit 1 {packages}');
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TOOL_UNAVAILABLE');
    expect(!r.ok && r.reason).toMatch(/testing\.affectedCommand .*shell syntax.*sh -c/);
  });

  describe('tool:test is scope-aware (T12959)', () => {
    const onlyC = `node -e "process.exit(process.argv.slice(1).join(',')==='@x/c'?0:3)" {packages}`;
    // The fixture has no resolvable CLEO project, so the full suite resolves
    // through the root package.json `test` script.
    beforeEach(() => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'root', private: true, scripts: { test: 'node -e 0' } }),
      );
    });
    function changeC(): void {
      writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
      git(root, ['commit', '-q', '-am', 'T1: change c']);
    }
    function context(implemented: EvidenceAtom[]): EvidenceValidationContext {
      return {
        task: {
          id: 'T1',
          verification: {
            passed: false,
            round: 1,
            gates: { implemented: true },
            lastAgent: null,
            lastUpdated: null,
            failureLog: [],
            evidence: {
              implemented: { atoms: implemented, capturedAt: 'now', capturedBy: 'test' },
            },
          },
        },
        gates: ['testsPassed'],
        criteria: [],
      };
    }

    it('runs the affected packages first and records scope:affected under tool:test', async () => {
      initRepo(onlyC);
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
        kind: 'tool',
        tool: 'test',
        scope: 'affected',
        affectedPackages: ['@x/c'],
      });
    });

    it('a root-config change falls back to the full suite and records scope:full with the reason', async () => {
      initRepo('node -e "process.exit(3)" {packages}');
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      git(root, ['add', 'pnpm-lock.yaml']);
      git(root, ['commit', '-q', '-m', 'T1: lock']);
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom).toMatchObject({ tool: 'test', scope: 'full' });
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(/pnpm-lock\.yaml/);
    });

    it('no origin falls back to the full suite', async () => {
      initRepo('node -e "process.exit(3)" {packages}');
      git(root, ['remote', 'remove', 'origin']);
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ scope: 'full' });
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(/cannot diff/);
    });

    it('testing.preferAffected=false opts out', async () => {
      initRepo('node -e "process.exit(3)" {packages}', { preferAffected: false });
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
        scope: 'full',
        scopeReason: 'testing.preferAffected is false',
      });
    });

    it('without an affected template, tool:test is the full suite and says why (T13125)', async () => {
      // `node -e 0` is not a workspace-wide command, so nothing derives.
      initRepo();
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ scope: 'full' });
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(
        /no testing\.affectedCommand is declared and none can be derived.*whole suite/,
      );
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).not.toMatch(/ci:<pr>/);
    });

    it('with evidence.ciSatisfies, the whole-suite reason names ci:<pr> as preferred (T13125)', async () => {
      initRepo();
      writeFileSync(
        join(root, '.cleo', 'project-context.json'),
        JSON.stringify({
          primaryType: 'node',
          testing: { command: 'node -e 0' },
          evidence: { ciSatisfies: true },
        }),
      );
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(
        /evidence\.ciSatisfies is set, so ci:<pr> .* is the preferred testsPassed evidence/,
      );
    });

    it('a merged change runs the full suite: a scoped run counts before merge only', async () => {
      initRepo('node -e "process.exit(3)" {packages}');
      changeC();
      const merged = context([
        {
          kind: 'pr',
          prNumber: 42,
          mergeCommitSha: 'a'.repeat(40),
          mergedAt: 'now',
          successCount: 1,
          totalChecks: 1,
        },
      ]);
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root, 'T1', undefined, merged);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ scope: 'full' });
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(/merged/);
    });

    it('an affected dependent with no test project fails closed to the full suite', async () => {
      writeFileSync(
        join(root, 'packages/b/package.json'),
        JSON.stringify({ name: '@x/b', dependencies: { '@x/a': 'workspace:*' } }),
      );
      initRepo('node -e "process.exit(3)" {packages}');
      writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
      git(root, ['commit', '-q', '-am', 'T1: change a']);
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ scope: 'full' });
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(
        /@x\/b.*no test project/,
      );
    });

    it('an affected atom says its dependents come from declared package deps only', async () => {
      initRepo(onlyC);
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(r.ok && r.atom.kind === 'tool' && r.atom.scopeReason).toMatch(
        /declared workspace package dependencies only/,
      );
    });

    it('a failing affected run fails tool:test', async () => {
      initRepo('node -e "process.exit(1)" {packages}');
      changeC();
      const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
      expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TOOL_FAILED');
      expect(!r.ok && r.reason).toMatch(/tool:test \(affected:/);
    });
  });

  it('refuses when testing.affectedCommand is not configured', async () => {
    initRepo();
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.reason).toMatch(/testing\.affectedCommand/);
  });
});

/**
 * Every repo-root script a package unit test depends on is in ci.yml's `code`
 * filter (T13175 review).
 *
 * `scripts/**` is deliberately outside `code` (gh#1403): a scripts-only change
 * runs Scripts Tests, not the package unit shards, and `ci:<pr>` may attest it
 * through CI's own filter skip (T14260). That is only sound when no package test
 * imports or runs the changed script. Several do (store fingerprint gates,
 * nested-nexus migration, injection flags, ...), so each such script must be
 * listed under `code`, where a change to it runs the unit tests.
 *
 * A dependency here is a relative import, dynamic import or require from any
 * package file, or a `scripts/...` path a package TEST file names (the tests
 * that spawn a script with `join(REPO_ROOT, 'scripts/x.mjs')`).
 *
 * T13177: the PR-affected selection (`ci-affected-test-projects.mjs`, T13142)
 * must not narrow such a change to the `scripts` project either, or Unit Tests
 * would succeed without running the importing packages' tests. It treats any
 * path outside every workspace package as workspace-wide and runs the full
 * suite; `packages/core/src/tasks/__tests__/affected-packages.test.ts` pins
 * that (this job runs without a build, so it cannot import core).
 *
 * @task T13175
 * @task T13177
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Calls that make a quoted `scripts/...` path a real dependency of a test
 * file: it imports, spawns, execs or reads the script, or resolves its path
 * (T14260). A plain string mention (fixture data, a doc comment) is not one.
 */
const USING_CALL =
  /\b(?:import|require|spawn\w*|exec\w*|fork|readFile\w*|createReadStream|join|resolve|URL)\s*\($/;

/**
 * Whether the innermost call whose argument list holds the quoted string at
 * `index` is a {@link USING_CALL} (looking back at most 300 characters).
 *
 * @param src - The source text.
 * @param index - Offset of the string's opening quote.
 * @returns True when a using call encloses it.
 */
export function insideUsingCall(src, index) {
  const before = src.slice(Math.max(0, index - 300), index);
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      // The innermost call holding the string decides.
      if (depth === 0) return USING_CALL.test(before.slice(0, i + 1));
      depth--;
    } else if (ch === ';' && depth === 0) return false;
  }
  return false;
}

/**
 * The repo-root scripts one package file depends on: relative imports, and in
 * a test, a `scripts/...` path it imports, spawns, execs, reads or resolves.
 *
 * @param src - The file's source.
 * @param file - Its repo-relative path.
 * @returns Repo-relative script paths (not yet checked for existence).
 */
export function scriptMentions(src, file) {
  const isTest = /(__tests__\/|\.test\.|\.spec\.)/.test(file);
  const resolveRel = (spec) =>
    path.relative(REPO_ROOT, path.resolve(path.dirname(path.join(REPO_ROOT, file)), spec));
  const out = [];
  for (const m of src.matchAll(
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g,
  ))
    out.push(resolveRel(m[1]));
  if (isTest) {
    for (const m of src.matchAll(/['"`]((?:\.\.\/)+scripts\/[\w./-]+)['"`]/g))
      if (insideUsingCall(src, m.index)) out.push(resolveRel(m[1]));
    for (const m of src.matchAll(/['"`](scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh))['"`]/g))
      if (insideUsingCall(src, m.index)) out.push(m[1]);
    // join(REPO_ROOT, 'scripts', 'x.mjs') — the path given as segments.
    for (const m of src.matchAll(
      /['"`]scripts['"`]\s*,\s*((?:['"`][\w.-]+['"`]\s*,\s*)*)['"`]([\w.-]+\.(?:mjs|cjs|js|ts|sh))['"`]/g,
    )) {
      if (!insideUsingCall(src, m.index)) continue;
      const dirs = [...m[1].matchAll(/['"`]([\w.-]+)['"`]/g)].map((d) => d[1]);
      out.push(['scripts', ...dirs, m[2]].join('/'));
    }
  }
  return [...new Set(out.filter((rel) => rel.startsWith('scripts/')))];
}

/** Repo-root scripts that package files import, or package tests run or read. */
function scriptDependencies() {
  const files = execFileSync('git', ['ls-files', 'packages'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?ts|m?js|cjs)$/.test(f));
  /** @type {Map<string, string>} */
  const deps = new Map();
  for (const f of files) {
    for (const rel of scriptMentions(readFileSync(path.join(REPO_ROOT, f), 'utf8'), f)) {
      if (existsSync(path.join(REPO_ROOT, rel)) && !deps.has(rel)) deps.set(rel, f);
    }
  }
  return deps;
}

/** paths-filter glob (`**` any depth, `*` within a segment) to a RegExp. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') out += '[^/]*';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The `code` filter of ci.yml's paths-filter step. */
function codeFilter() {
  const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.with?.filters === 'string' && step.with.filters.includes('code:')) {
        return parseYaml(step.with.filters).code;
      }
    }
  }
  throw new Error('ci.yml has no paths-filter step with a `code` filter');
}

describe('ci.yml `code` filter covers the scripts package tests depend on (T13175)', () => {
  const code = codeFilter().map(globToRegExp);
  const deps = scriptDependencies();

  it('finds the known dependencies (the scan works)', () => {
    expect([...deps.keys()]).toEqual(
      expect.arrayContaining([
        'scripts/lib/path-containment.mjs',
        'scripts/migrate-nested-nexus.mjs',
        'scripts/lint-injection-flags.mjs',
      ]),
    );
  });

  it('a script a test imports, spawns, execs or reads by a resolved path is a dependency', () => {
    const test = 'packages/core/src/x/__tests__/a.test.ts';
    const imported = scriptMentions(
      "const m = await import('../../../../../scripts/lib/x.mjs');",
      test,
    );
    expect(imported).toEqual(['scripts/lib/x.mjs']);
    const spawned = scriptMentions(
      "execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/lint-x.mjs'), '--check']);",
      test,
    );
    expect(spawned).toEqual(['scripts/lint-x.mjs']);
    const read = scriptMentions(
      "const src = readFileSync(\n  join(REPO_ROOT, 'scripts/y.mjs'),\n  'utf8',\n);",
      test,
    );
    expect(read).toEqual(['scripts/y.mjs']);
  });

  it('a script path a test only mentions (fixture data, a comment) is not a dependency (T14260)', () => {
    const test = 'packages/core/src/x/__tests__/a.test.ts';
    const fixture = [
      '// see scripts/lint-x.mjs for the gate',
      "const paths = ['scripts/__tests__/lint-x.test.mjs', 'scripts/lint-x.mjs'];",
      "await resolve({ resolvePr: pr(['.github/workflows/a.yml', 'scripts/lint-x.mjs']) });",
    ].join('\n');
    expect(scriptMentions(fixture, test)).toEqual([]);
  });

  it('every such script is listed under `code`', () => {
    const missing = [...deps]
      .filter(([script]) => !code.some((re) => re.test(script)))
      .map(([script, from]) => `${script} (used by ${from})`);
    expect(missing, 'add each to the `code` filter in ci.yml and macos-main.yml').toEqual([]);
  });
});

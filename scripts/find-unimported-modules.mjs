#!/usr/bin/env node
/**
 * Report source modules that NOTHING in the workspace imports.
 *
 * Written while answering "what is built, committed, and wired to nothing?" —
 * a question that produced two independent findings in one afternoon: the
 * `EmbeddingQueue` referenced only by its own teardown, and a generated
 * models.dev provider catalog with zero consumers. Both had shipped.
 *
 * ## What it does and does not prove
 *
 * It resolves relative specifiers AND `@cleocode/*` cross-package specifiers,
 * and it counts barrel re-exports as imports — so a module reachable through
 * `index.ts` is NOT reported. Entry points (`index.ts`, `internal.ts`,
 * `cli/index.ts`, anything under `bin/`) are excluded by name.
 *
 * It is a STARTING POINT, not a verdict. Known false positives:
 *   - SvelteKit file-based routes (`+page.server.ts`, `+server.ts`) are loaded
 *     by convention, never imported.
 *   - npm lifecycle scripts (`postinstall.ts`) and package `bin` entries.
 *   - one-off migration scripts invoked by path.
 *   - test fixtures under `__fixtures__`.
 *
 * Before deleting anything a run reports, confirm with a full-text grep across
 * `.ts`, `.mjs`, `.json`, `.yml` and `.md` — including `.cleo/deprecations.yml`,
 * which may already have scheduled the module for removal.
 *
 * Usage: `node scripts/find-unimported-modules.mjs`
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const PKGS = readdirSync('packages').filter((p) => existsSync(join('packages', p, 'src')));
const files = [];
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (/node_modules|dist|\.git|__tests__/.test(p)) continue;
      walk(p);
    } else if (/\.tsx?$/.test(e) && !/\.(test|spec|d)\.tsx?$/.test(e)) files.push(resolve(p));
  }
}
for (const p of PKGS) walk(join('packages', p, 'src'));
const fileSet = new Set(files);

// @cleocode/<pkg> -> packages/<dir>/src
const pkgRoot = new Map();
for (const p of PKGS) {
  try {
    const name = JSON.parse(readFileSync(join('packages', p, 'package.json'), 'utf-8')).name;
    if (name) pkgRoot.set(name, resolve(join('packages', p, 'src')));
  } catch {}
}

function resolveSpec(spec, fromFile) {
  const cands = [];
  if (spec.startsWith('.')) {
    const base = spec.replace(/\.js$/, '');
    cands.push(
      resolve(dirname(fromFile), base + '.ts'),
      resolve(dirname(fromFile), base + '.tsx'),
      resolve(dirname(fromFile), base, 'index.ts'),
    );
  } else {
    for (const [name, root] of pkgRoot) {
      if (spec === name) {
        cands.push(join(root, 'index.ts'));
        break;
      }
      if (spec.startsWith(name + '/')) {
        const sub = spec.slice(name.length + 1).replace(/\.js$/, '');
        cands.push(join(root, sub + '.ts'), join(root, sub, 'index.ts'));
        break;
      }
    }
  }
  return cands.find((c) => fileSet.has(c));
}

const importedBy = new Map();
const RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  for (const m of src.matchAll(RE)) {
    const t = resolveSpec(m[1], f);
    if (t && t !== f) {
      if (!importedBy.has(t)) importedBy.set(t, new Set());
      importedBy.get(t).add(f);
    }
  }
}

const isEntry = (f) => /\/(index|internal|cli\/index)\.ts$/.test(f) || /\/bin\//.test(f);
const orphans = files
  .filter((f) => !importedBy.has(f) && !isEntry(f))
  .map((f) => ({
    f: relative(process.cwd(), f),
    lines: readFileSync(f, 'utf-8').split('\n').length,
  }))
  .sort((a, b) => b.lines - a.lines);

console.log(`scanned ${files.length} modules across ${PKGS.length} packages`);
console.log(
  `${orphans.length} imported by NOTHING (excluding entry points), ${orphans.reduce((s, o) => s + o.lines, 0)} lines\n`,
);
for (const o of orphans.slice(0, 30)) console.log(String(o.lines).padStart(6), o.f);

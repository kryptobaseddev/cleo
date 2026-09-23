#!/usr/bin/env node
/**
 * CLI Startup Barrel Guard (T12138 · gh#1207)
 *
 * `packages/cleo/src/cli/index.ts` runs on EVERY invocation — `cleo --version`
 * and `cleo --help` included. Anything it statically imports, and anything
 * those modules statically import, is loaded before a single argument is
 * parsed.
 *
 * Measured 2026-09-12 against the core the installed CLI actually resolves
 * (its nested @cleocode/core 2026.8.9): `cleo --version` costs 1.31s, a bare
 * Node boot costs 0.01s, and importing `@cleocode/core/internal` alone costs
 * 1.14s. So ~87% of CLI startup was one barrel import — reached, transitively,
 * for ONE function (`buildCommandGroups` in help-renderer.ts). The narrow
 * module costs 0.09s on the same install.
 *
 * index.ts already carries a comment saying this must not happen. A comment is
 * not a gate: the import was added anyway, in a different file, and nothing
 * noticed. This script is the enforcement that comment implied.
 *
 * Rule: no module in the CLI entrypoint's STATIC import graph (restricted to
 * `packages/cleo/src/cli/**`) may statically import a CORE barrel. Dynamic
 * `await import(...)` at point of use is always fine — that is the pattern the
 * architecture prescribes.
 *
 * Per-line opt-out: `// startup-barrel-allowed: <reason>`.
 *
 * @task T12138 (gh#1207)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(REPO_ROOT, 'packages/cleo/src/cli/index.ts');
const CLI_ROOT = join(REPO_ROOT, 'packages/cleo/src/cli');

/** Barrels whose import pulls in the whole CORE dependency tree. */
const FORBIDDEN = [
  '@cleocode/core',
  '@cleocode/core/internal',
  '@cleocode/core/tasks',
  '@cleocode/core/store',
  '@cleocode/runtime/gateway',
];

const OPT_OUT = 'startup-barrel-allowed';

/** Static `import ... from '<spec>'` (not `await import(...)`). */
const STATIC_IMPORT = /^\s*import\s+(?:type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/;

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

const violations = [];
const seen = new Set();

function walk(file, chain) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!file.startsWith(CLI_ROOT)) return; // only follow CLI-local modules
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    const m = STATIC_IMPORT.exec(line);
    if (!m) return;
    const spec = m[1];
    if (FORBIDDEN.includes(spec)) {
      if (line.includes(OPT_OUT)) return;
      violations.push({
        file: file.slice(REPO_ROOT.length + 1),
        line: i + 1,
        spec,
        chain: [...chain, file.slice(REPO_ROOT.length + 1)],
      });
      return;
    }
    const local = resolveLocal(file, spec);
    if (local) walk(local, [...chain, file.slice(REPO_ROOT.length + 1)]);
  });
}

walk(ENTRY, []);

if (violations.length === 0) {
  console.log(
    `lint-cli-startup-barrel: OK — CLI entrypoint graph (${seen.size} modules) imports no CORE barrel.`,
  );
  process.exit(0);
}

console.error(
  `lint-cli-startup-barrel: FAIL — ${violations.length} CORE barrel import(s) in the CLI startup graph:\n`,
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  imports '${v.spec}'`);
  console.error(`    reached from: ${v.chain.join(' -> ')}`);
}
console.error(
  `\nEvery CLI invocation pays this, including \`cleo --version\`. Import the narrow\n` +
    `module instead (e.g. '@cleocode/core/routing/build-command-groups.js'), or defer\n` +
    `with \`await import(...)\` at the point of use. If the import is genuinely\n` +
    `unavoidable, append \`// ${OPT_OUT}: <reason>\` to the line.`,
);
process.exit(1);

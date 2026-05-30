#!/usr/bin/env node
/**
 * Lint rule: no runtime LOGIC in `@cleocode/contracts` (forward-only lock).
 *
 * `packages/contracts/` is the shared **type** SoT — envelopes, operations,
 * errors, zod schemas. Runtime helpers (bodied functions / arrows) that drift
 * into it create fan-out coupling, bloat the type-only consumer install, and
 * blur the package boundary the owner's "solid/DRY/scalable CORE SDK" mandate
 * depends on. This gate locks the package against accruing MORE runtime logic.
 *
 * What is ALLOWED in a contracts source file:
 *   - Type guards            — `export function isX(v): v is T` (and `hasX`)
 *   - Assertion guards       — `export function assertX(v): asserts v is T`
 *   - zod schemas            — `export const xSchema = z.object({...})` (a value,
 *                              not a function/arrow — never matched here)
 *   - const type-arrays/data — `export const X = [...] as const` (a value)
 *   - explicit whitelist     — {@link WHITELIST} (isRenderableEnvelope, …)
 *
 * What is a VIOLATION:
 *   - any other exported bodied `function` / arrow / `async` with runtime logic.
 *
 * Modes (mirrors the other arch gates):
 *   --check (default)  baseline mode: FAIL only on NET-NEW violation identities
 *                      vs scripts/.lint-no-runtime-in-contracts-baseline.json.
 *   --strict           zero-tolerance: FAIL on ANY violation (the eventual
 *                      end-state once the existing runtime helpers are migrated
 *                      out under E5 · T11392).
 *   --update-baseline  rewrite the baseline JSON from the current tree.
 *
 * REPO_ROOT is resolved from `process.cwd()` so unit tests can point the script
 * at a synthetic tree.
 *
 * Exit 0 = clean (or no net-add); exit 1 = violations.
 *
 * @task T11418
 * @epic T11392
 * @saga T11387
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Names that are intentionally exempt even if the classifier flags them. */
export const WHITELIST = new Set(['isRenderableEnvelope', 'isDocKind', 'isCanonicalDomain']);

const BASELINE_REL = 'scripts/.lint-no-runtime-in-contracts-baseline.json';

/** Recursively collect `.ts` source files under a dir, skipping tests + decls. */
function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      collectTsFiles(full, acc);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Index of the `)` that matches the `(` at `openIdx` (paren depth only). */
function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A return annotation that is a type guard / assertion (allowed). */
function isGuardReturn(slice) {
  return /:\s*[^={]*\b(?:is|asserts)\b/.test(slice);
}

/**
 * Find exported runtime-function/arrow VIOLATION identities in one file body.
 *
 * @param {string} text - file contents
 * @param {string} relPath - repo-relative path (for identity)
 * @returns {string[]} violation identities `relPath:exportName`
 */
export function findViolationsInFile(text, relPath) {
  const violations = [];

  // 1. export [async] function NAME(...) — bodied function declaration.
  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = fnRe.exec(text); m !== null; m = fnRe.exec(text)) {
    const name = m[1];
    const openParen = text.indexOf('(', m.index + m[0].length - 1);
    const closeParen = matchParen(text, openParen);
    if (closeParen === -1) continue;
    const bodyOpen = text.indexOf('{', closeParen);
    const returnSlice = bodyOpen === -1 ? '' : text.slice(closeParen + 1, bodyOpen);
    if (WHITELIST.has(name) || isGuardReturn(returnSlice)) continue;
    violations.push(`${relPath}:${name}`);
  }

  // 2. export const NAME = [async] (...) => ...  — bodied arrow.
  //    A leading `(` that is NOT arrow params (parenthesized value) is excluded
  //    because no `=>` follows the matched `)`.
  const arrowRe = /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]*)?=\s*(?:async\s+)?\(/g;
  for (let m = arrowRe.exec(text); m !== null; m = arrowRe.exec(text)) {
    const name = m[1];
    const openParen = text.indexOf('(', m.index + m[0].length - 1);
    const closeParen = matchParen(text, openParen);
    if (closeParen === -1) continue;
    const arrowIdx = text.indexOf('=>', closeParen);
    if (arrowIdx === -1) continue; // not an arrow → a parenthesized value, skip
    // Only treat as arrow if nothing but a return annotation sits before `=>`.
    const between = text.slice(closeParen + 1, arrowIdx);
    if (/[;{}]/.test(between)) continue; // a `)` from some other construct
    if (WHITELIST.has(name) || isGuardReturn(between)) continue;
    violations.push(`${relPath}:${name}`);
  }

  // 3. export const NAME = [async] function ... — function-expression.
  const fnExprRe = /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]*)?=\s*(?:async\s+)?function\b/g;
  for (let m = fnExprRe.exec(text); m !== null; m = fnExprRe.exec(text)) {
    const name = m[1];
    if (WHITELIST.has(name)) continue;
    violations.push(`${relPath}:${name}`);
  }

  return violations;
}

/**
 * Scan the contracts package for runtime-function violations.
 *
 * @param {string} repoRoot
 * @returns {string[]} sorted violation identities
 */
export function scanContracts(repoRoot) {
  const srcDir = join(repoRoot, 'packages', 'contracts', 'src');
  if (!existsSync(srcDir)) return [];
  const files = collectTsFiles(srcDir);
  const all = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    all.push(...findViolationsInFile(readFileSync(file, 'utf8'), rel));
  }
  return [...new Set(all)].sort();
}

/** CLI entry. */
function main() {
  const repoRoot = process.cwd();
  const mode = process.argv.includes('--strict')
    ? 'strict'
    : process.argv.includes('--update-baseline')
      ? 'update'
      : 'check';
  const baselinePath = join(repoRoot, BASELINE_REL);
  const current = scanContracts(repoRoot);

  if (mode === 'update') {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(
      `lint-no-runtime-in-contracts: baseline updated — ${current.length} runtime helper(s) recorded.`,
    );
    return 0;
  }

  if (mode === 'strict') {
    if (current.length > 0) {
      console.error(
        `\n✗ lint-no-runtime-in-contracts (strict): ${current.length} runtime helper(s) in @cleocode/contracts:\n`,
      );
      for (const v of current) console.error(`  - ${v}`);
      console.error(
        '\nContracts is the type SoT. Move runtime helpers to core/ (or a leaf lib).\n',
      );
      return 1;
    }
    console.log(
      '✓ lint-no-runtime-in-contracts (strict): contracts is pure (zero runtime helpers).',
    );
    return 0;
  }

  // check (baseline) mode: fail on net-new only.
  const baseline = existsSync(baselinePath)
    ? new Set(JSON.parse(readFileSync(baselinePath, 'utf8')))
    : new Set();
  const netNew = current.filter((v) => !baseline.has(v));
  if (netNew.length > 0) {
    console.error(
      `\n✗ lint-no-runtime-in-contracts: ${netNew.length} NEW runtime helper(s) added to @cleocode/contracts:\n`,
    );
    for (const v of netNew) console.error(`  - ${v}`);
    console.error(
      `\nContracts is types-only. Put runtime logic in packages/core/ (or a leaf lib) and import the TYPE here.\n` +
        `If this is a legitimate type guard / zod schema, the classifier mis-flagged it — add it to WHITELIST.\n` +
        `To intentionally re-baseline (e.g. after migrating helpers OUT): node ${BASELINE_REL.replace('.json', '.mjs').replace('scripts/.', 'scripts/')} --update-baseline\n`,
    );
    return 1;
  }
  const removed = [...baseline].filter((v) => !current.includes(v)).length;
  console.log(
    `✓ lint-no-runtime-in-contracts: no net-new runtime helpers (baseline ${baseline.size}` +
      `${removed > 0 ? `, ${removed} migrated out — run --update-baseline to tighten` : ''}).`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('lint-no-runtime-in-contracts.mjs')) {
  process.exit(main());
}

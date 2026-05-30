#!/usr/bin/env node
/**
 * Lint rule: zero crates.io publishes (E2 · T11389 · SG-PACKAGE-ARCH).
 *
 * Owner decision (2026-05-30): CLEO publishes ZERO crates to crates.io — the
 * Rust crates are internal (napi bindings bundled into npm packages, cores
 * consumed by their bindings). Every crate's `Cargo.toml` MUST therefore
 * declare `publish = false`; a crate that omits it (Cargo defaults to
 * publishable) or sets `publish = true` is a footgun that could leak an
 * internal crate to crates.io on a stray `cargo publish`.
 *
 * Fail-closed: any crate without an explicit `publish = false` in its
 * `[package]` table is a violation, unless its name is in {@link ALLOWLIST}
 * (reserved for a deliberate future external publish — empty today).
 *
 * REPO_ROOT from `process.cwd()` so unit tests can target a synthetic tree.
 *
 * @task T11389
 * @epic T11389
 * @saga T11387
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Crate names that are INTENTIONALLY publishable to crates.io (deliberate
 * external libraries). Empty today — owner decision is zero crates.io. To add
 * one, flip its Cargo.toml to `publish = true` AND list it here with rationale.
 */
export const ALLOWLIST = new Set();

/** Extract the `[package]` `name` + whether `publish = false` is declared. */
export function inspectCargoToml(text) {
  // Restrict to the [package] table (publish is a package key).
  const pkgStart = text.search(/^\s*\[package\]\s*$/m);
  if (pkgStart === -1) return { name: null, publishFalse: false };
  const rest = text.slice(pkgStart + 1);
  const nextTable = rest.search(/^\s*\[[^\]]+\]\s*$/m);
  const pkgBlock = nextTable === -1 ? rest : rest.slice(0, nextTable);
  const nameM = /^\s*name\s*=\s*"([^"]+)"/m.exec(pkgBlock);
  const publishFalse = /^\s*publish\s*=\s*false\b/m.test(pkgBlock);
  return { name: nameM ? nameM[1] : null, publishFalse };
}

/**
 * Find crates lacking `publish = false`.
 *
 * @param {string} repoRoot
 * @returns {string[]} sorted violation identities `crates/<dir>:<name>`
 */
export function scanCratePublish(repoRoot) {
  const cratesDir = join(repoRoot, 'crates');
  if (!existsSync(cratesDir)) return [];
  const violations = [];
  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const toml = join(cratesDir, entry.name, 'Cargo.toml');
    if (!existsSync(toml)) continue;
    const { name, publishFalse } = inspectCargoToml(readFileSync(toml, 'utf8'));
    if (!name) continue; // workspace-only / virtual manifest
    if (publishFalse) continue;
    if (ALLOWLIST.has(name)) continue;
    violations.push(`crates/${entry.name}:${name}`);
  }
  return violations.sort();
}

/** CLI entry. */
function main() {
  const violations = scanCratePublish(process.cwd());
  if (violations.length > 0) {
    console.error(
      `\n✗ crate-publish guard: ${violations.length} crate(s) missing \`publish = false\`:\n`,
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nCLEO publishes ZERO crates to crates.io (owner decision). Add `publish = false` to the\n' +
        '[package] table. If a crate is genuinely meant for external publishing, set `publish = true`\n' +
        'AND add it to ALLOWLIST in scripts/lint-no-crate-publish.mjs with rationale.\n',
    );
    return 1;
  }
  console.log('✓ crate-publish guard: every crate declares publish = false (zero crates.io).');
  return 0;
}

if (process.argv[1]?.endsWith('lint-no-crate-publish.mjs')) {
  process.exit(main());
}

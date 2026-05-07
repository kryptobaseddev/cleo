#!/usr/bin/env node
// scripts/lint-contracts-dep.mjs
//
// Enforces: "if a package imports from @cleocode/contracts, it MUST declare
// @cleocode/contracts in its package.json dependencies or devDependencies."
//
// Scans all packages/<name>/src/ trees for .ts files that contain import
// statements referencing '@cleocode/contracts'. For each package with at least
// one such import, checks that '@cleocode/contracts' appears in the package's
// dependencies or devDependencies.
//
// Usage:
//   node scripts/lint-contracts-dep.mjs          # report violations
//   node scripts/lint-contracts-dep.mjs --verbose # also list checked packages
//
// Exit codes:
//   0 — No violations found.
//   1 — One or more violations found.
//
// No untrusted input used — pure static analysis of checked-in source files.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const PACKAGES_DIR = join(REPO, 'packages');
const CONTRACTS_PKG = '@cleocode/contracts';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts source files under a directory,
 * skipping node_modules and dist directories.
 *
 * @param {string} dir - Directory to scan.
 * @returns {string[]} Absolute paths to .ts files found.
 */
function collectTsFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Strip block comments (including JSDoc) from TypeScript source so that
 * package references inside @example blocks or inline doc strings are not
 * mistaken for real import declarations.
 *
 * @param {string} content - Raw file contents.
 * @returns {string} Content with block comments replaced by whitespace.
 */
function stripBlockComments(content) {
  // Replace /* ... */ (including /** ... */) with blank space, preserving
  // line structure so line-based regex still works correctly.
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Preserve newlines so line-indexed regexes still work
    return match.replace(/[^\n]/g, ' ');
  });
}

/**
 * Check whether a TypeScript file contains a runtime or type import from the
 * given package specifier. Matches:
 *   import ... from '@cleocode/contracts'
 *   import type ... from '@cleocode/contracts'
 *   export ... from '@cleocode/contracts'
 *
 * Block comments (including JSDoc @example blocks) are stripped before
 * scanning to avoid false positives from documentation-only references.
 *
 * @param {string} content - File contents.
 * @param {string} pkg - Package specifier to search for.
 * @returns {boolean} True if the file imports from the package.
 */
function hasImportFrom(content, pkg) {
  const stripped = stripBlockComments(content);
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require the pattern: from 'pkg' or from 'pkg/subpath' or from "pkg"
  // The (?:['"\/]) at the end allows 'pkg' (closing quote) or 'pkg/sub'
  const pattern = new RegExp(
    `^\\s*(?:import|export)(?:\\s+type)?\\s+[\\s\\S]*?from\\s+['"]${escaped}(?:['"/])`,
    'm',
  );
  return pattern.test(stripped);
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const violations = [];

for (const pkgName of packageDirs) {
  const pkgDir = join(PACKAGES_DIR, pkgName);
  const pkgJsonPath = join(pkgDir, 'package.json');
  const srcDir = join(pkgDir, 'src');

  if (!existsSync(pkgJsonPath) || !existsSync(srcDir)) continue;

  const tsFiles = collectTsFiles(srcDir);
  if (tsFiles.length === 0) continue;

  // Collect files that import from @cleocode/contracts
  const importingFiles = [];
  for (const tsFile of tsFiles) {
    let content;
    try {
      content = readFileSync(tsFile, 'utf-8');
    } catch {
      continue;
    }
    if (hasImportFrom(content, CONTRACTS_PKG)) {
      importingFiles.push(tsFile);
    }
  }

  if (importingFiles.length === 0) {
    if (verbose) {
      console.log(`  ok  packages/${pkgName}  (no @cleocode/contracts imports)`);
    }
    continue;
  }

  // This package imports from @cleocode/contracts — verify the dep declaration.
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    console.error(`ERROR: could not parse ${pkgJsonPath}`);
    violations.push({ pkg: pkgName, file: pkgJsonPath });
    continue;
  }

  const deps = pkgJson.dependencies ?? {};
  const devDeps = pkgJson.devDependencies ?? {};
  const hasDep = CONTRACTS_PKG in deps || CONTRACTS_PKG in devDeps;

  if (hasDep) {
    if (verbose) {
      console.log(`  ok  packages/${pkgName}  (${importingFiles.length} import(s), dep declared)`);
    }
  } else {
    for (const f of importingFiles) {
      const rel = relative(REPO, f);
      console.error(
        `VIOLATION  packages/${pkgName}/package.json  missing "${CONTRACTS_PKG}" dependency\n` +
          `           importing file: ${rel}`,
      );
      violations.push({ pkg: pkgName, file: rel });
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (violations.length === 0) {
  console.log('All packages with @cleocode/contracts imports declare the dependency. OK.');
  process.exit(0);
} else {
  const uniquePkgs = [...new Set(violations.map((v) => v.pkg))];
  console.error(
    `\n${violations.length} violation(s) in ${uniquePkgs.length} package(s): ${uniquePkgs.join(', ')}`,
  );
  console.error(`Fix: add '"${CONTRACTS_PKG}": "workspace:*"' to the package's dependencies.`);
  process.exit(1);
}

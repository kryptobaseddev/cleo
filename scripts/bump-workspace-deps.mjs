#!/usr/bin/env node
/**
 * Bump @cleocode/* workspace dependency refs across packages/* package.json files.
 *
 * Scope (NON-NEGOTIABLE):
 *   - ONLY rewrites keys that match /^@cleocode\//.
 *   - Skips `workspace:*`, `file:`, `link:`, `npm:`, `git+` ref-style values.
 *   - LEAVES every external dep untouched (tree-sitter, drizzle-orm, @forge-ts/*,
 *     @biomejs/*, @types/*, etc.).
 *
 * Background:
 *   The previous in-workflow jq filter matched "any value starting with a digit"
 *   which incorrectly bumped 10 external deps in v2026.5.100 (PR #480/#481) and
 *   again in v2026.5.101 (surgical revert d26b76751). T10177 entrenches the fix
 *   by extracting the bump logic to a testable script.
 *
 * Usage:
 *   node scripts/bump-workspace-deps.mjs --version 2026.5.99 [--root /path/to/repo]
 *   node scripts/bump-workspace-deps.mjs --version 2026.5.99 --dry-run
 *   node scripts/bump-workspace-deps.mjs --version 2026.5.99 --json
 *
 * Exit codes:
 *   0 — success (or dry-run completed)
 *   1 — argument error
 *   2 — IO error
 *
 * @task T10177
 * @saga T10176
 * @decision D010
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CALVER_REGEX = /^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_SCOPE_PREFIX = '@cleocode/';
const NON_NUMERIC_REF_PREFIXES = ['workspace:', 'file:', 'link:', 'npm:', 'git+', 'github:'];

function usage() {
  process.stderr.write(
    [
      'Usage: node scripts/bump-workspace-deps.mjs --version <calver> [options]',
      '',
      'Options:',
      '  --version <v>   CalVer version to set (e.g. 2026.5.99)',
      '  --root <dir>    Repo root (default: cwd)',
      '  --dry-run       Do not write files; print intended changes',
      '  --json          Emit a JSON report on stdout',
      '',
      'Examples:',
      '  node scripts/bump-workspace-deps.mjs --version 2026.5.99',
      '  node scripts/bump-workspace-deps.mjs --version 2026.5.99 --dry-run --json',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const out = { version: null, root: process.cwd(), dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      out.version = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--root') {
      out.root = path.resolve(argv[i + 1] ?? '.');
      i += 1;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      usage();
      process.exit(1);
    }
  }
  return out;
}

/**
 * Decide whether a single dependency entry should be rewritten.
 *
 * @param {string} depName  e.g. "@cleocode/core" or "tree-sitter"
 * @param {string} depValue e.g. "workspace:*", "0.21.1", "2026.5.99"
 * @returns {boolean} true iff this dep is an @cleocode/* numeric pin
 */
export function shouldBump(depName, depValue) {
  if (typeof depName !== 'string' || typeof depValue !== 'string') return false;
  if (!depName.startsWith(WORKSPACE_SCOPE_PREFIX)) return false;
  for (const prefix of NON_NUMERIC_REF_PREFIXES) {
    if (depValue.startsWith(prefix)) return false;
  }
  // Accept either bare or caret-pinned numeric refs (we still bump to the bare
  // canonical CalVer — release-publish drops the ^).
  const stripped =
    depValue.startsWith('^') || depValue.startsWith('~') ? depValue.slice(1) : depValue;
  return /^[0-9]/.test(stripped);
}

/**
 * Rewrite a dep-map in place. Returns the per-key change log.
 *
 * @param {Record<string,string>} depMap
 * @param {string} newVersion
 * @returns {Array<{ key: string, from: string, to: string }>}
 */
export function rewriteDepMap(depMap, newVersion) {
  const changes = [];
  if (!depMap || typeof depMap !== 'object') return changes;
  for (const [key, value] of Object.entries(depMap)) {
    if (shouldBump(key, value)) {
      changes.push({ key, from: value, to: newVersion });
      depMap[key] = newVersion;
    }
  }
  return changes;
}

async function getPackageJsonPaths(root) {
  const packagesDir = path.join(root, 'packages');
  /** @type {string[]} */
  const paths = [];
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return paths;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(path.join(packagesDir, entry.name, 'package.json'));
  }
  return paths;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Walk every packages/&#42;/package.json and bump matching @cleocode/* deps.
 *
 * @param {{ version: string, root: string, dryRun?: boolean }} opts
 * @returns {Promise<{
 *   version: string,
 *   filesScanned: number,
 *   filesChanged: number,
 *   changes: Array<{ file: string, kind: string, key: string, from: string, to: string }>
 * }>}
 */
export async function bumpWorkspaceDeps({ version, root, dryRun = false }) {
  if (!version || !CALVER_REGEX.test(version)) {
    throw new Error(`Invalid version '${version}'. Expected CalVer YYYY.M.PATCH[-suffix].`);
  }
  const packageJsonPaths = await getPackageJsonPaths(root);
  /** @type {Array<{ file: string, kind: string, key: string, from: string, to: string }>} */
  const allChanges = [];
  let filesChanged = 0;
  for (const pkgPath of packageJsonPaths) {
    let pkg;
    try {
      pkg = await readJson(pkgPath);
    } catch (err) {
      throw new Error(
        `Failed to read ${pkgPath}: ${err && err.message ? err.message : String(err)}`,
      );
    }
    const relPath = path.relative(root, pkgPath);
    const sections = ['dependencies', 'devDependencies', 'peerDependencies'];
    let touched = false;
    for (const kind of sections) {
      const changes = rewriteDepMap(pkg[kind], version);
      for (const c of changes) {
        allChanges.push({ file: relPath, kind, key: c.key, from: c.from, to: c.to });
        touched = true;
      }
    }
    if (touched && !dryRun) {
      await writeJson(pkgPath, pkg);
    }
    if (touched) filesChanged += 1;
  }
  return {
    version,
    filesScanned: packageJsonPaths.length,
    filesChanged,
    changes: allChanges,
  };
}

async function main() {
  const { version, root, dryRun, json } = parseArgs(process.argv.slice(2));
  if (!version) {
    usage();
    process.exit(1);
  }
  if (!CALVER_REGEX.test(version)) {
    process.stderr.write(
      `ERROR: Invalid version '${version}'. Expected CalVer format YYYY.M.PATCH or YYYY.M.PATCH-suffix\n`,
    );
    process.exit(1);
  }

  let report;
  try {
    report = await bumpWorkspaceDeps({ version, root, dryRun });
  } catch (err) {
    process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const banner = dryRun ? '[dry-run] ' : '';
  if (report.changes.length === 0) {
    process.stdout.write(
      `${banner}No @cleocode/* numeric deps required bumping (scanned ${report.filesScanned} package.json files).\n`,
    );
    return;
  }

  process.stdout.write(
    `${banner}Bumped ${report.changes.length} @cleocode/* dep ref(s) across ${report.filesChanged}/${report.filesScanned} package.json file(s) to ${report.version}:\n`,
  );
  for (const c of report.changes) {
    process.stdout.write(`  ${c.file} :: ${c.kind}.${c.key}  ${c.from} -> ${c.to}\n`);
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  await main();
}

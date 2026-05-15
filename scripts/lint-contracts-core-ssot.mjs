#!/usr/bin/env node
/**
 * scripts/lint-contracts-core-ssot.mjs
 *
 * Enforces ADR-057 layering invariants:
 *   L1: Core fns that are dispatch entry points (referenced in defineTypedHandler op maps)
 *       must have signature (projectRoot: string, params: <Op>Params): Promise<<Op>Result>
 *   L2: Contract <Op>Params must declare each logical field exactly once (no aliases)
 *   L3: Dispatch handler bodies must not contain `params.X ?? params.Y` translations on contract fields
 *   L4: Core fns imported by dispatch must be re-exported from @cleocode/core
 *
 * Exceptions: lines annotated with `// SSoT-EXEMPT:<reason>` within 3 lines of the construct are excluded.
 *
 * Usage:
 *   node scripts/lint-contracts-core-ssot.mjs                # report all violations
 *   node scripts/lint-contracts-core-ssot.mjs --fix          # auto-fix safe ones
 *   node scripts/lint-contracts-core-ssot.mjs --exit-on-fail # CI mode
 *
 * Output:
 *   Per-violation: file:line  RULE-CODE  description
 *   Exit 0 if clean, exit 1 if any violation (CI mode), exit 0 if any (report mode).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const REPO = process.cwd();
const DISPATCH_DOMAINS_DIR = join(REPO, 'packages/cleo/src/dispatch/domains');
const CONTRACTS_OPS_DIR = join(REPO, 'packages/contracts/src/operations');
const CORE_DIR = join(REPO, 'packages/core/src');
const CORE_INDEX = join(REPO, 'packages/core/src/index.ts');
const CACHE_DIR = join(REPO, '.cache');
const CORE_EXPORT_CACHE = join(CACHE_DIR, 'core-export-map.json');

const RULES = {
  L1: 'SSOT_VIOLATION_NON_UNIFORM_SIGNATURE',
  L2: 'SSOT_VIOLATION_ALIAS_IN_CONTRACT',
  L3: 'SSOT_VIOLATION_DISPATCH_NORMALIZATION',
  L4: 'SSOT_VIOLATION_NON_PUBLIC_CORE_FN',
};

let violations = 0;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function isExempt(lines, lineIdx) {
  // Check 3 lines around for // SSoT-EXEMPT: annotation
  for (let i = Math.max(0, lineIdx - 3); i <= Math.min(lines.length - 1, lineIdx + 3); i++) {
    if (lines[i].includes('// SSoT-EXEMPT:')) return true;
  }
  return false;
}

function report(rule, file, line, msg) {
  console.error(`${file}:${line}  ${RULES[rule]}  ${msg}`);
  violations++;
}

function sourceCandidates(basePath) {
  const candidates = [basePath];
  if (basePath.endsWith('.js')) {
    candidates.push(basePath.replace(/\.js$/, '.ts'), basePath.replace(/\.js$/, '.tsx'));
  } else if (!/\.[cm]?[tj]sx?$/.test(basePath)) {
    candidates.push(`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.js`);
  }
  candidates.push(join(basePath, 'index.ts'), join(basePath, 'index.tsx'));
  return candidates;
}

function resolveExportTarget(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    const basePath = resolve(dirname(fromFile), specifier);
    return sourceCandidates(basePath).find((candidate) => existsSync(candidate)) ?? null;
  }

  const workspacePackage = specifier.match(/^@cleocode\/([^/]+)(?:\/(.+))?$/);
  if (!workspacePackage) return null;

  const [, packageName, subpath = 'index'] = workspacePackage;
  const sourcePath = join(REPO, 'packages', packageName, 'src', subpath);
  return sourceCandidates(sourcePath).find((candidate) => existsSync(candidate)) ?? null;
}

function exportedName(specifier) {
  const cleaned = specifier
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .trim()
    .replace(/^type\s+/, '');
  if (!cleaned) return null;

  const aliasMatch = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
  if (aliasMatch) return aliasMatch[1];

  const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*)$/);
  return nameMatch ? nameMatch[1] : null;
}

function addTopLevelExports(content, exports) {
  for (const m of content.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    exports.add(m[1]);
  }

  for (const m of content.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([^=;]+)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (name) exports.add(name[1]);
    }
  }

  for (const m of content.matchAll(/\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\b|;)/g)) {
    for (const part of m[1].split(',')) {
      const name = exportedName(part);
      if (name && name !== 'default') exports.add(name);
    }
  }
}

function addWildcardExports(fromFile, content, exports) {
  for (const m of content.matchAll(/\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolveExportTarget(fromFile, m[1]);
    if (target) {
      addTopLevelExports(readText(target), exports);
    }
  }
}

// --------------------------------------------------------------------------
// Core export map — built once, cached, used by L1
// --------------------------------------------------------------------------

/**
 * Scans packages/core/src once and builds a map of exported function names
 * to their definition metadata. This avoids spawning grep for every entry point.
 *
 * The result is cached to .cache/core-export-map.json with mtime-based
 * invalidation so subsequent runs (e.g. pre-commit) are sub-second.
 */
async function buildCoreExportMap() {
  const map = new Map();
  const mtimes = {};
  const files = [];

  /** @param {string} dir */
  function collect(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        collect(p);
      } else if (
        e.isFile() &&
        /\.[cm]?tsx?$/.test(e.name) &&
        !/\.(test|spec)\.[cm]?tsx?$/.test(e.name)
      ) {
        files.push(p);
      }
    }
  }
  collect(CORE_DIR);

  // Parallel stat + read + parse to avoid sequential FUSE overhead
  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const stats = await Promise.all(batch.map((p) => stat(p)));
    const contents = await Promise.all(batch.map((p) => readFile(p)));

    for (let j = 0; j < batch.length; j++) {
      const p = batch[j];
      const buf = contents[j];
      mtimes[p] = stats[j].mtimeMs;

      if (!buf.includes('export function') && !buf.includes('export async function')) {
        continue;
      }
      const content = buf.toString('utf-8');
      const lines = content.split('\n');
      for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        const m = line.match(/^(export\s+(?:async\s+)?function\s+)(\w+)/);
        if (m) {
          const fnName = m[2];
          // Read up to 8 lines to capture full signature (multi-line generics)
          const sigChunk = lines.slice(k, k + 8).join(' ');
          map.set(fnName, { file: p, line: k + 1, sigChunk });
        }
      }
    }
  }

  // Persist cache
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CORE_EXPORT_CACHE, JSON.stringify({ mtimes, map: Object.fromEntries(map) }));
  } catch {
    // Cache write is best-effort
  }

  return map;
}

/**
 * Loads the core export map from cache if valid, otherwise rebuilds.
 * Cache is valid when every tracked file's mtime matches the cached value.
 * New files are silently ignored until a tracked file changes (acceptable
 * trade-off for pre-commit hook performance).
 *
 * Validation is async + parallel to avoid sequential stat overhead on slow
 * filesystems (e.g. FUSE/NTFS where statSync can take 10ms+ per call).
 */
async function getCoreExportMap() {
  try {
    const raw = readFileSync(CORE_EXPORT_CACHE, 'utf-8');
    const cache = JSON.parse(raw);
    const { mtimes } = cache;

    // Verify cache validity in parallel
    const checks = Object.entries(mtimes).map(async ([file, cachedMtime]) => {
      const s = await stat(file);
      if (s.mtimeMs !== cachedMtime) {
        throw new Error('stale');
      }
    });
    await Promise.all(checks);

    // Cache is valid — reconstruct Map
    const map = new Map();
    for (const [fnName, val] of Object.entries(cache.map)) {
      map.set(fnName, val);
    }
    return map;
  } catch {
    return buildCoreExportMap();
  }
}

/**
 * Checks whether a line in a file is exempt via SSoT-EXEMPT annotation.
 * Reads the file on demand — used by L1 where context is not pre-loaded.
 */
function isExemptAt(filePath, lineIdx) {
  const lines = readText(filePath).split('\n');
  return isExempt(lines, lineIdx);
}

// --------------------------------------------------------------------------
// L1 — Core fn signature uniformity
// --------------------------------------------------------------------------
//
// SCOPE: Only Core fns that are dispatch entry points — i.e., directly called
// (via `await <fnName>(`) within a `defineTypedHandler<XOps>('domain', { ... })`
// block. Internal helpers used BY those entry points are out of scope.
//
// This filter prevents false-positives on utilities like getLogger, paginate,
// getProjectRoot, ADR helpers, token-service helpers, snapshot helpers, etc.
// which are imported by dispatch but are NOT themselves dispatch operations.

/**
 * Extract the set of Core fn names that are directly awaited within the
 * defineTypedHandler block of a dispatch file.
 *
 * Strategy: find the `defineTypedHandler<` call, then extract all `await <name>(`
 * calls within that block (balanced braces). Only names that were also imported
 * from @cleocode/core or engine files are returned.
 */
function extractDispatchEntryPoints(content, importedNames) {
  const entryPoints = new Set();

  // Find the defineTypedHandler block
  const handlerStart = content.indexOf('defineTypedHandler<');
  if (handlerStart === -1) return entryPoints;

  // Find the opening brace of the second argument (the ops object)
  const firstBrace = content.indexOf('{', handlerStart);
  if (firstBrace === -1) return entryPoints;

  // Walk balanced braces to find the end of the block
  let depth = 0;
  let blockEnd = firstBrace;
  for (let i = firstBrace; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }

  const block = content.slice(firstBrace, blockEnd + 1);

  // Extract all `await <name>(` patterns within the block
  for (const m of block.matchAll(/\bawait\s+(\w+)\s*\(/g)) {
    const name = m[1];
    if (importedNames.has(name)) {
      entryPoints.add(name);
    }
  }

  return entryPoints;
}

async function lintCoreSignatures() {
  const coreMap = await getCoreExportMap();
  const dispatchFiles = readdirSync(DISPATCH_DOMAINS_DIR).filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.startsWith('_') &&
      !f.match(/\.(test|spec)\.tsx?$/) &&
      !f.includes('__tests__'),
  );

  for (const file of dispatchFiles) {
    const content = readText(join(DISPATCH_DOMAINS_DIR, file));

    // Collect all Core fn names imported by this dispatch file
    const importedNames = new Set();
    const importBlocks = content.matchAll(
      /import\s+\{([^}]+)\}\s+from\s+['"](@cleocode\/core(?:\/internal)?|\.\.\/engines\/[\w-]+-engine\.js)['"]/g,
    );
    for (const block of importBlocks) {
      const names = block[1]
        .split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter((s) => s && !s.startsWith('type '));
      for (const n of names) importedNames.add(n);
    }

    // Scope to only dispatch entry points (fns called within defineTypedHandler block)
    const entryPoints = extractDispatchEntryPoints(content, importedNames);

    // Check each entry-point fn signature against pre-built map (O(1) lookup)
    for (const fnName of entryPoints) {
      const def = coreMap.get(fnName);
      if (!def) continue; // not a Core fn (might be from engine file)

      const { file: defFile, line: lineNum, sigChunk } = def;

      // Acceptance: has `(projectRoot: string, params: <Op>Params` per ADR-057 D1.
      // Note: \s* after the opening paren handles multi-line signatures joined with spaces.
      // _params is allowed (underscore prefix for unused params per TS convention).
      if (!/\(\s*_?projectRoot:\s*string,\s*_?params:\s*\w+Params\b/.test(sigChunk)) {
        if (!isExemptAt(defFile, lineNum - 1)) {
          report(
            'L1',
            defFile,
            lineNum,
            `Core fn ${fnName} signature is not (projectRoot: string, params: <Op>Params)`,
          );
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// L2 — Alias in contract
// --------------------------------------------------------------------------
//
// Detects pairs of fields in the same interface where one is the alias of the other.
// Heuristic: same interface, two fields where one is "<X>Id" and the other is "<X>",
// or a known alias pair like ("type", "kind"), ("role", "kind").

const KNOWN_ALIAS_PAIRS = [
  ['parent', 'parentId'],
  ['role', 'kind'],
  ['type', 'kind'],
];

function lintContractsForAliases() {
  const files = readdirSync(CONTRACTS_OPS_DIR).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const path = join(CONTRACTS_OPS_DIR, file);
    const content = readText(path);
    const lines = content.split('\n');
    // Naive parser: find `export interface <Name>Params { ... }` blocks
    let inInterface = false;
    let blockFields = [];
    let blockName = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^export interface (\w+Params)\s*\{/.test(line)) {
        const matched = line.match(/^export interface (\w+Params)/);
        inInterface = true;
        blockFields = [];
        blockName = matched[1];
        continue;
      }
      if (inInterface && /^\}/.test(line)) {
        // Check for alias pairs
        for (const [a, b] of KNOWN_ALIAS_PAIRS) {
          if (blockFields.some((f) => f.name === a) && blockFields.some((f) => f.name === b)) {
            const fieldA = blockFields.find((f) => f.name === a);
            if (!isExempt(lines, fieldA.line - 1)) {
              report(
                'L2',
                path,
                fieldA.line,
                `interface ${blockName} declares both '${a}' and '${b}' (alias pair)`,
              );
            }
          }
        }
        inInterface = false;
        continue;
      }
      if (inInterface) {
        const fm = line.match(/^\s+(\w+)\??:\s*/);
        if (fm) {
          blockFields.push({ name: fm[1], line: i + 1 });
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// L3 — Dispatch handler does alias normalization
// --------------------------------------------------------------------------

function lintDispatchForNormalization() {
  const files = readdirSync(DISPATCH_DOMAINS_DIR).filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.startsWith('_') &&
      !f.match(/\.(test|spec)\.tsx?$/) &&
      !f.includes('__tests__'),
  );
  for (const file of files) {
    const path = join(DISPATCH_DOMAINS_DIR, file);
    const content = readText(path);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match `params.X ?? params.Y` for contract fields
      const m = line.match(/params\.(\w+)\s*\?\?\s*params\.(\w+)/);
      if (m) {
        if (!isExempt(lines, i)) {
          report(
            'L3',
            path,
            i + 1,
            `dispatch handler normalizes alias: params.${m[1]} ?? params.${m[2]}`,
          );
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// L4 — Core fn imported by dispatch must be SDK-public
// --------------------------------------------------------------------------

function lintCorePublic() {
  const indexContent = readText(CORE_INDEX);
  // Collect re-exported names from packages/core/src/index.ts
  const reExports = new Set();
  addTopLevelExports(indexContent, reExports);
  addWildcardExports(CORE_INDEX, indexContent, reExports);

  // Check each fn imported by dispatch from @cleocode/core (not /internal)
  const dispatchFiles = readdirSync(DISPATCH_DOMAINS_DIR).filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.startsWith('_') &&
      !f.match(/\.(test|spec)\.tsx?$/) &&
      !f.includes('__tests__'),
  );
  for (const file of dispatchFiles) {
    const path = join(DISPATCH_DOMAINS_DIR, file);
    const content = readText(path);
    const importBlocks = content.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]@cleocode\/core['"]/g);
    for (const block of importBlocks) {
      const names = block[1]
        .split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter((s) => s && !s.startsWith('type '));
      for (const n of names) {
        if (!reExports.has(n)) {
          report(
            'L4',
            path,
            1,
            `dispatch imports ${n} from @cleocode/core but it is not re-exported from index.ts`,
          );
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

const args = process.argv.slice(2);
const exitOnFail = args.includes('--exit-on-fail');

console.error('# lint-contracts-core-ssot');
console.error('# ADR-057 enforcement\n');

(async () => {
  lintContractsForAliases();
  lintDispatchForNormalization();
  await lintCoreSignatures();
  lintCorePublic();

  if (violations === 0) {
    console.error('\n✅ No SSoT violations found.');
    process.exit(0);
  } else {
    console.error(`\n❌ ${violations} SSoT violation(s) found.`);
    process.exit(exitOnFail ? 1 : 0);
  }
})();

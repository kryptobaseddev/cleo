#!/usr/bin/env node
/**
 * Lint rule: enforce ONE writer per `BuiltinDocKind` across `packages/core/`
 * and assert routing parity with `.cleo/canon.yml`.
 *
 * Why this matters (T10294 / Saga T10288 / Epic T10290)
 * -----------------------------------------------------
 *
 * Before T10366, the mapping from `BuiltinDocKind` → canonical writer was
 * implicit and spread across multiple call sites. Two parallel writer paths
 * could (and did) call `attachmentStore.put({ slug })` for the SAME DocKind
 * through different code paths and surface conflicts through DIFFERENT
 * envelopes. T10294 (PR #576) classified this as the slug-collision class
 * — see option (c): collapse writers AND introduce a chokepoint allocator.
 *
 * `packages/core/src/docs/writer-registry.ts` is the writer-registry half of
 * the fix (the allocator half is `reserveSlug` in `slug-allocator.ts`). This
 * gate prevents writer-registry regressions from ever shipping:
 *
 *   1. Every `BuiltinDocKind` MUST have exactly ONE `WriterDescriptor`.
 *   2. Every descriptor's `mode: 'ssot-first'` MUST match a kind in
 *      `.cleo/canon.yml` whose `canonicalHome === 'ssot-first'`, and vice
 *      versa.
 *   3. Raw `writeFileSync(*.md)` / `writeFile(*.md)` calls outside the
 *      canonical writer set are flagged. Baseline-mode tolerates the
 *      pre-existing legitimate exempt writes captured in the baseline file.
 *
 * Three categories of rule fire:
 *
 *   - `dockind-coverage-missing` — a kind in `BUILTIN_DOC_KINDS` has zero
 *     descriptors (collision case is caught at build time by the registry
 *     itself; this gate fires when a kind is added without an entry).
 *   - `canon-yml-ssot-first-drift` — a descriptor's `mode: 'ssot-first'`
 *     does not match `.cleo/canon.yml::canonicalHome` for the same kind,
 *     or vice versa.
 *   - `unregistered-md-write` — a raw `.md` write callsite in
 *     `packages/core/src/**` that is not in the baseline.
 *
 * Allowlisted locations for raw .md writes (legitimate non-DocKind writers):
 *
 *   - `packages/core/src/sessions/handoff-markdown.ts` — session-handoff
 *     snapshots written by `cleo session end`. Different from DocKind
 *     `handoff` (which lives in the blob store).
 *   - `packages/core/src/changesets/writer.ts` — canonical `changeset`
 *     DocKind writer (registered: verb=`changeset add`).
 *   - Test files (`__tests__/`, `*.test.ts`, `*.spec.ts`).
 *
 * Per-line opt-out: append `// dockind-writer-allowed: <reason>` on the
 * line with the write call.
 *
 * Modes
 * -----
 * --strict        Require zero unregistered-md-write violations.
 * --baseline      Default — fails only if unregistered-write COUNT INCREASES
 *                 above `.lint-dockind-writer-baseline.json`. The schema /
 *                 parity rules are ALWAYS strict (they have no baseline).
 * --update-baseline Overwrite the baseline JSON with current counts.
 *
 * @task T10369
 * @epic T10290 E2-DOCS-DOCKIND-WRITER-DEDUP
 * @saga T10288 SG-DOCS-INTEGRITY
 * @adr ADR-076 (canon routing)
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const REGISTRY_PATH = 'packages/core/src/docs/writer-registry.ts';
const CONTRACTS_TAXONOMY_PATH = 'packages/contracts/src/docs-taxonomy.ts';
const CANON_YML_PATH = '.cleo/canon.yml';
const BASELINE_PATH = '.lint-dockind-writer-baseline.json';

const SCAN_DIRS = ['packages/core/src'];

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  'coverage',
  'fixtures',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.mts']);

const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/**
 * Path prefixes (POSIX, from repo root) that are allowed to contain raw .md
 * writes. These correspond to the canonical exception sites documented above.
 *
 * Each entry is a CANONICAL DocKind writer or a documented non-DocKind
 * writer. ADDING new entries here REQUIRES a corresponding writer-registry
 * entry OR a written justification in a follow-up task.
 */
const ALLOW_PATH_PREFIXES = [
  // Canonical changeset writer — registered as DocKind `changeset`.
  'packages/core/src/changesets/writer.ts',
  // Session handoff snapshot — NOT a DocKind (lives outside attachment store).
  // Written by `cleo session end` for human-readable resume context.
  'packages/core/src/sessions/handoff-markdown.ts',
];

/** Regex patterns tested against the POSIX-relative path — always allowed. */
const ALLOW_PATH_REGEXES = [/__tests__\//, /\/fixtures\//];

/** Inline opt-out marker (must appear on the same source line). */
const ALLOW_INLINE = '// dockind-writer-allowed';

// We hunt for any writeFileSync / writeFile call where the argument string
// or the immediately adjacent context references a `.md` literal. The
// heuristic is intentionally loose — false positives on test fixtures are
// suppressed by the ALLOW_PATH_REGEXES / TEST_FILE_SUFFIXES filters.
const PATTERN_WRITE_MD = /(writeFileSync|writeFile)\s*\([^)]*\.md/;

// Also flag `fs.writeFile(path, ...)` where `path` ends with `.md` on the
// SAME line. The two-pattern setup keeps false-positives minimal while
// catching the cases the changeset writer and session handoff use.
const PATTERN_WRITE_MD_VAR = /(writeFileSync|writeFile)\s*\([^,]*,\s*[^,)]*\)\s*;[^;]*\.md/;

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--baseline') || args.includes('--update-baseline');

// ============================================================================
// Helpers
// ============================================================================

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(process.cwd(), filePath);
  return rel.split(sep).join(posix.sep);
}

/** @param {string} relPath POSIX-relative path from repo root */
function isAllowedPath(relPath) {
  if (ALLOW_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  if (ALLOW_PATH_REGEXES.some((rx) => rx.test(relPath))) return true;
  return false;
}

/** @param {string} filePath */
function isTestFile(filePath) {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

// ============================================================================
// Registry parser — load the canonical DESCRIPTORS array from writer-registry.ts
// ============================================================================

/**
 * @typedef {{
 *   kind: string,
 *   verb: string,
 *   dispatchOp: string,
 *   coreFn: string,
 *   mode: string,
 *   sourcePath: string,
 * }} WriterDescriptorParsed
 */

/**
 * Parse the `DESCRIPTORS` array literal out of writer-registry.ts. Uses a
 * tolerant regex sweep (the source is hand-authored TypeScript with a known
 * shape, not a runtime structure we can import) — schema drift fails fast
 * via the kind-coverage parity check downstream.
 *
 * @param {string} src
 * @returns {WriterDescriptorParsed[]}
 */
function parseDescriptors(src) {
  const out = [];
  // Match each `{ kind: 'x', verb: 'y', ... }` block inside DESCRIPTORS.
  const blockRx =
    /\{\s*kind:\s*'([^']+)',\s*verb:\s*'([^']+)',\s*dispatchOp:\s*'([^']+)',\s*coreFn:\s*'([^']+)',\s*mode:\s*'([^']+)',\s*sourcePath:\s*'([^']+)',?\s*\}/g;
  for (;;) {
    const match = blockRx.exec(src);
    if (match === null) break;
    out.push({
      kind: match[1],
      verb: match[2],
      dispatchOp: match[3],
      coreFn: match[4],
      mode: match[5],
      sourcePath: match[6],
    });
  }
  return out;
}

/**
 * Extract the list of built-in DocKinds from the contracts taxonomy file.
 * Reads BUILTIN_DOC_KINDS array entries' `kind: 'x'` lines.
 *
 * @param {string} src
 * @returns {string[]}
 */
function parseBuiltinDocKinds(src) {
  // Locate the BUILTIN_DOC_KINDS array — only those entries are relevant.
  const startIdx = src.indexOf('BUILTIN_DOC_KINDS');
  if (startIdx === -1) return [];
  // Find the opening `[` after the assignment.
  const openIdx = src.indexOf('[', startIdx);
  if (openIdx === -1) return [];
  // Find the matching closing `]` (naive bracket walk — taxonomy file is flat).
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return [];
  const slice = src.slice(openIdx, closeIdx);
  const out = [];
  const kindRx = /kind:\s*'([^']+)'/g;
  for (;;) {
    const match = kindRx.exec(slice);
    if (match === null) break;
    out.push(match[1]);
  }
  return out;
}

// ============================================================================
// canon.yml parser — strict shape, naive YAML reader (no dependency)
// ============================================================================

/**
 * Parse `.cleo/canon.yml` for the per-kind `canonicalHome` value. Avoids
 * pulling the `yaml` package in this lint script — we only need the kind
 * → canonicalHome mapping which is straightforward to extract.
 *
 * @param {string} src
 * @returns {Record<string, string>}
 */
function parseCanonYml(src) {
  const out = {};
  const lines = src.split('\n');
  let currentKind = null;
  for (const line of lines) {
    // Skip comments and blank lines.
    if (/^\s*#/.test(line) || !line.trim()) continue;
    // A kind entry — exactly 2 leading spaces, name, colon (e.g. `  adr:`).
    const kindMatch = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (kindMatch) {
      currentKind = kindMatch[1];
      continue;
    }
    // A canonicalHome line — at least 4 leading spaces under the kind.
    if (currentKind) {
      const homeMatch = line.match(/^ {4}canonicalHome:\s*([a-z-]+)/);
      if (homeMatch) {
        out[currentKind] = homeMatch[1];
      }
    }
  }
  return out;
}

// ============================================================================
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, ruleId: string, snippet: string}>} */
const violations = [];

/** @param {string} absPath */
function scanFile(absPath) {
  const relPath = toPosixRel(absPath);

  if (isAllowedPath(relPath)) return;
  if (isTestFile(relPath)) return;

  // Don't scan the registry itself — it's a metadata declaration, not a writer.
  if (relPath === REGISTRY_PATH) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip TSDoc / JSDoc block lines.
    if (/^\s*\*/.test(line)) continue;
    // Strip inline comments to avoid matching in JSDoc prose.
    const code = (() => {
      const s = line.replace(/\/\*[\s\S]*?\*\//g, '');
      const idx = s.indexOf('//');
      return idx !== -1 ? s.slice(0, idx) : s;
    })();

    if (!code.trim()) continue;
    if (line.includes(ALLOW_INLINE)) continue;

    if (PATTERN_WRITE_MD.test(code) || PATTERN_WRITE_MD_VAR.test(code)) {
      violations.push({
        file: relPath,
        line: i + 1,
        ruleId: 'unregistered-md-write',
        snippet: line.trim(),
      });
    }
  }
}

/** @param {string} dir */
function walkDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full);
    } else if (st.isFile() && SCAN_EXTENSIONS.has(extname(entry))) {
      scanFile(full);
    }
  }
}

// ============================================================================
// 1. Schema parity — registry coverage + canon.yml alignment
// ============================================================================

/** @type {Array<{ruleId: string, message: string}>} */
const schemaViolations = [];

const registryPath = join(process.cwd(), REGISTRY_PATH);
const contractsPath = join(process.cwd(), CONTRACTS_TAXONOMY_PATH);
const canonPath = join(process.cwd(), CANON_YML_PATH);

if (!existsSync(registryPath)) {
  console.error(`lint-dockind-writer-uniqueness: FATAL — registry not found at ${REGISTRY_PATH}`);
  process.exit(2);
}
if (!existsSync(contractsPath)) {
  console.error(
    `lint-dockind-writer-uniqueness: FATAL — contracts taxonomy not found at ${CONTRACTS_TAXONOMY_PATH}`,
  );
  process.exit(2);
}
if (!existsSync(canonPath)) {
  console.error(`lint-dockind-writer-uniqueness: FATAL — canon.yml not found at ${CANON_YML_PATH}`);
  process.exit(2);
}

const registrySrc = readFileSync(registryPath, 'utf-8');
const contractsSrc = readFileSync(contractsPath, 'utf-8');
const canonSrc = readFileSync(canonPath, 'utf-8');

const descriptors = parseDescriptors(registrySrc);
const builtinKinds = parseBuiltinDocKinds(contractsSrc);
const canonHomes = parseCanonYml(canonSrc);

if (descriptors.length === 0) {
  schemaViolations.push({
    ruleId: 'registry-empty',
    message:
      `Could not parse any WriterDescriptor entries from ${REGISTRY_PATH}. ` +
      'Either the file is empty or the DESCRIPTORS array shape has drifted ' +
      'from the parser regex.',
  });
}

if (builtinKinds.length === 0) {
  schemaViolations.push({
    ruleId: 'contracts-empty',
    message: `Could not parse any BUILTIN_DOC_KINDS entries from ${CONTRACTS_TAXONOMY_PATH}.`,
  });
}

// Rule: every kind in BUILTIN_DOC_KINDS MUST have exactly one descriptor.
const descriptorCounts = new Map();
for (const desc of descriptors) {
  descriptorCounts.set(desc.kind, (descriptorCounts.get(desc.kind) ?? 0) + 1);
}

for (const kind of builtinKinds) {
  const count = descriptorCounts.get(kind) ?? 0;
  if (count === 0) {
    schemaViolations.push({
      ruleId: 'dockind-coverage-missing',
      message: `DocKind '${kind}' has zero WriterDescriptors in ${REGISTRY_PATH}.`,
    });
  } else if (count > 1) {
    schemaViolations.push({
      ruleId: 'dockind-coverage-collision',
      message:
        `DocKind '${kind}' has ${count} WriterDescriptors — exactly one writer per ` +
        `DocKind is required (T10366). See ${REGISTRY_PATH}.`,
    });
  }
}

// Rule: every descriptor with mode='ssot-first' MUST match canon.yml's
// canonicalHome='ssot-first' for the same kind, and vice versa.
for (const desc of descriptors) {
  if (desc.mode === 'ssot-first') {
    const canonHome = canonHomes[desc.kind];
    if (canonHome !== 'ssot-first') {
      schemaViolations.push({
        ruleId: 'canon-yml-ssot-first-drift',
        message:
          `Descriptor '${desc.kind}' is mode='ssot-first' but ${CANON_YML_PATH} ` +
          `has canonicalHome='${canonHome ?? '<missing>'}'. Both must agree.`,
      });
    }
  }
}

for (const [kind, home] of Object.entries(canonHomes)) {
  if (home !== 'ssot-first') continue;
  const desc = descriptors.find((d) => d.kind === kind);
  if (!desc) {
    schemaViolations.push({
      ruleId: 'canon-yml-ssot-first-drift',
      message:
        `${CANON_YML_PATH} has canonicalHome='ssot-first' for '${kind}' but ` +
        `${REGISTRY_PATH} has no matching descriptor.`,
    });
    continue;
  }
  if (desc.mode !== 'ssot-first') {
    schemaViolations.push({
      ruleId: 'canon-yml-ssot-first-drift',
      message:
        `${CANON_YML_PATH} has canonicalHome='ssot-first' for '${kind}' but ` +
        `descriptor mode='${desc.mode}'. Both must agree.`,
    });
  }
}

// ============================================================================
// 2. Scan packages/core/src for unregistered raw .md writes
// ============================================================================

for (const dir of SCAN_DIRS) {
  walkDir(join(process.cwd(), dir));
}

// ============================================================================
// Count violations per rule
// ============================================================================

const RULE_IDS = ['unregistered-md-write'];

/** @type {Record<string, number>} */
const currentCounts = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
for (const v of violations) {
  currentCounts[v.ruleId] = (currentCounts[v.ruleId] ?? 0) + 1;
}
const totalViolations = violations.length;

// ============================================================================
// Schema violations are ALWAYS strict — they have no baseline
// ============================================================================

if (schemaViolations.length > 0) {
  console.error(
    `lint-dockind-writer-uniqueness: SCHEMA FAIL — ${schemaViolations.length} violation(s):\n`,
  );
  for (const sv of schemaViolations) {
    console.error(`  [${sv.ruleId}] ${sv.message}`);
  }
  console.error(
    '\nFix the registry, the contracts taxonomy, or .cleo/canon.yml — these ' +
      'three sources MUST agree on every BuiltinDocKind.\n',
  );
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write current counts and exit
// ============================================================================

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-dockind-writer-uniqueness.mjs --update-baseline. ' +
          'DO NOT edit manually. See T10369 / Epic T10290 / Saga T10288 for context.',
        counts: currentCounts,
        total: totalViolations,
        violations: violations.map((v) => ({ file: v.file, line: v.line, ruleId: v.ruleId })),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-dockind-writer-uniqueness: baseline updated -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Strict mode — require zero unregistered-md-write violations
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-dockind-writer-uniqueness: STRICT OK — zero violations.');
    process.exit(0);
  }
  console.error(
    `lint-dockind-writer-uniqueness: STRICT FAIL — ${totalViolations} unregistered .md write(s):\n`,
  );
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\nFix: route the .md write through the canonical WriterRegistry entry for the kind\n' +
      '     (cleo docs add | cleo changeset add | system-managed producer), or add the\n' +
      '     callsite to ALLOW_PATH_PREFIXES with a written justification.\n' +
      '     Per-line opt-out: append `// dockind-writer-allowed: <reason>`.\n',
  );
  process.exit(1);
}

// ============================================================================
// Baseline mode (default) — fail only on net-add
// ============================================================================

/** @type {{counts: Record<string, number>, total: number} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(
      `lint-dockind-writer-uniqueness: ERROR — could not parse baseline at ${BASELINE_PATH}`,
    );
    process.exit(1);
  }
} else {
  // No baseline yet — write it on first run and exit 0 so CI bootstraps cleanly.
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Auto-generated by scripts/lint-dockind-writer-uniqueness.mjs. ' +
          'DO NOT edit manually. See T10369 / Epic T10290 / Saga T10288 for context.',
        counts: currentCounts,
        total: totalViolations,
        violations: violations.map((v) => ({ file: v.file, line: v.line, ruleId: v.ruleId })),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(
    `lint-dockind-writer-uniqueness: baseline created -> ${BASELINE_PATH} (${totalViolations} violation(s) recorded). ` +
      'Re-run to check against baseline.',
  );
  process.exit(0);
}

// Compare current counts to baseline — fail on net-add.
/** @type {Array<{ruleId: string, baselineCount: number, currentCount: number, added: number}>} */
const regressions = [];
for (const ruleId of RULE_IDS) {
  const baselineCount = baseline.counts?.[ruleId] ?? 0;
  const currentCount = currentCounts[ruleId] ?? 0;
  if (currentCount > baselineCount) {
    regressions.push({ ruleId, baselineCount, currentCount, added: currentCount - baselineCount });
  }
}

if (regressions.length === 0) {
  const saved = (baseline.total ?? 0) - totalViolations;
  const savedMsg = saved > 0 ? ` (${saved} violation(s) resolved vs baseline — great work!)` : '';
  console.info(
    `lint-dockind-writer-uniqueness: OK — ${totalViolations} violation(s) (baseline: ${baseline.total ?? 0})${savedMsg}`,
  );
  if (totalViolations > 0) {
    console.info(
      'Run `node scripts/lint-dockind-writer-uniqueness.mjs --update-baseline` after resolving violations to lower the baseline.',
    );
  }
  process.exit(0);
}

// Regressions detected.
console.error(
  `lint-dockind-writer-uniqueness: FAIL — ${regressions.length} rule(s) regressed vs baseline:\n`,
);
for (const r of regressions) {
  console.error(
    `  [${r.ruleId}] baseline: ${r.baselineCount} -> current: ${r.currentCount} (+${r.added} new violation(s))`,
  );
}

console.error('\nNew violations:\n');
const regressionRuleIds = new Set(regressions.map((r) => r.ruleId));
for (const v of violations) {
  if (!regressionRuleIds.has(v.ruleId)) continue;
  console.error(`  [${v.ruleId}] ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
}

console.error(
  '\nFix:\n' +
    '  • Route the .md write through the canonical WriterRegistry entry for the\n' +
    '    kind (cleo docs add | cleo changeset add | system-managed producer).\n' +
    '  • For NON-DocKind .md writes (e.g. session-handoff snapshots), add the\n' +
    '    callsite to ALLOW_PATH_PREFIXES in scripts/lint-dockind-writer-uniqueness.mjs\n' +
    '    with a written justification.\n' +
    '  • Per-line opt-out: append `// dockind-writer-allowed: <reason>`.\n' +
    '  • See packages/core/src/docs/writer-registry.ts for the canonical registry.\n',
);
process.exit(1);

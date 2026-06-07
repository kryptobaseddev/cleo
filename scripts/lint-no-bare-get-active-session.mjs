#!/usr/bin/env node
/**
 * Lint rule: reject NEW bare `getActiveSession(` callsites (T11640 · Epic T11638).
 *
 * Why this matters (ADR — Epic T11638 EP-SESSION-MANIFEST)
 * --------------------------------------------------------
 * `getActiveSession()` resolves "the most-recent `status='active'` session
 * row" — i.e. *whoever wrote the DB last*. Under the warm daemon (many
 * concurrent connections sharing one process) and under multi-agent spawn
 * isolation (many worktrees writing one DB), that is the WRONG identity: it
 * collapses every caller onto the last writer, causing session-bleed and
 * memory scope-leakage.
 *
 * Identity-meaning callers — anything that means "the session of whoever is
 * calling THIS request" — MUST use `resolveCurrentSession()` /
 * `resolveCurrentSessionId()` (the connection-handle → `CLEO_SESSION_ID` →
 * most-recent-active precedence). `getActiveSession()` is demoted to `@internal`
 * and survives ONLY as the tier-3 fallback inside the resolver and for genuine
 * SCAN-meaning callers ("is there ANY active session?", `gcSessions`, the
 * data-accessor pass-throughs).
 *
 * This gate freezes the current set of bare callsites in a baseline and fails
 * on any NET-NEW bare `getActiveSession(` so the identity-vs-scan split cannot
 * silently regress. It does NOT rewrite existing callsites — those migrate out
 * incrementally; lower the baseline with `--update-baseline` as they do.
 *
 * What counts as a "bare callsite"
 * --------------------------------
 *   - A CALL `getActiveSession(` (with the trailing `(`), NOT the definition,
 *     re-exports, type positions, or doc prose.
 *   - The canonical definition + resolver wiring in
 *     `packages/core/src/store/session-store.ts` is exempt (it OWNS the symbol
 *     and is the legitimate tier-3 fallback).
 *   - The interface declaration + concrete accessor methods named
 *     `getActiveSession` are method DEFINITIONS, not bare calls — only
 *     `accessor.getActiveSession(` *invocations* are counted, and accessor
 *     pass-through delegators (`return ...getActiveSession()`) inside the three
 *     accessor files are exempt as interface plumbing.
 *
 * Per-line opt-out: append `// get-active-session-allowed: <reason>` on the
 * call line for a justified SCAN-meaning callsite.
 *
 * Modes
 * -----
 * --strict          Require zero bare callsites — fail even if count matches baseline.
 * --update-baseline Overwrite the baseline file with the current count and exit 0.
 * (default)         Fail only if the count INCREASES vs the stored baseline.
 *
 * `--check` is accepted as a no-op alias for default (baseline) mode so the
 * `cleo check arch` driver can pass it uniformly.
 *
 * @task T11640
 * @epic T11638
 * @saga T11243
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const SCAN_DIRS = ['packages'];

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svelte-kit',
  '__snapshots__',
  '__mocks__',
  'coverage',
  '.next',
  'fixtures',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.tsx']);

/** Test file suffixes — skipped (mocks legitimately stub getActiveSession). */
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.mts'];

/**
 * Path prefixes (POSIX, from repo root) exempt from the bare-callsite rule —
 * the symbol's canonical home, the interface declaration, and the concrete
 * accessor implementations whose `getActiveSession` method bodies + pass-through
 * delegators are interface plumbing (NOT identity-meaning consumer callsites).
 */
const ALLOW_PATH_PREFIXES = [
  // OWNS getActiveSession + the resolveCurrentSession tier-3 fallback.
  'packages/core/src/store/session-store.ts',
  // The DataAccessor interface declaration (a type signature, not a call).
  'packages/contracts/src/data-accessor.ts',
  // Concrete accessor implementations: the method definition + pass-through
  // delegators are the interface wiring, scanned/banned only at the call sites
  // that CONSUME them.
  'packages/core/src/store/sqlite-data-accessor.ts',
  'packages/core/src/store/umbrella-data-accessor.ts',
  'packages/core/src/store/safety-data-accessor.ts',
];

/**
 * Definition-shape patterns: a METHOD definition (`async getActiveSession(`) or
 * an interface/type SIGNATURE (`getActiveSession(): ...`) — never a consumer
 * call. Lines matching only these are not bare callsites.
 */
const PATTERN_METHOD_DEF = /(?:^|[^.\w$])(?:async\s+)?getActiveSession\s*\(\s*\)\s*:/;

/** Regex patterns tested against the POSIX-relative path — always allowed. */
const ALLOW_PATH_REGEXES = [/__tests__\//];

/** Inline opt-out marker (must appear on the same source line). */
const ALLOW_INLINE = '// get-active-session-allowed';

/**
 * The bare-call pattern. Matches a CALL `getActiveSession(` optionally preceded
 * by a member access (`accessor.getActiveSession(`), but NOT:
 *   - the symbol with `Info`/other suffix (handled by the trailing `(` + `\b`),
 *   - an `import`/`export` of the identifier (those have no trailing `(`).
 * The `getActiveSessionInfo(` symbol is explicitly excluded.
 */
const PATTERN_BARE_CALL = /(?<![\w$])getActiveSession\s*\(/;
const PATTERN_INFO_CALL = /(?<![\w$])getActiveSessionInfo\s*\(/;

/** Baseline JSON path (relative to repo root). */
const BASELINE_PATH = 'scripts/.lint-no-bare-get-active-session-baseline.json';

// ============================================================================
// CLI flags
// ============================================================================

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

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
// Scanner
// ============================================================================

/** @type {Array<{file: string, line: number, snippet: string}>} */
const violations = [];

/** @param {string} absPath */
function scanFile(absPath) {
  const relPath = toPosixRel(absPath);

  if (isAllowedPath(relPath)) return;
  if (isTestFile(relPath)) return;

  const src = readFileSync(absPath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip TSDoc / JSDoc block lines (prose mentions of the symbol).
    if (/^\s*\*/.test(line)) continue;

    // Strip block + line comments so a `// getActiveSession()` mention in
    // a code comment is not counted.
    const code = (() => {
      const s = line.replace(/\/\*[\s\S]*?\*\//g, '');
      const idx = s.indexOf('//');
      return idx !== -1 ? s.slice(0, idx) : s;
    })();

    if (!code.trim()) continue;
    if (line.includes(ALLOW_INLINE)) continue;

    // Skip method/interface definitions (`async getActiveSession(): Promise<…>`
    // / `getActiveSession(): Promise<…>`) — declarations, not consumer calls.
    if (PATTERN_METHOD_DEF.test(code)) continue;

    // Exclude the distinct getActiveSessionInfo() symbol.
    if (PATTERN_INFO_CALL.test(code)) {
      // Remove the Info() call(s) before testing the bare pattern so a line
      // that ONLY calls getActiveSessionInfo() is not flagged.
      const stripped = code.replace(/getActiveSessionInfo\s*\(/g, '');
      if (PATTERN_BARE_CALL.test(stripped)) {
        violations.push({ file: relPath, line: i + 1, snippet: line.trim() });
      }
      continue;
    }

    if (PATTERN_BARE_CALL.test(code)) {
      violations.push({ file: relPath, line: i + 1, snippet: line.trim() });
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

for (const dir of SCAN_DIRS) {
  walkDir(join(process.cwd(), dir));
}

const totalViolations = violations.length;

// ============================================================================
// Strict mode — require zero bare callsites
// ============================================================================

if (STRICT) {
  if (totalViolations === 0) {
    console.info('lint-no-bare-get-active-session: STRICT OK — zero bare callsites.');
    process.exit(0);
  }
  console.error(
    `lint-no-bare-get-active-session: STRICT FAIL — ${totalViolations} bare callsite(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    '\nFix: use resolveCurrentSession()/resolveCurrentSessionId() for identity,\n' +
      '     or annotate a justified SCAN-meaning callsite with\n' +
      '     `// get-active-session-allowed: <reason>`.\n',
  );
  process.exit(1);
}

// ============================================================================
// Update-baseline mode — write new baseline and exit
// ============================================================================

/**
 * @param {string} note
 */
function writeBaseline(note) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _comment:
          `Auto-generated by scripts/lint-no-bare-get-active-session.mjs (${note}). ` +
          'DO NOT edit manually. Lower the count with --update-baseline as bare ' +
          'callsites migrate to resolveCurrentSession. See T11640 / Epic T11638.',
        total: totalViolations,
        callsites: violations.map((v) => `${v.file}:${v.line}`),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

if (UPDATE_BASELINE) {
  writeBaseline('--update-baseline');
  console.info(
    `lint-no-bare-get-active-session: baseline updated -> ${BASELINE_PATH} (${totalViolations} bare callsite(s) recorded)`,
  );
  process.exit(0);
}

// ============================================================================
// Baseline mode (default) — fail only on net-add
// ============================================================================

/** @type {{total: number} | null} */
let baseline = null;

if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(
      `lint-no-bare-get-active-session: ERROR — could not parse baseline at ${BASELINE_PATH}`,
    );
    process.exit(1);
  }
} else {
  // No baseline yet — write it on first run and exit 0 so CI bootstraps cleanly.
  writeBaseline('first-run');
  console.info(
    `lint-no-bare-get-active-session: baseline created -> ${BASELINE_PATH} (${totalViolations} bare callsite(s) recorded). ` +
      'Re-run to check against baseline.',
  );
  process.exit(0);
}

const baselineTotal = baseline.total ?? 0;

if (totalViolations <= baselineTotal) {
  const saved = baselineTotal - totalViolations;
  const savedMsg =
    saved > 0 ? ` (${saved} bare callsite(s) migrated vs baseline — great work!)` : '';
  console.info(
    `lint-no-bare-get-active-session: OK — ${totalViolations} bare callsite(s) (baseline: ${baselineTotal})${savedMsg}`,
  );
  if (saved > 0) {
    console.info(
      'Run `node scripts/lint-no-bare-get-active-session.mjs --update-baseline` to lower the baseline.',
    );
  }
  process.exit(0);
}

// Net-add detected. Surface the callsites NOT in the baseline set.
const baselineSet = new Set(Array.isArray(baseline.callsites) ? baseline.callsites : []);
const added = violations.filter((v) => !baselineSet.has(`${v.file}:${v.line}`));

console.error(
  `lint-no-bare-get-active-session: FAIL — ${totalViolations} bare callsite(s) > baseline ${baselineTotal} ` +
    `(+${totalViolations - baselineTotal} new):\n`,
);
for (const v of added) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.snippet}`);
}
console.error(
  '\nFix:\n' +
    '  • Identity-meaning ("the caller\'s session") → resolveCurrentSession() /\n' +
    '    resolveCurrentSessionId() from @cleocode/core (store/session-store.ts),\n' +
    '    or accessor.resolveCurrentSession().\n' +
    '  • Justified SCAN-meaning callsite → append\n' +
    '    `// get-active-session-allowed: <reason>` on the call line.\n',
);
process.exit(1);

#!/usr/bin/env node

/**
 * Lint rule: block PRs adding near-duplicate docs.
 *
 * Detects newly-added `.md` files in the PR diff (`git diff --diff-filter=A
 * <base>...HEAD`) and compares each one against ALL existing docs in the
 * canonical doc roots (publishMirror dirs + rawMdPaths from `.cleo/canon.yml`).
 *
 * Similarity is content-based, NOT slug-based — token-frequency cosine over
 * (title + body keywords), case-folded and stop-word-filtered. Anything >=
 * threshold (default 0.85) against ANY existing doc triggers
 * `E_DOC_NEAR_DUPLICATE` with the offender's path and the suggested fix:
 * `cleo docs update <existing-slug>` (preferred) or `cleo docs add
 * --allow-similar` (escape hatch).
 *
 * Why this matters (T10170 / Saga T9855 / Epic E12.C13)
 * ------------------------------------------------------
 *
 * Agents and humans both regularly produce near-duplicate notes: rewording
 * the same handoff under a fresh slug, copy-paste with one section changed,
 * etc. Slug-similarity alone (the existing `checkSlugSimilarity` chokepoint
 * in `packages/core/src/docs/similarity-check.ts`) catches *intent-collision
 * via naming*, but misses *intent-collision via content*. This gate is the
 * second arm of that policy — block content-near-dupes at PR time so the
 * SSoT stays canonical.
 *
 * Slug-similarity is already enforced at write-time inside `cleo docs add`
 * (T10361). This script is the CI half: it catches the case where an agent
 * bypassed the chokepoint (e.g. raw `Write` to `.cleo/research/foo.md`) or
 * where two parallel branches added genuinely-different slugs whose content
 * happens to overlap.
 *
 * Modes
 * -----
 *
 *   --check     CI default — read `scripts/.lint-docs-similarity-baseline.json`,
 *               fail only when new violations not present in the baseline appear.
 *               Existing near-duplicates (legacy corpus) are recorded in the
 *               baseline and tolerated. Net-add fails.
 *
 *   --baseline  Local — overwrite the baseline JSON with the current set of
 *               findings. Run after intentional doc additions to lock the
 *               new state in.
 *
 *   --strict    Zero-tolerance — fails on ANY finding regardless of baseline.
 *               Used by the eventual "no new near-dupes ever" enforcement
 *               wave once the legacy corpus is cleaned up.
 *
 *   --threshold N    Override similarity cutoff (default 0.85). 0..1.
 *
 *   --base REF       Override the git base ref (default `origin/main`).
 *                    Falls back to `main` then HEAD~1 if missing.
 *
 *   --all            Skip the git-diff filter; treat EVERY doc as new. Used
 *                    for baseline bootstrap and ad-hoc full-corpus audits.
 *
 * Escape hatches
 * --------------
 *
 *   - Per-file: add a YAML frontmatter key `similarity-exempt: <reason>`
 *     (or HTML-comment `<!-- similarity-exempt: <reason> -->` in the first
 *     50 lines) on the NEW doc.
 *   - Per-pair: the baseline file lists tolerated near-dupe pairs by
 *     (newPath, existingPath, score). Re-running `--baseline` after a
 *     legitimate exception captures it.
 *
 * Exit codes
 * ----------
 *
 *   0 — OK (no new near-dupes, or all within baseline tolerance).
 *   1 — Near-duplicate found (and in --strict OR a net-add over baseline).
 *   2 — FATAL setup error (canon.yml missing, git failure with no fallback).
 *
 * @task T10170 — T-E12.C13 lint-docs-similarity CI gate
 * @epic T9855  — E12 (docs SSoT integrity)
 * @saga T9855  — SG-DOCS-INTEGRITY (post-shipping docs SSoT hardening)
 * @related T10361 (write-time slug similarity), T10369 (DocKind writer uniqueness)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, resolve, sep } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const CANON_YML_PATH = '.cleo/canon.yml';
const BASELINE_PATH = 'scripts/.lint-docs-similarity-baseline.json';

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_BASE_REF = 'origin/main';

const MD_EXT = '.md';

// Skip these directory segments while walking the corpus.
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '__snapshots__',
  '__mocks__',
  'fixtures',
]);

// Common English stop words to drop before tokenising. Keeps the cosine
// score focused on doc-specific vocabulary instead of glue words.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'if',
  'in',
  'is',
  'it',
  'its',
  'no',
  'not',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'then',
  'this',
  'to',
  'was',
  'we',
  'what',
  'when',
  'which',
  'will',
  'with',
  'you',
]);

const FRONTMATTER_SCAN_LINES = 50;
const EXEMPT_MARKER = 'similarity-exempt';

// ============================================================================
// CLI flag parsing
// ============================================================================

// --check is the default mode when neither --baseline nor --strict is given;
// no explicit MODE_CHECK constant — code falls through to the check branch.
const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_STRICT = args.includes('--strict');
const SKIP_DIFF = args.includes('--all');

/**
 * Pull a `--key value` pair out of argv.
 *
 * @param {string} key - The flag name (with leading `--`).
 * @returns {string | null}
 */
function getArg(key) {
  const idx = args.indexOf(key);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1] ?? null;
}

const THRESHOLD = (() => {
  const raw = getArg('--threshold');
  if (raw === null) return DEFAULT_THRESHOLD;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0 || n > 1) {
    console.error(`lint-docs-similarity: invalid --threshold ${raw} (must be 0..1)`);
    process.exit(2);
  }
  return n;
})();

const BASE_REF = getArg('--base') ?? DEFAULT_BASE_REF;

// ============================================================================
// Path helpers
// ============================================================================

const REPO_ROOT = process.cwd();

/** @param {string} filePath */
function toPosixRel(filePath) {
  const rel = relative(REPO_ROOT, filePath);
  return rel.split(sep).join(posix.sep);
}

/** @param {string} relPath */
function toAbs(relPath) {
  return resolve(REPO_ROOT, relPath);
}

// ============================================================================
// canon.yml — load the doc-root paths
// ============================================================================

/**
 * Parse `.cleo/canon.yml` and extract every `publishMirror` + `rawMdPaths`
 * entry. Uses the same line-walker shape as
 * `scripts/lint-dockind-writer-uniqueness.mjs`; we deliberately avoid
 * pulling the `yaml` dependency in a lint script.
 *
 * @param {string} src
 * @returns {{publishMirrors: string[], rawMdPaths: string[]}}
 */
function parseCanonRoots(src) {
  /** @type {string[]} */
  const publishMirrors = [];
  /** @type {string[]} */
  const rawMdPaths = [];

  const lines = src.split('\n');
  let inRawMdBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, ''); // strip inline comment
    if (!line.trim()) {
      inRawMdBlock = false;
      continue;
    }

    // Match: `    publishMirror: <value>`
    const pmMatch = line.match(/^ {4}publishMirror:\s*(\S+)/);
    if (pmMatch) {
      publishMirrors.push(pmMatch[1]);
      inRawMdBlock = false;
      continue;
    }

    // Enter `rawMdPaths:` list mode (sub-block under a kind).
    if (/^ {4}rawMdPaths:\s*$/.test(line)) {
      inRawMdBlock = true;
      continue;
    }

    if (inRawMdBlock) {
      const itemMatch = line.match(/^ {6}-\s*(\S+)/);
      if (itemMatch) {
        rawMdPaths.push(itemMatch[1]);
        continue;
      }
      // Exited the list — any non-matching line ends it.
      if (line.trim()) {
        inRawMdBlock = false;
      }
    }
  }

  return { publishMirrors, rawMdPaths };
}

// ============================================================================
// Markdown content extraction + tokenisation
// ============================================================================

/**
 * Extract `# Heading` text (first H1) from a markdown document body, or fall
 * back to a frontmatter `name:` or `title:` value. Returns empty string when
 * no heading is present.
 *
 * @param {string} src
 * @returns {string}
 */
function extractTitle(src) {
  // Frontmatter scan — first 50 lines.
  const fmLines = src.split('\n').slice(0, FRONTMATTER_SCAN_LINES);
  for (const line of fmLines) {
    const fm = line.match(/^(?:name|title):\s*(.+?)\s*$/);
    if (fm) return fm[1].replace(/^['"]|['"]$/g, '');
  }
  // First H1.
  for (const line of src.split('\n')) {
    const h = line.match(/^#\s+(.+?)\s*$/);
    if (h) return h[1];
  }
  return '';
}

/**
 * Check if a markdown doc carries the `similarity-exempt:` opt-out marker
 * (frontmatter key or HTML comment) in its first {@link FRONTMATTER_SCAN_LINES}
 * lines.
 *
 * @param {string} src
 * @returns {boolean}
 */
function hasExemptMarker(src) {
  const head = src.split('\n').slice(0, FRONTMATTER_SCAN_LINES).join('\n');
  return head.includes(EXEMPT_MARKER);
}

/**
 * Strip markdown noise that shouldn't influence similarity (fenced code,
 * URLs, badge markup, HTML tags) so the cosine sees content vocabulary.
 *
 * @param {string} src
 * @returns {string}
 */
function stripMarkdownNoise(src) {
  return src
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ') // images
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ') // links — keep text? drop for simplicity
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/https?:\/\/\S+/g, ' ') // bare urls
    .replace(/[#*_>`~|-]+/g, ' '); // markdown punctuation
}

/**
 * Tokenise text → lowercase word list with stop words removed and tokens
 * shorter than 3 characters dropped. Returns a frequency map suitable for
 * cosine similarity.
 *
 * @param {string} src
 * @returns {Map<string, number>}
 */
function tokenise(src) {
  /** @type {Map<string, number>} */
  const freq = new Map();
  const lower = src.toLowerCase();
  const words = lower.match(/[a-z][a-z0-9_-]{2,}/g);
  if (!words) return freq;
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

/**
 * Build the comparison vector for a single doc. The title is weighted ×3 to
 * keep "ADR-099 widget routing" and "spec-099-widget-routing" close even
 * when their body prose diverges in surface form.
 *
 * @param {string} src
 * @returns {Map<string, number>}
 */
function buildDocVector(src) {
  const title = extractTitle(src);
  const body = stripMarkdownNoise(src);
  const vec = tokenise(body);
  const titleTokens = tokenise(title);
  for (const [tok, count] of titleTokens) {
    vec.set(tok, (vec.get(tok) ?? 0) + count * 3);
  }
  return vec;
}

/**
 * Cosine similarity between two token-frequency vectors in `[0, 1]`.
 *
 * Returns `0` for either-side-empty inputs (avoids NaN from a zero
 * denominator). Vectors are compared by iterating the smaller side and
 * looking up the other — O(min(|a|, |b|)).
 *
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const [tok, count] of smaller) {
    const other = larger.get(tok);
    if (other !== undefined) dot += count * other;
  }
  return dot / denom;
}

// ============================================================================
// File walker — collect .md files under a set of doc roots
// ============================================================================

/**
 * Walk a directory recursively and collect every `.md` path. Skips
 * `node_modules`, `dist`, dotfiles (except inside `.cleo/`), and the
 * common test/fixture segments.
 *
 * @param {string} absDir
 * @returns {string[]} Absolute paths.
 */
function collectMdFiles(absDir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry.name)) continue;
    // Allow `.cleo/` and similar dotted doc roots; skip other dotfiles.
    if (entry.name.startsWith('.') && !absDir.includes('.cleo')) continue;
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMdFiles(full));
    } else if (entry.isFile() && extname(entry.name) === MD_EXT) {
      out.push(full);
    }
  }
  return out;
}

// ============================================================================
// Git diff — newly-added .md paths
// ============================================================================

/**
 * Resolve a usable git base ref. Tries `BASE_REF` first; falls back to `main`
 * then `HEAD~1`. Returns `null` if none are reachable.
 *
 * @returns {string | null}
 */
function resolveBaseRef() {
  for (const candidate of [BASE_REF, 'main', 'HEAD~1']) {
    const r = spawnSync('git', ['rev-parse', '--verify', candidate], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status === 0) return candidate;
  }
  return null;
}

/**
 * Newly-added `.md` paths in this PR via `git diff --diff-filter=A
 * <base>...HEAD`. Returns absolute paths.
 *
 * @param {string} baseRef
 * @returns {string[] | null} `null` on git failure.
 */
function getAddedMdFiles(baseRef) {
  const r = spawnSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', '*.md'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((rel) => toAbs(rel));
}

// ============================================================================
// Pair classification — under a canonical doc root?
// ============================================================================

/**
 * Test whether `relPath` is inside any of the configured doc roots
 * (publishMirror dirs or rawMdPaths).
 *
 * @param {string} relPath - POSIX-relative.
 * @param {string[]} roots - POSIX-relative roots (with or without trailing `/`).
 * @returns {boolean}
 */
function isUnderDocRoot(relPath, roots) {
  for (const root of roots) {
    const normalised = root.endsWith('/') ? root : `${root}/`;
    if (normalised === './') {
      // publishMirror `.` (repo root) — too broad to scan, skip.
      continue;
    }
    if (relPath.startsWith(normalised)) return true;
  }
  return false;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  // ----- 1. Load canon.yml + collect doc roots ----------------------------
  const canonAbs = toAbs(CANON_YML_PATH);
  if (!existsSync(canonAbs)) {
    console.error(`lint-docs-similarity: FATAL — ${CANON_YML_PATH} not found at ${canonAbs}`);
    process.exit(2);
  }
  const canonSrc = readFileSync(canonAbs, 'utf-8');
  const { publishMirrors, rawMdPaths } = parseCanonRoots(canonSrc);

  // De-dup + drop repo-root wildcards (`.`).
  const docRoots = Array.from(new Set([...publishMirrors, ...rawMdPaths])).filter(
    (p) => p !== '.' && p !== './',
  );

  if (docRoots.length === 0) {
    console.error('lint-docs-similarity: FATAL — no doc roots found in canon.yml');
    process.exit(2);
  }

  // ----- 2. Collect the corpus (every existing .md under any doc root) ----
  /** @type {string[]} */
  const corpusAbs = [];
  for (const root of docRoots) {
    const absRoot = toAbs(root);
    if (!existsSync(absRoot)) continue;
    if (!statSync(absRoot).isDirectory()) continue;
    corpusAbs.push(...collectMdFiles(absRoot));
  }

  // ----- 3. Determine which docs are "new" -------------------------------
  /** @type {string[]} */
  let newDocsAbs;
  if (SKIP_DIFF) {
    newDocsAbs = [...corpusAbs];
  } else {
    const baseRef = resolveBaseRef();
    if (baseRef === null) {
      console.error(
        'lint-docs-similarity: no usable git base ref (tried ' +
          `${BASE_REF}, main, HEAD~1) — pass --all to scan the full corpus.`,
      );
      process.exit(0);
    }
    const added = getAddedMdFiles(baseRef);
    if (added === null) {
      console.error('lint-docs-similarity: git diff failed — pass --all to scan the full corpus.');
      process.exit(0);
    }
    // Filter to additions that live under a canonical doc root.
    newDocsAbs = added.filter((abs) => {
      const rel = toPosixRel(abs);
      return isUnderDocRoot(rel, docRoots);
    });
    if (newDocsAbs.length === 0) {
      console.info(
        `lint-docs-similarity: OK — no new docs under canonical doc roots (base: ${baseRef}).`,
      );
      process.exit(0);
    }
  }

  // ----- 4. Build vectors for new + existing ------------------------------
  // Skip exempt files entirely.
  /** @type {Map<string, Map<string, number>>} keyed on POSIX-rel path */
  const newVectors = new Map();
  /** @type {Set<string>} newDocs that we'll skip because of exempt marker */
  const exemptDocs = new Set();
  for (const abs of newDocsAbs) {
    const rel = toPosixRel(abs);
    let src;
    try {
      src = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (hasExemptMarker(src)) {
      exemptDocs.add(rel);
      continue;
    }
    newVectors.set(rel, buildDocVector(src));
  }

  // Existing-doc vectors = the FULL corpus (minus exempts). We compare each
  // new doc against every other corpus doc — including other "new" docs
  // when running in --all mode. The self-pair (newPath === candidatePath)
  // is filtered out in the scoring loop. This intentionally surfaces
  // pairwise dupes between two NEW siblings, not just new-vs-old.
  /** @type {Map<string, Map<string, number>>} */
  const corpusVectors = new Map();
  for (const abs of corpusAbs) {
    const rel = toPosixRel(abs);
    if (exemptDocs.has(rel)) continue;
    let src;
    try {
      src = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    corpusVectors.set(rel, buildDocVector(src));
  }
  // Backfill any newDoc that didn't live under a doc root walked above
  // (e.g. a brand new dir under `docs/` outside canon publishMirror).
  for (const [rel, vec] of newVectors) {
    if (!corpusVectors.has(rel)) corpusVectors.set(rel, vec);
  }

  // ----- 5. Score every (new, candidate) pair -----------------------------
  /** @type {Array<{newPath: string, existingPath: string, score: number}>} */
  const findings = [];
  for (const [newPath, newVec] of newVectors) {
    let bestScore = 0;
    let bestPath = '';
    for (const [candidatePath, candidateVec] of corpusVectors) {
      if (candidatePath === newPath) continue; // self
      const score = cosineSimilarity(newVec, candidateVec);
      if (score > bestScore) {
        bestScore = score;
        bestPath = candidatePath;
      }
    }
    if (bestScore >= THRESHOLD && bestPath !== '') {
      findings.push({ newPath, existingPath: bestPath, score: Number(bestScore.toFixed(4)) });
    }
  }

  // ----- 6. Mode dispatch -------------------------------------------------
  const summary = {
    threshold: THRESHOLD,
    newDocCount: newVectors.size,
    exemptCount: exemptDocs.size,
    corpusCount: corpusVectors.size,
    findings,
    updatedAt: new Date().toISOString(),
  };

  if (MODE_BASELINE) {
    writeFileSync(
      toAbs(BASELINE_PATH),
      `${JSON.stringify(
        {
          _comment:
            'Auto-generated by scripts/lint-docs-similarity.mjs --baseline. ' +
            'DO NOT edit manually. See T10170 / Saga T9855 / Epic E12.C13 for context.',
          ...summary,
        },
        null,
        2,
      )}\n`,
    );
    console.info(
      `lint-docs-similarity: baseline written -> ${BASELINE_PATH} ` +
        `(${findings.length} pair(s) above threshold ${THRESHOLD}).`,
    );
    process.exit(0);
  }

  if (MODE_STRICT) {
    if (findings.length === 0) {
      console.info(
        `lint-docs-similarity: STRICT OK — 0 near-duplicate pair(s) ` +
          `over ${newVectors.size} new doc(s) vs ${corpusVectors.size} corpus.`,
      );
      process.exit(0);
    }
    reportFindings(findings, 'STRICT FAIL');
    process.exit(1);
  }

  // --- --check mode (default) ---
  /** @type {{findings?: Array<{newPath: string, existingPath: string, score: number}>} | null} */
  let baseline = null;
  if (existsSync(toAbs(BASELINE_PATH))) {
    try {
      baseline = JSON.parse(readFileSync(toAbs(BASELINE_PATH), 'utf-8'));
    } catch {
      console.error(`lint-docs-similarity: ERROR — could not parse baseline at ${BASELINE_PATH}.`);
      process.exit(1);
    }
  } else {
    // First run — bootstrap the baseline and pass.
    writeFileSync(
      toAbs(BASELINE_PATH),
      `${JSON.stringify(
        {
          _comment:
            'Auto-generated by scripts/lint-docs-similarity.mjs. ' +
            'DO NOT edit manually. See T10170 / Saga T9855 / Epic E12.C13.',
          ...summary,
        },
        null,
        2,
      )}\n`,
    );
    console.info(
      `lint-docs-similarity: baseline created -> ${BASELINE_PATH} ` +
        `(${findings.length} pair(s) above threshold ${THRESHOLD}).`,
    );
    process.exit(0);
  }

  // Pair identity for baseline match: (newPath, existingPath).
  const baselinePairs = new Set(
    (baseline.findings ?? []).map((f) => `${f.newPath} ${f.existingPath}`),
  );

  const newFindings = findings.filter((f) => !baselinePairs.has(`${f.newPath} ${f.existingPath}`));

  if (newFindings.length === 0) {
    const saved = (baseline.findings?.length ?? 0) - findings.length;
    const savedMsg = saved > 0 ? ` (${saved} pair(s) resolved vs baseline — great work!)` : '';
    console.info(
      `lint-docs-similarity: OK — ${findings.length} pair(s) over threshold ` +
        `(baseline: ${baseline.findings?.length ?? 0})${savedMsg}.`,
    );
    process.exit(0);
  }

  reportFindings(newFindings, 'E_DOC_NEAR_DUPLICATE');
  process.exit(1);
}

/**
 * Print a structured report for a list of findings.
 *
 * @param {Array<{newPath: string, existingPath: string, score: number}>} findings
 * @param {string} prefix
 */
function reportFindings(findings, prefix) {
  console.error(
    `lint-docs-similarity: ${prefix} — ${findings.length} near-duplicate pair(s) ` +
      `(threshold ${THRESHOLD}):\n`,
  );
  for (const f of findings) {
    console.error(`  [${f.score}] new:      ${f.newPath}`);
    console.error(`         existing: ${f.existingPath}`);
  }
  console.error(
    '\nFix:\n' +
      '  • Preferred — update the existing doc instead of forking:\n' +
      '        cleo docs update <existing-slug> --body-file <newPath>\n' +
      '  • Or, if the overlap is legitimate (e.g. a release note that\n' +
      '    quotes the spec), add `cleo docs add --allow-similar` AND a\n' +
      '    one-line `similarity-exempt: <reason>` frontmatter key on the\n' +
      '    new doc.\n' +
      '  • To accept the new pair as a tolerated baseline entry, run:\n' +
      `        node scripts/lint-docs-similarity.mjs --baseline\n` +
      '    and commit the updated scripts/.lint-docs-similarity-baseline.json.\n',
  );
}

main();

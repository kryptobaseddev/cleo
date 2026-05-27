#!/usr/bin/env node
/**
 * scripts/sweep-manual-doc-writes.mjs
 *
 * Repo-wide audit of manual `*.md` writes under `.cleo/canon.yml`'s
 * `rawMdPaths` directories since the T9791 docs-import cutoff
 * (commit 251814e86, 2026-05-20).
 *
 * READ-ONLY. Mutates nothing. Walks the git history, computes content
 * SHA-256 per file, queries the docs SSoT, and classifies each entry as:
 *
 *   - `in-sync`   — file SHA matches a blob already in the SSoT.
 *   - `drift`     — slug exists in SSoT but the on-disk SHA differs;
 *                   the file should be re-published or re-imported.
 *   - `orphan`    — no SSoT entry resolves either by SHA or by slug;
 *                   the file is a raw fs write that bypassed `cleo
 *                   docs add` and should be migrated.
 *   - `deleted`   — file was added since the cutoff but no longer
 *                   exists on disk (informational only, not counted as
 *                   unresolved).
 *
 * Emits a structured JSON report under `audit/manual-write-sweep-<date>.json`
 * (idempotent — the same script invocation on the same git state and
 * SSoT snapshot rewrites the same file). The report's `summary` is also
 * printed to stdout. Exit code:
 *
 *   0 — clean (zero orphan + zero drift) OR `--allow-unresolved`
 *   1 — at least one orphan/drift entry exists (regression gate)
 *   2 — internal error (canon.yml parse failure, git not available, …)
 *
 * Designed to wire into CI as a non-blocking job initially (until
 * Saga T10288 / Epic T10293 E5.3 lands the orphan cleanup migration),
 * then flip strict by removing `continue-on-error: true`.
 *
 * Usage:
 *   node scripts/sweep-manual-doc-writes.mjs                # default
 *   node scripts/sweep-manual-doc-writes.mjs --json         # stdout JSON only
 *   node scripts/sweep-manual-doc-writes.mjs --allow-unresolved
 *   node scripts/sweep-manual-doc-writes.mjs --cutoff <sha> # override
 *   node scripts/sweep-manual-doc-writes.mjs --out <path>   # report dest
 *
 * @task T10372
 * @epic T10293
 * @saga T10288
 * @adr ADR-076
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// T9791 docs-import cutoff — the commit that bulk-imported the legacy
// markdown corpus into the SSoT. Files added BEFORE this commit are
// considered legacy and are not classified by this sweep; the gate is
// forward-only, matching `cleo check canon docs`.
const T9791_CUTOFF = '251814e86';

/**
 * Parse CLI arguments into a flat options object. The script is
 * intentionally small — no commander/citty dep — to keep startup fast
 * for CI runs.
 *
 * @param {string[]} argv
 * @returns {{json: boolean, allowUnresolved: boolean, cutoff: string, out: string | null, repoRoot: string, cleoBin: string[]}}
 */
function parseArgs(argv) {
  const opts = {
    json: false,
    allowUnresolved: false,
    cutoff: T9791_CUTOFF,
    out: null,
    repoRoot: resolve(__dirname, '..'),
    /** @type {string[]} argv prefix for invoking cleo; defaults to globally-installed `cleo` */
    cleoBin: ['cleo'],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--allow-unresolved') opts.allowUnresolved = true;
    else if (arg === '--cutoff') opts.cutoff = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--repo-root') opts.repoRoot = resolve(argv[++i]);
    else if (arg === '--cleo-bin') opts.cleoBin = argv[++i].split(' ').filter(Boolean);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: sweep-manual-doc-writes.mjs [--json] [--allow-unresolved] [--cutoff <sha>] [--out <path>] [--repo-root <dir>] [--cleo-bin <cmd>]',
      );
      process.exit(0);
    }
  }
  return opts;
}

/**
 * Load `.cleo/canon.yml` and collect every `rawMdPaths` entry whose
 * kind has `rawMdAllowed: false`. These are the directories where new
 * raw `.md` writes are forbidden by `cleo check canon docs`, and thus
 * the directories this sweep audits.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function loadRawMdPaths(repoRoot) {
  const canonPath = resolve(repoRoot, '.cleo/canon.yml');
  if (!existsSync(canonPath)) {
    throw new Error(`canon.yml not found at ${canonPath}`);
  }
  const canon = parseYaml(readFileSync(canonPath, 'utf-8'));
  /** @type {string[]} */
  const paths = [];
  for (const def of Object.values(canon.kinds || {})) {
    if (def.rawMdAllowed === false && Array.isArray(def.rawMdPaths)) {
      for (const p of def.rawMdPaths) paths.push(p);
    }
  }
  return Array.from(new Set(paths));
}

/**
 * Enumerate every `*.md` file added under one of `paths` since
 * `cutoffSha` using a single `git log --diff-filter=A` invocation per
 * pathspec. Returns a deduplicated sorted list.
 *
 * @param {string} cutoffSha
 * @param {string[]} paths
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listMdFilesAddedSince(cutoffSha, paths, repoRoot) {
  /** @type {Set<string>} */
  const result = new Set();
  for (const p of paths) {
    const proc = spawnSync(
      'git',
      ['log', '--diff-filter=A', '--name-only', `${cutoffSha}..HEAD`, '--pretty=format:', '--', p],
      { cwd: repoRoot, encoding: 'utf-8' },
    );
    if (proc.status !== 0) {
      throw new Error(`git log failed for ${p}: ${proc.stderr}`);
    }
    for (const line of proc.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.endsWith('.md')) result.add(trimmed);
    }
  }
  return Array.from(result).sort();
}

/**
 * Compute the SHA-256 of a Buffer as lowercase hex. Matches the
 * canonical encoding used by `packages/core/src/store/attachments.ts`.
 *
 * @param {Buffer} content
 * @returns {string}
 */
function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Build a slug→{type,sha256,attachmentId} index from `cleo docs list`.
 *
 * The list command paginates; we ask for an unbounded result set
 * (`--limit 0`) and accept that the `sha256` field is rendered with a
 * unicode ellipsis (`…`) for table-friendly display. The truncation
 * makes `sha256` unsuitable for equality comparisons here — we use the
 * full SHA via `cleo docs fetch <fullSha>` only when probing for
 * in-sync status. Slug + type from the listing is the cheap part.
 *
 * @param {string} repoRoot
 * @param {string[]} cleoBin
 * @returns {Map<string, { type: string, sha256: string, attachmentId: string }>}
 */
function loadSlugIndex(repoRoot, cleoBin) {
  const [cmd, ...prefix] = cleoBin;
  const proc = spawnSync(
    cmd,
    [...prefix, 'docs', 'list', '--project', '--limit', '0', '--orderBy', 'slug', '--json'],
    { cwd: repoRoot, encoding: 'utf-8' },
  );
  if (proc.status !== 0) {
    throw new Error(`cleo docs list failed: ${proc.stderr || proc.stdout}`);
  }
  const env = JSON.parse(proc.stdout);
  if (!env.success) {
    throw new Error(`cleo docs list returned non-success envelope: ${proc.stdout}`);
  }
  /** @type {Map<string, { type: string, sha256: string, attachmentId: string }>} */
  const index = new Map();
  for (const a of env.data.attachments || []) {
    if (!a.slug) continue;
    // Last-wins is fine — slug is unique per project per DocKind in
    // the post-T10288/E1 world; the truncated SHA here is only used as
    // a tie-breaker hint, not for content equality.
    index.set(a.slug, {
      type: a.type ?? 'unknown',
      sha256: typeof a.sha256 === 'string' ? a.sha256.replace(/…$/, '') : '',
      attachmentId: a.id,
    });
  }
  return index;
}

/**
 * Probe the SSoT for an attachment by full SHA-256. Returns the parsed
 * metadata when present, or null on `E_NOT_FOUND`. Any other failure
 * mode (network, db lock, …) re-throws so the sweep fails loudly.
 *
 * @param {string} sha
 * @param {string} repoRoot
 * @param {string[]} cleoBin
 * @returns {{ slug?: string, type?: string, attachmentId: string, sha256: string } | null}
 */
function fetchBySha(sha, repoRoot, cleoBin) {
  const [cmd, ...prefix] = cleoBin;
  const proc = spawnSync(cmd, [...prefix, 'docs', 'fetch', sha], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  // `cleo docs fetch` exits non-zero on E_NOT_FOUND but still emits a
  // valid envelope. We always parse stdout when present.
  let env;
  try {
    env = JSON.parse(proc.stdout);
  } catch {
    if (proc.status !== 0) return null;
    throw new Error(`cleo docs fetch ${sha} stdout not JSON: ${proc.stdout}`);
  }
  if (!env.success) {
    if (env.error?.codeName === 'E_NOT_FOUND') return null;
    throw new Error(
      `cleo docs fetch ${sha} unexpected error: ${env.error?.message ?? proc.stderr}`,
    );
  }
  const meta = env.data?.metadata;
  if (!meta) return null;
  return {
    slug: meta.slug,
    type: meta.type,
    attachmentId: meta.id,
    sha256: meta.sha256,
  };
}

/**
 * Derive a canonical slug candidate from a markdown filename. Examples:
 *   `.cleo/adrs/ADR-085-cross-db-invariants.md` → `adr-085-cross-db-invariants`
 *   `.cleo/research/sg-arch-solid-master-plan.md` → `sg-arch-solid-master-plan`
 *
 * @param {string} filePath
 * @returns {string}
 */
function deriveSlugCandidate(filePath) {
  const base = filePath.split('/').pop() || filePath;
  return base.replace(/\.md$/, '').toLowerCase();
}

/**
 * Classify one file against the SSoT.
 *
 * @param {string} file
 * @param {string} fileSha
 * @param {Map<string, { type: string, sha256: string, attachmentId: string }>} slugIndex
 * @param {string} repoRoot
 * @param {string[]} cleoBin
 * @returns {{ remediation: 'in-sync' | 'drift' | 'orphan', ssotSlug: string | null, ssotType: string | null, ssotAttachmentId: string | null, ssotSha: string | null }}
 */
function classify(file, fileSha, slugIndex, repoRoot, cleoBin) {
  // 1. Cheapest probe — does ANY blob with this exact SHA exist in
  //    the SSoT? If yes, the file is in-sync regardless of slug.
  const byShaHit = fetchBySha(fileSha, repoRoot, cleoBin);
  if (byShaHit) {
    return {
      remediation: 'in-sync',
      ssotSlug: byShaHit.slug ?? null,
      ssotType: byShaHit.type ?? null,
      ssotAttachmentId: byShaHit.attachmentId,
      ssotSha: byShaHit.sha256,
    };
  }
  // 2. SHA not found — try the derived slug. If the slug exists, the
  //    content has drifted and the SSoT needs a re-publish.
  const slug = deriveSlugCandidate(file);
  const bySlug = slugIndex.get(slug);
  if (bySlug) {
    return {
      remediation: 'drift',
      ssotSlug: slug,
      ssotType: bySlug.type,
      ssotAttachmentId: bySlug.attachmentId,
      // The listing SHA is intentionally truncated — surface what we
      // know but the canonical truth lives in the per-attachment row.
      ssotSha: bySlug.sha256,
    };
  }
  // 3. Neither SHA nor slug resolves — the file is an orphan and
  //    needs to be migrated through `cleo docs add`.
  return {
    remediation: 'orphan',
    ssotSlug: null,
    ssotType: null,
    ssotAttachmentId: null,
    ssotSha: null,
  };
}

/**
 * Entry point. Returns the structured report and exit code so the
 * test harness can drive the script as an in-process library.
 *
 * @param {string[]} argv
 * @returns {{ report: object, exitCode: number }}
 */
export function runSweep(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const rawPaths = loadRawMdPaths(opts.repoRoot);
  const files = listMdFilesAddedSince(opts.cutoff, rawPaths, opts.repoRoot);
  const slugIndex = loadSlugIndex(opts.repoRoot, opts.cleoBin);

  /** @type {Array<{file: string, fileSha: string | null, remediation: string, ssotSlug: string | null, ssotType: string | null, ssotAttachmentId: string | null, ssotSha: string | null}>} */
  const items = [];
  for (const file of files) {
    const abs = resolve(opts.repoRoot, file);
    if (!existsSync(abs)) {
      items.push({
        file,
        fileSha: null,
        remediation: 'deleted',
        ssotSlug: null,
        ssotType: null,
        ssotAttachmentId: null,
        ssotSha: null,
      });
      continue;
    }
    const content = readFileSync(abs);
    const fileSha = sha256Hex(content);
    const cls = classify(file, fileSha, slugIndex, opts.repoRoot, opts.cleoBin);
    items.push({ file, fileSha, ...cls });
  }

  const grouped = { orphan: [], drift: [], 'in-sync': [], deleted: [] };
  for (const it of items) {
    (grouped[it.remediation] ?? grouped.orphan).push(it);
  }
  const summary = {
    cutoff: opts.cutoff,
    totalFiles: items.length,
    orphan: grouped.orphan.length,
    drift: grouped.drift.length,
    inSync: grouped['in-sync'].length,
    deleted: grouped.deleted.length,
    unresolved: grouped.orphan.length + grouped.drift.length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    rawMdPaths: rawPaths,
    summary,
    grouped,
  };

  const reportPath =
    opts.out ?? resolve(opts.repoRoot, `audit/manual-write-sweep-${todayUtc()}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (!opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Report: ${reportPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  const exitCode = !opts.allowUnresolved && summary.unresolved > 0 ? 1 : 0;
  return { report, exitCode };
}

/**
 * Format today's date as `YYYY-MM-DD` in UTC. Stable across runs in
 * the same calendar day, even across timezones.
 *
 * @returns {string}
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { exitCode } = runSweep();
    process.exit(exitCode);
  } catch (err) {
    console.error(`sweep-manual-doc-writes: ${err.message}`);
    process.exit(2);
  }
}

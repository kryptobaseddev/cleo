#!/usr/bin/env node
/**
 * pre-commit-docs-drift — advisory hook that warns when a staged Markdown
 * file is registered in the docs-publications ledger but its on-disk content
 * has drifted from the SSoT blob recorded under `docs_publications` in the
 * project `cleo.db` (T13362).
 *
 * Triggered by `simple-git-hooks` on every `pre-commit` event. Designed for
 * sub-200ms execution on the staged-file fast-path (zero work when no
 * staged file is in the ledger).
 *
 * Ledger read (T13362)
 * --------------------
 * The ledger lives in the `docs_publications` table of `.cleo/cleo.db`. The
 * hook opens the DB read-only via `node:sqlite` (no migrations run, no
 * writes, no lock contention) and indexes rows by `published_path`. When the
 * table is absent (older store) or holds zero rows, the hook falls back to
 * the deprecated `.cleo/docs-publications.json` — mirroring the core
 * seed shim so drift is caught before AND after the one-time seed.
 *
 * Behaviour
 * ---------
 * 1. Read the staged `.md` paths via `git diff --cached --name-only --diff-filter=ACMR`.
 * 2. Load the ledger (store table first, legacy JSON fallback). No rows → exit 0 (no-op).
 * 3. For each staged path that matches a `publishedPath` in the ledger:
 *      - Hash the on-disk bytes.
 *      - Compare against `lastBlobSha`.
 *      - Mismatch → emit an ADVISORY hint with the exact `cleo docs sync`
 *        invocation needed to update the SSoT blob.
 * 4. Exit 0 by default — this hook NEVER blocks a commit.
 *
 * Strict mode
 * -----------
 * When `CLEO_STRICT_DOCS_DRIFT=1` is set in the environment, the hook exits
 * with code 1 on any drift — useful for release-prep branches where
 * unsynced docs should be a blocker before tagging.
 *
 * Bypass
 * ------
 * `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON="<reason>"` bypasses
 * the strict gate AND appends an audit row to `.cleo/audit/force-bypass.jsonl`.
 * In advisory mode the bypass is a no-op (nothing to bypass).
 *
 * Exit codes
 * ----------
 *   0 — no drift, OR drift detected in advisory mode (default)
 *   1 — drift detected with CLEO_STRICT_DOCS_DRIFT=1 set
 *
 * @task T9645
 * @task T13362 (ledger moved into cleo.db)
 * @epic T9630
 * @saga T9625
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STRICT = process.env.CLEO_STRICT_DOCS_DRIFT === '1';
const OWNER_OVERRIDE = process.env.CLEO_OWNER_OVERRIDE === '1';
const OWNER_OVERRIDE_REASON = process.env.CLEO_OWNER_OVERRIDE_REASON ?? '';

function projectRoot() {
  // Repo root is git's top-level when invoked from any subdir.
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) process.exit(0);
  return r.stdout.trim();
}

function stagedMarkdownPaths(root) {
  // ACMR — Added, Copied, Modified, Renamed (skip Deleted; nothing to sync).
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: root,
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase().endsWith('.md'));
}

/**
 * Load the ledger rows from the `docs_publications` store table, falling
 * back to the deprecated JSON sidecar when the table is absent or empty
 * (mirrors the core seed shim, T13362).
 *
 * @param root - Project root (git top-level).
 * @returns Ledger rows shaped like the legacy JSON entries.
 */
function loadLedger(root) {
  const fromStore = loadLedgerFromStore(root);
  if (fromStore.length > 0) return fromStore;
  return loadLedgerFromLegacyJson(root);
}

/**
 * Read `docs_publications` rows from `.cleo/cleo.db` read-only.
 *
 * Opens the DB with `readOnly: true` so the hook never migrates, writes, or
 * contends with a live writer; any failure (no DB, pre-T13362 schema, busy)
 * yields an empty list and the caller falls back to the legacy JSON.
 */
function loadLedgerFromStore(root) {
  const dbPath = join(root, '.cleo', 'cleo.db');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        'SELECT owner_id AS ownerId, blob_name AS blobName, published_path AS publishedPath, ' +
          'last_blob_sha AS lastBlobSha, published_at AS publishedAt FROM docs_publications',
      )
      .all();
    return rows.filter(
      (r) =>
        r &&
        typeof r.ownerId === 'string' &&
        typeof r.blobName === 'string' &&
        typeof r.publishedPath === 'string' &&
        typeof r.lastBlobSha === 'string',
    );
  } catch {
    // Table absent (older store schema) — the legacy JSON fallback applies.
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* closing is best-effort */
    }
  }
}

/** Read the deprecated `.cleo/docs-publications.json` sidecar (legacy shim). */
function loadLedgerFromLegacyJson(root) {
  const path = join(root, '.cleo', 'docs-publications.json');
  try {
    const data = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) {
      return parsed.rows;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return parsed.entries;
    }
    return [];
  } catch {
    return [];
  }
}

function sha256(path) {
  try {
    const data = readFileSync(path);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function appendBypassAudit(root, payload) {
  try {
    const dir = join(root, '.cleo', 'audit');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'force-bypass.jsonl'), `${JSON.stringify(payload)}\n`, 'utf-8');
  } catch {
    /* audit failures must NEVER block a commit */
  }
}

function main() {
  const root = projectRoot();
  const staged = stagedMarkdownPaths(root);
  if (staged.length === 0) process.exit(0);

  const ledger = loadLedger(root);
  if (ledger.length === 0) process.exit(0);

  // Index ledger by publishedPath for O(1) lookup.
  const byPath = new Map();
  for (const row of ledger) {
    if (row && typeof row.publishedPath === 'string') {
      byPath.set(row.publishedPath, row);
    }
  }
  if (byPath.size === 0) process.exit(0);

  const drifts = [];
  for (const rel of staged) {
    const row = byPath.get(rel);
    if (!row) continue;
    const abs = isAbsolute(rel) ? rel : resolve(root, rel);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    const fileSha = sha256(abs);
    if (fileSha === null) continue;
    if (fileSha !== row.lastBlobSha) {
      drifts.push({
        publishedPath: rel,
        ownerId: row.ownerId,
        blobName: row.blobName,
        fileSha,
        blobSha: row.lastBlobSha,
      });
    }
  }

  if (drifts.length === 0) process.exit(0);

  // Emit advisory message to stderr — visible but does not block.
  process.stderr.write('\n');
  process.stderr.write('[docs-drift] CLEO docs SSoT drift detected on staged files:\n\n');
  for (const d of drifts) {
    process.stderr.write(`  - ${d.publishedPath}\n`);
    process.stderr.write(`      owner    : ${d.ownerId}\n`);
    process.stderr.write(`      blobSha  : ${d.blobSha?.slice(0, 12) ?? '(none)'}\n`);
    process.stderr.write(`      fileSha  : ${d.fileSha.slice(0, 12)}\n`);
    process.stderr.write(
      `      sync     : cleo docs sync --from ${d.publishedPath} --for ${d.ownerId} --name ${d.blobName}\n\n`,
    );
  }
  process.stderr.write(
    '[docs-drift] Tip: run `cleo docs sync --from <path> --for <ownerId> --name <blobName>` to update the SSoT blob before committing.\n',
  );

  if (!STRICT) {
    process.stderr.write(
      '[docs-drift] Advisory only — commit allowed (set CLEO_STRICT_DOCS_DRIFT=1 to enforce).\n\n',
    );
    process.exit(0);
  }

  // STRICT mode — block unless owner override.
  if (OWNER_OVERRIDE) {
    if (!OWNER_OVERRIDE_REASON || OWNER_OVERRIDE_REASON.trim().length === 0) {
      process.stderr.write(
        '[docs-drift] CLEO_OWNER_OVERRIDE=1 set but CLEO_OWNER_OVERRIDE_REASON is empty — blocking.\n',
      );
      process.exit(1);
    }
    appendBypassAudit(root, {
      ts: new Date().toISOString(),
      hook: 'pre-commit-docs-drift',
      reason: OWNER_OVERRIDE_REASON,
      drifts: drifts.map((d) => d.publishedPath),
    });
    process.stderr.write(
      `[docs-drift] Owner override accepted — bypass logged (reason: "${OWNER_OVERRIDE_REASON}").\n\n`,
    );
    process.exit(0);
  }

  process.stderr.write('[docs-drift] CLEO_STRICT_DOCS_DRIFT=1 set — refusing to commit.\n\n');
  process.exit(1);
}

main();

#!/usr/bin/env node
/**
 * pre-commit-docs-drift — advisory hook that warns when a staged Markdown
 * file is registered in the docs-publications ledger but its on-disk content
 * has drifted from the SSoT blob recorded under `.cleo/docs-publications.json`.
 *
 * Triggered by `simple-git-hooks` on every `pre-commit` event. Designed for
 * sub-200ms execution on the staged-file fast-path (zero work when no
 * staged file is in the ledger).
 *
 * Behaviour
 * ---------
 * 1. Read the staged `.md` paths via `git diff --cached --name-only --diff-filter=ACMR`.
 * 2. Load `.cleo/docs-publications.json` (ledger). No ledger → exit 0 (no-op).
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
 * @epic T9630
 * @saga T9625
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

function loadLedger(root) {
  const path = join(root, '.cleo', 'docs-publications.json');
  try {
    const data = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) {
      return parsed.rows;
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

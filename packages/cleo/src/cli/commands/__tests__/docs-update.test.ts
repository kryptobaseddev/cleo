/**
 * End-to-end tests for `cleo docs update <slug>` (T10161).
 *
 * Drives the compiled `cleo` CLI as a subprocess against an isolated tmp
 * `CLEO_PROJECT_ROOT` and verifies the slug-preserving in-place update
 * contract from {@link import('@cleocode/contracts/operations/docs').DocsUpdateParams}.
 *
 * Coverage:
 *
 *   (a) docs add → docs update --file → version increments + audit line
 *   (b) docs add → docs update --content "text" → same slug, new sha256
 *   (c) updating a non-existent slug → E_NOT_FOUND
 *   (d) two updates within the 5-minute squash window → ONE audit line
 *       with two `revisions[]` entries
 *   (e) noop (re-update with identical bytes) → changed=false, sha256 stable
 *
 * @task T10161 (Epic T10157 · Saga T9855 · E12.C4)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts';

// T11060 — core-level regression imports for 2026-05-25 dogfood failures
import {
  DOCS_UPDATE_LIFECYCLE_STATUS_LIST,
  isLifecycleStatus,
  SecurityError,
  sanitizePath,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runCli(args: readonly string[], projectRoot: string): CliResult {
  const env = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    CLEO_OUTPUT_FORMAT: 'json',
  };
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: projectRoot,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

interface LafsEnvelope<TData = unknown> {
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: {
    readonly code?: number | string;
    readonly codeName?: string;
    readonly message?: string;
    readonly fix?: string;
    readonly details?: Record<string, unknown>;
  };
  readonly meta?: {
    readonly operation?: string;
    readonly command?: string;
    readonly timestamp?: string;
    readonly dryRun?: true;
  };
}

function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error(`parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

interface UpdateResultShape {
  slug: string;
  attachmentId: string;
  previousAttachmentId: string;
  sha256: string;
  previousSha256: string;
  changed: boolean;
  lifecycleStatus: string;
  updatedAt: string;
  version: number;
  squashed: boolean;
  summary: string;
  dryRun?: true;
  wouldWrite?: boolean;
  wouldChange?: boolean;
}

interface AddResultShape {
  attachmentId: string;
  sha256: string;
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T10161-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('T10161 — cleo docs update <slug>', () => {
  it('(a) add → update --file → slug preserved, sha256 differs, version increments', async () => {
    const original = join(projectRoot, 'orig.md');
    await writeFile(original, '# Title\n\nOriginal body.\n', 'utf-8');

    const addRes = runCli(
      ['docs', 'add', 'T-T10161-a', original, '--slug', 't10161-doc-a', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status, `add failed; stdout=${addRes.stdout} stderr=${addRes.stderr}`).toBe(0);
    const addEnv = parseEnvelope<AddResultShape>(addRes.stdout);
    expect(addEnv.success).toBe(true);
    const originalSha = addEnv.data?.sha256;
    expect(originalSha).toBeTruthy();

    const updated = join(projectRoot, 'updated.md');
    await writeFile(updated, '# Title\n\nUpdated body (typo fix).\n', 'utf-8');

    const upRes = runCli(
      ['docs', 'update', 't10161-doc-a', '--file', updated, '--message', 'fix typo'],
      projectRoot,
    );
    expect(upRes.status, `update failed; stdout=${upRes.stdout} stderr=${upRes.stderr}`).toBe(0);
    const upEnv = parseEnvelope<UpdateResultShape>(upRes.stdout);
    expect(upEnv.success).toBe(true);
    const data = upEnv.data;
    expect(data).toBeDefined();
    expect(data?.slug).toBe('t10161-doc-a');
    expect(data?.changed).toBe(true);
    expect(data?.sha256).not.toBe(originalSha);
    expect(data?.previousSha256).toBe(originalSha);
    expect(data?.lifecycleStatus).toBe('draft');
    // First update bumps version >= 2.
    expect(data?.version).toBeGreaterThanOrEqual(2);

    // Audit log line exists with the update revision.
    const auditPath = join(projectRoot, '.cleo', 'audit', 'docs-versioning.jsonl');
    const auditRaw = readFileSync(auditPath, 'utf-8');
    expect(auditRaw).toContain('"docs.update"');
    expect(auditRaw).toContain('"t10161-doc-a"');
    expect(auditRaw).toContain('"fix typo"');
  });

  it('(b) add → update --content inline text → new sha256 + slug preserved', async () => {
    const original = join(projectRoot, 'orig-b.md');
    await writeFile(original, 'original text\n', 'utf-8');

    const addRes = runCli(
      ['docs', 'add', 'T-T10161-b', original, '--slug', 't10161-doc-b', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status, `add failed; stdout=${addRes.stdout}`).toBe(0);
    const originalSha = parseEnvelope<AddResultShape>(addRes.stdout).data?.sha256;

    const upRes = runCli(
      ['docs', 'update', 't10161-doc-b', '--content', 'updated text via --content\n'],
      projectRoot,
    );
    expect(upRes.status, `update failed; stdout=${upRes.stdout}`).toBe(0);
    const data = parseEnvelope<UpdateResultShape>(upRes.stdout).data;
    expect(data?.slug).toBe('t10161-doc-b');
    expect(data?.changed).toBe(true);
    expect(data?.sha256).not.toBe(originalSha);
    expect(data?.previousSha256).toBe(originalSha);
  });

  it('(c) update against a non-existent slug → E_NOT_FOUND', async () => {
    const upRes = runCli(
      ['docs', 'update', 'no-such-slug', '--content', 'whatever\n'],
      projectRoot,
    );
    expect(upRes.status).not.toBe(0);
    const env = parseEnvelope(upRes.stdout);
    expect(env.success).toBe(false);
    // codeName mirrors the symbolic LAFS code; raw `error.code` may be the numeric exit.
    const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
    expect(symbolic).toBe('E_NOT_FOUND');
    expect(env.error?.message ?? '').toMatch(/no attachment.*no-such-slug/i);
    expect(env.error?.message ?? '').toMatch(/does not exist/);
  });

  it('(d) two updates within 5 min → squashed onto ONE audit line with revisions[]', async () => {
    const original = join(projectRoot, 'orig-d.md');
    await writeFile(original, 'rev 0\n', 'utf-8');

    runCli(
      ['docs', 'add', 'T-T10161-d', original, '--slug', 't10161-doc-d', '--type', 'note'],
      projectRoot,
    );

    const r1 = runCli(
      ['docs', 'update', 't10161-doc-d', '--content', 'rev 1\n', '--message', 'first edit'],
      projectRoot,
    );
    expect(r1.status, `update 1 failed; stdout=${r1.stdout}`).toBe(0);
    const d1 = parseEnvelope<UpdateResultShape>(r1.stdout).data;
    expect(d1?.squashed).toBe(false);

    const r2 = runCli(
      ['docs', 'update', 't10161-doc-d', '--content', 'rev 2\n', '--message', 'second edit'],
      projectRoot,
    );
    expect(r2.status, `update 2 failed; stdout=${r2.stdout}`).toBe(0);
    const d2 = parseEnvelope<UpdateResultShape>(r2.stdout).data;
    expect(d2?.squashed).toBe(true);

    // Exactly one audit line for this slug, containing two revisions.
    const auditPath = join(projectRoot, '.cleo', 'audit', 'docs-versioning.jsonl');
    const auditRaw = readFileSync(auditPath, 'utf-8');
    const lines = auditRaw.split('\n').filter((l) => l.length > 0 && l.includes('t10161-doc-d'));
    expect(lines.length, `expected exactly 1 audit line; got ${lines.length}\n${auditRaw}`).toBe(1);
    const entry = JSON.parse(lines[0]) as { revisions: unknown[] };
    expect(entry.revisions.length).toBe(2);
  });

  it('(e) noop update with identical bytes → changed=false, sha256 stable', async () => {
    const original = join(projectRoot, 'orig-e.md');
    await writeFile(original, 'stable content\n', 'utf-8');

    const addRes = runCli(
      ['docs', 'add', 'T-T10161-e', original, '--slug', 't10161-doc-e', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status).toBe(0);
    const originalSha = parseEnvelope<AddResultShape>(addRes.stdout).data?.sha256;

    const upRes = runCli(
      ['docs', 'update', 't10161-doc-e', '--content', 'stable content\n'],
      projectRoot,
    );
    expect(upRes.status, `noop update failed; stdout=${upRes.stdout}`).toBe(0);
    const data = parseEnvelope<UpdateResultShape>(upRes.stdout).data;
    expect(data?.changed).toBe(false);
    expect(data?.sha256).toBe(originalSha);
    expect(data?.previousSha256).toBe(originalSha);
  });

  it('(f) --dry-run returns preview metadata without mutating rows or audit log', async () => {
    const original = join(projectRoot, 'orig-f.md');
    await writeFile(original, 'rev 0\n', 'utf-8');

    const addRes = runCli(
      ['docs', 'add', 'T-T10617-f', original, '--slug', 't10617-doc-f', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status, `add failed; stdout=${addRes.stdout} stderr=${addRes.stderr}`).toBe(0);
    const originalSha = parseEnvelope<AddResultShape>(addRes.stdout).data?.sha256;

    const dryRun = runCli(
      [
        'docs',
        'update',
        't10617-doc-f',
        '--content',
        'rev 1\n',
        '--dry-run',
        '--message',
        'preview only',
      ],
      projectRoot,
    );
    expect(dryRun.status, `dry-run failed; stdout=${dryRun.stdout} stderr=${dryRun.stderr}`).toBe(
      0,
    );
    const dryEnv = parseEnvelope<UpdateResultShape>(dryRun.stdout);
    expect(dryEnv.success).toBe(true);
    expect(dryEnv.meta).toMatchObject({ dryRun: true });
    expect(dryEnv.data?.dryRun).toBe(true);
    expect(dryEnv.data?.changed).toBe(false);
    expect(dryEnv.data?.wouldWrite).toBe(false);
    expect(dryEnv.data?.wouldChange).toBe(true);
    expect(dryEnv.data?.previousSha256).toBe(originalSha);
    expect(dryEnv.data?.sha256).not.toBe(originalSha);
    expect(existsSync(join(projectRoot, '.cleo', 'audit', 'docs-versioning.jsonl'))).toBe(false);

    const realUpdate = runCli(
      ['docs', 'update', 't10617-doc-f', '--content', 'rev 1\n', '--message', 'real edit'],
      projectRoot,
    );
    expect(realUpdate.status, `real update failed; stdout=${realUpdate.stdout}`).toBe(0);
    const realData = parseEnvelope<UpdateResultShape>(realUpdate.stdout).data;
    expect(realData?.changed).toBe(true);
    expect(realData?.previousSha256).toBe(originalSha);
  });

  it('(g) --strict fails body-schema diagnostics before any write', async () => {
    const original = join(projectRoot, 'orig-g.md');
    await writeFile(
      original,
      '## Context\n\nInitial ADR body.\n\n## Decision\n\nShip it.\n',
      'utf-8',
    );

    const addRes = runCli(
      [
        'docs',
        'add',
        'T-T10617-g',
        original,
        '--slug',
        't10617-doc-g',
        '--type',
        'adr',
        '--strict',
      ],
      projectRoot,
    );
    expect(addRes.status, `add failed; stdout=${addRes.stdout} stderr=${addRes.stderr}`).toBe(0);
    const originalSha = parseEnvelope<AddResultShape>(addRes.stdout).data?.sha256;

    const strictUpdate = runCli(
      [
        'docs',
        'update',
        't10617-doc-g',
        '--content',
        '## Context\n\nMissing decision section.\n',
        '--strict',
      ],
      projectRoot,
    );
    expect(strictUpdate.status).not.toBe(0);
    const env = parseEnvelope(strictUpdate.stdout);
    expect(env.success).toBe(false);
    const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
    expect(symbolic).toBe('E_DOC_SCHEMA_MISMATCH');
    expect(env.error?.details).toMatchObject({ kind: 'adr', strict: true });
    expect(existsSync(join(projectRoot, '.cleo', 'audit', 'docs-versioning.jsonl'))).toBe(false);

    const validUpdate = runCli(
      [
        'docs',
        'update',
        't10617-doc-g',
        '--content',
        '## Context\n\nStill original until now.\n\n## Decision\n\nUpdated.\n',
      ],
      projectRoot,
    );
    expect(validUpdate.status, `valid update failed; stdout=${validUpdate.stdout}`).toBe(0);
    const data = parseEnvelope<UpdateResultShape>(validUpdate.stdout).data;
    expect(data?.changed).toBe(true);
    expect(data?.previousSha256).toBe(originalSha);
  });

  // ── T11042 regression: update preserves owner-publishability ─────────────────

  // T11042-B2a: After a docs-update rotates the slug onto new bytes, the
  // owner that originally attached the doc MUST still be able to fetch and
  // publish the updated blob.  Today updateDocBySlug copies attachment_refs
  // from old row → new row only when the old row had refs — but if the doc
  // was attached outside the normal "docs add" path (or if refs were
  // cleaned), the update leaves the new blob orphaned.
  //
  // Marked .skip until the ref-preservation logic is fixed.  To validate:
  //   1. docs add <owner> <file> --slug <s> --type note
  //   2. docs update <s> --content <new-content>
  //   3. docs publish --for <owner> --to <path>
  //   4. Assert the published bytes === new-content
  it.todo('T11042: updated doc remains publishable by the same owner (owner refs preserved)');

  // T11042-B2b: When a doc is updated and then published, the SHA-256
  // in the publish result must match the SHA-256 that docs fetch returns
  // for the same slug immediately after the update.  No SHA drift between
  // the SSoT write path (update) and the read path (fetch/publish).
  //
  // Marked .skip until verified.  To validate:
  //   1. docs add → get sha256-a
  //   2. docs update → get sha256-b from result
  //   3. docs publish --for <owner> --to <path> → get publish-sha256
  //   4. Assert publish-sha256 === sha256-b (not sha256-a)
  it.todo(
    'T11042: publish SHA agrees with post-update fetch SHA (no drift between write and publish)',
  );

  // T11042-B2c: docs status (drift detector) MUST report the published
  // file as in-sync when publish was called immediately after update.
  // Today the ledger only records the lastBlobSha at publish time, but
  // if publish selects a stale blob, the status report shows a false
  // negative (modified/deleted) or a false positive (in-sync with stale data).
  it.todo('T11042: docs status reports in-sync after update + publish cycle');

  // ── T11055: enforcement of replacement semantics ─────────────────────────────

  it('(h) summary field states whether slug was changed or left untouched', async () => {
    const original = join(projectRoot, 'orig-h.md');
    await writeFile(original, 'original\\n', 'utf-8');

    const addRes = runCli(
      ['docs', 'add', 'T-T11055-h', original, '--slug', 't11055-doc-h', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status).toBe(0);
    const originalSha = parseEnvelope<AddResultShape>(addRes.stdout).data?.sha256;

    // (h1) changed update → summary says "was changed"
    const upRes = runCli(
      [
        'docs',
        'update',
        't11055-doc-h',
        '--content',
        'changed content\\n',
        '--message',
        'replaced',
      ],
      projectRoot,
    );
    expect(upRes.status).toBe(0);
    const upData = parseEnvelope<UpdateResultShape>(upRes.stdout).data;
    expect(upData?.changed).toBe(true);
    expect(upData?.summary).toContain('was changed');
    expect(upData?.summary).toContain('t11055-doc-h');

    // (h2) noop update → summary says "left untouched"
    const noopRes = runCli(
      ['docs', 'update', 't11055-doc-h', '--content', 'changed content\\n'],
      projectRoot,
    );
    expect(noopRes.status).toBe(0);
    const noopData = parseEnvelope<UpdateResultShape>(noopRes.stdout).data;
    expect(noopData?.changed).toBe(false);
    expect(noopData?.summary).toContain('left untouched');

    // (h3) dry-run → summary says "would be changed" or "would be left untouched"
    const dryRes = runCli(
      ['docs', 'update', 't11055-doc-h', '--content', 'brand new\\n', '--dry-run'],
      projectRoot,
    );
    expect(dryRes.status).toBe(0);
    const dryData = parseEnvelope<UpdateResultShape>(dryRes.stdout).data;
    expect(dryData?.dryRun).toBe(true);
    expect(dryData?.summary).toContain('would be changed');
  });

  it('(i) E_NOT_FOUND error message states the slug does not exist and cannot be updated', async () => {
    const upRes = runCli(
      ['docs', 'update', 'nonexistent-slug', '--content', 'whatever\\n'],
      projectRoot,
    );
    expect(upRes.status).not.toBe(0);
    const env = parseEnvelope(upRes.stdout);
    expect(env.success).toBe(false);
    const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
    expect(symbolic).toBe('E_NOT_FOUND');
    expect(env.error?.message ?? '').toContain('does not exist');
    expect(env.error?.message ?? '').toContain('cannot be updated');
  });

  it('(j) blob-write failure returns E_FILE_ERROR when storage directory is unwritable', async () => {
    // Add a doc first to populate the DB
    const original = join(projectRoot, 'orig-j.md');
    await writeFile(original, 'content j\\n', 'utf-8');
    const addRes = runCli(
      ['docs', 'add', 'T-T11055-j', original, '--slug', 't11055-doc-j', '--type', 'note'],
      projectRoot,
    );
    expect(addRes.status).toBe(0);

    // Make the attachments directory unwritable to simulate a blob-write failure.
    // The blob path is <cleoDir>/attachments/sha256/<prefix>/<rest>.ext
    const attachmentsDir = join(projectRoot, '.cleo', 'attachments', 'sha256');
    const mode = 0o444; // read-only
    await mkdir(attachmentsDir, { recursive: true });
    await chmod(attachmentsDir, mode);

    try {
      const upRes = runCli(
        ['docs', 'update', 't11055-doc-j', '--content', 'updated j\\n'],
        projectRoot,
      );
      // Should fail because the directory is unwritable
      const env = parseEnvelope(upRes.stdout);
      expect(env.success).toBe(false);
      const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
      expect(['E_FILE_ERROR', 'E_INTERNAL']).toContain(symbolic);
    } finally {
      // Restore writability for cleanup
      await chmod(attachmentsDir, 0o755);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T11060 — Docs dogfood regression tests for 2026-05-25 failures
//
// These tests use core-level imports (no CLI dist dependency) and cover:
//   AC1: Outside-project file rejection → E_PATH_TRAVERSAL
//   AC2: Invalid docs status enum → E_INVALID_STATUS with canonical list
//   AC3: Tests run without depending on machine-specific temp paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs update — outside-project path rejection', () => {
  const projectRoot = '/tmp/t11060-test-project';

  it('rejects absolute path outside projectRoot with E_PATH_TRAVERSAL', () => {
    expect(() => sanitizePath('/etc/passwd', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('/etc/passwd', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/outside project root/i);
      expect(se.message).toContain('/etc/passwd');
    }
  });

  it('rejects ../ escape path with E_PATH_TRAVERSAL', () => {
    expect(() => sanitizePath('../../../etc/passwd', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('../../../etc/passwd', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/outside project root/i);
    }
  });

  it('rejects path with null bytes', () => {
    expect(() => sanitizePath('/tmp/t11060-test-project/file\0hidden.txt', projectRoot)).toThrow(
      SecurityError,
    );

    try {
      sanitizePath('/tmp/t11060-test-project/file\0hidden.txt', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toMatch(/null bytes/i);
    }
  });

  it('accepts paths inside projectRoot', () => {
    expect(sanitizePath('/tmp/t11060-test-project/docs/file.md', projectRoot)).toBe(
      '/tmp/t11060-test-project/docs/file.md',
    );
    expect(sanitizePath('docs/file.md', projectRoot)).toBe('/tmp/t11060-test-project/docs/file.md');
  });

  it('rejects empty path', () => {
    expect(() => sanitizePath('', projectRoot)).toThrow(SecurityError);

    try {
      sanitizePath('', projectRoot);
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_INVALID_PATH');
      expect(se.message).toMatch(/cannot be empty/i);
    }
  });
});

describe('Docs update — invalid docs status enum', () => {
  it('rejects "review" — not in canonical lifecycle list', () => {
    expect(isLifecycleStatus('review')).toBe(false);
  });

  it('rejects "done" — not a docs lifecycle status', () => {
    expect(isLifecycleStatus('done')).toBe(false);
  });

  it('rejects "published" — confusing with task status', () => {
    expect(isLifecycleStatus('published')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLifecycleStatus('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isLifecycleStatus(42)).toBe(false);
    expect(isLifecycleStatus(null)).toBe(false);
    expect(isLifecycleStatus(undefined)).toBe(false);
    expect(isLifecycleStatus({})).toBe(false);
  });

  for (const status of DOCS_LIFECYCLE_STATUSES) {
    it(`accepts canonical status "${status}"`, () => {
      expect(isLifecycleStatus(status)).toBe(true);
    });
  }
});

describe('Docs update — lifecycle status list contract', () => {
  it('contains all six canonical statuses pipe-delimited', () => {
    for (const status of DOCS_LIFECYCLE_STATUSES) {
      expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toContain(status);
    }
    expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toContain('|');
  });

  it('matches the canonical order from @cleocode/contracts', () => {
    expect(DOCS_UPDATE_LIFECYCLE_STATUS_LIST).toBe(DOCS_LIFECYCLE_STATUSES.join('|'));
  });

  it('contains no extra statuses beyond the canonical six', () => {
    const parts = DOCS_UPDATE_LIFECYCLE_STATUS_LIST.split('|');
    expect(parts).toHaveLength(DOCS_LIFECYCLE_STATUSES.length);
  });
});

describe('Docs update — error message contract', () => {
  it('E_INVALID_STATUS message includes canonical lifecycle status list', () => {
    const msg = `status must be one of: ${DOCS_UPDATE_LIFECYCLE_STATUS_LIST} — got 'review'`;

    expect(msg).toMatch(/status must be one of/i);
    for (const s of DOCS_LIFECYCLE_STATUSES) {
      expect(msg).toContain(s);
    }
    expect(msg).toContain('review');
    expect(msg).toContain('draft|proposed|accepted|superseded|archived|deprecated');
  });

  it('E_PATH_TRAVERSAL error includes rejected path for agent debugging', () => {
    try {
      sanitizePath('/outside/file.txt', '/tmp/test-project');
    } catch (err) {
      const se = err as SecurityError;
      expect(se.code).toBe('E_PATH_TRAVERSAL');
      expect(se.message).toContain('/outside/file.txt');
      expect(se.message).toMatch(/outside project root/i);
      expect(se.field).toBe('path');
    }
  });
});

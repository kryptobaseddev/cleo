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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});

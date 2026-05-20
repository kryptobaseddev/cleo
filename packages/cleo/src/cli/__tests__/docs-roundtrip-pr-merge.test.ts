/**
 * T9645 — End-to-end round-trip test for the post-merge docs re-ingest flow.
 *
 * This test simulates the exact sequence the
 * `.github/workflows/docs-reingest.yml` workflow performs after a PR merges:
 *
 *   1. Seed a blob and `cleo docs publish` it to a git-tracked path (RT-A).
 *   2. Edit the on-disk file (simulates a PR that touched the published doc).
 *   3. Run `cleo docs status` against the post-merge state → drift=modified.
 *   4. Iterate the drifted items and call
 *      `cleo docs sync --from <publishedPath> --for <ownerId> --name <blobName>`
 *      exactly as the workflow does.
 *   5. Re-run `cleo docs status` → drift cleared (all in-sync, exit 0).
 *   6. AC4 invariants:
 *      - The new SSoT blob SHA matches the on-disk file SHA after re-ingest.
 *      - The OLD blob SHA is preserved as `oldSha` on the sync envelope
 *        so blob-version history is reconstructable.
 *      - The publications ledger row reflects the new SHA.
 *
 * Whereas `docs-roundtrip.test.ts` exercises the per-command surfaces in
 * isolation, this file validates that the WORKFLOW LOGIC (status → for each
 * drifted item: sync → status) is consistent end-to-end and idempotent on
 * a second pass.
 *
 * @task T9645 (T-DOCS-GH-2 — Re-ingest on PR merge + drift gating)
 * @epic T9630
 * @saga T9625
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to the compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/**
 * Run `node dist/cli/index.js <args>` against an isolated tmp project root.
 */
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

async function fileSha(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

interface DocsStatusItem {
  readonly ownerId: string;
  readonly blobName: string;
  readonly publishedPath: string;
  readonly blobSha: string;
  readonly fileSha: string | null;
  readonly drift: 'in-sync' | 'added' | 'modified' | 'deleted';
}

/**
 * Simulates the re-ingest loop the GitHub Actions workflow performs.
 * Returns the list of `cleo docs sync` envelopes (one per drifted entry).
 */
function reingestDriftedDocs(
  status: { items: readonly DocsStatusItem[] },
  projectRoot: string,
): Array<{
  publishedPath: string;
  envelope: LafsEnvelope<{
    action: 'created' | 'updated' | 'noop';
    newSha: string;
    oldSha?: string;
  }>;
  exitCode: number | null;
}> {
  const out: Array<{
    publishedPath: string;
    envelope: LafsEnvelope<{
      action: 'created' | 'updated' | 'noop';
      newSha: string;
      oldSha?: string;
    }>;
    exitCode: number | null;
  }> = [];
  for (const item of status.items) {
    if (item.drift === 'in-sync' || item.drift === 'deleted') continue;
    const args = [
      'docs',
      'sync',
      '--from',
      item.publishedPath,
      '--for',
      item.ownerId,
      '--name',
      item.blobName,
    ];
    const res = runCli(args, projectRoot);
    out.push({
      publishedPath: item.publishedPath,
      envelope: parseEnvelope(res.stdout),
      exitCode: res.status,
    });
  }
  return out;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T9645-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

async function seedBlobViaCli(ownerId: string, filename: string, content: string): Promise<string> {
  const seedDir = join(projectRoot, '__seeds', ownerId);
  await mkdir(seedDir, { recursive: true });
  const fixturePath = join(seedDir, filename);
  await writeFile(fixturePath, content, 'utf-8');
  const res = runCli(['docs', 'add', ownerId, fixturePath], projectRoot);
  if (res.status !== 0) {
    throw new Error(
      `seedBlobViaCli failed (exit ${res.status}). stdout=${res.stdout} stderr=${res.stderr}`,
    );
  }
  const env = parseEnvelope<{ sha256: string }>(res.stdout);
  expect(env.success, `docs add envelope: ${JSON.stringify(env)}`).toBe(true);
  return env.data?.sha256 ?? '';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!CLI_DIST_AVAILABLE)('T9645 — post-merge docs re-ingest round-trip', () => {
  it('AC4: edit → status drift → reingest → status clean → blob SHA matches file SHA', async () => {
    const ownerId = 'T9645-ac4';
    const original = '# Original doc\n\nv1 content.\n';
    const originalSha = createHash('sha256').update(original).digest('hex');
    await seedBlobViaCli(ownerId, 'doc.md', original);

    // Step 1 — publish to a git-tracked path (simulates merge into main).
    const dest = 'docs/published/ac4-doc.md';
    const pubRes = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);
    expect(pubRes.status, `publish stderr: ${pubRes.stderr}`).toBe(0);
    const pubEnv = parseEnvelope<{ blobSha256: string; publishedPath: string }>(pubRes.stdout);
    expect(pubEnv.success).toBe(true);
    expect(pubEnv.data?.blobSha256).toBe(originalSha);

    // Step 2 — simulate a PR editing the on-disk file before merging.
    const absDest = join(projectRoot, dest);
    const edited = '# Original doc\n\nv2 content — edited in the PR that just merged.\n';
    const editedSha = createHash('sha256').update(edited).digest('hex');
    await writeFile(absDest, edited, 'utf-8');
    expect(await fileSha(absDest)).toBe(editedSha);

    // Step 3 — `cleo docs status` MUST exit 2 (drift) and classify modified.
    const driftRes = runCli(['docs', 'status'], projectRoot);
    expect(driftRes.status).toBe(2);
    const driftEnv = parseEnvelope<{
      items: DocsStatusItem[];
      allInSync: boolean;
    }>(driftRes.stdout);
    expect(driftEnv.success).toBe(true);
    expect(driftEnv.data?.allInSync).toBe(false);
    const driftedItems = driftEnv.data?.items ?? [];
    expect(driftedItems).toHaveLength(1);
    expect(driftedItems[0]?.drift).toBe('modified');
    expect(driftedItems[0]?.fileSha).toBe(editedSha);
    expect(driftedItems[0]?.blobSha).toBe(originalSha);

    // Step 4 — run the workflow's re-ingest loop on the drifted items.
    const syncResults = reingestDriftedDocs({ items: driftedItems }, projectRoot);
    expect(syncResults).toHaveLength(1);
    const [{ envelope, exitCode }] = syncResults;
    expect(exitCode).toBe(0);
    expect(envelope.success).toBe(true);
    expect(envelope.data?.action).toBe('updated');
    // AC4 invariant: new SHA == on-disk edited SHA.
    expect(envelope.data?.newSha).toBe(editedSha);
    // AC4 invariant: oldSha references the previous published version.
    expect(envelope.data?.oldSha).toBe(originalSha);

    // Step 5 — status MUST now be clean and exit 0.
    const finalRes = runCli(['docs', 'status'], projectRoot);
    expect(finalRes.status, `final stderr: ${finalRes.stderr}`).toBe(0);
    const finalEnv = parseEnvelope<{
      items: DocsStatusItem[];
      allInSync: boolean;
    }>(finalRes.stdout);
    expect(finalEnv.success).toBe(true);
    expect(finalEnv.data?.allInSync).toBe(true);
    expect(finalEnv.data?.items).toHaveLength(1);
    expect(finalEnv.data?.items[0]?.drift).toBe('in-sync');
    expect(finalEnv.data?.items[0]?.blobSha).toBe(editedSha);
    expect(finalEnv.data?.items[0]?.fileSha).toBe(editedSha);
  });

  it('AC4-idempotent: replaying the re-ingest loop on a clean tree is a no-op (action=noop)', async () => {
    const ownerId = 'T9645-ac4-idem';
    const content = '# Idempotent\n';
    await seedBlobViaCli(ownerId, 'idem.md', content);
    const dest = 'docs/idem.md';
    expect(runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot).status).toBe(0);

    // Edit + reingest once.
    const edited = '# Edited once\n';
    await writeFile(join(projectRoot, dest), edited, 'utf-8');
    const status1 = parseEnvelope<{ items: DocsStatusItem[]; allInSync: boolean }>(
      runCli(['docs', 'status'], projectRoot).stdout,
    );
    const first = reingestDriftedDocs({ items: status1.data?.items ?? [] }, projectRoot);
    expect(first).toHaveLength(1);
    expect(first[0]?.envelope.data?.action).toBe('updated');

    // Second pass — file unchanged on disk, ledger row already in-sync.
    // The workflow re-runs `status` and finds nothing to sync, so the
    // re-ingest loop returns an empty result set.
    const status2 = parseEnvelope<{ items: DocsStatusItem[]; allInSync: boolean }>(
      runCli(['docs', 'status'], projectRoot).stdout,
    );
    expect(status2.data?.allInSync).toBe(true);
    const second = reingestDriftedDocs({ items: status2.data?.items ?? [] }, projectRoot);
    expect(second).toHaveLength(0);

    // Belt-and-braces: even if the workflow naively re-syncs every item
    // (no status filter), the sync MUST return `noop` because content
    // matches the latest stored blob.
    const directSync = runCli(
      ['docs', 'sync', '--from', dest, '--for', ownerId, '--name', 'idem.md'],
      projectRoot,
    );
    expect(directSync.status).toBe(0);
    const directEnv = parseEnvelope<{ action: string; newSha: string; oldSha: string }>(
      directSync.stdout,
    );
    expect(directEnv.data?.action).toBe('noop');
    expect(directEnv.data?.newSha).toBe(directEnv.data?.oldSha);
  });

  it('AC4-deleted: status reports drift=deleted; workflow logic skips it (does not auto-sync)', async () => {
    const ownerId = 'T9645-ac4-del';
    await seedBlobViaCli(ownerId, 'gone.md', '# To be deleted\n');
    const dest = 'docs/gone.md';
    expect(runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot).status).toBe(0);

    // Remove the published file on disk (simulates a retire-PR merge).
    const absDest = isAbsolute(dest) ? dest : resolve(projectRoot, dest);
    await rm(absDest);

    const status = parseEnvelope<{ items: DocsStatusItem[]; allInSync: boolean }>(
      runCli(['docs', 'status'], projectRoot).stdout,
    );
    expect(status.data?.allInSync).toBe(false);
    expect(status.data?.items[0]?.drift).toBe('deleted');

    const ingest = reingestDriftedDocs({ items: status.data?.items ?? [] }, projectRoot);
    // Workflow logic explicitly does NOT re-ingest deleted entries —
    // they require `cleo docs remove` to retire the publication.
    expect(ingest).toHaveLength(0);
  });
});

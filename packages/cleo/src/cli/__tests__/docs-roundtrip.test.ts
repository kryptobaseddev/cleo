/**
 * T9635 — End-to-end round-trip tests for `cleo docs publish/sync/status`.
 *
 * Filename note: these are CLI-subprocess integration tests, but the cleo
 * vitest config excludes the `*.integration.test.ts` suffix from the default
 * run (reserved for the heavyweight release-pipeline harness). Keeping the
 * filename as `docs-roundtrip.test.ts` ensures the standard `pnpm test`
 * surface picks them up — which is what T9635 AC5/AC6 require.
 *
 * These tests drive the compiled `cleo` CLI as a subprocess against an
 * isolated tmp `CLEO_PROJECT_ROOT` per test, validating the public envelope
 * surface + on-disk side effects shipped under Epic T9626 / Saga T9625:
 *
 *   - PR #318 (T9633)  — citty runMain LAFS envelope wrap
 *   - PR #327 (T9701)  — `docs publish` atomic write + path-escape guard
 *   - PR #327 (T9702)  — `docs sync --from` reverse-ingest
 *   - PR #327 (T9703)  — `docs status` drift detector with exit code 2
 *   - PR #327 (T9704)  — in-process idempotency coverage
 *
 * Whereas `docs-idempotency.test.ts` exercises the core fns directly with
 * an explicit `projectRoot` (skipping the CLI), T9635 deliberately spawns
 * `node dist/cli/index.js` so envelope emission, exit codes, JSON shape,
 * and the docs-publications ledger are validated together — the only
 * configuration an external operator actually sees.
 *
 * Coverage matrix (one `it()` per row):
 *
 * | ID    | Behavior                                                      |
 * | ----- | ------------------------------------------------------------- |
 * | RT-1  | publish → read-back equals original bytes + sha               |
 * | RT-2  | publish twice → same SHA, no error, idempotent on disk        |
 * | RT-3  | sync --from after edit → new blob version created (updated)   |
 * | RT-4  | sync --from twice with no change → action=noop                |
 * | RT-5  | status after publish, untouched → in-sync, exit 0             |
 * | RT-6  | status after on-disk edit → drift=modified, exit 2            |
 * | RT-7  | status after on-disk delete → drift=deleted, exit 2           |
 * | RT-8  | publish to nested subdir → mkdir -p, file appears             |
 * | RT-9  | publish --to absolute path outside root → LAFS error envelope |
 *
 * @task T9635 (T-DOCS-PUB-3 — Round-trip integration tests)
 * @epic T9626 (W0)
 * @saga T9625
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
 *
 * `CLEO_PROJECT_ROOT` pins `getProjectRoot()` so the subprocess never walks
 * out of the tmp dir and the worktree's own `.cleo/` is never touched. We
 * also clear `CLEO_DIR` to prevent inheritance from an outer test runner.
 */
function runCli(args: readonly string[], projectRoot: string): CliResult {
  const env = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    // Force the CLI's default JSON output even if the outer env disabled it.
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
  readonly meta?: {
    readonly operation?: string;
    readonly command?: string;
    readonly timestamp?: string;
  };
}

/**
 * Extract the JSON LAFS envelope from a CLI invocation's stdout.
 *
 * The envelope is emitted as a single JSON line. Some commands emit pager
 * footer lines so we scan for the first `{`-prefixed line that successfully
 * parses as JSON.
 */
function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  throw new Error(`parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

/** sha256 of file bytes — matches the digest the core layer writes. */
async function fileSha(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T9635-'));
  // The blob store stats `<projectRoot>/.cleo/` to derive its data dir, and
  // getProjectRoot() walks back to whatever holds `.cleo/`, so create it.
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// ─── Helpers built on the CLI subprocess ─────────────────────────────────────

/**
 * Seed a blob by writing a temp file + invoking `cleo docs add` under tmp root.
 *
 * The `cleo docs add` handler derives the v2 blob `name` from
 * `basename(fixturePath)`, which is what `syncFromGit` then matches against
 * when classifying `created` vs `updated`. To keep round-trip tests symmetric
 * (i.e. `sync --from docs/x/note.md` should see the blob seeded under name
 * `note.md`), we place each seed file under its OWN isolated subdir using
 * exactly the requested basename — never a prefixed temp name.
 */
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

describe.skipIf(!CLI_DIST_AVAILABLE)(
  'T9635 — cleo docs publish/sync/status round-trip (CLI subprocess)',
  () => {
    // ─── RT-1 ────────────────────────────────────────────────────────────────
    it('RT-1: publish writes file bytes that match the envelope sha + original content', async () => {
      const ownerId = 'T9635-rt1';
      const content = '# RT-1 spec\n\nbytes go round-trip.\n';
      const expectedSha = createHash('sha256').update(content).digest('hex');
      await seedBlobViaCli(ownerId, 'spec.md', content);

      const dest = 'docs/published/spec.md';
      const res = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);

      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      const env = parseEnvelope<{
        publishedPath: string;
        sha256: string;
        bytes: number;
        blobSha256: string;
      }>(res.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.sha256).toBe(expectedSha);
      expect(env.data?.blobSha256).toBe(expectedSha);
      expect(env.data?.bytes).toBe(Buffer.byteLength(content, 'utf-8'));

      // On-disk bytes byte-identical to original input.
      const absDest = join(projectRoot, dest);
      const onDisk = await readFile(absDest, 'utf-8');
      expect(onDisk).toBe(content);
      expect(await fileSha(absDest)).toBe(expectedSha);
    });

    // ─── RT-2 ────────────────────────────────────────────────────────────────
    it('RT-2: publish twice produces identical sha + leaves the file untouched bit-for-bit', async () => {
      const ownerId = 'T9635-rt2';
      const content = '# RT-2 idempotent\n';
      await seedBlobViaCli(ownerId, 'spec.md', content);

      const dest = 'docs/published/idemp.md';
      const first = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);
      const second = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);

      const firstEnv = parseEnvelope<{ sha256: string }>(first.stdout);
      const secondEnv = parseEnvelope<{ sha256: string }>(second.stdout);
      expect(firstEnv.data?.sha256).toBe(secondEnv.data?.sha256);

      // Disk truth — same sha after two publishes.
      const absDest = join(projectRoot, dest);
      expect(await fileSha(absDest)).toBe(firstEnv.data?.sha256);
    });

    // ─── RT-3 ────────────────────────────────────────────────────────────────
    it('RT-3: sync --from after publish + on-disk edit creates a new blob version', async () => {
      const ownerId = 'T9635-rt3';
      const initial = '# v1\n';
      await seedBlobViaCli(ownerId, 'note.md', initial);

      const dest = 'docs/sync/note.md';
      const pubRes = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);
      expect(pubRes.status).toBe(0);

      // Mutate the on-disk file (simulates a human edit in git).
      const absDest = join(projectRoot, dest);
      const mutated = '# v2 (edited locally)\n';
      await writeFile(absDest, mutated, 'utf-8');

      // Reverse-ingest the new content. blobName must match what the publish
      // path was seeded under so the manifest sees this as an UPDATE not a new doc.
      const syncRes = runCli(
        ['docs', 'sync', '--from', dest, '--for', ownerId, '--name', 'note.md'],
        projectRoot,
      );
      expect(syncRes.status, `stderr: ${syncRes.stderr}`).toBe(0);
      const env = parseEnvelope<{
        action: 'created' | 'updated' | 'noop';
        newSha: string;
        oldSha?: string;
      }>(syncRes.stdout);

      expect(env.success).toBe(true);
      expect(env.data?.action).toBe('updated');
      const expectedNewSha = createHash('sha256').update(mutated).digest('hex');
      expect(env.data?.newSha).toBe(expectedNewSha);
      expect(env.data?.oldSha).toBe(createHash('sha256').update(initial).digest('hex'));
    });

    // ─── RT-4 ────────────────────────────────────────────────────────────────
    it('RT-4: sync --from a second time with unchanged file returns action=noop', async () => {
      const ownerId = 'T9635-rt4';
      const content = '# unchanged\n';
      await seedBlobViaCli(ownerId, 'doc.md', content);

      // First sync exists to anchor the blobName in the manifest under this owner.
      const fixture = join(projectRoot, 'docs/source/doc.md');
      await mkdir(dirname(fixture), { recursive: true });
      await writeFile(fixture, content, 'utf-8');

      const args = [
        'docs',
        'sync',
        '--from',
        'docs/source/doc.md',
        '--for',
        ownerId,
        '--name',
        'doc.md',
      ];
      const first = runCli(args, projectRoot);
      expect(first.status).toBe(0);
      const firstEnv = parseEnvelope<{ action: string; newSha: string }>(first.stdout);
      // First call may be 'noop' (sha already matches seed) or 'updated' (if seed
      // path differs) — the second-call contract is what matters.

      const second = runCli(args, projectRoot);
      expect(second.status).toBe(0);
      const secondEnv = parseEnvelope<{ action: string; newSha: string; oldSha: string }>(
        second.stdout,
      );
      expect(secondEnv.success).toBe(true);
      expect(secondEnv.data?.action).toBe('noop');
      expect(secondEnv.data?.newSha).toBe(firstEnv.data?.newSha);
      expect(secondEnv.data?.oldSha).toBe(firstEnv.data?.newSha);
    });

    // ─── RT-5 ────────────────────────────────────────────────────────────────
    it('RT-5: status after publish + untouched file → drift=in-sync, exit 0', async () => {
      const ownerId = 'T9635-rt5';
      await seedBlobViaCli(ownerId, 'g.md', '# guide\n');
      const dest = 'docs/guide.md';
      expect(runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot).status).toBe(
        0,
      );

      const statusRes = runCli(['docs', 'status'], projectRoot);
      expect(statusRes.status, `stderr: ${statusRes.stderr}`).toBe(0);

      const env = parseEnvelope<{
        items: Array<{ ownerId: string; drift: string }>;
        allInSync: boolean;
      }>(statusRes.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.allInSync).toBe(true);
      expect(env.data?.items).toHaveLength(1);
      expect(env.data?.items[0]?.drift).toBe('in-sync');
      expect(env.data?.items[0]?.ownerId).toBe(ownerId);
    });

    // ─── RT-6 ────────────────────────────────────────────────────────────────
    it('RT-6: status after on-disk edit → drift=modified for that slug, exit 2', async () => {
      const ownerId = 'T9635-rt6';
      await seedBlobViaCli(ownerId, 'a.md', '# A v1\n');
      const dest = 'docs/a.md';
      expect(runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot).status).toBe(
        0,
      );

      // Mutate the published file on disk.
      await writeFile(join(projectRoot, dest), '# A mutated\n', 'utf-8');

      const statusRes = runCli(['docs', 'status'], projectRoot);
      expect(statusRes.status).toBe(2);

      const env = parseEnvelope<{
        items: Array<{ ownerId: string; drift: string }>;
        allInSync: boolean;
      }>(statusRes.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.allInSync).toBe(false);
      expect(env.data?.items[0]?.drift).toBe('modified');
      expect(env.data?.items[0]?.ownerId).toBe(ownerId);
    });

    // ─── RT-7 ────────────────────────────────────────────────────────────────
    it('RT-7: status after on-disk delete → drift=deleted, exit 2', async () => {
      const ownerId = 'T9635-rt7';
      await seedBlobViaCli(ownerId, 'b.md', '# B\n');
      const dest = 'docs/b.md';
      const pubRes = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);
      expect(pubRes.status).toBe(0);

      // Delete the published file.
      await rm(join(projectRoot, dest));

      const statusRes = runCli(['docs', 'status'], projectRoot);
      expect(statusRes.status).toBe(2);

      const env = parseEnvelope<{
        items: Array<{ ownerId: string; drift: string; fileSha: string | null }>;
        allInSync: boolean;
      }>(statusRes.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.allInSync).toBe(false);
      expect(env.data?.items[0]?.drift).toBe('deleted');
      expect(env.data?.items[0]?.fileSha).toBeNull();
    });

    // ─── RT-8 ────────────────────────────────────────────────────────────────
    it('RT-8: publish to a deeply nested path auto-creates parent dirs', async () => {
      const ownerId = 'T9635-rt8';
      await seedBlobViaCli(ownerId, 'deep.md', '# deep\n');

      const dest = 'docs/a/b/c/d/deep.md';
      // Confirm the parent does not yet exist — the operation must mkdir -p.
      const parent = join(projectRoot, 'docs/a/b/c/d');
      let parentExisted = true;
      try {
        await stat(parent);
      } catch {
        parentExisted = false;
      }
      expect(parentExisted).toBe(false);

      const res = runCli(['docs', 'publish', '--for', ownerId, '--to', dest], projectRoot);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);

      // Both the parent dir AND the file now exist.
      const fileStat = await stat(join(projectRoot, dest));
      expect(fileStat.isFile()).toBe(true);
    });

    // ─── RT-9 ────────────────────────────────────────────────────────────────
    it('RT-9: publish --to an absolute path outside the project root is rejected with a LAFS error', async () => {
      const ownerId = 'T9635-rt9';
      await seedBlobViaCli(ownerId, 'escape.md', '# escape attempt\n');

      // A second tmp dir, OUTSIDE projectRoot — should NEVER be written to.
      const outsideDir = await mkdtemp(join(tmpdir(), 'cleo-T9635-outside-'));
      const outsidePath = join(outsideDir, 'gotcha.md');

      const res = runCli(['docs', 'publish', '--for', ownerId, '--to', outsidePath], projectRoot);

      // Non-zero exit + LAFS error envelope on stdout.
      expect(res.status).not.toBe(0);
      expect(res.status).not.toBeNull();

      const env = parseEnvelope(res.stdout);
      expect(env.success).toBe(false);
      expect(env.error).toBeDefined();
      expect(env.error?.message ?? '').toMatch(/outside projectRoot|publish failed/i);
      // ADR-039 — meta MUST be present on every envelope, success or not.
      expect(env.meta).toBeDefined();

      // CRITICAL: the file MUST NOT have been written.
      let leakedFile = false;
      try {
        await stat(outsidePath);
        leakedFile = true;
      } catch {
        leakedFile = false;
      }
      expect(leakedFile, `path-escape guard leaked ${outsidePath}`).toBe(false);

      await rm(outsideDir, { recursive: true, force: true }).catch(() => {
        /* tmp cleanup is best-effort */
      });
    });
  },
);

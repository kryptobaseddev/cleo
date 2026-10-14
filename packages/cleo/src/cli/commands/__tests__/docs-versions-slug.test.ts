/**
 * End-to-end tests for `cleo docs versions --for` slug resolution (T13725).
 *
 * Before T13725 the `--for` arg was passed verbatim as a blob-manifest owner
 * id, so `cleo docs versions --for <doc-slug>` always returned an empty list
 * (the diagnosis behind this task). The fix resolves the arg as a doc slug
 * when it matches no owner with mirrored blobs, via the same
 * `AttachmentStore.findBySlug` + `listRefs` surface `docs fetch` uses.
 *
 * Drives the compiled `cleo` CLI as a subprocess against an isolated tmp
 * project and verifies:
 *
 *   (a) a fresh add+update doc: `--for <slug>` returns the same non-empty
 *       rows as `--for <owner-id>`;
 *   (b) an unknown slug returns the named `E_NOT_FOUND` error, not a silent
 *       empty list;
 *   (c) the owner-id form is unchanged (back-compat).
 *
 * @task T13725
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    timeout: 90_000,
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

interface VersionsEntry {
  attachmentId: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
}

interface VersionsResultShape {
  ownerId: string;
  nameFilter?: string;
  versions: VersionsEntry[];
}

const OWNER = 'T13725';
const SLUG = 't13725-versions-slug-fixture';

/** Seed one doc via `docs add` then update it once, so the manifest has rows. */
async function seedDocWithUpdate(projectRoot: string): Promise<void> {
  const v1 = join(projectRoot, `${SLUG}-v1.md`);
  await writeFile(v1, '# versions fixture v1\n\nInitial body for the T13725 fixture.\n', 'utf-8');
  const add = runCli(['docs', 'add', OWNER, v1, '--slug', SLUG], projectRoot);
  if (add.status !== 0) {
    throw new Error(`docs add failed: status=${add.status} stdout=${add.stdout}`);
  }
  const v2 = join(projectRoot, `${SLUG}-v2.md`);
  await writeFile(
    v2,
    '# versions fixture v2\n\nUpdated body for the T13725 fixture, with more content.\n',
    'utf-8',
  );
  const update = runCli(['docs', 'update', SLUG, '--file', v2], projectRoot);
  if (update.status !== 0) {
    throw new Error(`docs update failed: status=${update.status} stdout=${update.stdout}`);
  }
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T13725-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// Each test spawns several subprocess CLI invocations; `docs add` can take
// 10-30s when the AttachmentStore initialises the project DB from a clean
// tmpdir, so allot generous per-test headroom.
const TEST_TIMEOUT_MS = 300_000;

describe.skipIf(!CLI_DIST_AVAILABLE)('T13725 — cleo docs versions --for', () => {
  it(
    '(a) --for <slug> returns the same non-empty rows as --for <owner-id>',
    async () => {
      await seedDocWithUpdate(projectRoot);

      const byOwner = runCli(['docs', 'versions', '--for', OWNER], projectRoot);
      expect(byOwner.status, `versions failed; stdout=${byOwner.stdout}`).toBe(0);
      const ownerEnv = parseEnvelope<VersionsResultShape>(byOwner.stdout);
      expect(ownerEnv.success).toBe(true);
      expect(ownerEnv.data?.versions.length).toBeGreaterThan(0);

      const bySlug = runCli(['docs', 'versions', '--for', SLUG], projectRoot);
      expect(bySlug.status, `versions failed; stdout=${bySlug.stdout}`).toBe(0);
      const slugEnv = parseEnvelope<VersionsResultShape>(bySlug.stdout);
      expect(slugEnv.success).toBe(true);

      expect(slugEnv.data?.ownerId).toBe(OWNER);
      expect(slugEnv.data?.versions).toEqual(ownerEnv.data?.versions);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '(b) unknown slug returns the named E_NOT_FOUND error, not an empty list',
    async () => {
      await seedDocWithUpdate(projectRoot);

      const res = runCli(['docs', 'versions', '--for', 't13725-no-such-doc'], projectRoot);
      expect(res.status).not.toBe(0);
      const env = parseEnvelope(res.stdout);
      expect(env.success).toBe(false);
      const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
      expect(symbolic).toBe('E_NOT_FOUND');
      expect(env.error?.message ?? '').toContain("no doc or owner found for 't13725-no-such-doc'");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '(c) owner-id form is unchanged (back-compat)',
    async () => {
      await seedDocWithUpdate(projectRoot);

      const res = runCli(['docs', 'versions', '--for', OWNER], projectRoot);
      expect(res.status, `versions failed; stdout=${res.stdout}`).toBe(0);
      const env = parseEnvelope<VersionsResultShape>(res.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.ownerId).toBe(OWNER);
      expect(env.data?.versions.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

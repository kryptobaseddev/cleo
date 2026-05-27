/**
 * Integration test suite for the consolidated six-verb docs CLI surface.
 *
 * Tests the canonical verbs: add, update, fetch, list, remove, publish.
 * All tests run the compiled CLI as a subprocess against isolated project roots.
 *
 * @task T11188 (Saga T10516 / Epic T10521)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── CLI dist discovery ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

// ── Helpers ──────────────────────────────────────────────────────────────

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
  };
  readonly meta?: Record<string, unknown>;
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

/** Write a temp file and add it as a doc via the CLI. */
async function addDocFile(
  projectRoot: string,
  taskId: string,
  content: string,
  opts?: { slug?: string; type?: string },
): Promise<{ attachmentId: string; sha256: string; slug?: string }> {
  const filename = opts?.slug ? `${opts.slug}.md` : `test-doc-${Date.now()}.md`;
  const filePath = join(projectRoot, filename);
  await writeFile(filePath, content, 'utf-8');

  const cliArgs: string[] = ['docs', 'add', taskId, filePath, '--json'];
  if (opts?.slug) cliArgs.push('--slug', opts.slug);
  if (opts?.type) cliArgs.push('--type', opts.type);

  const result = runCli(cliArgs, projectRoot);
  if (result.status !== 0) {
    throw new Error(`addDocFile failed (status=${result.status}): stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const env = parseEnvelope(result.stdout);
  if (!env.success) {
    throw new Error(`addDocFile failed: ${JSON.stringify(env.error)}`);
  }
  return (env.data ?? {}) as { attachmentId: string; sha256: string; slug?: string };
}

/** Six canonical verbs per T10517 acceptance. */
const CANONICAL_SIX = ['add', 'update', 'fetch', 'list', 'remove', 'publish'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// CLI E2E TESTS
// ═══════════════════════════════════════════════════════════════════════════

let projectRoot: string;

describe.runIf(CLI_DIST_AVAILABLE)('docs canonical six-verb CLI integration', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T11188-'));
    await mkdir(join(projectRoot, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {
      /* never fail teardown */
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // docs add
  // ═════════════════════════════════════════════════════════════════════════

  describe('docs add', () => {
    it('adds a doc from a file and returns attachment metadata', async () => {
      const filePath = join(projectRoot, 'test-doc.md');
      await writeFile(filePath, '# Test Doc\n\nHello world.', 'utf-8');

      const result = runCli(
        ['docs', 'add', 'T99999', filePath, '--type', 'spec', '--json'],
        projectRoot,
      );
      expect(result.status, `add failed; stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      const env = parseEnvelope(result.stdout);
      expect(env.success).toBe(true);
      expect((env.data as Record<string, unknown>)?.attachmentId).toBeDefined();
    });

    it('adds a doc with --slug for a named attachment', async () => {
      const filePath = join(projectRoot, 'named.md');
      await writeFile(filePath, '# Named Doc', 'utf-8');
      const slug = 'my-test-doc';

      const result = runCli(
        ['docs', 'add', 'T99999', filePath, '--slug', slug, '--type', 'spec', '--json'],
        projectRoot,
      );
      expect(result.status, `add failed; stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      const env = parseEnvelope(result.stdout);
      expect(env.success).toBe(true);
      expect((env.data as Record<string, unknown>)?.slug).toBe(slug);
    });

    it('rejects --replace (unknown flag)', () => {
      const result = runCli(
        ['docs', 'add', 'T99999', '/nonexistent.md', '--replace', '--json'],
        projectRoot,
      );
      // Should error — unknown flag
      expect(result.status).not.toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // docs list
  // ═════════════════════════════════════════════════════════════════════════

  describe('docs list', () => {
    it('lists docs scoped to a task', async () => {
      await addDocFile(projectRoot, 'T99999', '# Doc A');
      await addDocFile(projectRoot, 'T99999', '# Doc B');

      const result = runCli(['docs', 'list', '--task', 'T99999', '--json'], projectRoot);
      expect(result.status).toBe(0);

      const env = parseEnvelope<{ items?: unknown[] }>(result.stdout);
      expect(env.success).toBe(true);
      const items = (env.data as Record<string, unknown>)?.items as Record<string, unknown>[];
      expect(items).toBeDefined();
      expect(items!.length).toBeGreaterThanOrEqual(2);
    });

    it('lists docs with --type filter', async () => {
      await addDocFile(projectRoot, 'T99999', '# Spec A\n\n## Overview\n\nSpec content.', { type: 'spec' });
      await addDocFile(projectRoot, 'T99999', '# Spec B\n\n## Overview\n\nSpec content.', { type: 'spec' });
      await addDocFile(projectRoot, 'T99999', '# ADR X\n\n## Decision\n\n## Context\n\nADR content.', { type: 'adr' });

      const result = runCli(['docs', 'list', '--task', 'T99999', '--type', 'adr', '--json'], projectRoot);
      expect(result.status).toBe(0);

      const env = parseEnvelope<{ items?: unknown[] }>(result.stdout);
      expect(env.success).toBe(true);
      const items = (env.data as Record<string, unknown>)?.items as Record<string, unknown>[];
      for (const item of items!) {
        expect(item.type).toBe('adr');
      }
    });

    it('lists docs with --limit and --orderBy', async () => {
      await addDocFile(projectRoot, 'T99999', '# Doc 1');
      await addDocFile(projectRoot, 'T99999', '# Doc 2');
      await addDocFile(projectRoot, 'T99999', '# Doc 3');

      const result = runCli(
        ['docs', 'list', '--task', 'T99999', '--limit', '2', '--orderBy', 'newest', '--json'],
        projectRoot,
      );
      expect(result.status).toBe(0);

      const env = parseEnvelope<{ items?: unknown[] }>(result.stdout);
      expect(env.success).toBe(true);
      const items = (env.data as Record<string, unknown>)?.items as Record<string, unknown>[];
      expect(items!.length).toBeLessThanOrEqual(2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // docs fetch
  // ═════════════════════════════════════════════════════════════════════════

  describe('docs fetch', () => {
    it('fetches an attachment by attachment ID', async () => {
      const doc = await addDocFile(projectRoot, 'T99999', '# Fetchable Doc');
      const result = runCli(['docs', 'fetch', doc.attachmentId, '--json'], projectRoot);
      expect(result.status).toBe(0);
      const env = parseEnvelope(result.stdout);
      expect(env.success).toBe(true);
    });

    it('fetches an attachment by SHA-256', async () => {
      const doc = await addDocFile(projectRoot, 'T99999', '# SHA Fetch');
      const result = runCli(['docs', 'fetch', doc.sha256, '--json'], projectRoot);
      expect(result.status).toBe(0);
      const env = parseEnvelope(result.stdout);
      expect(env.success).toBe(true);
    });

    it('errors on non-existent attachment ref', async () => {
      const result = runCli(['docs', 'fetch', 'att_nonexistent_ffffffff', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // docs remove
  // ═════════════════════════════════════════════════════════════════════════

  describe('docs remove', () => {
    it('removes an attachment ref from an owner', async () => {
      const doc = await addDocFile(projectRoot, 'T99999', '# Removable Doc');
      let listResult = runCli(['docs', 'list', '--task', 'T99999', '--json'], projectRoot);
      let listEnv = parseEnvelope<{ items?: unknown[] }>(listResult.stdout);
      const beforeCount = ((listEnv.data as Record<string, unknown>)?.items as unknown[])?.length ?? 0;

      const result = runCli(
        ['docs', 'remove', doc.attachmentId, '--from', 'T99999', '--json'],
        projectRoot,
      );
      expect(result.status).toBe(0);

      listResult = runCli(['docs', 'list', '--task', 'T99999', '--json'], projectRoot);
      listEnv = parseEnvelope<{ items?: unknown[] }>(listResult.stdout);
      const afterCount = ((listEnv.data as Record<string, unknown>)?.items as unknown[])?.length ?? 0;
      expect(afterCount).toBeLessThan(beforeCount);
    });

    it('errors when --from is missing', () => {
      const result = runCli(['docs', 'remove', 'att_something', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // docs publish
  // ═════════════════════════════════════════════════════════════════════════

  describe('docs publish', () => {
    it('publishes an attachment to a file path with --for and --to', async () => {
      const doc = await addDocFile(projectRoot, 'T99999', '# Publishable Doc\n\nHello publish!');
      const publishPath = join(projectRoot, 'docs', 'published-spec.md');

      const result = runCli(
        ['docs', 'publish', '--for', 'T99999', '--to', 'docs/published-spec.md', '--json'],
        projectRoot,
      );
      expect(result.status).toBe(0);
      const env = parseEnvelope(result.stdout);
      expect(env.success).toBe(true);
      expect(existsSync(publishPath)).toBe(true);
      expect(readFileSync(publishPath, 'utf-8')).toContain('Hello publish!');
    });

    it('errors when --for is missing', () => {
      const result = runCli(
        ['docs', 'publish', '--to', 'docs/some-file.md', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });

    it('errors when --to is missing', () => {
      const result = runCli(
        ['docs', 'publish', '--for', 'T99999', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Cross-verb lifecycle: add → list → fetch → update → publish → remove
  // ═════════════════════════════════════════════════════════════════════════

  describe('cross-verb lifecycle', () => {
    const TASK_ID = 'T99988';

    it('completes full add→list→fetch→update→publish→remove lifecycle', async () => {
      const slug = 'lifecycle-test-doc';
      const addFilePath = join(projectRoot, `${slug}-v1.md`);
      await writeFile(addFilePath, '# Lifecycle Test v1\n\nInitial content.', 'utf-8');

      // 1. ADD
      const addResult = runCli(
        ['docs', 'add', TASK_ID, addFilePath, '--slug', slug, '--type', 'note', '--json'],
        projectRoot,
      );
      expect(addResult.status, `add failed: ${addResult.stderr}`).toBe(0);
      const addEnv = parseEnvelope(addResult.stdout);
      expect(addEnv.success).toBe(true);
      const addData = addEnv.data as Record<string, unknown>;
      expect(addData.slug).toBe(slug);
      const attachmentId = addData.attachmentId as string;
      expect(attachmentId).toBeDefined();

      // 2. LIST
      const listResult = runCli(['docs', 'list', '--task', TASK_ID, '--json'], projectRoot);
      expect(listResult.status).toBe(0);
      const listEnv = parseEnvelope<{ items?: unknown[] }>(listResult.stdout);
      const items = (listEnv.data as Record<string, unknown>)?.items as Record<string, unknown>[];
      expect(items?.find((i) => i.slug === slug)).toBeDefined();

      // 3. FETCH
      const fetchResult = runCli(['docs', 'fetch', attachmentId, '--json'], projectRoot);
      expect(fetchResult.status).toBe(0);
      expect(parseEnvelope(fetchResult.stdout).success).toBe(true);

      // 4. UPDATE
      const updateFilePath = join(projectRoot, `${slug}-v2.md`);
      await writeFile(updateFilePath, '# Lifecycle Test v2\n\nUpdated content.', 'utf-8');
      const updateResult = runCli(
        ['docs', 'update', slug, '--file', updateFilePath, '--json'],
        projectRoot,
      );
      expect(updateResult.status, `update failed: ${updateResult.stderr}`).toBe(0);
      const updateEnv = parseEnvelope(updateResult.stdout);
      expect(updateEnv.success).toBe(true);
      expect((updateEnv.data as Record<string, unknown>).changed).toBe(true);

      // 5. PUBLISH
      const publishPath = join(projectRoot, 'docs', 'lifecycle-published.md');
      const publishResult = runCli(
        ['docs', 'publish', '--for', TASK_ID, '--to', 'docs/lifecycle-published.md', '--json'],
        projectRoot,
      );
      expect(publishResult.status).toBe(0);
      expect(parseEnvelope(publishResult.stdout).success).toBe(true);
      expect(existsSync(publishPath)).toBe(true);
      expect(readFileSync(publishPath, 'utf-8')).toContain('Updated content');

      // 6. REMOVE
      const removeResult = runCli(
        ['docs', 'remove', attachmentId, '--from', TASK_ID, '--json'],
        projectRoot,
      );
      expect(removeResult.status).toBe(0);

      // Verify gone
      const afterListResult = runCli(['docs', 'list', '--task', TASK_ID, '--json'], projectRoot);
      const afterItems = (parseEnvelope<{ items?: unknown[] }>(afterListResult.stdout).data as Record<string, unknown>)?.items as Record<string, unknown>[];
      expect(afterItems?.find((i) => i.slug === slug)).toBeUndefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Error coverage
  // ═════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('docs list rejects mutually exclusive --task/--session', () => {
      const result = runCli(
        ['docs', 'list', '--task', 'T1', '--session', 'ses_x', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });

    it('docs list rejects non-integer --limit', () => {
      const result = runCli(
        ['docs', 'list', '--task', 'T1', '--limit', 'abc', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });

    it('docs list rejects invalid --orderBy', () => {
      const result = runCli(
        ['docs', 'list', '--task', 'T1', '--orderBy', 'invalid', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });

    it('docs fetch with missing positional arg fails', () => {
      const result = runCli(['docs', 'fetch', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });

    it('docs remove with missing positional arg fails', () => {
      const result = runCli(['docs', 'remove', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });

    it('docs publish with missing --for fails', () => {
      const result = runCli(['docs', 'publish', '--to', 'docs/out.md', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });

    it('docs publish with missing --to fails', () => {
      const result = runCli(['docs', 'publish', '--for', 'T99999', '--json'], projectRoot);
      expect(result.status).not.toBe(0);
    });

    it('docs publish with non-existent --for owner surfaces error', () => {
      const result = runCli(
        ['docs', 'publish', '--for', 'T_nonexistent_999', '--to', 'docs/out.md', '--json'],
        projectRoot,
      );
      expect(result.status).not.toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guard when CLI not built
// ═══════════════════════════════════════════════════════════════════════════

describe.runIf(!CLI_DIST_AVAILABLE)('docs canonical surface (CLI not built)', () => {
  it('skips because CLI dist is not available', () => {
    expect(CLI_DIST_AVAILABLE).toBe(false);
  });
});

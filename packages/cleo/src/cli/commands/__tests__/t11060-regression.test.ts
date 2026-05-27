/**
 * T11060 — Docs dogfood regression tests for 2026-05-25 failures.
 *
 * Covers two dogfood failure classes from the 2026-05-25 sessions:
 *   (a) Outside-project file rejection produces an actionable agent-facing error
 *   (b) Invalid docs status enum is rejected with the canonical lifecycle status list
 *
 * All tests drive the compiled CLI dist binary so they verify the full
 * dispatch→core→sanitizer chain. Temp directories use os.tmpdir() with
 * mkdtemp (dynamic) — portable across CI environments.
 *
 * @task T11060 (Epic T10521 · Saga T10516 · E2)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── CLI dist constants ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root (resolved from commands/__tests__/). */
const PKG_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Path to compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Canonical docs lifecycle statuses from @cleocode/contracts.
 * These are the ONLY valid values for --status on `docs update`.
 */
const CANONICAL_LIFECYCLE_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'superseded',
  'archived',
  'deprecated',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Test suites
// ═══════════════════════════════════════════════════════════════════════════════

let projectRoot: string;

describe('T11060 regression — docs dogfood failures (2026-05-25)', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T11060-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {
      /* never fail teardown */
    });
  });

  // ── (a) Outside-project file rejection ───────────────────────────────────

  describe.skipIf(!CLI_DIST_AVAILABLE)(
    'AC1: outside-project file rejection → actionable agent-facing error',
    () => {
      it('rejects --file pointing outside projectRoot with E_PATH_TRAVERSAL', async () => {
        // Create a file OUTSIDE the project root.
        const outsideRoot = await mkdtemp(join(tmpdir(), 'cleo-T11060-outside-'));
        const outsidePath = join(outsideRoot, 'outside.md');
        await writeFile(outsidePath, '# Outside\n\nContent outside the project.\n', 'utf-8');

        // Add an attachment first so the update has a valid slug.
        const original = join(projectRoot, 'orig.md');
        await writeFile(original, '# Original\n\nBody.\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-A1', original, '--slug', 't11060-outside', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status, `docs add failed: ${addRes.stderr}`).toBe(0);

        // Update with a file OUTSIDE the project root.
        const upRes = runCli(
          ['docs', 'update', 't11060-outside', '--file', outsidePath],
          projectRoot,
        );
        expect(upRes.status).not.toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(false);

        // Code must be E_PATH_TRAVERSAL — tells the agent it's a path issue.
        const codeName = env.error?.codeName ?? String(env.error?.code ?? '');
        expect(codeName).toBe('E_PATH_TRAVERSAL');

        // Message must explain the problem AND name the rejected path.
        const msg = env.error?.message ?? '';
        expect(msg).toMatch(/outside project root/i);
        expect(msg).toContain(outsidePath);

        // Clean up outside directory.
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      });

      it('accepts --file inside projectRoot (happy path)', async () => {
        const original = join(projectRoot, 'orig-happy.md');
        await writeFile(original, 'original content\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-H1', original, '--slug', 't11060-inside', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status, `docs add failed: ${addRes.stderr}`).toBe(0);

        // Create update file INSIDE the project root.
        const updated = join(projectRoot, 'updated.md');
        await writeFile(updated, 'updated content\n', 'utf-8');

        const upRes = runCli(
          ['docs', 'update', 't11060-inside', '--file', updated],
          projectRoot,
        );
        expect(
          upRes.status,
          `update failed: code=${upRes.status} stderr=${upRes.stderr} stdout=${upRes.stdout}`,
        ).toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(true);
      });

      it('accepts --file outside projectRoot with --allow-external', async () => {
        const original = join(projectRoot, 'orig-ext.md');
        await writeFile(original, 'original content\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-X1', original, '--slug', 't11060-allowext', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status, `docs add failed: ${addRes.stderr}`).toBe(0);

        const outsideRoot = await mkdtemp(join(tmpdir(), 'cleo-T11060-allowext-'));
        const outsidePath = join(outsideRoot, 'outside.md');
        await writeFile(outsidePath, '# External\n\nAllowed via --allow-external.\n', 'utf-8');

        const upRes = runCli(
          ['docs', 'update', 't11060-allowext', '--file', outsidePath, '--allow-external'],
          projectRoot,
        );
        expect(
          upRes.status,
          `update with --allow-external failed: code=${upRes.status} stderr=${upRes.stderr} stdout=${upRes.stdout}`,
        ).toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(true);

        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      });
    },
  );

  // ── (b) Invalid docs status enum ────────────────────────────────────────

  describe.skipIf(!CLI_DIST_AVAILABLE)(
    'AC2: invalid docs status enum → rejected with canonical lifecycle list',
    () => {
      it('rejects --status "review" (not in canonical lifecycle list)', async () => {
        const original = join(projectRoot, 'orig-s1.md');
        await writeFile(original, 'content for status test\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-S1', original, '--slug', 't11060-status1', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status, `docs add failed: ${addRes.stderr}`).toBe(0);

        const upRes = runCli(
          ['docs', 'update', 't11060-status1', '--content', 'updated\n', '--status', 'review'],
          projectRoot,
        );
        expect(upRes.status).not.toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(false);
        expect(env.error?.codeName).toBe('E_INVALID_STATUS');

        const msg = env.error?.message ?? '';
        // Must contain the canonical list so agents can pick a valid value.
        for (const s of CANONICAL_LIFECYCLE_STATUSES) {
          expect(msg).toContain(s);
        }
        // Must name the invalid value that was passed.
        expect(msg).toContain('review');
      });

      it('rejects --status "done" (not a docs lifecycle status)', async () => {
        const original = join(projectRoot, 'orig-s2.md');
        await writeFile(original, 'content for status test 2\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-S2', original, '--slug', 't11060-status2', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status).toBe(0);

        const upRes = runCli(
          ['docs', 'update', 't11060-status2', '--content', 'updated\n', '--status', 'done'],
          projectRoot,
        );
        expect(upRes.status).not.toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(false);
        expect(env.error?.codeName).toBe('E_INVALID_STATUS');

        const msg = env.error?.message ?? '';
        for (const s of CANONICAL_LIFECYCLE_STATUSES) {
          expect(msg).toContain(s);
        }
        expect(msg).toContain('done');
      });

      it('rejects --status "published" (confusing with task status, not docs status)', async () => {
        const original = join(projectRoot, 'orig-s3.md');
        await writeFile(original, 'content for published test\n', 'utf-8');

        const addRes = runCli(
          ['docs', 'add', 'T-T11060-S3', original, '--slug', 't11060-status3', '--type', 'note'],
          projectRoot,
        );
        expect(addRes.status).toBe(0);

        const upRes = runCli(
          ['docs', 'update', 't11060-status3', '--content', 'updated\n', '--status', 'published'],
          projectRoot,
        );
        expect(upRes.status).not.toBe(0);

        const env = parseEnvelope(upRes.stdout);
        expect(env.success).toBe(false);
        expect(env.error?.codeName).toBe('E_INVALID_STATUS');
        expect(env.error?.message ?? '').toContain('published');
      });

      it('accepts all six canonical lifecycle statuses', async () => {
        for (const status of CANONICAL_LIFECYCLE_STATUSES) {
          const slug = `t11060-valid-${status}`;
          const original = join(projectRoot, `orig-${status}.md`);
          await writeFile(original, `content for ${status}\n`, 'utf-8');

          const addRes = runCli(
            [
              'docs',
              'add',
              `T-T11060-V-${status}`,
              original,
              '--slug',
              slug,
              '--type',
              'note',
            ],
            projectRoot,
          );
          expect(
            addRes.status,
            `docs add failed for status=${status}: stderr=${addRes.stderr}`,
          ).toBe(0);

          const upRes = runCli(
            ['docs', 'update', slug, '--content', `updated to ${status}\n`, '--status', status],
            projectRoot,
          );
          expect(
            upRes.status,
            `docs update --status ${status} failed: code=${upRes.status} stdout=${upRes.stdout} stderr=${upRes.stderr}`,
          ).toBe(0);
        }
      });
    },
  );
});

/**
 * End-to-end tests for `cleo docs add --strict` body-schema validation (T10160).
 *
 * Drives the compiled `cleo` CLI as a subprocess against an isolated tmp
 * `CLEO_PROJECT_ROOT` to verify:
 *
 * 1. `--strict` on an ADR body missing the `Decision` H2 → E_DOC_SCHEMA_MISMATCH
 *    envelope on stdout, non-zero exit, missing-sections list in details.
 * 2. (default / advisory) the same body succeeds — the write completes and the
 *    envelope still reports `success: true`.
 * 3. `--strict` on a complete ADR body → write succeeds, no warning.
 * 4. `--strict` for a kind with no `requiredSections` (e.g. `note`) → write
 *    succeeds regardless of body shape.
 *
 * The strict-args schema mirror is kept in sync with the production schema
 * by `docs-add-strict-args.test.ts`; this suite exercises the runtime
 * behaviour wired in {@link import('../../../dispatch/domains/docs.js')}.
 *
 * @task T10160 (E12.C3 · absorbs T10154)
 * @epic T10157
 * @saga T9855
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
    /** Numeric exit code (1 by default) — `codeName` carries the symbolic id. */
    readonly code?: number | string;
    /** Symbolic error name (e.g. `E_DOC_SCHEMA_MISMATCH`). */
    readonly codeName?: string;
    readonly message?: string;
    readonly fix?: string;
    readonly details?: Record<string, unknown>;
  };
  readonly meta?: {
    readonly operation?: string;
    readonly command?: string;
    readonly timestamp?: string;
    readonly warnings?: ReadonlyArray<{ code?: string; message?: string }>;
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

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T10160-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

describe.skipIf(!CLI_DIST_AVAILABLE)(
  'T10160 — cleo docs add --strict body schema validation',
  () => {
    it('(a) --strict + ADR missing Decision → E_DOC_SCHEMA_MISMATCH with details.missing', async () => {
      const file = join(projectRoot, 'bad-adr.md');
      await writeFile(
        file,
        [
          '## Status',
          'Accepted',
          '',
          '## Date',
          '2026-05-24',
          '',
          '## Context',
          'why',
          '',
          '## Consequences',
          'plus/minus',
        ].join('\n'),
        'utf-8',
      );

      const r = runCli(
        ['docs', 'add', 'T-T10160-a', file, '--type', 'adr', '--strict'],
        projectRoot,
      );

      expect(r.status, `expected non-zero exit; stdout=${r.stdout}`).not.toBe(0);
      const env = parseEnvelope(r.stdout);
      expect(env.success).toBe(false);
      // Symbolic error name lives at `codeName`; `code` is the numeric exit code.
      expect(env.error?.codeName).toBe('E_DOC_SCHEMA_MISMATCH');
      expect(env.error?.message).toContain('Decision');
      expect(env.error?.details).toMatchObject({
        kind: 'adr',
        missing: ['Decision'],
        strict: true,
      });
    });

    it('(b) advisory mode (default) + ADR missing Decision → write succeeds', async () => {
      const file = join(projectRoot, 'advisory-adr.md');
      await writeFile(file, '## Status\nA\n## Context\nC\n', 'utf-8');

      const r = runCli(['docs', 'add', 'T-T10160-b', file, '--type', 'adr'], projectRoot);

      expect(r.status, `expected success; stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const env = parseEnvelope<{ sha256: string }>(r.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.sha256).toBeTruthy();
    });

    it('(c) --strict + complete ADR body → write succeeds', async () => {
      const file = join(projectRoot, 'good-adr.md');
      await writeFile(
        file,
        [
          '## Status',
          'A',
          '## Date',
          'd',
          '## Context',
          'c',
          '## Decision',
          'do it',
          '## Consequences',
          'p',
        ].join('\n'),
        'utf-8',
      );

      const r = runCli(
        ['docs', 'add', 'T-T10160-c', file, '--type', 'adr', '--strict'],
        projectRoot,
      );

      expect(r.status, `expected success; stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const env = parseEnvelope<{ sha256: string }>(r.stdout);
      expect(env.success).toBe(true);
    });

    it('(d) --strict + kind with no requiredSections (note) → free-form body accepted', async () => {
      const file = join(projectRoot, 'note.md');
      await writeFile(file, 'free-form observation prose, no headers at all.\n', 'utf-8');

      const r = runCli(
        ['docs', 'add', 'O-T10160-d', file, '--type', 'note', '--strict'],
        projectRoot,
      );

      expect(r.status, `expected success; stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const env = parseEnvelope<{ sha256: string }>(r.stdout);
      expect(env.success).toBe(true);
    });
  },
);

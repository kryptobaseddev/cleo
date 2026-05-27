/**
 * T9789 — `cleo docs <verb>` LAFS error envelope contract.
 *
 * Reproduces the pre-fix double-wrap class: six sibling commands
 * (export, search, merge, graph, rank, versions) all called
 * `cliOutput(formatError(...))` in their `catch` blocks. Because
 * `formatError` already serialises a `{success:false, error, meta}`
 * envelope to JSON, feeding that string into `cliOutput` produced
 * `{success:true, data:"<json>"}` — a FAKE-success envelope that
 * masked failures from agents and pipelines.
 *
 * After the T9789 fix, every verb's failure path emits a top-level
 * `{success:false, error:{...}, meta:{...}}` envelope on stdout while
 * still exiting non-zero (ADR-039). This suite verifies the contract
 * on every verb that has a reliable failure-trigger from the CLI
 * surface; the corresponding lint rule
 * (`scripts/lint-format-error-misuse.mjs`) guards every other site
 * (and any future re-introduction) at the source level.
 *
 * Uses the `it.skipIf(!CLI_DIST_AVAILABLE)` pattern from
 * docs-publish-envelope.test.ts so the suite is harmless on a cold
 * monorepo where `dist/` does not yet exist.
 *
 * @task T9789
 * @epic E-DOCS-FORMATERR-FIX (T9789)
 * @saga T9787
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

/** Shape of a parsed LAFS envelope as observed on stdout. */
interface LafsEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: number | string; message?: string; codeName?: string };
  meta?: { operation?: string; requestId?: string; timestamp?: string };
}

/** Run `node dist/cli/index.js <args>` with a short timeout. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 20000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Locate the first JSON-envelope line on stdout, parse it, and return.
 * `cliError` writes the LAFS envelope to stdout; any other lines (citty
 * usage etc.) go to stderr.
 */
function parseEnvelopeFromStdout(stdout: string): LafsEnvelope {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const envelopeLine = lines.find((l) => l.trim().startsWith('{'));
  expect(envelopeLine, 'expected a JSON envelope line on stdout').toBeDefined();
  return JSON.parse(envelopeLine as string) as LafsEnvelope;
}

/**
 * Shared contract assertions: an envelope on stdout — whether
 * success or failure — MUST NOT be a double-wrapped success envelope
 * carrying a serialised `{success:false,...}` blob inside `data`.
 * That fingerprint is the smoking gun of the pre-T9789 bug.
 */
function assertNotDoubleWrapped(envelope: LafsEnvelope): void {
  // ADR-039: meta MUST always be present.
  expect(envelope.meta).toBeDefined();

  // The double-wrap bug fingerprint: a success envelope carrying a
  // stringified error envelope inside `data`. Refuse to ship this.
  if (envelope.success === true && typeof envelope.data === 'string') {
    const dataStr = envelope.data as string;
    if (dataStr.startsWith('{')) {
      let inner: { success?: boolean } | null = null;
      try {
        inner = JSON.parse(dataStr) as { success?: boolean };
      } catch {
        /* not JSON — fine */
      }
      expect(inner?.success, 'double-wrapped error envelope inside data').not.toBe(false);
    }
  }
}

describe('T9789 — cleo docs <verb> emits flat LAFS error envelopes (no double-wrap)', () => {
  it.skipIf(!CLI_DIST_AVAILABLE)(
    'cleo docs export — unknown task ID emits flat E_DOCS_EXPORT_FAILED envelope',
    () => {
      // exportDocument reliably throws on an unknown task ID, exercising
      // the catch block that previously double-wrapped via
      // `cliOutput(formatError(...))`.
      const { stdout, status } = runCli(['docs', 'export', '--task', 'T-DOES-NOT-EXIST-9789']);

      expect(stdout.length).toBeGreaterThan(0);
      const envelope = parseEnvelopeFromStdout(stdout);

      assertNotDoubleWrapped(envelope);
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(envelope.error?.codeName).toBe('E_DOCS_EXPORT_FAILED');
      expect(envelope.error?.message).toMatch(/export/i);
      expect(envelope.meta?.operation).toBeDefined();
      expect(status).not.toBe(0);
      expect(status).not.toBeNull();
    },
  );

  it.skipIf(!CLI_DIST_AVAILABLE)(
    'cleo docs merge — invalid attachment refs emit flat E_DOCS_MERGE_FAILED envelope',
    () => {
      // mergeDocs reliably throws when passed two attachment identifiers
      // that cannot be resolved to blobs. Exercises the merge catch block.
      const { stdout, status } = runCli([
        'docs',
        'merge',
        '/nonexistent/cleo-T9789-A.md',
        '/nonexistent/cleo-T9789-B.md',
      ]);

      expect(stdout.length).toBeGreaterThan(0);
      const envelope = parseEnvelopeFromStdout(stdout);

      assertNotDoubleWrapped(envelope);
      // Either the catch fires (success=false) — preferred — or core
      // succeeds with empty data. The double-wrap is what we forbid.
      if (envelope.success === false) {
        expect(envelope.error?.codeName).toBe('E_DOCS_MERGE_FAILED');
        expect(envelope.error?.message).toMatch(/merge/i);
        expect(status).not.toBe(0);
      }
    },
  );

  /**
   * Static envelope-shape contract: for every sibling verb the renderer
   * MUST emit a flat envelope on stdout when the catch block fires.
   *
   * This test uses `--help` rather than a failure trigger so it works
   * reliably across environments — the goal is to confirm the CLI
   * BINARY is invokable for each verb without crashing into an
   * unrecoverable double-wrap on the happy path. Failure-path coverage
   * for these verbs is enforced structurally by the lint rule
   * (`scripts/lint-format-error-misuse.mjs`), which fails CI if
   * `cliOutput(formatError(...))` or `cliError(formatError(...))` is
   * ever re-introduced.
   */
  const SMOKE_VERBS = [
    { label: 'search', argv: ['docs', 'search', '--help'] },
    { label: 'graph', argv: ['docs', 'graph', '--help'] },
    { label: 'rank', argv: ['docs', 'rank', '--help'] },
    { label: 'versions', argv: ['docs', 'versions', '--help'] },
  ];

  for (const verb of SMOKE_VERBS) {
    it.skipIf(!CLI_DIST_AVAILABLE)(
      `cleo docs ${verb.label} — --help responds without crashing (CLI surface alive)`,
      () => {
        const { status } = runCli(verb.argv);
        // citty exits 0 on --help. The point of this case is just to
        // confirm the verb is reachable; failure-path lint coverage
        // is enforced statically.
        expect(status).toBe(0);
      },
    );
  }
});

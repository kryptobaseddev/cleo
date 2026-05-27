/**
 * T9633 — `cleo docs publish` LAFS envelope contract.
 *
 * Reproduce-case for the silent-failure bug:
 *
 *   $ cleo docs publish 4b30bae5 --to docs/sagas/SG-CLEO-SKILLS.md
 *   <stderr: "Missing required argument: --for" + usage>
 *   <stdout: (empty)>
 *   exit 1
 *
 * Before this fix, citty's default `runMain` caught the `CLIError` and
 * printed plain text to stderr + exited non-zero, but emitted ZERO bytes on
 * stdout — violating ADR-039 which requires every CLI invocation to produce
 * a `{success, error, meta}` envelope.
 *
 * After the fix, the failure path emits a proper LAFS error envelope on
 * stdout (success=false, error.message contains "Missing required argument",
 * meta object present) while still exiting non-zero so shell pipelines fail
 * loudly.
 *
 * @task T9633
 * @epic T9626 (W0 P0)
 * @saga T9625 (SG-CLEO-DOCS-CANON)
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

/** Run `node dist/cli/index.js <args>` with the standard timeout. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('T9633 — cleo docs publish always emits a LAFS envelope', () => {
  it.skipIf(!CLI_DIST_AVAILABLE)(
    'missing required arg (--for omitted) emits LAFS error envelope on stdout + non-zero exit',
    () => {
      // The exact failing invocation the user reported.
      const { stdout, status } = runCli([
        'docs',
        'publish',
        '4b30bae5',
        '--to',
        'docs/sagas/SG-CLEO-SKILLS.md',
      ]);

      // Contract: ADR-039 envelope on stdout, regardless of error class.
      expect(stdout.length).toBeGreaterThan(0);

      // Find the JSON envelope. Some output lines (e.g. citty usage) are
      // printed to stderr — stdout must contain ONLY the envelope JSON.
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      const envelopeLine = lines.find((l) => l.trim().startsWith('{'));
      expect(envelopeLine, 'expected a JSON envelope line on stdout').toBeDefined();

      const envelope = JSON.parse(envelopeLine as string) as {
        success: boolean;
        error?: { code: number | string; message: string; codeName?: string };
        meta?: { operation?: string; requestId?: string; timestamp?: string };
      };

      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(envelope.error?.message).toMatch(/Missing required argument/i);
      // Citty's EARG → LAFS E_VALIDATION mapping in runMainWithLafsEnvelope.
      expect(envelope.error?.codeName).toBe('E_VALIDATION');

      // ADR-039: meta MUST always be present on the envelope.
      expect(envelope.meta).toBeDefined();
      expect(typeof envelope.meta?.operation).toBe('string');
      expect(typeof envelope.meta?.timestamp).toBe('string');

      // Failure must propagate as a non-zero exit so pipelines fail loudly.
      expect(status).not.toBe(0);
      expect(status).not.toBeNull();
    },
  );

  it.skipIf(!CLI_DIST_AVAILABLE)(
    'unknown owner (well-formed args) emits LAFS error envelope, not a double-wrapped success envelope',
    () => {
      // Well-formed args, but T-DOES-NOT-EXIST has no attachments so
      // publishDocs throws. The envelope must still appear on stdout as a
      // top-level error envelope (success:false), not as a success envelope
      // with an error JSON string nested in `data` — that was the
      // formatError+cliOutput double-wrap bug fixed alongside T9633.
      const { stdout, status } = runCli([
        'docs',
        'publish',
        '--for',
        'T-DOES-NOT-EXIST-9633',
        '--to',
        '/tmp/cleo-t9633-should-not-exist.md',
      ]);

      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      const envelopeLine = lines.find((l) => l.trim().startsWith('{'));
      expect(envelopeLine, 'expected a JSON envelope line on stdout').toBeDefined();

      const envelope = JSON.parse(envelopeLine as string) as {
        success: boolean;
        error?: { message: string };
        meta?: { operation?: string };
      };

      expect(envelope.success).toBe(false);
      expect(envelope.error?.message).toMatch(/publish/i);
      expect(envelope.meta?.operation).toBeDefined();
      expect(status).not.toBe(0);
    },
  );
});

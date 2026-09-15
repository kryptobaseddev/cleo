/**
 * `cleo release plan` — readiness gate must agree with itself (gh#1366).
 *
 * The defect is a DISAGREEMENT between two readings of one run:
 *
 *   stdout   { "success": true, ... }        <- envelope said the plan succeeded
 *   stderr   FAILED gates: changeset-lint
 *   exit     1
 *
 * Both readings are consumed by automation — `release-prepare.yml` gates on the
 * exit code, and CLEO-INJECTION.md instructs every spawned agent to gate on the
 * envelope — so the two disagreeing means the pipeline's answer depends on which
 * consumer is asking.
 *
 * Every test here therefore asserts the envelope AND the exit code TOGETHER. A
 * test that reads only one of them is structurally incapable of seeing this bug:
 * the old code produced a correct-looking exit code and a correct-looking
 * envelope, and was wrong only in their relationship.
 *
 * Spawns the compiled CLI rather than calling the handler in-process, because
 * `process.exitCode` at the real process boundary is half of what is being
 * asserted and does not exist in-process.
 *
 * @task gh#1366
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `packages/cleo/`. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to the compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

/**
 * In CI the `Build packages` step runs before the tests, so a missing dist is a
 * broken job rather than a local convenience. Failing here keeps this file from
 * becoming the thing gh#1403 was about: a check that reports success by not
 * running. Locally (no CI env) the suite skips with the dist absent.
 */
if (process.env['CI'] === 'true' && !CLI_DIST_AVAILABLE) {
  throw new Error(
    `CI run with no compiled CLI at ${CLI_DIST}. These tests assert on the real ` +
      'process boundary and must not silently skip.',
  );
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/** Run the compiled CLI against an isolated project root. */
function runCli(args: readonly string[], projectRoot: string): CliResult {
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 120_000,
    cwd: projectRoot,
    env: {
      ...process.env,
      CLEO_PROJECT_ROOT: projectRoot,
      CLEO_ROOT: projectRoot,
      CLEO_DIR: join(projectRoot, '.cleo'),
      CLEO_OUTPUT_FORMAT: 'json',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface Envelope {
  readonly success: boolean;
  readonly error?: { readonly code?: number | string; readonly codeName?: string };
}

/** Pull the LAFS envelope off stdout; the readiness report is plain text above it. */
function parseEnvelope(stdout: string): Envelope {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Envelope;
    } catch {
      /* not the envelope line */
    }
  }
  throw new Error(`no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

let projectRoot: string;

beforeEach(async () => {
  // A root with no CHANGELOG.md and no scripts/lint-changesets.mjs — both
  // error-severity gates fail, which is the blocking condition.
  projectRoot = await mkdtemp(join(tmpdir(), 'release-readiness-'));
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo release plan — blocked by readiness (gh#1366)', () => {
  it('emits success:false AND a non-zero exit — the two must agree', () => {
    const r = runCli(['release', 'plan', 'v2026.9.99', '--epic', 'T1'], projectRoot);
    const envelope = parseEnvelope(r.stdout);

    // Neither assertion alone can see the defect. The old code produced a
    // non-zero exit (via the backstop) with success:true on stdout, so a test
    // asserting only the exit code passed against the bug.
    expect(envelope.success, 'envelope must not claim success').toBe(false);
    expect(r.status, 'process must exit non-zero').not.toBe(0);

    // Stated as one proposition so the failure message names the disagreement.
    expect({ envelopeSuccess: envelope.success, exitedZero: r.status === 0 }).toEqual({
      envelopeSuccess: false,
      exitedZero: false,
    });
  });

  it('names the failure with a typed code rather than a generic one', () => {
    const r = runCli(['release', 'plan', 'v2026.9.99', '--epic', 'T1'], projectRoot);
    const envelope = parseEnvelope(r.stdout);

    expect(envelope.error?.codeName).toBe('E_READINESS_GATE_FAILED');
    expect(envelope.error?.code).toBe(6);
    // The numeric code in the envelope is what the shell saw.
    expect(r.status).toBe(6);
  });

  it('does not write a plan file when the gate blocks', () => {
    runCli(['release', 'plan', 'v2026.9.99', '--epic', 'T1'], projectRoot);
    // The original defect planned the release anyway; the envelope's claim that
    // no plan was written has to be true.
    expect(existsSync(join(projectRoot, '.cleo', 'release', 'v2026.9.99.plan.json'))).toBe(false);
  });

  it('--skip-readiness still bypasses the gate', () => {
    // The escape hatch must survive. This run will fail for unrelated reasons in
    // an empty project root — what matters is that it is NOT the readiness code,
    // i.e. the gate was genuinely skipped rather than merely renamed.
    const r = runCli(
      ['release', 'plan', 'v2026.9.99', '--epic', 'T1', '--skip-readiness'],
      projectRoot,
    );
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).not.toContain('E_READINESS_GATE_FAILED');
  });
});

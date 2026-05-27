/**
 * Default real `SmokeEnvironment` implementation for `runShipE2eSmoke`.
 *
 * Wraps `spawnSync` calls to `cleo`, `gh`, `git`, and `npm view` so the
 * smoke walker can drive the production toolchain without coupling its
 * orchestration logic to any specific runtime. Tests bypass this module
 * entirely by injecting a fake `SmokeEnvironment` directly into
 * {@link runShipE2eSmoke}.
 *
 * @task T10103
 * @epic E-CLEO-RELEASE-VERBS
 * @saga T10099
 */

import { spawnSync } from 'node:child_process';
import type { SmokeEnvironment } from './ship-e2e-smoke.js';

/** Sleep for the given milliseconds (poll backoff helper). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a child process and return its trimmed stdout. Throws when the
 * exit code is non-zero so callers can decide whether to retry or fail
 * the step. Inherits the parent stderr stream so debug output reaches
 * the operator without being swallowed.
 */
function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with status ${result.status}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * Poll `predicate` at `pollIntervalMs` until it returns a non-null
 * value or the deadline is exceeded. Throws when the deadline hits.
 */
async function pollUntil<T>(
  label: string,
  predicate: () => Promise<T | null>,
  deadlineEpochMs: number,
  pollIntervalMs: number,
): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await predicate();
    if (value !== null) return value;
    if (Date.now() >= deadlineEpochMs) {
      throw new Error(`${label}: deadline exceeded`);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Construct the production `SmokeEnvironment`. Pass `cleoBin` to point
 * at a non-default `cleo` binary (defaults to whatever resolves on
 * PATH).
 */
export function createDefaultSmokeEnvironment(opts: { cleoBin?: string } = {}): SmokeEnvironment {
  const cleo = opts.cleoBin ?? 'cleo';
  return {
    async runPlan({ version, epicId }) {
      run(cleo, ['release', 'plan', version, '--epic', epicId]);
      return { planPath: `.cleo/release/${version}.plan.json` };
    },
    async runOpen({ version }) {
      run(cleo, ['release', 'open', version]);
      return { workflowRunId: 'dispatched' };
    },
    async waitForPr({ version, deadlineEpochMs, pollIntervalMs }) {
      const branch = `release/${version}`;
      const prNumber = await pollUntil<number>(
        `wait-for-pr ${branch}`,
        async () => {
          const out = run('gh', [
            'pr',
            'list',
            '--head',
            branch,
            '--state',
            'merged',
            '--json',
            'number',
            '--jq',
            '.[0].number // empty',
          ]);
          if (!out) return null;
          const n = Number.parseInt(out, 10);
          return Number.isFinite(n) ? n : null;
        },
        deadlineEpochMs,
        pollIntervalMs,
      );
      return { prNumber };
    },
    async waitForTag({ version, deadlineEpochMs, pollIntervalMs }) {
      const tagSha = await pollUntil<string>(
        `wait-for-tag ${version}`,
        async () => {
          const out = run('git', ['ls-remote', '--tags', 'origin', version]);
          const line = out.split('\n').find((l) => l.includes(`refs/tags/${version}`));
          if (!line) return null;
          const sha = line.split(/\s+/)[0];
          return sha && sha.length > 0 ? sha : null;
        },
        deadlineEpochMs,
        pollIntervalMs,
      );
      return { tagSha };
    },
    async verifyNpmPublished({ version, deadlineEpochMs, pollIntervalMs }) {
      const stripped = version.startsWith('v') ? version.slice(1) : version;
      const tarballUrl = await pollUntil<string>(
        `verify-npm-published ${stripped}`,
        async () => {
          try {
            const url = run('npm', ['view', `@cleocode/cleo@${stripped}`, 'dist.tarball']);
            return url.length > 0 ? url : null;
          } catch {
            return null;
          }
        },
        deadlineEpochMs,
        pollIntervalMs,
      );
      return { tarballUrl };
    },
    now: () => Date.now(),
  };
}

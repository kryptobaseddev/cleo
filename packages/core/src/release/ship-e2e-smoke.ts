/**
 * Ship E2E Smoke — one-shot walker that validates the full release
 * lifecycle from `plan` through `npm publish`.
 *
 * Why this exists (T10103 · Saga T10099 SG-RELEASE-AUDIT-V2)
 * ----------------------------------------------------------
 * The v2026.5.100 release ship required four manual interventions
 * (manual `gh workflow run`, manual `git tag + push`, manual CHANGELOG
 * append, manual `npm install -g`). The smoke walker exists to detect
 * those gaps mechanically on every release before the operator runs the
 * real flow — gaps surface as `step.status === 'failed'` instead of as
 * 3am dogfood pain.
 *
 * Architecture
 * ------------
 * The walker is a pure orchestrator: it takes a `SmokeEnvironment`
 * dependency capsule that owns every external interaction (CLI dispatch,
 * `gh` polling, `npm view`). Tests inject a fake environment to assert
 * step ordering and dry-run semantics without touching the network.
 *
 * Steps (each idempotent — re-runnable from any failure point):
 *   1. plan                 — build & persist Release Plan envelope
 *   2. open                 — dispatch release-prepare workflow
 *   3. wait-for-pr          — poll until release PR merges
 *   4. wait-for-tag         — poll until `v<version>` git tag visible
 *   5. verify-npm-published — poll until `npm view @cleocode/cleo@<v>`
 *                             resolves
 *
 * Dry-run mode (default): every step reports what it WOULD do and
 * returns `status: 'skipped'`. `--execute` flips the runner to perform
 * the real mutations.
 *
 * @task T10103
 * @epic E-CLEO-RELEASE-VERBS
 * @saga T10099
 */

import type {
  ShipE2eSmokeFinalState,
  ShipE2eSmokeParams,
  ShipE2eSmokeResult,
  ShipE2eSmokeStep,
  ShipE2eSmokeStepName,
} from '@cleocode/contracts';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Pluggable environment for the smoke walker. Every operation the
 * walker performs is routed through this capsule so tests can inject
 * fakes without monkey-patching globals.
 */
export interface SmokeEnvironment {
  /**
   * Run `cleo release plan <version> --epic <id>`. Returns the resolved
   * plan path so the walker can include it in the step detail.
   */
  runPlan(args: { version: string; epicId: string }): Promise<{ planPath: string }>;
  /**
   * Run `cleo release open <version>`. Returns the workflow run ID
   * dispatched by `gh workflow run`.
   */
  runOpen(args: { version: string }): Promise<{ workflowRunId: string }>;
  /**
   * Poll `gh pr list --state merged --search "release/v<version>"`
   * until the release PR is merged or the deadline is hit. Returns the
   * merged PR number.
   */
  waitForPr(args: { version: string; deadlineEpochMs: number; pollIntervalMs: number }): Promise<{
    prNumber: number;
  }>;
  /**
   * Poll `git ls-remote --tags origin v<version>` until the tag is
   * visible or the deadline is hit. Returns the tag commit SHA.
   */
  waitForTag(args: { version: string; deadlineEpochMs: number; pollIntervalMs: number }): Promise<{
    tagSha: string;
  }>;
  /**
   * Poll `npm view @cleocode/cleo@<version>` until the version
   * resolves on the registry or the deadline is hit. Returns the
   * registry-reported tarball URL.
   */
  verifyNpmPublished(args: {
    version: string;
    deadlineEpochMs: number;
    pollIntervalMs: number;
  }): Promise<{ tarballUrl: string }>;
  /**
   * Wall-clock now in milliseconds. Tests fake this to avoid `Date.now`
   * coupling.
   */
  now(): number;
}

/**
 * Normalise a user-supplied version to the `v`-prefixed form used by
 * git tags and the npm registry.
 */
function ensureVPrefix(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Internal step builder. Records start time, runs the body, captures
 * detail/error, and returns a fully-populated step record.
 */
async function runStep(
  name: ShipE2eSmokeStepName,
  env: SmokeEnvironment,
  body: () => Promise<{ detail: string }>,
): Promise<ShipE2eSmokeStep> {
  const start = env.now();
  try {
    const { detail } = await body();
    return {
      name,
      status: 'ok',
      durationMs: env.now() - start,
      detail,
    };
  } catch (err) {
    return {
      name,
      status: 'failed',
      durationMs: env.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Step factory for dry-run mode — every step short-circuits to skipped. */
function skippedStep(name: ShipE2eSmokeStepName, detail: string): ShipE2eSmokeStep {
  return { name, status: 'skipped', durationMs: 0, detail };
}

/**
 * Order of state transitions advanced by each successful step. Used to
 * compute `finalState` at smoke termination.
 */
const STEP_TO_FINAL_STATE: Record<ShipE2eSmokeStepName, ShipE2eSmokeFinalState> = {
  plan: 'planned',
  open: 'pr-opened',
  'wait-for-pr': 'pr-merged',
  'wait-for-tag': 'tag-pushed',
  'verify-npm-published': 'npm-published',
};

/**
 * Run the smoke walker against the given environment. Returns the
 * aggregate envelope. Never throws — all errors are captured in step
 * records so the envelope is always parseable.
 */
export async function runShipE2eSmoke(
  params: ShipE2eSmokeParams,
  env: SmokeEnvironment,
): Promise<ShipE2eSmokeResult> {
  const versionRaw = params.version;
  const versionV = ensureVPrefix(versionRaw);
  const totalTimeout = params.totalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollInterval = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = env.now();
  const deadlineEpochMs = startedAt + totalTimeout;

  const steps: ShipE2eSmokeStep[] = [];
  let finalState: ShipE2eSmokeFinalState = 'not-started';

  // Dry-run path — every step short-circuits with the planned action.
  if (!params.execute) {
    steps.push(
      skippedStep('plan', `would run: cleo release plan ${versionV} --epic ${params.epicId}`),
    );
    steps.push(skippedStep('open', `would run: cleo release open ${versionV}`));
    steps.push(
      skippedStep('wait-for-pr', `would poll: gh pr list release/${versionV} --state merged`),
    );
    steps.push(skippedStep('wait-for-tag', `would poll: git ls-remote --tags origin ${versionV}`));
    steps.push(
      skippedStep(
        'verify-npm-published',
        `would poll: npm view @cleocode/cleo@${versionRaw.replace(/^v/, '')}`,
      ),
    );
    finalState = 'planned';
    return {
      success: true,
      version: versionV,
      executed: false,
      steps,
      finalState,
      totalDurationMs: env.now() - startedAt,
    };
  }

  // Execute path — each step runs sequentially; first failure stops the
  // walker but the envelope still reports every prior step.
  const planStep = await runStep('plan', env, async () => {
    const { planPath } = await env.runPlan({ version: versionV, epicId: params.epicId });
    return { detail: `plan written: ${planPath}` };
  });
  steps.push(planStep);
  if (planStep.status === 'failed') {
    return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
  }
  finalState = STEP_TO_FINAL_STATE.plan;

  const openStep = await runStep('open', env, async () => {
    const { workflowRunId } = await env.runOpen({ version: versionV });
    return { detail: `workflow dispatched: run=${workflowRunId}` };
  });
  steps.push(openStep);
  if (openStep.status === 'failed') {
    return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
  }
  finalState = STEP_TO_FINAL_STATE.open;

  const prStep = await runStep('wait-for-pr', env, async () => {
    const { prNumber } = await env.waitForPr({
      version: versionV,
      deadlineEpochMs,
      pollIntervalMs: pollInterval,
    });
    return { detail: `release PR merged: #${prNumber}` };
  });
  steps.push(prStep);
  if (prStep.status === 'failed') {
    return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
  }
  finalState = STEP_TO_FINAL_STATE['wait-for-pr'];

  const tagStep = await runStep('wait-for-tag', env, async () => {
    const { tagSha } = await env.waitForTag({
      version: versionV,
      deadlineEpochMs,
      pollIntervalMs: pollInterval,
    });
    return { detail: `tag ${versionV} visible at ${tagSha.slice(0, 12)}` };
  });
  steps.push(tagStep);
  if (tagStep.status === 'failed') {
    return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
  }
  finalState = STEP_TO_FINAL_STATE['wait-for-tag'];

  const npmStep = await runStep('verify-npm-published', env, async () => {
    const { tarballUrl } = await env.verifyNpmPublished({
      version: versionV,
      deadlineEpochMs,
      pollIntervalMs: pollInterval,
    });
    return { detail: `npm publish confirmed: ${tarballUrl}` };
  });
  steps.push(npmStep);
  if (npmStep.status === 'failed') {
    return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
  }
  finalState = STEP_TO_FINAL_STATE['verify-npm-published'];

  return finalEnvelope(versionV, true, steps, finalState, env.now() - startedAt);
}

/** Assemble the terminal envelope. Aggregate success = no failed steps. */
function finalEnvelope(
  versionV: string,
  executed: boolean,
  steps: ShipE2eSmokeStep[],
  finalState: ShipE2eSmokeFinalState,
  totalDurationMs: number,
): ShipE2eSmokeResult {
  const success = steps.every((s) => s.status !== 'failed');
  return {
    success,
    version: versionV,
    executed,
    steps,
    finalState,
    totalDurationMs,
  };
}

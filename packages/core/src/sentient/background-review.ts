/**
 * Background-review fork for the skill auto-improve loop.
 *
 * TypeScript port of the Hermes `agent/background_review.py` daemon-thread
 * pattern (`spawn_background_review_thread`, `_run_review_in_thread`). The
 * background-review fork is the bridge between live skill usage and the
 * auto-improve council pipeline: when the sentient daemon decides a skill
 * deserves a review, it spawns a worker that
 *
 *   1. Builds the canonical review prompt via {@link buildSkillReviewPrompt}.
 *   2. Installs the `'background-review'` write-origin frame so every
 *      downstream skills.db mutation is provenance-tagged (and refused if
 *      it targets a `canonical` row — see T9708).
 *   3. Invokes the provided callback (an LLM call site in production, an
 *      injected stub in tests) and surfaces the verdict back to the daemon.
 *   4. Suppresses worker-thread stdio so the review output doesn't pollute
 *      the daemon's log stream (the verdict is the single channel back).
 *
 * ## Surface
 *
 * - {@link SkillReviewVerdict}    — the structured outcome a callback returns.
 * - {@link RunReviewInlineArgs}   — argument shape for the in-process variant.
 * - {@link RunReviewInlineResult} — return shape including the prompt that
 *                                    was used (handy for `cleo sentient
 *                                    review-status` and audit logs).
 * - {@link runReviewInline}       — synchronous variant that runs the callback
 *                                    inside the current event loop but still
 *                                    installs the provenance frame. Used by
 *                                    unit tests and by callers that don't
 *                                    need the OS-level isolation a worker
 *                                    thread provides.
 * - {@link spawnReviewWorker}     — fork-style variant: runs the callback
 *                                    inside a `node:worker_threads.Worker`
 *                                    so stdio is suppressed and the OS will
 *                                    reap the worker on parent crash.
 *
 * ## Why two entry points?
 *
 * The Hermes original splits "build the target + prompt" from "actually
 * construct the thread" so test-level patches still work. We follow the
 * same shape: `runReviewInline` is the unit-testable inner loop; the worker
 * variant wraps it in OS isolation when a real daemon spawns it. Both share
 * the same provenance contract.
 *
 * @task T9707
 * @epic T9563
 * @saga T9560
 * @port-of agent/background_review.py (Hermes Agent)
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §6-§7
 */

import { Worker } from 'node:worker_threads';
import {
  type BuildSkillReviewPromptArgs,
  buildSkillReviewPrompt,
} from './skill-review-prompt.js';
import { type SkillWriteOrigin, withProvenance } from './skill-provenance.js';

// ---------------------------------------------------------------------------
// Verdict + argument types
// ---------------------------------------------------------------------------

/**
 * The structured verdict returned by a review callback / worker.
 *
 * Mirrors the three terminal decisions the prompt template asks for
 * (see {@link buildSkillReviewPrompt}). The summary is free-form prose
 * used for the audit log + the `cleo sentient review-status` listing.
 */
export interface SkillReviewVerdict {
  /** Terminal decision — one of `approved`, `rejected`, `needs-changes`. */
  readonly decision: 'approved' | 'rejected' | 'needs-changes';
  /** Free-form verdict prose (1-3 sentences in the prompt contract). */
  readonly summary: string;
  /**
   * Optional unified diff produced by the callback when `decision` is
   * `approved` and the reviewer wants the fork to also propose a patch.
   * The daemon downstream of {@link runReviewInline} hands this off to
   * {@link applyLocalSkillPatch} (for user/community/agent-created rows)
   * or to the `cleo skill propose-patch` PR path (for canonical rows).
   */
  readonly diff?: string;
}

/**
 * Callback signature that runReviewInline / spawnReviewWorker invoke once
 * the provenance frame is installed.
 *
 * Production call sites pass an LLM-driven adapter; unit tests inject a
 * synchronous stub that asserts on the active provenance frame.
 */
export type SkillReviewCallback = (prompt: string) => Promise<SkillReviewVerdict>;

/**
 * Argument bag for {@link runReviewInline}.
 *
 * Combines the prompt-build inputs (see {@link BuildSkillReviewPromptArgs})
 * with the callback that actually runs the review and an optional
 * provenance override (defaults to `'background-review'`).
 */
export interface RunReviewInlineArgs extends BuildSkillReviewPromptArgs {
  /** The reviewer callback. See {@link SkillReviewCallback}. */
  readonly callback: SkillReviewCallback;
  /**
   * Override the provenance frame installed for the duration of the
   * callback. Defaults to `'background-review'` — only override in tests
   * that need to validate the guard from a different origin.
   */
  readonly origin?: SkillWriteOrigin;
}

/**
 * Result envelope returned by {@link runReviewInline}.
 *
 * Exposes both the verdict and the prompt that was built so daemons can
 * persist the prompt alongside the review row (`skill_reviews.summary`
 * stores the verdict; the prompt is captured in the audit log).
 */
export interface RunReviewInlineResult {
  /** The verdict returned by the callback. */
  readonly verdict: SkillReviewVerdict;
  /** The full prompt that was passed to the callback. */
  readonly prompt: string;
}

// ---------------------------------------------------------------------------
// runReviewInline — synchronous variant (testable inner loop)
// ---------------------------------------------------------------------------

/**
 * Run a review callback inside the `background-review` provenance frame.
 *
 * This is the unit-testable inner loop — it does NOT spawn a worker
 * thread. Production daemon code typically goes through
 * {@link spawnReviewWorker} for OS-level isolation, but the worker
 * variant ultimately delegates back to this function inside the worker.
 *
 * Contract:
 *
 *   - Builds the review prompt from `args` via {@link buildSkillReviewPrompt}.
 *   - Installs the requested provenance origin (`background-review` by
 *     default) via {@link withProvenance}.
 *   - Invokes `args.callback(prompt)` inside that frame.
 *   - Returns the callback's verdict + the prompt that was used.
 *   - Propagates callback errors verbatim (the provenance frame still
 *     unwinds cleanly — see test in background-review.test.ts).
 *
 * @example
 * ```typescript
 * const outcome = await runReviewInline({
 *   skillName: 'ct-orchestrator',
 *   recentTaskContext: 'Loaded 12 times last 7d',
 *   lifecycleState: 'active',
 *   callback: async (prompt) => {
 *     const reply = await llm.chat([{ role: 'user', content: prompt }]);
 *     return parseVerdict(reply);
 *   },
 * });
 * ```
 *
 * @param args - See {@link RunReviewInlineArgs}.
 * @returns The verdict + prompt envelope.
 *
 * @task T9707
 */
export async function runReviewInline(args: RunReviewInlineArgs): Promise<RunReviewInlineResult> {
  const prompt = buildSkillReviewPrompt({
    skillName: args.skillName,
    recentTaskContext: args.recentTaskContext,
    lifecycleState: args.lifecycleState,
  });
  const origin: SkillWriteOrigin = args.origin ?? 'background-review';
  const verdict = await withProvenance(origin, async () => {
    return args.callback(prompt);
  });
  return { verdict, prompt };
}

// ---------------------------------------------------------------------------
// spawnReviewWorker — worker-thread variant (OS-isolated fork)
// ---------------------------------------------------------------------------

/**
 * Argument bag for {@link spawnReviewWorker}.
 *
 * The worker form CANNOT serialise a function across the postMessage
 * boundary, so the caller passes the absolute path to a worker entry
 * file. The entry file is responsible for calling {@link runReviewInline}
 * with whatever production callback is appropriate (e.g. an LLM client).
 *
 * The worker `workerData` carries the prompt-build inputs verbatim so
 * the entry file can re-invoke `runReviewInline` with them.
 */
export interface SpawnReviewWorkerArgs extends BuildSkillReviewPromptArgs {
  /**
   * Absolute path to the worker entry file. Typically built at install
   * time and pinned by the daemon's config so test sandboxes can swap it.
   */
  readonly workerEntry: string;
  /**
   * Optional override for the worker's `execArgv` — handy for enabling
   * `--experimental-sqlite` inside the worker on Node versions where the
   * parent has it active but the child doesn't inherit.
   */
  readonly execArgv?: readonly string[];
}

/**
 * Result envelope returned by {@link spawnReviewWorker}.
 *
 * `verdict` is `null` when the worker exited without posting a verdict
 * (timeout, OOM, kill) — daemons MUST treat this as `needs-changes` and
 * surface the failure in the audit log.
 */
export interface SpawnReviewWorkerResult {
  /** Verdict posted by the worker, or `null` on abnormal exit. */
  readonly verdict: SkillReviewVerdict | null;
  /** Non-zero when the worker exited abnormally. */
  readonly exitCode: number;
  /**
   * Captured stderr from the worker, if any. Empty string on success.
   * Worker stdout is suppressed by default (the verdict is the only
   * signal that flows back to the parent).
   */
  readonly stderr: string;
}

/**
 * Spawn a `node:worker_threads.Worker` to run the review out-of-process.
 *
 * The worker entry file at `args.workerEntry` MUST:
 *
 *   1. Import `parentPort` from `node:worker_threads`.
 *   2. Read its task arguments from `workerData` (shape:
 *      `BuildSkillReviewPromptArgs`).
 *   3. Invoke {@link runReviewInline} with those arguments + its own
 *      production callback (LLM client, etc.).
 *   4. `parentPort.postMessage(verdict)` on success.
 *   5. `process.exit(0)` to release the worker thread.
 *
 * Stdio is suppressed (`stdout` + `stderr` redirected to `MessagePort`
 * sinks) so the daemon log stream stays clean — verdicts are the only
 * channel back. The Hermes original used `contextlib.redirect_stdout`
 * for the same reason; Node's `Worker({ stdout, stderr })` flags are
 * the equivalent affordance.
 *
 * @param args - See {@link SpawnReviewWorkerArgs}.
 * @returns A promise resolving when the worker exits.
 *
 * @task T9707
 */
export function spawnReviewWorker(
  args: SpawnReviewWorkerArgs,
): Promise<SpawnReviewWorkerResult> {
  return new Promise<SpawnReviewWorkerResult>((resolve, reject) => {
    const workerData: BuildSkillReviewPromptArgs = {
      skillName: args.skillName,
      recentTaskContext: args.recentTaskContext,
      lifecycleState: args.lifecycleState,
    };
    let worker: Worker;
    try {
      worker = new Worker(args.workerEntry, {
        workerData,
        stdout: true,
        stderr: true,
        ...(args.execArgv ? { execArgv: [...args.execArgv] } : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    let posted: SkillReviewVerdict | null = null;
    let stderrBuf = '';

    worker.stdout?.resume(); // drain — suppression: do nothing with the data.
    worker.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    worker.on('message', (msg: unknown) => {
      // Trust the worker to post the right shape — the entry file is
      // owned-internal code, not user input.
      posted = msg as SkillReviewVerdict;
    });
    worker.on('error', (err) => {
      reject(err);
    });
    worker.on('exit', (code) => {
      resolve({ verdict: posted, exitCode: code, stderr: stderrBuf });
    });
  });
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { buildSkillReviewPrompt } from './skill-review-prompt.js';
export type { BuildSkillReviewPromptArgs } from './skill-review-prompt.js';

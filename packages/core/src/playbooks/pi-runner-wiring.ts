/**
 * Production wiring helper for the Pi in-process `SkillRunner` (T11945 · M4).
 *
 * THE M4 keystone seam: this is the single place the two production cantbook
 * dispatchers (`buildDefaultDispatcher` in `playbook.ts` and `buildGoDispatcher`
 * in `go-ivtr-runner.ts`) reach to obtain the Pi-backed `SkillRunner` they pass
 * into {@link runSkillNodeOrSpawn}'s `runner` slot. When the runner is supplied,
 * an in-process `ct-*` skill node routes THROUGH the {@link
 * import('../llm/pi/pi-agent-adapter.js').PiAgentAdapter} (the Pi agent loop);
 * when it is `undefined`, the adapter falls back to `defaultSkillRunner` — the
 * pre-T11945 behaviour.
 *
 * ## Default-OFF + lazy-import (Gate-13 + OOM safety)
 *
 * The Pi embed is gated behind the **default-OFF** `CLEO_PI_RUNNER_ENABLED`
 * flag. When the flag is unset (the default) this helper returns `undefined`
 * WITHOUT importing the Pi barrel — so `@earendil-works/pi-ai`'s `register-
 * builtins` side effect is never paid on the hot dispatch path, and there is
 * ZERO behaviour change. Only when the flag is explicitly `'1'` do we
 * dynamically import the barrel and construct the runner. The import is dynamic
 * (not a top-level `import`) precisely so the heavy `pi-ai` dependency stays out
 * of `@cleocode/core/internal`'s eager module graph (every CLI dispatcher loads
 * `internal`, but must not load `pi-ai` unless Pi is enabled).
 *
 * Keeping this helper in `core` keeps the CLI dispatchers thin (CLI package
 * boundary, Gate-6): each call site is a single `await maybeCreatePiRunner(...)`.
 *
 * @epic T10403
 * @task T11761
 * @task T11945
 */

import type { SystemOfUseLabel } from '@cleocode/contracts';
import type { SkillRunner } from '../skills/skill-executor-adapter.js';

/**
 * The default-OFF env flag controlling the Pi in-process runner. Mirrors
 * `isPiRunnerEnabled()` in the Pi barrel exactly (strict `'1'`), read here as a
 * cheap pre-check so the heavy Pi/`pi-ai` barrel is only dynamically imported
 * when Pi is actually enabled.
 */
const PI_RUNNER_FLAG = 'CLEO_PI_RUNNER_ENABLED';

/**
 * Resolution + project-root deps forwarded to `createPiSkillRunner` when the Pi
 * runner is constructed. Mirrors the subset of `PiAgentAdapterDeps` the
 * dispatchers can supply at their call site.
 */
export interface MaybePiRunnerDeps {
  /**
   * The system-of-use label the Pi adapter resolves its LLM through (E9). When
   * omitted, `createPiSkillRunner` defaults to `'task-executor'`.
   */
  readonly system?: SystemOfUseLabel;
  /**
   * Project root for config + credential resolution. When omitted, resolution
   * defaults to `process.cwd()` inside `resolveLLMForSystem`.
   */
  readonly projectRoot?: string;
}

/**
 * Return the Pi-backed {@link SkillRunner} when `CLEO_PI_RUNNER_ENABLED=1`, else
 * `undefined`.
 *
 * The two production cantbook dispatchers call this and pass the result into
 * {@link runSkillNodeOrSpawn}'s `runner` slot:
 *
 * @example
 * ```ts
 * const runner = await maybeCreatePiRunner({ system: 'task-executor', projectRoot });
 * await runSkillNodeOrSpawn(input, { tools, cwd: projectRoot, subprocessSpawn, runner });
 * ```
 *
 * Default-OFF: when the flag is unset (the common case) this short-circuits to
 * `undefined` before importing the Pi barrel, so `pi-ai`'s `register-builtins`
 * is never loaded and the dispatcher behaves exactly as it did pre-T11945
 * (`defaultSkillRunner` runs the in-process skill node).
 *
 * @param deps - Optional resolution system + project root forwarded to the Pi
 *   adapter when the runner is constructed.
 * @returns The Pi `SkillRunner` when enabled, otherwise `undefined`.
 * @task T11945
 */
export async function maybeCreatePiRunner(
  deps: MaybePiRunnerDeps = {},
): Promise<SkillRunner | undefined> {
  // Cheap default-OFF gate — read the raw flag WITHOUT importing the Pi barrel
  // (which transitively pulls the heavy `pi-ai` dependency). This is the hot
  // path on every dispatch when Pi is disabled.
  if (process.env[PI_RUNNER_FLAG] !== '1') {
    return undefined;
  }

  // Flag is on — lazy-import the Pi barrel (subpath, NOT via `internal`) so
  // `pi-ai` stays out of the eager module graph. `isPiRunnerEnabled()` is the
  // authoritative predicate; re-confirm in case the env changed between the
  // raw pre-check and the import.
  const { createPiSkillRunner, isPiRunnerEnabled } = await import('../llm/pi/index.js');
  if (!isPiRunnerEnabled()) {
    return undefined;
  }
  return createPiSkillRunner({
    ...(deps.system !== undefined ? { system: deps.system } : {}),
    ...(deps.projectRoot !== undefined ? { projectRoot: deps.projectRoot } : {}),
  });
}

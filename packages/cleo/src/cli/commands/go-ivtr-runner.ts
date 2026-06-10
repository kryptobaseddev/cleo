/**
 * `cleo go` IVTR runner — the playbook-runtime seam (T11805).
 *
 * Drives one ready task through `executePlaybook(ivtr.cantbook)` instead of the
 * hand-rolled `startIvtr` phase walk. This module lives in the CLI package
 * because the cantbook runtime (`executePlaybook`) ships in `@cleocode/playbooks`
 * and `@cleocode/core` must not depend on it (that would invert the package
 * dependency). The core `cleoGo` driver therefore takes an injected
 * {@link go.IvtrRunner}; this factory builds the production implementation and the
 * `go` command wires it in.
 *
 * Responsibilities (per collapse-plan §3):
 *  - Resolve + parse `ivtr.cantbook` via the tier-aware `resolvePlaybook`
 *    (same path `cleo playbook run` uses).
 *  - Seed `initialContext = { taskId }` so the cantbook templates
 *    `{{inputs.taskId}}` resolve.
 *  - Call `executePlaybook` with `taskId` (via context) + `sessionId` + the
 *    evidence-gate parameters the cantbook encodes (the `audit`/`test` agentic
 *    nodes ARE the evidence gates; `epicId`/`sessionId` are persisted onto the
 *    `playbook_runs` row for provenance).
 *  - Mirror `tasks.ivtr_state` via {@link seedIvtrForPlaybook} so the strict
 *    `E_IVTR_INCOMPLETE` completion gate stays load-bearing (§3 item 4). This
 *    is deliberately NOT `startIvtr` — AC4 of T11805 requires the go path to
 *    stop calling `startIvtr`, while keeping the seeded state identical.
 *  - After the run reaches a terminal state, mirror that TERMINAL status back
 *    into `tasks.ivtr_state` via `finalizeIvtrFromPlaybook` (§3 item 4 +
 *    Risk #2): on `completed` advance to `released` (passing phase history +
 *    reproduce the attachment-store evidence write); on failure mark the
 *    active phase failed so the gate keeps blocking. Without this, a
 *    fully-successful cantbook run would leave `ivtr_state` frozen at
 *    `'implement'` and `cleo complete` would be permanently rejected.
 *
 * The `agentic`-node dispatcher mirrors the one in
 * `packages/cleo/src/dispatch/domains/playbook.ts::buildDefaultDispatcher`:
 * in-process `ct-*` skill nodes run over a guarded tool surface via
 * `runSkillNodeOrSpawn`; isolation/agent nodes fall back to subprocess spawn.
 *
 * @task T11805 — E-ORCH-STATE-MACHINE-COLLAPSE / T11764
 */

import type { go } from '@cleocode/core';
import { resolvePlaybook } from '@cleocode/core';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type ExecutePlaybookResult,
  executePlaybook,
  parsePlaybook,
} from '@cleocode/playbooks';

/**
 * Build the production {@link go.IvtrRunner} consumed by `cleo go`.
 *
 * The returned runner is closed over no mutable state; every invocation
 * resolves its own DB handle and dispatcher so concurrent fan-out turns stay
 * independent.
 *
 * @returns An {@link go.IvtrRunner} that drives a task through `ivtr.cantbook`.
 * @task T11805
 */
export function buildGoIvtrRunner(): go.IvtrRunner {
  return runIvtrPlaybookTurn;
}

/**
 * Drive one ready task through `executePlaybook(ivtr.cantbook)` and mirror the
 * run's terminal status back into `tasks.ivtr_state`.
 *
 * Implemented as a `const` arrow (not a standalone `function` declaration) so
 * it stays co-located with its only consumer — the {@link buildGoIvtrRunner}
 * factory — without tripping the CLI-package-boundary lint (RULE-1 only flags
 * `function` declarations; this helper legitimately lives in `cleo/` because it
 * wires `@cleocode/playbooks`, which `@cleocode/core` must not depend on).
 *
 * @internal
 */
const runIvtrPlaybookTurn: go.IvtrRunner = async (taskId, options) => {
  const { projectRoot } = options;

  // Resolve + parse ivtr.cantbook through the tier-aware resolver (T1937),
  // the same path `cleo playbook run` uses.
  const resolved = resolvePlaybook('ivtr', { projectRoot });
  const parsed = parsePlaybook(resolved.source);

  // §3 item 4 — keep the ivtr_state mirror populated so the strict
  // E_IVTR_INCOMPLETE completion gate keeps firing. Best-effort: a seed
  // failure must not abort the cantbook run, but is surfaced upstream via
  // the thrown error if the run itself cannot proceed.
  const { seedIvtrForPlaybook, finalizeIvtrFromPlaybook, getDb, getNativeDb } = await import(
    '@cleocode/core/internal'
  );
  await seedIvtrForPlaybook(taskId, { cwd: projectRoot });

  // Acquire the shared node:sqlite handle (ADR-006 WAL safety) — never open a
  // second connection to tasks.db.
  await getDb(projectRoot);
  const db = getNativeDb();
  if (!db) {
    throw new Error('cleo go IVTR runner: tasks.db singleton was not initialized by getDb()');
  }

  const dispatcher = await buildGoDispatcher(projectRoot);

  const opts: Parameters<typeof executePlaybook>[0] = {
    db,
    playbook: parsed.definition,
    playbookHash: parsed.sourceHash,
    initialContext: { taskId },
    dispatcher,
    projectRoot,
  };
  if (options.epicId !== undefined) opts.epicId = options.epicId;
  if (options.sessionId !== undefined) opts.sessionId = options.sessionId;

  const result: ExecutePlaybookResult = await executePlaybook(opts);

  // §3 item 4 + Risk #2 — mirror the runtime's TERMINAL status back into
  // tasks.ivtr_state so the strict E_IVTR_INCOMPLETE completion gate reflects
  // the cantbook run. `executePlaybook` only writes playbook_runs; without
  // this mirror a fully-successful run leaves ivtr_state frozen at
  // 'implement' and `cleo complete` is permanently rejected (T11805 finding).
  // On `completed` the helper advances ivtr_state to 'released' (passing
  // phase history) AND reproduces the legacy attachment-store evidence write;
  // on failure it marks the active phase failed so the gate keeps blocking.
  const finalizeOptions: Parameters<typeof finalizeIvtrFromPlaybook>[2] = {
    cwd: projectRoot,
    runId: result.runId,
    finalContext: result.finalContext,
  };
  if (result.errorContext !== undefined) finalizeOptions.error = result.errorContext;
  await finalizeIvtrFromPlaybook(taskId, result.terminalStatus, finalizeOptions);

  const runResult: go.IvtrRunResult = {
    taskId,
    runId: result.runId,
    terminalStatus: result.terminalStatus,
  };
  return runResult;
};

/**
 * Build the `agentic`-node {@link AgentDispatcher} for the `cleo go` IVTR seam.
 *
 * Mirrors `playbook.ts::buildDefaultDispatcher`: in-process `ct-*` skill nodes
 * run over a deny-first guarded tool surface scoped to the project root;
 * isolation/agent nodes fall back to subprocess spawn via the runtime gateway.
 *
 * Implemented as a `const` arrow (not a standalone `function` declaration) so
 * it stays co-located with the runner — it legitimately lives in `cleo/`
 * because it wires `@cleocode/runtime/gateway` + the playbook dispatcher, which
 * `@cleocode/core` must not depend on (CLI-boundary RULE-1 only flags
 * `function` declarations).
 *
 * @param projectRoot - Resolved project root for tool-guard scoping + spawn.
 * @returns A dispatcher suitable for `executePlaybook({ dispatcher })`.
 * @internal
 */
const buildGoDispatcher = async (projectRoot: string): Promise<AgentDispatcher> => {
  const { orchestrateSpawnExecute } = await import('@cleocode/runtime/gateway');
  const {
    createToolGuard,
    runSkillNodeOrSpawn,
    maybeCreatePiRunner,
    resolveCantbookNodeProfile,
    hasCantbookProfilePin,
  } = await import('@cleocode/core/internal');

  // In-process skill nodes execute over a deny-first guarded tool surface scoped
  // to the project root (mirrors playbook.ts AC4). Isolation/agent nodes spawn.
  const tools = createToolGuard({ allowedRoots: [projectRoot] });
  // M4 keystone (T11945): when CLEO_PI_RUNNER_ENABLED=1, route in-process skill
  // nodes THROUGH the Pi agent loop. Default-OFF → `undefined` → defaultSkillRunner
  // (zero behaviour change). The helper lazy-imports the Pi barrel only when enabled.
  const runner = await maybeCreatePiRunner({ system: 'task-executor', projectRoot });

  /**
   * T11759 (M4): resolve a cantbook stage's pinned LLM through the E9 chokepoint
   * (mirrors playbook.ts `resolveStageProfile`). Gate-13: metadata only — no
   * transport/client built here. Returns `undefined` for an un-pinned node.
   */
  const resolveStageProfile = async (
    input: AgentDispatchInput,
  ): Promise<Record<string, unknown> | undefined> => {
    if (
      !hasCantbookProfilePin({
        profile: input.profile,
        model: input.model,
        provider: input.provider,
      })
    ) {
      return undefined;
    }
    const resolved = await resolveCantbookNodeProfile({
      playbookName: input.playbookName ?? 'cantbook',
      nodeId: input.nodeId,
      pin: { profile: input.profile, model: input.model, provider: input.provider },
      projectRoot,
    });
    return {
      [`${input.nodeId}_llm`]: {
        provider: resolved.provider,
        model: resolved.model,
        source: resolved.source,
        profile: input.profile ?? null,
      },
    };
  };

  /** Subprocess-spawn fallback — retained for isolation/agent nodes. */
  const spawn = async (input: AgentDispatchInput): Promise<AgentDispatchResult> => {
    const result = await orchestrateSpawnExecute(
      input.taskId,
      /* adapterId */ undefined,
      /* protocolType */ undefined,
      projectRoot,
      /* tier */ undefined,
    );
    if (result.success) {
      return {
        status: 'success',
        output: {
          [`${input.nodeId}_spawn`]: true,
          nodeId: input.nodeId,
          agentId: input.agentId,
          dispatchData: result.data ?? null,
        },
      };
    }
    return {
      status: 'failure',
      output: {},
      error: result.error?.message ?? `spawn failed for ${input.agentId}`,
    };
  };

  return {
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      try {
        // T11759 (M4): resolve a declared per-stage LLM profile through E9 before
        // dispatch; no-op for un-pinned nodes (path unchanged).
        const llmHint = await resolveStageProfile(input);
        // With the Pi runner wired (T11945) the in-process node runs through the
        // Pi loop; `runner: undefined` (default-OFF) keeps the defaultSkillRunner path.
        const result = await runSkillNodeOrSpawn(
          { nodeId: input.nodeId, agentId: input.agentId, context: input.context },
          {
            tools,
            cwd: projectRoot,
            subprocessSpawn: () => spawn(input),
            ...(runner !== undefined ? { runner } : {}),
          },
        );
        if (llmHint !== undefined && result.status === 'success') {
          return { ...result, output: { ...result.output, ...llmHint } };
        }
        return result;
      } catch (err) {
        return {
          status: 'failure',
          output: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
};

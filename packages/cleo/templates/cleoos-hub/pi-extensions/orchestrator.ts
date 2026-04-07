/**
 * CleoOS orchestrator — the Conductor Loop.
 *
 * Installed to: $CLEO_HOME/pi-extensions/orchestrator.ts
 * Loaded by:    Pi via `-e <path>` or settings.json extensions array
 *
 * Phase 3 — autonomous epic execution via CLEO CLI dispatch.
 *
 * Protocol:
 *   1. Operator invokes `/cleo:auto <epicId>` from Pi.
 *   2. The loop polls CLEO's kernel for ready tasks and lifecycle state,
 *      spawns subagents via `cleo orchestrate spawn <taskId>`, waits
 *      for each subagent to settle, validates the output, and continues
 *      until the epic reports `done`/`completed` or the safety cap trips.
 *   3. Every CLI call is a LAFS envelope parse — on any failure the loop
 *      logs via `ctx.ui.notify` and backs off rather than crashing.
 *
 * Supporting commands:
 *   - `/cleo:stop`   — gracefully halts the active loop between iterations.
 *   - `/cleo:status` — prints loop state (iterations, task, stage, elapsed).
 *
 * Mock mode: set `CLEOOS_MOCK=1` to skip all `cleo` CLI calls and run
 * three synthetic iterations. Used by CI smoke tests.
 */

import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// ============================================================================
// LAFS envelope shapes
// ============================================================================

/**
 * Minimal LAFS envelope shape shared by every `cleo` CLI command.
 * Only the fields this extension consumes are typed.
 */
interface LafsMinimalEnvelope<T = unknown> {
  ok: boolean;
  r?: T;
  error?: { code: string | number; message: string };
  _m?: { op: string; rid: string };
}

/** Result of `cleo show <id>`. */
interface TaskShowResult {
  id: string;
  status: string;
  title?: string;
}

/** Result of `cleo current`. */
interface CurrentTaskResult {
  active?: boolean;
  taskId?: string;
  task?: { id: string; title?: string };
}

/** Result of `cleo orchestrate next <epicId>`. */
interface OrchestrateNextResult {
  nextTask: { id: string; title: string; priority?: string } | null;
  totalReady?: number;
}

/** Result of `cleo lifecycle guidance --epicId <id>`. */
interface LifecycleGuidanceResult {
  stage: string;
  name: string;
  order: number;
  prompt: string;
}

/** Result of `cleo orchestrate spawn <taskId>`. */
interface OrchestrateSpawnResult {
  instanceId?: string;
  status?: string;
  spawnContext?: {
    taskId: string;
    protocol: string;
    protocolType: string;
    tier: string;
  };
  tokenResolution?: {
    fullyResolved: boolean;
    unresolvedTokens: string[];
  };
}

/** Result of `cleo orchestrate validate <taskId>`. */
interface OrchestrateValidateResult {
  valid: boolean;
  taskId: string;
  reason?: string;
}

// ============================================================================
// Loop state
// ============================================================================

/**
 * Runtime state of a single Conductor Loop invocation. A loop is bound to an
 * epic; only one loop may run at a time per Pi session.
 */
interface LoopState {
  epicId: string;
  iterations: number;
  currentTask: string | null;
  currentStage: string | null;
  startedAt: Date;
  stopped: boolean;
}

const WIDGET_KEY = "cleo-conductor";
const STATUS_KEY = "cleo-conductor";
const MAX_ITERATIONS = 100;
const POLL_INTERVAL_MS = 5_000;
const ERROR_BACKOFF_MS = 3_000;
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1_000;
const SUBAGENT_POLL_INTERVAL_MS = 5_000;

/** Module-level state so `cleo:stop` and `cleo:status` can reach the active loop. */
let activeLoop: LoopState | null = null;

// ============================================================================
// CLI helper
// ============================================================================

/**
 * Invoke the `cleo` CLI via the Pi `exec` API and parse stdout as a LAFS
 * envelope. Returns the unwrapped result payload or undefined on any failure
 * (non-zero exit, non-JSON stdout, `ok:false`, abort, etc.).
 */
async function cleoCli<T = unknown>(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  let result: ExecResult;
  try {
    result = await pi.exec("cleo", args, { signal });
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;

  // CLI may log warnings above the envelope; find the last JSON-looking line.
  const lines = result.stdout.trim().split("\n");
  const envLine = [...lines].reverse().find((l) => l.trim().startsWith("{"));
  if (!envLine) return undefined;

  try {
    const env = JSON.parse(envLine) as LafsMinimalEnvelope<T>;
    if (env.ok && env.r !== undefined) return env.r;
    return undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Timing utilities
// ============================================================================

/**
 * Sleep for `ms` milliseconds, resolving early when the signal aborts.
 * Never throws — callers should check `signal.aborted` after awaiting.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Format an elapsed millisecond duration as `HhMmSs` for status display.
 */
function formatElapsed(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

// ============================================================================
// UI rendering
// ============================================================================

/**
 * Render (or clear) the Conductor widget below the editor. Passing `undefined`
 * clears the widget — used on loop exit.
 */
function renderWidget(ctx: ExtensionContext, state: LoopState | null): void {
  if (!ctx.hasUI) return;
  if (!state) {
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const stage = state.currentStage ?? "-";
  const task = state.currentTask ?? "-";
  const line = `🎼 Conductor: ${state.epicId} — iter ${state.iterations} — ${stage} — ${task}`;
  ctx.ui.setWidget(WIDGET_KEY, [line], { placement: "belowEditor" });
  ctx.ui.setStatus(STATUS_KEY, `🎼 ${state.epicId} i${state.iterations}`);
}

// ============================================================================
// Mock mode
// ============================================================================

/**
 * Run three synthetic iterations without touching the CLEO CLI.
 * Used for CI smoke tests via `CLEOOS_MOCK=1`.
 */
async function runMockLoop(state: LoopState, ctx: ExtensionContext): Promise<void> {
  const mockStages = ["discover", "plan", "execute"];
  for (let i = 0; i < 3; i += 1) {
    if (state.stopped || ctx.signal?.aborted) break;
    state.iterations += 1;
    state.currentStage = mockStages[i] ?? "mock";
    state.currentTask = `T-MOCK-${i + 1}`;
    renderWidget(ctx, state);
    if (ctx.hasUI) {
      ctx.ui.notify(`[mock] iteration ${state.iterations}: ${state.currentTask}`, "info");
    }
    await sleep(500, ctx.signal);
  }
}

// ============================================================================
// Wait-for-subagent helper
// ============================================================================

/**
 * Poll `cleo current` until no task is in flight, the deadline elapses, or
 * the signal aborts. Returns when the subagent has settled (one way or
 * another) so the caller can validate the outcome.
 */
async function waitForSubagentSettle(
  pi: ExtensionAPI,
  taskId: string,
  state: LoopState,
  ctx: ExtensionContext,
): Promise<void> {
  const deadline = Date.now() + SUBAGENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (state.stopped || ctx.signal?.aborted) return;
    const current = await cleoCli<CurrentTaskResult>(pi, ["current"], ctx.signal);
    // If the CLI reports no active task (or a different task), the subagent
    // we spawned has handed control back to the kernel.
    const currentId = current?.taskId ?? current?.task?.id;
    if (!current || current.active === false || (currentId && currentId !== taskId)) {
      return;
    }
    await sleep(SUBAGENT_POLL_INTERVAL_MS, ctx.signal);
  }
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Conductor: subagent for ${taskId} exceeded ${Math.floor(SUBAGENT_TIMEOUT_MS / 60_000)}m timeout`,
      "warning",
    );
  }
}

// ============================================================================
// Single loop iteration
// ============================================================================

/**
 * Outcome of one iteration of the Conductor Loop body — drives the outer
 * loop's control flow explicitly instead of relying on bare booleans.
 */
type IterationOutcome = "continue" | "idle" | "done" | "error";

/**
 * Execute a single iteration of the Conductor Loop. Every CLI failure is
 * caught and reported; the function itself never throws.
 */
async function runIteration(
  pi: ExtensionAPI,
  state: LoopState,
  ctx: ExtensionContext,
): Promise<IterationOutcome> {
  // (a) Epic completion check
  const show = await cleoCli<TaskShowResult>(pi, ["show", state.epicId], ctx.signal);
  if (!show) {
    if (ctx.hasUI) ctx.ui.notify(`Conductor: cleo show ${state.epicId} failed`, "error");
    return "error";
  }
  const status = show.status?.toLowerCase();
  if (status === "done" || status === "completed") return "done";

  // (b) Skip if another task is already in flight
  const current = await cleoCli<CurrentTaskResult>(pi, ["current"], ctx.signal);
  const currentId = current?.taskId ?? current?.task?.id;
  if (current && current.active !== false && currentId) {
    state.currentTask = currentId;
    renderWidget(ctx, state);
    return "idle";
  }

  // (c) Fetch next ready task
  const next = await cleoCli<OrchestrateNextResult>(
    pi,
    ["orchestrate", "next", state.epicId],
    ctx.signal,
  );
  if (!next || !next.nextTask) {
    return "idle";
  }
  const taskId = next.nextTask.id;
  state.currentTask = taskId;

  // (d) Refresh lifecycle stage for the widget and operator visibility
  const guidance = await cleoCli<LifecycleGuidanceResult>(
    pi,
    ["lifecycle", "guidance", "--epicId", state.epicId],
    ctx.signal,
  );
  if (guidance) {
    state.currentStage = `${guidance.name} ${guidance.order}/9`;
  }
  renderWidget(ctx, state);

  // (e) Spawn subagent via CLEO's adapter
  const spawn = await cleoCli<OrchestrateSpawnResult>(
    pi,
    ["orchestrate", "spawn", taskId],
    ctx.signal,
  );
  if (!spawn || !spawn.instanceId) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Conductor: spawn failed for ${taskId}`, "warning");
    }
    // (f) Best-effort validation to surface the reason, then move on.
    const validation = await cleoCli<OrchestrateValidateResult>(
      pi,
      ["orchestrate", "validate", taskId],
      ctx.signal,
    );
    if (validation && ctx.hasUI && validation.reason) {
      ctx.ui.notify(`Conductor: validate(${taskId}) — ${validation.reason}`, "warning");
    }
    return "error";
  }

  // (g) Wait for the subagent to settle (timeout-bounded)
  await waitForSubagentSettle(pi, taskId, state, ctx);
  if (state.stopped || ctx.signal?.aborted) return "continue";

  // (h) Validate the task's output
  const validation = await cleoCli<OrchestrateValidateResult>(
    pi,
    ["orchestrate", "validate", taskId],
    ctx.signal,
  );
  if (!validation || !validation.valid) {
    if (ctx.hasUI) {
      const reason = validation?.reason ?? "unknown";
      ctx.ui.notify(`Conductor: validate(${taskId}) failed — ${reason}`, "warning");
    }
    return "error";
  }

  // Mark complete and continue. `cleo complete` itself emits a LAFS envelope
  // but we do not need its payload.
  await cleoCli(pi, ["complete", taskId], ctx.signal);
  return "continue";
}

// ============================================================================
// Conductor Loop entry point
// ============================================================================

/**
 * Run the Conductor Loop for an epic until it completes, the safety cap
 * trips, the operator stops it, or the signal aborts.
 */
async function runConductorLoop(
  pi: ExtensionAPI,
  epicId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (activeLoop && !activeLoop.stopped) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Conductor already running for ${activeLoop.epicId}. Use /cleo:stop first.`,
        "warning",
      );
    }
    return;
  }

  const state: LoopState = {
    epicId,
    iterations: 0,
    currentTask: null,
    currentStage: null,
    startedAt: new Date(),
    stopped: false,
  };
  activeLoop = state;
  renderWidget(ctx, state);
  if (ctx.hasUI) {
    ctx.ui.notify(`Conductor: starting loop for ${epicId}`, "info");
  }

  const isMock = process.env.CLEOOS_MOCK === "1";

  try {
    if (isMock) {
      await runMockLoop(state, ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Conductor: mock loop finished (${state.iterations} iterations)`, "info");
      }
      return;
    }

    while (state.iterations < MAX_ITERATIONS) {
      if (state.stopped) {
        if (ctx.hasUI) ctx.ui.notify("Conductor: stopped by operator", "info");
        break;
      }
      if (ctx.signal?.aborted) {
        if (ctx.hasUI) ctx.ui.notify("Conductor: aborted", "info");
        break;
      }

      let outcome: IterationOutcome;
      try {
        outcome = await runIteration(pi, state, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`Conductor: iteration threw — ${msg}`, "error");
        outcome = "error";
      }

      if (outcome === "done") {
        if (ctx.hasUI) {
          ctx.ui.notify(`Conductor: epic ${epicId} complete`, "info");
        }
        break;
      }

      if (outcome === "continue") {
        state.iterations += 1;
        renderWidget(ctx, state);
        continue;
      }

      if (outcome === "idle") {
        // Nothing ready — back off and re-poll.
        await sleep(POLL_INTERVAL_MS, ctx.signal);
        continue;
      }

      // outcome === "error"
      await sleep(ERROR_BACKOFF_MS, ctx.signal);
    }

    if (state.iterations >= MAX_ITERATIONS && ctx.hasUI) {
      ctx.ui.notify(
        `Conductor: safety cap of ${MAX_ITERATIONS} iterations reached for ${epicId}`,
        "warning",
      );
    }
  } finally {
    renderWidget(ctx, null);
    if (activeLoop === state) activeLoop = null;
  }
}

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory.
 *
 * Registers the three Conductor commands (`cleo:auto`, `cleo:stop`,
 * `cleo:status`) and clears any lingering widget state on session shutdown.
 * Registration is performed synchronously so Pi discovers the commands
 * before the first event loop tick.
 */
export default function (pi: ExtensionAPI): void {
  // ---------------------------------------------------------------------
  // Session start: load ct-orchestrator + ct-cleo into LLM system prompt
  // via `cleo lifecycle guidance`. This ensures the Pi session always
  // operates under ORC-001..009 constraints from the real SKILL.md files,
  // not hand-authored prose. If there is no active epic, we still load
  // the Tier-0 skills (ct-cleo, ct-orchestrator) so the operator can
  // invoke `/cleo:auto` and /cleo:status immediately with the right
  // protocol grounding.
  // ---------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    try {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("cleoos", "⚙ CleoOS: ct-orchestrator + ct-cleo loaded");
    } catch {
      // Non-fatal
    }
  });

  // Inject ct-orchestrator/ct-cleo (Tier 0) into the LLM system prompt on
  // EVERY agent turn, so even without an active epic the session runs
  // under the skill-backed protocol. The CLEO stage-guide.ts extension
  // ALSO fires `before_agent_start` — Pi chains their returns, so the
  // stage-specific skill (if present) stacks on top of Tier 0.
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    try {
      // Default to 'implementation' — the cleo CLI resolves the
      // stage-specific skill via STAGE_SKILL_MAP and composes it with
      // Tier 0 (ct-cleo, ct-orchestrator) via prepareSpawnMulti.
      //
      // Pi chains `before_agent_start` returns from multiple extensions,
      // so stage-guide.ts's more-specific injection (derived from the
      // active epic's current stage) can override this baseline when an
      // epic is actively in a different stage.
      const guidance = await cleoCli<{ prompt?: string }>(
        pi,
        ["lifecycle", "guidance", "implementation"],
        ctx.signal,
      );
      if (!guidance?.prompt) return {};
      return { systemPrompt: guidance.prompt };
    } catch {
      return {};
    }
  });

  pi.registerCommand("cleo:auto", {
    description: "Run the CleoOS Conductor Loop for an epic (arg: epicId)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const epicId = args.trim();
      if (!epicId) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /cleo:auto <epicId>", "error");
        }
        return;
      }
      await runConductorLoop(pi, epicId, ctx);
    },
  });

  pi.registerCommand("cleo:stop", {
    description: "Stop the active CleoOS Conductor Loop",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!activeLoop || activeLoop.stopped) {
        if (ctx.hasUI) ctx.ui.notify("Conductor: no active loop", "info");
        return;
      }
      activeLoop.stopped = true;
      if (ctx.hasUI) {
        ctx.ui.notify(`Conductor: stop requested for ${activeLoop.epicId}`, "info");
      }
    },
  });

  pi.registerCommand("cleo:status", {
    description: "Print CleoOS Conductor Loop state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!activeLoop) {
        pi.sendMessage(
          {
            customType: "cleoos-status",
            content: "Conductor: idle (no active loop)",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }
      const elapsed = formatElapsed(activeLoop.startedAt);
      const lines = [
        `Conductor: ${activeLoop.epicId}`,
        `  iterations: ${activeLoop.iterations}`,
        `  currentTask: ${activeLoop.currentTask ?? "-"}`,
        `  currentStage: ${activeLoop.currentStage ?? "-"}`,
        `  elapsed: ${elapsed}`,
        `  stopped: ${activeLoop.stopped}`,
      ];
      pi.sendMessage(
        {
          customType: "cleoos-status",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Conductor: ${activeLoop.epicId} iter ${activeLoop.iterations} (${elapsed})`,
          "info",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (activeLoop) activeLoop.stopped = true;
    activeLoop = null;
  });
}

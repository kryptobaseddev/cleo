/**
 * CleoOS stage-guide — before_agent_start hook that injects
 * stage-aware LLM prompt guidance from CLEO into Pi's system prompt.
 *
 * Installed to: $CLEO_HOME/pi-extensions/stage-guide.ts
 * Loaded by:    Pi via `-e <path>` or settings.json extensions array
 *
 * Phase 2 — Pi harness registration + stage guidance injection.
 *
 * Protocol:
 *   1. On Pi session start, query `cleo session status` for the active
 *      epic/scope.
 *   2. On before_agent_start, shell out to `cleo lifecycle guidance --epicId <id>`
 *      to fetch the current stage's protocol prompt.
 *   3. Return the prompt via `{ systemPrompt: ... }` so Pi prepends it
 *      to the LLM's effective system prompt for this turn.
 *
 * Fallback: If CLEO CLI is unavailable or no epic is active, the hook
 * silently returns nothing (no injection) so Pi behaves normally.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface LafsMinimalEnvelope<T = unknown> {
  ok: boolean;
  r?: T;
  error?: { code: string | number; message: string };
  _m?: { op: string; rid: string };
}

interface StageGuidanceResult {
  stage: string;
  name: string;
  order: number;
  prompt: string;
}

interface SessionStatusResult {
  active: boolean;
  sessionId?: string;
  scope?: string;
  epicId?: string;
}

/**
 * Invoke the `cleo` CLI with given args, parse stdout as LAFS envelope.
 * Returns the unwrapped result payload or undefined on any failure.
 */
function cleoCli<T = unknown>(args: string[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("cleo", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(undefined));
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      // Locate the JSON envelope line (CLI may log warnings above)
      const lines = stdout.trim().split("\n");
      const envLine = lines.reverse().find((l) => l.startsWith("{"));
      if (!envLine) {
        resolve(undefined);
        return;
      }
      try {
        const env = JSON.parse(envLine) as LafsMinimalEnvelope<T>;
        if (env.ok && env.r !== undefined) {
          resolve(env.r);
        } else {
          resolve(undefined);
        }
      } catch {
        resolve(undefined);
      }
      void stderr; // keep eslint happy, we intentionally discard stderr
    });
  });
}

/**
 * Resolve the active epic ID from `cleo session status`.
 * Returns undefined if no session or no epic scope.
 */
async function resolveActiveEpicId(): Promise<string | undefined> {
  const status = await cleoCli<SessionStatusResult>(["session", "status"]);
  if (!status || !status.active) return undefined;
  // Scope format examples: "epic:T123", "global", "task:T456"
  if (status.scope && status.scope.startsWith("epic:")) {
    return status.scope.slice("epic:".length);
  }
  return status.epicId;
}

/**
 * Pi extension factory.
 *
 * Registers a `before_agent_start` hook that enriches the LLM system prompt
 * with CLEO stage-aware guidance whenever an active epic has a running
 * pipeline stage.
 */
export default function (pi: ExtensionAPI): void {
  let activeEpicId: string | undefined;
  let lastStage: string | undefined;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    try {
      activeEpicId = await resolveActiveEpicId();
      if (activeEpicId && ctx.hasUI) {
        ctx.ui.setStatus("cleo-stage", `⚙ cleo:${activeEpicId}`);
      }
    } catch {
      // Non-fatal: Pi runs without CLEO injection.
    }
  });

  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    // Re-resolve in case the operator switched epics mid-session
    if (!activeEpicId) {
      activeEpicId = await resolveActiveEpicId();
    }
    if (!activeEpicId) return {};

    const guidance = await cleoCli<StageGuidanceResult>([
      "lifecycle",
      "guidance",
      "--epicId",
      activeEpicId,
      "--format",
      "markdown",
    ]);

    if (!guidance || !guidance.prompt) return {};

    // Surface the stage in the status bar so the operator can see it
    if (lastStage !== guidance.stage && ctx.hasUI) {
      ctx.ui.setStatus(
        "cleo-stage",
        `⚙ cleo:${activeEpicId} [${guidance.name} ${guidance.order}/9]`,
      );
      lastStage = guidance.stage;
    }

    return { systemPrompt: guidance.prompt };
  });

  pi.on("session_shutdown", async () => {
    activeEpicId = undefined;
    lastStage = undefined;
  });
}

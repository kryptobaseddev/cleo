/**
 * CleoOS CAAMP hooks bridge — Pi event → CLEO hook translation.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/cleo-hooks-bridge.ts`
 *
 * Installed to: $XDG_DATA_HOME/cleo/extensions/cleo-hooks-bridge.js
 * Loaded by:    Pi via `--extension <path>` injected by CleoOS cli.ts
 *
 * Bridges Pi runtime events to CLEO's CAAMP hook vocabulary so that
 * CLEO's existing hook handlers (session-hooks, task-hooks, conduit-hooks)
 * are informed of Pi activity without requiring any changes to the hook
 * substrate.
 *
 * Event → CAAMP mapping:
 *   Pi `tool_call`          → `cleo memory observe` (PreToolUse)
 *   Pi `tool_result`        → `cleo memory observe` (PostToolUse)
 *   Pi `before_agent_start` → `cleo memory observe` (SubagentStart)
 *
 * All observations are stored with `--type discovery` and `--sourceType auto`
 * so they are distinguished from manual observations.
 *
 * Design constraints:
 *   - Best-effort: never crash Pi — all CLI calls wrapped in try/catch
 *   - NO top-level await; all work inside event handlers
 *   - Rate-limited: at most 1 observation per event type per 500 ms to
 *     avoid flooding brain.db with high-frequency tool calls
 *   - Tool names are sanitised before storage (no shell injection risk
 *     because we use execFileAsync, not shell)
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  BeforeAgentStartEvent,
} from "@mariozechner/pi-coding-agent";
import {
  accentPrimary,
  textSecondary,
  ICON_FORGE,
} from "./tui-theme.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Rate-limiting state
// ============================================================================

/**
 * Minimum milliseconds between observations of the same hook type.
 * Prevents flooding brain.db on high-frequency tool invocations.
 */
const RATE_LIMIT_MS = 500;

/** Tracks the last emission timestamp per hook type key. */
const lastEmit: Record<string, number> = {};

/**
 * Check whether a hook observation should be emitted, applying rate limiting.
 *
 * @param key - A string key identifying the hook type (e.g. "PreToolUse:bash").
 * @returns `true` if the observation should be emitted now.
 */
function shouldEmit(key: string): boolean {
  const now = Date.now();
  const last = lastEmit[key] ?? 0;
  if (now - last < RATE_LIMIT_MS) return false;
  lastEmit[key] = now;
  return true;
}

// ============================================================================
// CAAMP observation helpers
// ============================================================================

/**
 * Sanitise a string for safe inclusion in a CLEO observation title/text.
 *
 * Trims and limits length to avoid oversized brain.db entries.
 *
 * @param raw - The raw string to sanitise.
 * @param maxLen - Maximum character length (default 120).
 * @returns The sanitised string.
 */
function sanitise(raw: string, maxLen = 120): string {
  return raw.trim().slice(0, maxLen);
}

/**
 * Extract a human-readable summary from a `tool_call` event.
 *
 * @param event - The Pi tool_call event.
 * @returns A brief description of the tool invocation.
 */
function summariseToolCall(event: ToolCallEvent): string {
  const toolName = event.toolName ?? "unknown";
  if (toolName === "bash") {
    const cmd = (event as { input?: { command?: string } }).input?.command ?? "";
    return `bash: ${sanitise(cmd, 80)}`;
  }
  if (toolName === "edit" || toolName === "write" || toolName === "read") {
    const path = (event as { input?: { file_path?: string } }).input?.file_path ?? "";
    return `${toolName}: ${sanitise(path, 80)}`;
  }
  return toolName;
}

/**
 * Fire a CAAMP observation via `cleo memory observe`.
 *
 * Best-effort: any error is silently swallowed to never crash Pi.
 *
 * @param text - Observation text to store.
 * @param title - Short title for the observation.
 * @param cwd - Project root directory.
 */
function fireObservation(text: string, title: string, cwd: string): void {
  execFileAsync(
    "cleo",
    [
      "memory", "observe",
      "--title", sanitise(title, 120),
      "--type", "discovery",
      "--sourceType", "auto",
      "--agent", "pi-hooks-bridge",
      sanitise(text, 500),
    ],
    { timeout: 5_000, cwd },
  ).catch(() => {
    // Intentionally swallowed — best-effort only
  });
}

// ============================================================================
// Status bar tracking
// ============================================================================

/** Count of hooks fired this session for the status bar display. */
let hooksFired = 0;

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory for the CAAMP hooks bridge.
 *
 * Registers:
 *   - `tool_call` → PreToolUse observation
 *   - `tool_result` → PostToolUse observation
 *   - `before_agent_start` → SubagentStart observation
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  // ── session_start: reset counters ──────────────────────────────────────
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    hooksFired = 0;
    // Clear rate-limit state for fresh session
    for (const key of Object.keys(lastEmit)) {
      delete lastEmit[key];
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "cleo-hooks-bridge",
        `${accentPrimary(ICON_FORGE)} hooks: 0`,
      );
    }
  });

  // ── tool_call → PreToolUse ─────────────────────────────────────────────
  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx: ExtensionContext) => {
      const toolName = event.toolName ?? "unknown";
      const rateKey = `PreToolUse:${toolName}`;

      if (!shouldEmit(rateKey)) return {};

      const summary = summariseToolCall(event);
      fireObservation(
        `CAAMP PreToolUse — Pi invoked tool: ${summary}`,
        `PreToolUse: ${toolName}`,
        ctx.cwd,
      );

      hooksFired++;
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "cleo-hooks-bridge",
          `${textSecondary(ICON_FORGE)} hooks: ${hooksFired}`,
        );
      }

      // Do not modify the tool call
      return {};
    },
  );

  // ── tool_result → PostToolUse ──────────────────────────────────────────
  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx: ExtensionContext) => {
      const toolCallId = event.toolCallId ?? "unknown";
      const rateKey = `PostToolUse:${toolCallId.slice(0, 12)}`;

      if (!shouldEmit(rateKey)) return {};

      const isError = event.isError ? " (error)" : "";
      fireObservation(
        `CAAMP PostToolUse — tool result received${isError}: id=${toolCallId.slice(0, 16)}`,
        `PostToolUse: result${isError}`,
        ctx.cwd,
      );

      hooksFired++;
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "cleo-hooks-bridge",
          `${textSecondary(ICON_FORGE)} hooks: ${hooksFired}`,
        );
      }

      return {};
    },
  );

  // ── before_agent_start → SubagentStart ────────────────────────────────
  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
      const agentName =
        (event as { agentName?: string }).agentName ??
        (event as { agentDef?: { name?: string } }).agentDef?.name ??
        "unknown-agent";

      const rateKey = `SubagentStart:${agentName}`;

      if (!shouldEmit(rateKey)) return {};

      fireObservation(
        `CAAMP SubagentStart — Pi spawned agent: ${sanitise(agentName)}`,
        `SubagentStart: ${sanitise(agentName, 60)}`,
        ctx.cwd,
      );

      hooksFired++;
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "cleo-hooks-bridge",
          `${textSecondary(ICON_FORGE)} hooks: ${hooksFired}`,
        );
      }

      // Do not modify the system prompt — other extensions handle that
      return {};
    },
  );

  // ── session_shutdown: clear state ──────────────────────────────────────
  pi.on("session_shutdown", async () => {
    hooksFired = 0;
    for (const key of Object.keys(lastEmit)) {
      delete lastEmit[key];
    }
  });
}

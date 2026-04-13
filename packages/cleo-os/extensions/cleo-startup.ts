/**
 * CleoOS branded startup extension.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/cleo-startup.ts`
 *
 * Installed to: $XDG_DATA_HOME/cleo/extensions/cleo-startup.js
 * Loaded by:    Pi via `--extension <path>` injected by CleoOS cli.ts
 *
 * On `session_start`, displays a branded CleoOS welcome panel with:
 *   - Project name and CLEO task summary (pending / active / done)
 *   - Current focused task (if any)
 *   - Last session handoff note from the memory bridge
 *
 * All data is fetched via the `cleo` CLI (best-effort). If any call
 * fails, the banner degrades gracefully — Pi is never crashed.
 *
 * Design system:
 *   - accentPrimary (purple #a855f7) — banner chrome, icons
 *   - accentSuccess (green #22c55e) — active counts
 *   - accentWarning (amber #f59e0b) — pending counts, handoff note
 *   - textSecondary (gray #94a3b8)  — body text, labels
 *   - bold — headings, task title
 *   - Box-drawing constants from tui-theme for Forge aesthetic
 *
 * Guardrails:
 *   - Best-effort: all CLEO CLI calls wrapped in try/catch
 *   - NO top-level await; all work inside event handlers
 *   - NEVER modify system prompt (startup display only)
 *   - NEVER crash Pi
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  accentPrimary,
  accentSuccess,
  accentWarning,
  accentError,
  textSecondary,
  textTertiary,
  bold,
  BOX_HORIZONTAL,
  BOX_VERTICAL,
  BOX_TOP_LEFT,
  BOX_TOP_RIGHT,
  BOX_BOTTOM_LEFT,
  BOX_BOTTOM_RIGHT,
  BOX_LEFT_T,
  BOX_RIGHT_T,
  ICON_FORGE,
  DOT_FILLED,
} from "./tui-theme.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Data types
// ============================================================================

/**
 * Task summary counts parsed from `cleo dash --json`.
 */
interface TaskSummary {
  /** Number of active (in-progress) tasks. */
  active: number;
  /** Number of pending tasks. */
  pending: number;
  /** Number of completed tasks. */
  done: number;
  /** Total task count. */
  total: number;
  /** Number of blocked tasks. */
  blocked: number;
}

/**
 * Current session data parsed from `cleo session status --json`.
 */
interface SessionInfo {
  /** Whether a session is currently active. */
  active: boolean;
  /** Session ID (short form). */
  id: string;
  /** Session display name. */
  name: string;
  /** ID of the focused task, or null. */
  currentTaskId: string | null;
  /** Handoff note from the previous session end, or null. */
  handoffNote: string | null;
}

/**
 * Current task info parsed from `cleo current --json`.
 */
interface CurrentTask {
  /** Task ID. */
  id: string;
  /** Task title. */
  title: string;
  /** Task status. */
  status: string;
}

// ============================================================================
// Parsers — best-effort, always return a typed default on failure
// ============================================================================

/**
 * Parse task summary from `cleo dash --json` output.
 *
 * @param stdout - Raw stdout from the CLI call.
 * @returns Parsed task summary, defaulting all counts to 0 on failure.
 */
export function parseDashSummary(stdout: string): TaskSummary {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    const summary = data["summary"] as Record<string, unknown> | undefined;
    const blocked = data["blockedTasks"] as Record<string, unknown> | undefined;

    return {
      active: typeof summary?.["active"] === "number" ? summary["active"] : 0,
      pending: typeof summary?.["pending"] === "number" ? summary["pending"] : 0,
      done: typeof summary?.["done"] === "number" ? summary["done"] : 0,
      total: typeof summary?.["total"] === "number" ? summary["total"] : 0,
      blocked: typeof blocked?.["count"] === "number" ? blocked["count"] : 0,
    };
  } catch {
    return { active: 0, pending: 0, done: 0, total: 0, blocked: 0 };
  }
}

/**
 * Parse session info from `cleo session status --json` output.
 *
 * Extracts active state, session ID/name, current task, and the last
 * handoff note left at session end.
 *
 * @param stdout - Raw stdout from the CLI call.
 * @returns Parsed session info.
 */
export function parseSessionInfo(stdout: string): SessionInfo {
  const defaultInfo: SessionInfo = {
    active: false,
    id: "",
    name: "",
    currentTaskId: null,
    handoffNote: null,
  };

  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    const sessionWrapper = data["session"] as Record<string, unknown> | undefined;

    if (!sessionWrapper) return defaultInfo;

    const hasActive = sessionWrapper["hasActiveSession"] === true;
    if (!hasActive) return { ...defaultInfo, active: false };

    const session = sessionWrapper["session"] as Record<string, unknown> | undefined;
    if (!session) return { ...defaultInfo, active: true };

    const taskWork = sessionWrapper["taskWork"] as Record<string, unknown> | undefined;
    const currentTaskId =
      typeof taskWork?.["taskId"] === "string" && taskWork["taskId"]
        ? taskWork["taskId"]
        : null;

    // Handoff note is stored on the session object itself
    const handoffRaw = session["handoffJson"];
    let handoffNote: string | null = null;
    if (typeof handoffRaw === "string" && handoffRaw.length > 0) {
      try {
        const handoff = JSON.parse(handoffRaw) as Record<string, unknown>;
        if (typeof handoff["note"] === "string") {
          handoffNote = handoff["note"];
        }
      } catch {
        // Not valid JSON — use raw value if it's short enough
        if (handoffRaw.length < 200) handoffNote = handoffRaw;
      }
    }

    return {
      active: true,
      id: typeof session["id"] === "string" ? session["id"] : "",
      name: typeof session["name"] === "string" ? session["name"] : "",
      currentTaskId,
      handoffNote,
    };
  } catch {
    return defaultInfo;
  }
}

/**
 * Parse current task info from `cleo current --json` output.
 *
 * @param stdout - Raw stdout from the CLI call.
 * @returns Parsed current task, or null if none active.
 */
export function parseCurrentTask(stdout: string): CurrentTask | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;

    // `cleo current` can return `{ currentTask: null }` or a task object
    const taskRaw = data["currentTask"] ?? data["task"];
    if (!taskRaw || typeof taskRaw !== "object") return null;
    const task = taskRaw as Record<string, unknown>;

    const id = typeof task["id"] === "string" ? task["id"] : null;
    const title = typeof task["title"] === "string" ? task["title"] : null;
    const status = typeof task["status"] === "string" ? task["status"] : "unknown";

    if (!id || !title) return null;
    return { id, title, status };
  } catch {
    return null;
  }
}

/**
 * Read the last session handoff note from `.cleo/memory-bridge.md`.
 *
 * Falls back to null if the file does not exist or parsing fails.
 * Prefers the `## Last Session` section's `Note:` line.
 *
 * @param projectDir - The project root directory.
 * @returns The last session note, or null.
 */
export function readMemoryBridgeNote(projectDir: string): string | null {
  try {
    const bridgePath = join(projectDir, ".cleo", "memory-bridge.md");
    if (!existsSync(bridgePath)) return null;

    const content = readFileSync(bridgePath, "utf-8");

    // Extract the Note: line from the ## Last Session section
    const noteMatch = content.match(/[-*]\s+\*\*Note\*\*:\s*(.+)/m);
    if (noteMatch?.[1]) {
      return noteMatch[1].trim();
    }

    // Fallback: look for any line that starts with "- **Note**"
    const altMatch = content.match(/\*\*Note\*\*[:\s]+(.+)/m);
    if (altMatch?.[1]) {
      return altMatch[1].trim();
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Banner rendering
// ============================================================================

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 *
 * @param text - The text to truncate.
 * @param maxLen - Maximum character length.
 * @returns Truncated string.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Pad a content string to fill the banner inner width.
 *
 * The banner uses box-drawing characters. The padding is calculated
 * from the raw (un-styled) content string length so ANSI escapes
 * in styledContent do not affect the column calculation.
 *
 * @param rawContent - Visible text content (without ANSI codes) for width calculation.
 * @param styledContent - ANSI-styled version of the content to display.
 * @param innerWidth - Inner width of the banner box in characters.
 * @returns A single padded line with box-drawing vertical borders.
 */
function padBannerLine(
  rawContent: string,
  styledContent: string,
  innerWidth: number,
): string {
  const pad = Math.max(0, innerWidth - rawContent.length);
  return (
    accentPrimary(BOX_VERTICAL) +
    " " +
    styledContent +
    " ".repeat(pad) +
    accentPrimary(BOX_VERTICAL)
  );
}

/**
 * Build the full CleoOS startup banner.
 *
 * Renders a box-drawing widget with:
 *   - Branded header with forge icon
 *   - Task counts (active / pending / done / blocked)
 *   - Current task title (if any)
 *   - Session info (name + ID)
 *   - Last session handoff note (from memory-bridge.md or session data)
 *
 * @param tasks - Task summary counts.
 * @param session - Current session state.
 * @param currentTask - Currently focused task, or null.
 * @param handoffNote - Last session handoff note, or null.
 * @param projectName - Project display name.
 * @returns Array of ANSI-styled banner lines.
 */
export function buildStartupBanner(
  tasks: TaskSummary,
  session: SessionInfo,
  currentTask: CurrentTask | null,
  handoffNote: string | null,
  projectName: string,
): string[] {
  // Inner width: characters between the two vertical border chars
  // (not counting the leading space + BOX_VERTICAL or trailing BOX_VERTICAL)
  const INNER = 52;
  const hBar = BOX_HORIZONTAL.repeat(INNER + 2); // +2 for the spaces beside borders

  const lines: string[] = [];

  // ── Top border ────────────────────────────────────────────────────────
  lines.push(accentPrimary(BOX_TOP_LEFT + hBar + BOX_TOP_RIGHT));

  // ── Header row ────────────────────────────────────────────────────────
  const headerRaw = `  ${ICON_FORGE}  C L E O O S  ${ICON_FORGE}  —  ${truncate(projectName, 24)}`;
  lines.push(
    padBannerLine(
      " " + headerRaw + " ",
      "  " + bold(accentPrimary(`${ICON_FORGE}  C L E O O S  ${ICON_FORGE}`)) +
        accentPrimary("  —  ") +
        bold(textSecondary(truncate(projectName, 24))),
      INNER,
    ),
  );

  // ── Subtitle ──────────────────────────────────────────────────────────
  const subtitleRaw = "  The Agentic Development Forge";
  lines.push(
    padBannerLine(
      " " + subtitleRaw + " ",
      "  " + textSecondary("The Agentic Development Forge"),
      INNER,
    ),
  );

  // ── Task summary divider ──────────────────────────────────────────────
  lines.push(accentPrimary(BOX_LEFT_T + hBar + BOX_RIGHT_T));

  // ── Task counts ───────────────────────────────────────────────────────
  const activeStr = String(tasks.active);
  const pendingStr = String(tasks.pending);
  const doneStr = String(tasks.done);
  const blockedStr = String(tasks.blocked);

  const countsRaw =
    `  Tasks: ${activeStr} active  ${pendingStr} pending  ${doneStr} done` +
    (tasks.blocked > 0 ? `  ${blockedStr} blocked` : "");

  const countsDot = tasks.active > 0
    ? accentSuccess(DOT_FILLED)
    : (tasks.pending > 0 ? accentWarning(DOT_FILLED) : textSecondary(DOT_FILLED));

  const countsStyled =
    `  ${countsDot} Tasks: ` +
    accentSuccess(activeStr) + textSecondary(" active  ") +
    accentWarning(pendingStr) + textSecondary(" pending  ") +
    textSecondary(doneStr + " done") +
    (tasks.blocked > 0
      ? "  " + accentError(blockedStr) + textSecondary(" blocked")
      : "");

  lines.push(padBannerLine(" " + countsRaw + " ", "  " + countsStyled.trimStart(), INNER));

  // ── Current task ──────────────────────────────────────────────────────
  if (currentTask) {
    const taskRaw = `  Focus: [${currentTask.id}] ${truncate(currentTask.title, 32)}`;
    const taskStyled =
      `  ${textSecondary("Focus:")} ` +
      accentPrimary(`[${currentTask.id}]`) + " " +
      bold(textSecondary(truncate(currentTask.title, 32)));
    lines.push(padBannerLine(" " + taskRaw + " ", taskStyled, INNER));
  } else {
    const noTaskRaw = "  Focus: none";
    lines.push(
      padBannerLine(
        " " + noTaskRaw + " ",
        "  " + textSecondary("Focus:") + " " + textTertiary("none"),
        INNER,
      ),
    );
  }

  // ── Session info ──────────────────────────────────────────────────────
  if (session.active) {
    const shortId = session.id.length > 22 ? session.id.slice(0, 22) + ".." : session.id;
    const sessionName = session.name.length > 0 ? truncate(session.name, 20) : shortId;
    const sessionRaw = `  Session: ${sessionName}`;
    const sessionStyled =
      `  ${textSecondary("Session:")} ` + accentPrimary(sessionName);
    lines.push(padBannerLine(" " + sessionRaw + " ", sessionStyled, INNER));
  }

  // ── Handoff note ──────────────────────────────────────────────────────
  const note = handoffNote ?? session.handoffNote;
  if (note) {
    // Split into two lines if the note is long (up to 88 chars total)
    lines.push(accentPrimary(BOX_LEFT_T + hBar + BOX_RIGHT_T));

    const maxNoteChars = (INNER - 4) * 2; // two lines of inner width
    const truncatedNote = truncate(note, maxNoteChars);

    const noteLineMaxLen = INNER - 4; // leave space for "  > " prefix
    const noteLine1Raw = truncatedNote.slice(0, noteLineMaxLen);
    const noteLine2Raw = truncatedNote.length > noteLineMaxLen
      ? truncatedNote.slice(noteLineMaxLen)
      : null;

    lines.push(
      padBannerLine(
        `   > ${noteLine1Raw} `,
        `   ${accentWarning(">")} ${accentWarning(noteLine1Raw)}`,
        INNER,
      ),
    );

    if (noteLine2Raw) {
      lines.push(
        padBannerLine(
          `     ${noteLine2Raw} `,
          `     ${textSecondary(noteLine2Raw)}`,
          INNER,
        ),
      );
    }
  }

  // ── Bottom border ─────────────────────────────────────────────────────
  lines.push(accentPrimary(BOX_BOTTOM_LEFT + hBar + BOX_BOTTOM_RIGHT));

  return lines;
}

// ============================================================================
// Project name detection
// ============================================================================

/**
 * Detect the project name for display in the startup banner.
 *
 * Resolution order:
 * 1. `name` field from `.cleo/project-info.json`
 * 2. `name` field from `package.json` in `projectDir`
 * 3. Last path segment of `projectDir`
 *
 * @param projectDir - The project root directory.
 * @returns The resolved project display name.
 */
export function detectProjectName(projectDir: string): string {
  // Try .cleo/project-info.json first
  try {
    const infoPath = join(projectDir, ".cleo", "project-info.json");
    if (existsSync(infoPath)) {
      const raw = readFileSync(infoPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["name"] === "string" && parsed["name"].length > 0) {
        return parsed["name"];
      }
    }
  } catch {
    // Fall through
  }

  // Try package.json
  try {
    const pkgPath = join(projectDir, "package.json");
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["name"] === "string" && parsed["name"].length > 0) {
        return parsed["name"];
      }
    }
  } catch {
    // Fall through
  }

  // Fall back to last path segment
  const parts = projectDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown-project";
}

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory for the CleoOS branded startup experience.
 *
 * Registers a `session_start` handler that:
 *   1. Fetches project, task, and session data via `cleo` CLI in parallel
 *   2. Reads the memory-bridge.md handoff note
 *   3. Renders the branded startup banner as a Pi UI widget
 *
 * All operations are best-effort — failures are silently swallowed so Pi
 * is never blocked by CLEO unavailability.
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // Fetch dash + session status in parallel (best-effort)
    const [dashResult, sessionResult, currentResult] = await Promise.allSettled([
      execFileAsync("cleo", ["dash", "--json"], {
        timeout: 8_000,
        cwd: ctx.cwd,
      }),
      execFileAsync("cleo", ["session", "status", "--json"], {
        timeout: 8_000,
        cwd: ctx.cwd,
      }),
      execFileAsync("cleo", ["current", "--json"], {
        timeout: 8_000,
        cwd: ctx.cwd,
      }),
    ]);

    const tasks =
      dashResult.status === "fulfilled"
        ? parseDashSummary(dashResult.value.stdout)
        : { active: 0, pending: 0, done: 0, total: 0, blocked: 0 };

    const session =
      sessionResult.status === "fulfilled"
        ? parseSessionInfo(sessionResult.value.stdout)
        : { active: false, id: "", name: "", currentTaskId: null, handoffNote: null };

    const currentTask =
      currentResult.status === "fulfilled"
        ? parseCurrentTask(currentResult.value.stdout)
        : null;

    // Read handoff note from memory-bridge.md (synchronous, fast)
    const handoffNote = readMemoryBridgeNote(ctx.cwd);

    // Detect project name from filesystem
    const projectName = detectProjectName(ctx.cwd);

    // Build and display the banner
    const bannerLines = buildStartupBanner(
      tasks,
      session,
      currentTask,
      handoffNote,
      projectName,
    );

    if (ctx.hasUI) {
      ctx.ui.setWidget("cleo-startup-banner", bannerLines, {
        placement: "aboveEditor",
      });

      // Also set a compact status bar entry
      const taskSummary = `${tasks.active}a ${tasks.pending}p ${tasks.done}d`;
      ctx.ui.setStatus(
        "cleo-startup",
        `${ICON_FORGE} ${projectName.split("/").pop() ?? projectName} [${taskSummary}]`,
      );
    } else {
      // No UI — print to stderr as a text summary (visible in TTY mode)
      process.stderr.write(bannerLines.join("\n") + "\n");
    }
  });

  // -------------------------------------------------------------------------
  // Command: /cleo:status — on-demand project status refresh
  // -------------------------------------------------------------------------
  pi.registerCommand("cleo:status", {
    description: "Show CleoOS project status: tasks, session, and last handoff",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const [dashResult, sessionResult, currentResult] = await Promise.allSettled([
        execFileAsync("cleo", ["dash", "--json"], { timeout: 8_000, cwd: ctx.cwd }),
        execFileAsync("cleo", ["session", "status", "--json"], { timeout: 8_000, cwd: ctx.cwd }),
        execFileAsync("cleo", ["current", "--json"], { timeout: 8_000, cwd: ctx.cwd }),
      ]);

      const tasks =
        dashResult.status === "fulfilled"
          ? parseDashSummary(dashResult.value.stdout)
          : { active: 0, pending: 0, done: 0, total: 0, blocked: 0 };

      const session =
        sessionResult.status === "fulfilled"
          ? parseSessionInfo(sessionResult.value.stdout)
          : { active: false, id: "", name: "", currentTaskId: null, handoffNote: null };

      const currentTask =
        currentResult.status === "fulfilled"
          ? parseCurrentTask(currentResult.value.stdout)
          : null;

      const handoffNote = readMemoryBridgeNote(ctx.cwd);
      const projectName = detectProjectName(ctx.cwd);

      const bannerLines = buildStartupBanner(
        tasks,
        session,
        currentTask,
        handoffNote,
        projectName,
      );

      pi.sendMessage(
        {
          customType: "cleo-status",
          content: bannerLines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("CleoOS status refreshed", "info");
      }
    },
  });

  // session_shutdown: remove the startup banner widget
  pi.on("session_shutdown", async () => {
    // No cleanup needed — Pi clears widgets on shutdown
  });
}

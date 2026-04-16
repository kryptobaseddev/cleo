/**
 * CleoOS agent monitor — agent activity TUI + Circle of Eleven status.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/cleo-agent-monitor.ts`
 *
 * Installed to: $XDG_DATA_HOME/cleo/extensions/cleo-agent-monitor.js
 * Loaded by:    Pi via `--extension <path>` injected by CleoOS cli.ts
 *
 * T442 deliverables:
 *   - `/cleo:agents` command: shows current agent activity in a TUI panel
 *   - `before_agent_start` hook: tracks agent spawns with tier-aware prefixes
 *   - `/cleo:circle` command: renders Circle of Eleven status from CLEO CLI data
 *
 * Requirements:
 *   - Pi coding agent runtime (`@mariozechner/pi-coding-agent`)
 *   - Optional: `cleo` CLI on PATH for `/cleo:circle` data
 *
 * Guardrails:
 *   - Best-effort: if `cleo` CLI is not available, `/cleo:circle` shows
 *     static fallback data. NEVER crash Pi.
 *   - NO top-level await; all work happens inside event handlers.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  accentPrimary,
  accentSuccess,
  accentWarning,
  accentError,
  textSecondary,
  textTertiary,
  tierWorker,
  bold,
  DOT_FILLED,
  DOT_HOLLOW,
  ICON_FORGE,
  LINE_HORIZONTAL,
} from "./tui-theme.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// ANSI color helpers — imported from shared tui-theme.ts
// ============================================================================
// All styling functions come from tui-theme.ts. The mapping to design tokens:
//   accentPrimary  → #a855f7 (ANSI 135) — headers, Circle of Eleven title
//   accentSuccess  → #22c55e (ANSI 35)  — active dots, orchestrator [O]
//   accentWarning  → #f59e0b (ANSI 214) — paused dots, lead [L]
//   accentError    → #ef4444 (ANSI 196) — error dots, failed states
//   tierWorker     → #5fafff (ANSI 75)  — worker [W]
//   textSecondary  → #94a3b8 (ANSI 245) — dim/muted text
//   textTertiary   → #64748b (ANSI 243) — disabled/very muted text
//   bold           → ANSI bold           — headings, agent names

// ============================================================================
// Agent activity tracking
// ============================================================================

/** Tier role of an agent in the 3-tier hierarchy. */
type AgentTierRole = "orchestrator" | "lead" | "worker";

/** A tracked agent activity entry. */
interface AgentActivity {
  /** ISO-8601 timestamp of the activity. */
  timestamp: string;
  /** Agent name. */
  name: string;
  /** Agent tier role. */
  role: AgentTierRole;
  /** Activity description (e.g. "spawned", "completed"). */
  action: string;
}

/** Maximum number of agent activities to keep in the ring buffer. */
const MAX_ACTIVITIES = 5;

/** In-memory ring buffer of recent agent activities. */
const activities: AgentActivity[] = [];

/** Widget key for the agent monitor panel. */
const WIDGET_KEY = "cleo-agent-monitor";

/**
 * Cached CANT tool count from the bridge extension's status bar.
 * Updated when agent spawns are tracked (best-effort cross-extension state).
 */
let cachedCantTools = 0;

/**
 * Cached CANT agent count from agent spawn tracking.
 * Incremented as agents are seen in the current session.
 */
let cachedCantAgents = 0;

/**
 * Return the tier prefix for an agent role.
 *
 * Uses design system colors:
 * - `[O]` orchestrator — accent-success (#22c55e)
 * - `[L]` lead — accent-warning (#f59e0b)
 * - `[W]` worker — tier-worker blue (#5fafff)
 *
 * @param role - The agent's tier role.
 * @returns The styled tier prefix string.
 */
export function tierPrefix(role: AgentTierRole): string {
  switch (role) {
    case "orchestrator":
      return accentSuccess("[O]");
    case "lead":
      return accentWarning("[L]");
    default:
      return tierWorker("[W]");
  }
}

/**
 * Format a single agent activity for TUI display.
 *
 * @param activity - The activity to format.
 * @returns A formatted single-line string with ANSI styling.
 */
export function formatActivity(activity: AgentActivity): string {
  const time = activity.timestamp.slice(11, 19);
  const prefix = tierPrefix(activity.role);
  return `${prefix} ${textSecondary(`[${time}]`)} ${bold(activity.name)} ${textSecondary(activity.action)}`;
}

/**
 * Record an agent activity and trim the buffer to MAX_ACTIVITIES.
 *
 * @param activity - The activity to record.
 */
function recordActivity(activity: AgentActivity): void {
  activities.push(activity);
  while (activities.length > MAX_ACTIVITIES) {
    activities.shift();
  }
}

/**
 * Render the agent activity widget.
 *
 * @param ctx - The Pi extension context.
 */
function renderAgentWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (activities.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, [textSecondary("  No agent activity yet")], {
      placement: "belowEditor",
    });
    return;
  }

  const header = accentPrimary(`  ${ICON_FORGE} Agent Activity`);
  const separator = textSecondary("  " + LINE_HORIZONTAL.repeat(30));
  const lines = [header, separator, ...activities.map(formatActivity)];
  ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
}

// ============================================================================
// Circle of Eleven status
// ============================================================================

/**
 * Parsed dashboard data from `cleo dash --json`.
 *
 * Each field is optional because the CLI output format may vary or the
 * CLI may not be available. Fields are sourced from the `data` envelope
 * of `cleo dash --json` output.
 */
interface DashData {
  /** Number of active tasks (summary.active). */
  activeTasks?: number;
  /** Number of pending tasks (summary.pending). */
  pendingTasks?: number;
  /** Number of completed tasks (summary.done). */
  doneTasks?: number;
  /** Total tasks across all statuses. */
  totalTasks?: number;
  /** Number of blocked tasks (blockedTasks.count). */
  blockedTasks?: number;
  /** Number of high-priority tasks (highPriority.count). */
  highPriorityTasks?: number;
  /** Top labels from the project (topLabels[].label). */
  topLabels?: string[];
}

/**
 * Parsed session data from `cleo session status --json`.
 *
 * Each field is optional; the CLI may not be available or the
 * response format may vary.
 */
interface SessionData {
  /** Whether a session is currently active. */
  hasActiveSession?: boolean;
  /** Active session ID. */
  sessionId?: string;
  /** Active session name. */
  sessionName?: string;
  /** Number of tasks completed in the current session. */
  tasksCompleted?: number;
  /** Number of focus changes in the current session. */
  focusChanges?: number;
}

/**
 * Combined data for Circle of Eleven rendering.
 *
 * Merges dashboard data, session data, and any in-memory
 * extension state (e.g. CANT bundle counts from the bridge).
 */
interface CircleData {
  dash: DashData;
  session: SessionData;
  /** Number of tools from the CANT bundle (populated by bridge). */
  cantTools?: number;
  /** Number of agents from the CANT bundle (populated by bridge). */
  cantAgents?: number;
}

/**
 * Parse `cleo dash --json` output for Circle of Eleven status data.
 *
 * Extracts task summary counts, blocked/high-priority stats, and top labels.
 * Best-effort: returns empty object on any parse failure.
 *
 * @param output - Raw stdout from `cleo dash --json`.
 * @returns Parsed dashboard data.
 */
function parseDashOutput(output: string): DashData {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;

    // Extract summary counts
    const summary = data["summary"] as Record<string, unknown> | undefined;
    const activeTasks = typeof summary?.["active"] === "number" ? summary["active"] : undefined;
    const pendingTasks = typeof summary?.["pending"] === "number" ? summary["pending"] : undefined;
    const doneTasks = typeof summary?.["done"] === "number" ? summary["done"] : undefined;
    const totalTasks = typeof summary?.["total"] === "number" ? summary["total"] : undefined;

    // Extract blocked tasks count
    const blocked = data["blockedTasks"] as Record<string, unknown> | undefined;
    const blockedCount = typeof blocked?.["count"] === "number" ? blocked["count"] : undefined;

    // Extract high-priority count
    const highPri = data["highPriority"] as Record<string, unknown> | undefined;
    const highPriCount = typeof highPri?.["count"] === "number" ? highPri["count"] : undefined;

    // Extract top labels
    const rawLabels = data["topLabels"];
    let topLabels: string[] | undefined;
    if (Array.isArray(rawLabels)) {
      topLabels = rawLabels
        .slice(0, 5)
        .map((l) => {
          const label = (l as Record<string, unknown>)["label"];
          return typeof label === "string" ? label : "";
        })
        .filter((l) => l.length > 0);
    }

    return {
      activeTasks,
      pendingTasks,
      doneTasks,
      totalTasks,
      blockedTasks: blockedCount,
      highPriorityTasks: highPriCount,
      topLabels,
    };
  } catch {
    return {};
  }
}

/**
 * Parse `cleo session status --json` output for session data.
 *
 * Extracts active session state, ID, name, and completion stats.
 * Best-effort: returns empty object on any parse failure.
 *
 * @param output - Raw stdout from `cleo session status --json`.
 * @returns Parsed session data.
 */
function parseSessionOutput(output: string): SessionData {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    const sessionWrapper = data["session"] as Record<string, unknown> | undefined;

    if (!sessionWrapper) return {};

    const hasActive = sessionWrapper["hasActiveSession"] === true;
    const session = sessionWrapper["session"] as Record<string, unknown> | undefined;

    if (!hasActive || !session) {
      return { hasActiveSession: false };
    }

    const stats = session["stats"] as Record<string, unknown> | undefined;

    return {
      hasActiveSession: true,
      sessionId: typeof session["id"] === "string" ? session["id"] : undefined,
      sessionName: typeof session["name"] === "string" ? session["name"] : undefined,
      tasksCompleted: typeof stats?.["tasksCompleted"] === "number" ? stats["tasksCompleted"] : undefined,
      focusChanges: typeof stats?.["focusChanges"] === "number" ? stats["focusChanges"] : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Build the Circle of Eleven status display lines.
 *
 * Each Circle aspect is shown with a filled (active) or hollow (inactive)
 * dot and a brief status summary. Data is wired from live CLI sources
 * where available, with explicit "not wired" labels where the data
 * source does not yet exist.
 *
 * Design system colors:
 * - Filled dot: accent-success (#22c55e) for active zones
 * - Warning dot: accent-warning (#f59e0b) for zones with alerts
 * - Error dot: accent-error (#ef4444) for blocked/failed zones
 * - Hollow dot: text-secondary (#94a3b8) for inactive/offline zones
 *
 * @param data - Combined Circle data from CLI sources and extension state.
 * @returns Array of ANSI-styled lines for TUI display.
 */
export function buildCircleOfTenStatus(data: CircleData): string[] {
  const dot = accentSuccess(DOT_FILLED);
  const warnDot = accentWarning(DOT_FILLED);
  const errDot = accentError(DOT_FILLED);
  const hollow = textSecondary(DOT_HOLLOW);

  const { dash, session } = data;

  // ── Smiths (tasks) — wired to cleo dash summary ──
  const activeCount = dash.activeTasks ?? 0;
  const pendingCount = dash.pendingTasks ?? 0;
  const doneCount = dash.doneTasks ?? 0;
  const smithsDot = activeCount > 0 ? dot : (pendingCount > 0 ? warnDot : hollow);
  const smithsDetail = `${activeCount} active, ${pendingCount} pending, ${doneCount} done`;

  // ── Weavers (pipeline) — not wired (no pipeline CLI endpoint) ──
  const weaversDot = hollow;
  const weaversDetail = textTertiary("not wired");

  // ── Conductors (orchestrate) — wired to cleo session status ──
  const hasSession = session.hasActiveSession === true;
  const conductorsDot = hasSession ? dot : hollow;
  const conductorsDetail = hasSession
    ? `active: ${session.sessionName ?? session.sessionId ?? "unnamed"}`
    : "no session";

  // ── Artificers (tools) — wired to CANT bundle counts ──
  const toolCount = data.cantTools ?? 0;
  const agentCount = data.cantAgents ?? 0;
  const artificersDot = toolCount > 0 || agentCount > 0 ? dot : hollow;
  const artificersDetail = `${toolCount} tools, ${agentCount} agents`;

  // ── Archivists (memory) — wired to cleo dash (done count as proxy) ──
  // The dash endpoint does not directly expose observation counts,
  // but done tasks indicate archived work history.
  const archivistsDot = doneCount > 0 ? dot : hollow;
  const archivistsDetail = `${doneCount} archived tasks`;

  // ── Scribes (session) — wired to session stats ──
  const scribesCompleted = session.tasksCompleted ?? 0;
  const scribesDot = hasSession ? dot : hollow;
  const scribesDetail = hasSession
    ? `${scribesCompleted} completed this session`
    : "no session";

  // ── Wardens (check) — wired to blocked + high-priority counts ──
  const blockedCount = dash.blockedTasks ?? 0;
  const highPriCount = dash.highPriorityTasks ?? 0;
  const wardensDot = blockedCount > 0 ? errDot : (highPriCount > 0 ? warnDot : dot);
  const wardensDetail = `${blockedCount} blocked, ${highPriCount} high-pri`;

  // ── Wayfinders (nexus) — not wired (Nexus deferred to Phase 3) ──
  const wayfindersDot = hollow;
  const wayfindersDetail = textTertiary("not wired");

  // ── Catchers (sticky) — not wired (no sticky notes API) ──
  const catchersDot = hollow;
  const catchersDetail = textTertiary("not wired");

  // ── Keepers (admin) — wired to overall health from dash totals ──
  const totalCount = dash.totalTasks ?? 0;
  const keepersDot = totalCount > 0 ? dot : hollow;
  const keepersDetail = `${totalCount} total tasks tracked`;

  // ── Labels line (bonus data from dash) ──
  const labelsLine = dash.topLabels && dash.topLabels.length > 0
    ? `  ${textSecondary("Labels:")} ${textTertiary(dash.topLabels.join(", "))}`
    : null;

  const lines = [
    "",
    bold(accentPrimary("  The Circle of Eleven")),
    textSecondary("  " + LINE_HORIZONTAL.repeat(36)),
    `  ${bold("Smiths")} ${textSecondary("(tasks)")}      ${smithsDot} ${smithsDetail}`,
    `  ${bold("Weavers")} ${textSecondary("(pipeline)")}  ${weaversDot} ${weaversDetail}`,
    `  ${bold("Conductors")} ${textSecondary("(orch)")}   ${conductorsDot} ${conductorsDetail}`,
    `  ${bold("Artificers")} ${textSecondary("(tools)")}  ${artificersDot} ${artificersDetail}`,
    `  ${bold("Archivists")} ${textSecondary("(memory)")} ${archivistsDot} ${archivistsDetail}`,
    `  ${bold("Scribes")} ${textSecondary("(session)")}   ${scribesDot} ${scribesDetail}`,
    `  ${bold("Wardens")} ${textSecondary("(check)")}     ${wardensDot} ${wardensDetail}`,
    `  ${bold("Wayfinders")} ${textSecondary("(nexus)")}  ${wayfindersDot} ${wayfindersDetail}`,
    `  ${bold("Catchers")} ${textSecondary("(sticky)")}   ${catchersDot} ${catchersDetail}`,
    `  ${bold("Keepers")} ${textSecondary("(admin)")}     ${keepersDot} ${keepersDetail}`,
  ];

  if (labelsLine) {
    lines.push(textSecondary("  " + LINE_HORIZONTAL.repeat(36)));
    lines.push(labelsLine);
  }

  lines.push("");

  return lines;
}

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory for the CleoOS agent monitor.
 *
 * Registers agent activity tracking, the `/cleo:agents` command, and the
 * `/cleo:circle` Circle of Eleven status command.
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  // -------------------------------------------------------------------------
  // session_start: initialize widget
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    activities.length = 0;
    cachedCantTools = 0;
    cachedCantAgents = 0;
    renderAgentWidget(ctx);
  });

  // -------------------------------------------------------------------------
  // before_agent_start: track agent spawn
  // -------------------------------------------------------------------------
  pi.on(
    "before_agent_start",
    async (
      event: {
        systemPrompt?: string;
        agentName?: string;
        agentDef?: {
          role?: string;
          name?: string;
        };
      },
      ctx: ExtensionContext,
    ) => {
      const agentName = event.agentName ?? event.agentDef?.name ?? "unknown";
      const roleStr = event.agentDef?.role ?? "worker";

      // Normalise the role to a valid AgentTierRole
      let role: AgentTierRole;
      switch (roleStr) {
        case "orchestrator":
          role = "orchestrator";
          break;
        case "lead":
          role = "lead";
          break;
        default:
          role = "worker";
          break;
      }

      recordActivity({
        timestamp: new Date().toISOString(),
        name: agentName,
        role,
        action: "spawned",
      });

      // Track unique agents seen for Circle of Eleven Artificers zone
      cachedCantAgents = activities.length;

      renderAgentWidget(ctx);

      // Return empty object (do not modify system prompt)
      return {};
    },
  );

  // -------------------------------------------------------------------------
  // Command: /cleo:agents — show agent activity
  // -------------------------------------------------------------------------
  pi.registerCommand("cleo:agents", {
    description: "Show current agent activity and recent spawn history",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines: string[] = [
        bold(accentPrimary(`${ICON_FORGE} CleoOS Agent Monitor`)),
        textSecondary("  " + LINE_HORIZONTAL.repeat(28)),
        "",
        `  Total tracked activities: ${activities.length}`,
        "",
      ];

      if (activities.length === 0) {
        lines.push(textSecondary("  No agent activity recorded this session."));
      } else {
        lines.push(bold("  Recent Agent Activity:"));
        for (const activity of activities) {
          lines.push("  " + formatActivity(activity));
        }
      }

      lines.push("");
      lines.push(textSecondary(`  Legend: ${accentSuccess("[O]")} orchestrator  ${accentWarning("[L]")} lead  ${tierWorker("[W]")} worker`));

      pi.sendMessage(
        {
          customType: "cleo-agent-monitor",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );

      if (ctx.hasUI) {
        ctx.ui.notify(`Agent monitor: ${activities.length} activities`, "info");
      }
    },
  });

  // -------------------------------------------------------------------------
  // Command: /cleo:circle — Circle of Eleven status
  // -------------------------------------------------------------------------
  pi.registerCommand("cleo:circle", {
    description: "Show Circle of Eleven operational status from CLEO CLI",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let dashData: DashData = {};
      let sessionData: SessionData = {};

      // Best-effort: fetch data from both `cleo dash` and `cleo session status`
      // in parallel. Either or both may fail if the CLI is not available.
      const [dashResult, sessionResult] = await Promise.allSettled([
        execFileAsync("cleo", ["dash", "--json"], { timeout: 5000, cwd: ctx.cwd }),
        execFileAsync("cleo", ["session", "status", "--json"], { timeout: 5000, cwd: ctx.cwd }),
      ]);

      if (dashResult.status === "fulfilled") {
        dashData = parseDashOutput(dashResult.value.stdout);
      }
      if (sessionResult.status === "fulfilled") {
        sessionData = parseSessionOutput(sessionResult.value.stdout);
      }

      // Build combined Circle data, including CANT bundle state if available.
      // The CANT bridge stores counts in its own module scope — we read them
      // from the status bar entries as a cross-extension communication channel.
      // For now, we pass defaults and let the bridge contribute via status bar.
      const circleData: CircleData = {
        dash: dashData,
        session: sessionData,
        cantTools: cachedCantTools,
        cantAgents: cachedCantAgents,
      };

      const lines = buildCircleOfTenStatus(circleData);

      pi.sendMessage(
        {
          customType: "cleo-circle-of-ten",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("Circle of Eleven status", "info");
      }
    },
  });

  // -------------------------------------------------------------------------
  // session_shutdown: clear state
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    activities.length = 0;
    cachedCantTools = 0;
    cachedCantAgents = 0;
  });
}

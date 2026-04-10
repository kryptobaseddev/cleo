/**
 * CleoOS agent monitor — agent activity TUI + Circle of Ten status.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/cleo-agent-monitor.ts`
 *
 * Installed to: $XDG_DATA_HOME/cleo/extensions/cleo-agent-monitor.js
 * Loaded by:    Pi via `--extension <path>` injected by CleoOS cli.ts
 *
 * T442 deliverables:
 *   - `/cleo:agents` command: shows current agent activity in a TUI panel
 *   - `before_agent_start` hook: tracks agent spawns with tier-aware prefixes
 *   - `/cleo:circle` command: renders Circle of Ten status from CLEO CLI data
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

const execFileAsync = promisify(execFile);

// ============================================================================
// ANSI color helpers (shared visual identity with cleo-cant-bridge)
// ============================================================================

/** ANSI escape code prefix. */
const ESC = "\x1b[";

/** ANSI reset sequence. */
const RESET = `${ESC}0m`;

/**
 * Wrap text in ANSI 256-color foreground.
 *
 * @param text - The text to colorize.
 * @param code - ANSI 256-color code.
 * @returns The text wrapped in ANSI color escape sequences.
 */
function ansi256(text: string, code: number): string {
  return `${ESC}38;5;${code}m${text}${RESET}`;
}

/**
 * Purple accent color (approximate #a855f7).
 *
 * @param text - The text to style.
 * @returns Purple ANSI text.
 */
function purple(text: string): string {
  return ansi256(text, 135);
}

/**
 * Green accent color (approximate #22c55e).
 *
 * @param text - The text to style.
 * @returns Green ANSI text.
 */
function green(text: string): string {
  return ansi256(text, 35);
}

/**
 * Yellow accent color (approximate #f59e0b).
 *
 * @param text - The text to style.
 * @returns Yellow ANSI text.
 */
function yellow(text: string): string {
  return ansi256(text, 214);
}

/**
 * Blue accent color.
 *
 * @param text - The text to style.
 * @returns Blue ANSI text.
 */
function blue(text: string): string {
  return ansi256(text, 75);
}

/**
 * Dim/muted text.
 *
 * @param text - The text to dim.
 * @returns Dim ANSI text.
 */
function dim(text: string): string {
  return ansi256(text, 245);
}

/**
 * Bold text.
 *
 * @param text - The text to bold.
 * @returns Bold ANSI text.
 */
function bold(text: string): string {
  return `${ESC}1m${text}${RESET}`;
}

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
 * Return the tier prefix for an agent role.
 *
 * - `[O]` orchestrator (green)
 * - `[L]` lead (yellow)
 * - `[W]` worker (blue)
 *
 * @param role - The agent's tier role.
 * @returns The styled tier prefix string.
 */
export function tierPrefix(role: AgentTierRole): string {
  switch (role) {
    case "orchestrator":
      return green("[O]");
    case "lead":
      return yellow("[L]");
    default:
      return blue("[W]");
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
  return `${prefix} ${dim(`[${time}]`)} ${bold(activity.name)} ${dim(activity.action)}`;
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
    ctx.ui.setWidget(WIDGET_KEY, [dim("  No agent activity yet")], {
      placement: "belowEditor",
    });
    return;
  }

  const header = purple("  \u2692 Agent Activity");
  const separator = dim("  " + "\u2500".repeat(30));
  const lines = [header, separator, ...activities.map(formatActivity)];
  ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
}

// ============================================================================
// Circle of Ten status
// ============================================================================

/**
 * Parsed dashboard data from `cleo dash`.
 *
 * Each field is optional because the CLI output format may vary or the
 * CLI may not be available.
 */
interface DashData {
  tasks?: number;
  sessions?: number;
  observations?: number;
}

/**
 * Parse `cleo dash` JSON output for Circle of Ten status data.
 *
 * Best-effort: returns empty object on any parse failure.
 *
 * @param output - Raw stdout from `cleo dash --json`.
 * @returns Parsed dashboard data.
 */
function parseDashOutput(output: string): DashData {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    return {
      tasks: typeof data["activeTasks"] === "number" ? data["activeTasks"] : undefined,
      sessions: typeof data["activeSessions"] === "number" ? data["activeSessions"] : undefined,
      observations: typeof data["observations"] === "number" ? data["observations"] : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Build the Circle of Ten status display lines.
 *
 * Each Circle aspect is shown with a filled (active) or hollow (inactive)
 * dot and a brief status summary. Data comes from `cleo dash` when available,
 * otherwise shows reasonable fallback states.
 *
 * @param data - Dashboard data from the CLEO CLI.
 * @returns Array of ANSI-styled lines for TUI display.
 */
export function buildCircleOfTenStatus(data: DashData): string[] {
  const dot = green("\u25CF");
  const hollow = dim("\u25CB");

  const taskCount = data.tasks ?? 0;
  const sessionCount = data.sessions ?? 0;
  const obsCount = data.observations ?? 0;

  return [
    "",
    bold(purple("  The Circle of Ten")),
    dim("  " + "\u2500".repeat(20)),
    `  Smiths (tasks)      ${taskCount > 0 ? dot : hollow} ${taskCount} active`,
    `  Weavers (pipeline)  ${dot} stage: impl`,
    `  Conductors (orch)   ${sessionCount > 0 ? dot : hollow} ${sessionCount} session${sessionCount !== 1 ? "s" : ""}`,
    `  Artificers (tools)  ${hollow} 0 recipes`,
    `  Archivists (memory) ${obsCount > 0 ? dot : hollow} ${obsCount} obs`,
    `  Scribes (session)   ${dot} active`,
    `  Wardens (check)     ${hollow} 0 alerts`,
    `  Wayfinders (nexus)  ${hollow} offline`,
    `  Catchers (sticky)   ${hollow} 0 notes`,
    `  Keepers (admin)     ${dot} healthy`,
    "",
  ];
}

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory for the CleoOS agent monitor.
 *
 * Registers agent activity tracking, the `/cleo:agents` command, and the
 * `/cleo:circle` Circle of Ten status command.
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  // -------------------------------------------------------------------------
  // session_start: initialize widget
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    activities.length = 0;
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
        bold(purple("\u2692 CleoOS Agent Monitor")),
        dim("  " + "\u2500".repeat(28)),
        "",
        `  Total tracked activities: ${activities.length}`,
        "",
      ];

      if (activities.length === 0) {
        lines.push(dim("  No agent activity recorded this session."));
      } else {
        lines.push(bold("  Recent Agent Activity:"));
        for (const activity of activities) {
          lines.push("  " + formatActivity(activity));
        }
      }

      lines.push("");
      lines.push(dim("  Legend: [O] orchestrator  [L] lead  [W] worker"));

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
  // Command: /cleo:circle — Circle of Ten status
  // -------------------------------------------------------------------------
  pi.registerCommand("cleo:circle", {
    description: "Show Circle of Ten operational status from CLEO CLI",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let dashData: DashData = {};

      // Best-effort: try to fetch data from `cleo dash`
      try {
        const { stdout } = await execFileAsync("cleo", ["dash", "--json"], {
          timeout: 5000,
          cwd: ctx.cwd,
        });
        dashData = parseDashOutput(stdout);
      } catch {
        // CLI not available or timed out — use defaults
      }

      const lines = buildCircleOfTenStatus(dashData);

      pi.sendMessage(
        {
          customType: "cleo-circle-of-ten",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("Circle of Ten status", "info");
      }
    },
  });

  // -------------------------------------------------------------------------
  // session_shutdown: clear state
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    activities.length = 0;
  });
}

/**
 * CleoOS chat room — inter-agent messaging TUI.
 *
 * Installed to: $CLEO_HOME/pi-extensions/cleo-chatroom.ts
 * Loaded by:    Pi via `-e <path>` or settings.json extensions array
 *
 * Wave 7 — surfaces inter-agent traffic as a TUI panel per ULTRAPLAN
 * section 13. Agents communicate through four tools:
 *
 *   - `send_to_lead`            — worker sends a message to their lead.
 *   - `broadcast_to_team`       — lead broadcasts to all group workers.
 *   - `report_to_orchestrator`  — lead reports status to the orchestrator.
 *   - `query_peer`              — worker queries another worker in the same group.
 *
 * Each tool appends a structured JSONL entry to the Pi session's message
 * log. A TUI widget (registered on `session_start`) renders the last N
 * messages in a scrollable panel below the editor.
 *
 * This is a TEMPLATE extension — it uses `import type` for Pi types and
 * mirrors the patterns established by the existing extensions in
 * `packages/cleo/templates/cleoos-hub/pi-extensions/`.
 *
 * @packageDocumentation
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------

/** A single inter-agent chat message. */
interface ChatMessage {
  /** ISO-8601 timestamp of when the message was created. */
  timestamp: string;
  /** Name of the sending agent. */
  from: string;
  /** Name of the receiving agent or group (e.g. "team:backend"). */
  to: string;
  /** Message channel identifying the tool that produced this message. */
  channel: "send_to_lead" | "broadcast_to_team" | "report_to_orchestrator" | "query_peer";
  /** The message text. */
  text: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const WIDGET_KEY = "cleo-chatroom";
const STATUS_KEY = "cleo-chatroom";
const MAX_DISPLAY_MESSAGES = 15;

/** In-memory message buffer for the current session. */
const messages: ChatMessage[] = [];

/** Path to the JSONL log file (set on session_start). */
let logPath: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Record a chat message: push to the in-memory buffer and append to the
 * JSONL log file. The log file is created lazily on first write.
 *
 * @param msg - The chat message to record.
 */
function recordMessage(msg: ChatMessage): void {
  messages.push(msg);
  if (logPath) {
    try {
      appendFileSync(logPath, JSON.stringify(msg) + "\n", "utf-8");
    } catch {
      // Best-effort: never crash Pi over a log write failure.
    }
  }
}

/**
 * Format a chat message for TUI display.
 *
 * @param msg - The message to format.
 * @returns A single-line string representation.
 */
function formatMessage(msg: ChatMessage): string {
  const time = msg.timestamp.slice(11, 19);
  return `[${time}] ${msg.from} -> ${msg.to}: ${msg.text}`;
}

/**
 * Render the chat room widget with the latest messages.
 *
 * @param ctx - The Pi extension context.
 */
function renderWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const tail = messages.slice(-MAX_DISPLAY_MESSAGES);
  if (tail.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, ["(no messages yet)"], {
      placement: "belowEditor",
    });
    return;
  }
  const lines = tail.map(formatMessage);
  ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
  ctx.ui.setStatus(STATUS_KEY, `Chat: ${messages.length} msg(s)`);
}

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox)
// ---------------------------------------------------------------------------

const SendToLeadParams = Type.Object({
  message: Type.String({ description: "Message to send to your team lead" }),
  from: Type.String({ description: "Your agent name" }),
  lead: Type.String({ description: "Name of the lead agent" }),
});

const BroadcastToTeamParams = Type.Object({
  message: Type.String({ description: "Message to broadcast to the team" }),
  from: Type.String({ description: "Your agent name (lead)" }),
  group: Type.String({ description: "Team group name (e.g. 'backend')" }),
});

const ReportToOrchestratorParams = Type.Object({
  message: Type.String({ description: "Status report for the orchestrator" }),
  from: Type.String({ description: "Your agent name (lead)" }),
  orchestrator: Type.String({
    description: "Name of the orchestrator agent",
  }),
});

const QueryPeerParams = Type.Object({
  message: Type.String({ description: "Query for your peer worker" }),
  from: Type.String({ description: "Your agent name" }),
  peer: Type.String({ description: "Name of the peer worker to query" }),
});

// ---------------------------------------------------------------------------
// Pi extension factory
// ---------------------------------------------------------------------------

/**
 * Pi extension factory for the CleoOS chat room.
 *
 * Registers four inter-agent communication tools and a TUI widget that
 * displays the message stream. Also registers `/cleo:chat-info` for
 * introspection and clears state on session shutdown.
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  // -------------------------------------------------------------------------
  // session_start: initialize log directory and widget
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    messages.length = 0;
    logPath = null;

    try {
      const chatDir = join(ctx.cwd, ".cleo", "chat");
      mkdirSync(chatDir, { recursive: true });
      const sessionTs = new Date().toISOString().replace(/[:.]/g, "-");
      logPath = join(chatDir, `chatroom-${sessionTs}.jsonl`);
    } catch {
      // Best-effort: widget still works without persistent logging.
    }

    renderWidget(ctx);

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, "Chat: ready");
    }
  });

  // -------------------------------------------------------------------------
  // Tools: send_to_lead
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "send_to_lead",
    label: "Send to Lead",
    description:
      "Send a message from a worker agent to their team lead. " +
      "Used for status updates, questions, and escalations.",
    parameters: SendToLeadParams,
    async execute(
      _id: string,
      params: { message: string; from: string; lead: string },
      _signal: AbortSignal,
      _onUpdate: (text: string) => void,
      ctx: ExtensionContext,
    ) {
      const msg: ChatMessage = {
        timestamp: new Date().toISOString(),
        from: params.from,
        to: params.lead,
        channel: "send_to_lead",
        text: params.message,
      };
      recordMessage(msg);
      renderWidget(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to lead ${params.lead}: ${params.message}`,
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: broadcast_to_team
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "broadcast_to_team",
    label: "Broadcast to Team",
    description:
      "Broadcast a message from a lead to all workers in their group. " +
      "Used for coordination directives and status announcements.",
    parameters: BroadcastToTeamParams,
    async execute(
      _id: string,
      params: { message: string; from: string; group: string },
      _signal: AbortSignal,
      _onUpdate: (text: string) => void,
      ctx: ExtensionContext,
    ) {
      const msg: ChatMessage = {
        timestamp: new Date().toISOString(),
        from: params.from,
        to: `team:${params.group}`,
        channel: "broadcast_to_team",
        text: params.message,
      };
      recordMessage(msg);
      renderWidget(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Broadcast to team:${params.group}: ${params.message}`,
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: report_to_orchestrator
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "report_to_orchestrator",
    label: "Report to Orchestrator",
    description:
      "Send a status report from a lead to the orchestrator. " +
      "Used for task completion reports, blockers, and escalations.",
    parameters: ReportToOrchestratorParams,
    async execute(
      _id: string,
      params: { message: string; from: string; orchestrator: string },
      _signal: AbortSignal,
      _onUpdate: (text: string) => void,
      ctx: ExtensionContext,
    ) {
      const msg: ChatMessage = {
        timestamp: new Date().toISOString(),
        from: params.from,
        to: params.orchestrator,
        channel: "report_to_orchestrator",
        text: params.message,
      };
      recordMessage(msg);
      renderWidget(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Report sent to orchestrator ${params.orchestrator}: ${params.message}`,
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: query_peer
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "query_peer",
    label: "Query Peer",
    description:
      "Send a query from one worker to a peer worker in the same group. " +
      "Used for cross-agent information sharing and coordination.",
    parameters: QueryPeerParams,
    async execute(
      _id: string,
      params: { message: string; from: string; peer: string },
      _signal: AbortSignal,
      _onUpdate: (text: string) => void,
      ctx: ExtensionContext,
    ) {
      const msg: ChatMessage = {
        timestamp: new Date().toISOString(),
        from: params.from,
        to: params.peer,
        channel: "query_peer",
        text: params.message,
      };
      recordMessage(msg);
      renderWidget(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Query sent to peer ${params.peer}: ${params.message}`,
          },
        ],
      };
    },
  });

  // -------------------------------------------------------------------------
  // Command: /cleo:chat-info — introspection
  // -------------------------------------------------------------------------
  pi.registerCommand("cleo:chat-info", {
    description: "Show chat room status and recent messages",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const tail = messages.slice(-5);
      const lines = [
        `Chat Room: ${messages.length} total message(s)`,
        `Log: ${logPath ?? "(none)"}`,
        "",
        "Recent messages:",
        ...tail.map(formatMessage),
      ];
      if (tail.length === 0) {
        lines.push("  (no messages yet)");
      }
      pi.sendMessage(
        {
          customType: "cleo-chatroom-info",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
      if (ctx.hasUI) {
        ctx.ui.notify(`Chat room: ${messages.length} messages`, "info");
      }
    },
  });

  // -------------------------------------------------------------------------
  // session_shutdown: clear state
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    messages.length = 0;
    logPath = null;
  });
}

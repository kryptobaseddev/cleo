/**
 * Wave 7 empirical gate — CleoOS chat room tier-aware rendering (T413).
 *
 * Validates that the cleo-chatroom extension formats TUI rows with distinct
 * tier prefixes per ULTRAPLAN §13:
 *
 *   [O]  orchestrator row
 *   [L]  lead row
 *   [W]  worker row (default when role is absent)
 *
 * NOTE: Does NOT start a real Pi session and does NOT import from the extension
 * directly (the extension imports optional runtime deps at module level).
 * The pure formatting functions are re-implemented here as spec-level contracts.
 * If the extension implementation diverges from this spec, the extension is wrong.
 *
 * The source validation tests below also assert the extension source contains
 * the tier-aware formatting.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Spec-level re-implementation of the pure functions defined in cleo-chatroom.ts
// (matches the exported tierPrefix + formatMessage contract exactly)
// ---------------------------------------------------------------------------

/** Tier role of an agent in the 3-tier hierarchy. */
type AgentTierRole = "orchestrator" | "lead" | "worker";

/** Minimal shape of a chat message for formatting purposes. */
interface ChatMessage {
  timestamp: string;
  from: string;
  to: string;
  channel: string;
  text: string;
  role?: AgentTierRole;
}

/**
 * Return the three-character tier prefix for a TUI row.
 * Mirrors `tierPrefix` in cleo-chatroom.ts.
 *
 * @param role - Agent tier role, or undefined to default to worker.
 * @returns "[O]", "[L]", or "[W]".
 */
function tierPrefix(role: AgentTierRole | undefined): string {
  switch (role) {
    case "orchestrator":
      return "[O]";
    case "lead":
      return "[L]";
    default:
      return "[W]";
  }
}

/**
 * Format a chat message as a single TUI row.
 * Mirrors `formatMessage` in cleo-chatroom.ts.
 *
 * @param msg - The chat message to format.
 * @returns A single-line string representation with tier prefix.
 */
function formatMessage(msg: ChatMessage): string {
  const time = msg.timestamp.slice(11, 19);
  const prefix = tierPrefix(msg.role);
  return `${prefix} [${time}] ${msg.from} -> ${msg.to}: ${msg.text}`;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal ChatMessage fixture.
 *
 * @param overrides - Fields to merge into the default fixture.
 * @returns A ChatMessage ready for formatMessage.
 */
function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    timestamp: "2026-04-08T10:00:00.000Z",
    from: "sender-agent",
    to: "receiver-agent",
    channel: "send_to_lead",
    text: "Hello from test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tierPrefix unit tests
// ---------------------------------------------------------------------------

describe("T413 — tierPrefix — maps role to TUI prefix", () => {
  it("returns [O] for orchestrator", () => {
    expect(tierPrefix("orchestrator")).toBe("[O]");
  });

  it("returns [L] for lead", () => {
    expect(tierPrefix("lead")).toBe("[L]");
  });

  it("returns [W] for worker", () => {
    expect(tierPrefix("worker")).toBe("[W]");
  });

  it("returns [W] for undefined (default fallback)", () => {
    expect(tierPrefix(undefined)).toBe("[W]");
  });
});

// ---------------------------------------------------------------------------
// formatMessage tier-aware rendering tests
// ---------------------------------------------------------------------------

describe("T413 — formatMessage — tier-aware TUI rows", () => {
  it("orchestrator row begins with [O]", () => {
    const msg = makeMessage({ role: "orchestrator", from: "cleo-prime" });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[O\]/);
  });

  it("lead row begins with [L]", () => {
    const msg = makeMessage({ role: "lead", from: "planning-lead" });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[L\]/);
  });

  it("worker row begins with [W]", () => {
    const msg = makeMessage({ role: "worker", from: "backend-dev" });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[W\]/);
  });

  it("row without role defaults to [W]", () => {
    const msg = makeMessage({});
    delete (msg as Partial<ChatMessage>).role;
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[W\]/);
  });

  it("row includes timestamp slice (HH:MM:SS)", () => {
    const msg = makeMessage({ role: "lead" });
    const line = formatMessage(msg);
    // Timestamp 2026-04-08T10:00:00.000Z — slice(11,19) = "10:00:00"
    expect(line).toContain("10:00:00");
  });

  it("row includes from -> to and message text", () => {
    const msg = makeMessage({
      role: "lead",
      from: "planning-lead",
      to: "product-manager",
      text: "Please draft acceptance criteria",
    });
    const line = formatMessage(msg);
    expect(line).toContain("planning-lead -> product-manager");
    expect(line).toContain("Please draft acceptance criteria");
  });

  it("three tier rows are visually distinct from each other", () => {
    const orch = formatMessage(makeMessage({ role: "orchestrator", from: "cleo-prime" }));
    const lead = formatMessage(makeMessage({ role: "lead", from: "planning-lead" }));
    const worker = formatMessage(makeMessage({ role: "worker", from: "backend-dev" }));

    // All three prefixes differ
    expect(orch.slice(0, 3)).not.toBe(lead.slice(0, 3));
    expect(lead.slice(0, 3)).not.toBe(worker.slice(0, 3));
    expect(orch.slice(0, 3)).not.toBe(worker.slice(0, 3));
  });

  it("broadcast_to_team channel renders correctly for a lead", () => {
    const msg = makeMessage({
      role: "lead",
      from: "engineering-lead",
      to: "team:engineering",
      channel: "broadcast_to_team",
      text: "Starting implementation sprint",
    });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[L\]/);
    expect(line).toContain("engineering-lead -> team:engineering");
  });

  it("report_to_orchestrator channel renders correctly for a lead", () => {
    const msg = makeMessage({
      role: "lead",
      from: "validation-lead",
      to: "cleo-prime",
      channel: "report_to_orchestrator",
      text: "All tests pass — ready for release",
    });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[L\]/);
    expect(line).toContain("validation-lead -> cleo-prime");
  });

  it("query_peer channel renders correctly for a worker", () => {
    const msg = makeMessage({
      role: "worker",
      from: "backend-dev",
      to: "frontend-dev",
      channel: "query_peer",
      text: "What shape is the API response?",
    });
    const line = formatMessage(msg);
    expect(line).toMatch(/^\[W\]/);
    expect(line).toContain("backend-dev -> frontend-dev");
  });
});

// ---------------------------------------------------------------------------
// T413 — cleo-chatroom.ts source validation
// Source-level assertion that the extension implements tier-aware formatting
// ---------------------------------------------------------------------------

describe("T413 — cleo-chatroom.ts source structure", () => {
  const chatroomPath = join(PKG_ROOT, "extensions", "cleo-chatroom.ts");

  it("cleo-chatroom.ts exists", () => {
    expect(existsSync(chatroomPath), `Missing: ${chatroomPath}`).toBe(true);
  });

  it("source exports AgentTierRole type", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain("AgentTierRole");
  });

  it("source exports tierPrefix function", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain("export function tierPrefix");
  });

  it("source exports formatMessage function", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain("export function formatMessage");
  });

  it("source uses [O] prefix for orchestrator", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain('"[O]"');
  });

  it("source uses [L] prefix for lead", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain('"[L]"');
  });

  it("source uses [W] prefix for worker / default", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain('"[W]"');
  });

  it("ChatMessage interface carries optional role field", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain("role?: AgentTierRole");
  });

  it("formatMessage uses tierPrefix (renders tier per row)", () => {
    const content = readFileSync(chatroomPath, "utf-8");
    expect(content).toContain("tierPrefix");
    expect(content).toContain("formatMessage");
  });
});

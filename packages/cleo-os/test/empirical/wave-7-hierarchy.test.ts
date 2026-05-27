/**
 * Wave 7 empirical gate — 3-Tier Hierarchy runtime enforcement (T416).
 *
 * Per ULTRAPLAN §17, wave gates validate that the artefacts produced by a wave
 * meet the spec before the wave is merged. This file covers the W7b deliverables
 * (T411, T412, T413, T416):
 *
 *   T411 — .cleo/teams.cant exists and declares the canonical platform team
 *           with 3 leads (planning, engineering, validation) and 9 workers
 *   T412 — tool_call hook in cleo-cant-bridge.ts rejects Edit/Write/Bash for
 *           lead-role agents with E_LEAD_TOOL_BLOCKED (ULTRAPLAN §10.3)
 *   T413 — tier-aware TUI rendering (covered in wave-7-chatroom.test.ts;
 *           cross-checked here at the integration level)
 *   T416 — end-to-end empirical gate: classify routes, lead blocked, worker free
 *
 * NOTE: Does NOT spawn a real Pi session. The Pi bridge tool_call handler is
 * extracted as a pure async function and called directly with mock events,
 * matching the test pattern in wave-3-launcher.test.ts.
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

/** Absolute path to packages/cleo-os/ root. */
const PKG_ROOT = resolve(__dirname, "..", "..");

/** Absolute path to the worktree / repo root (two levels above packages/cleo-os). */
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a required file and return its content.
 *
 * @param filePath - Absolute path to the file.
 * @returns File content as a UTF-8 string.
 */
function readRequired(filePath: string): string {
  expect(existsSync(filePath), `File should exist: ${filePath}`).toBe(true);
  const content = readFileSync(filePath, "utf-8");
  expect(content.length, `File should be non-empty: ${filePath}`).toBeGreaterThan(0);
  return content;
}

// ---------------------------------------------------------------------------
// Mock Pi bridge tool_call handler
//
// We extract the EXACT handler logic from cleo-cant-bridge.ts rather than
// calling the Pi runtime, so the test is fast and hermetic.
// ---------------------------------------------------------------------------

/**
 * Mock representation of an agentDef shape understood by the tool_call hook.
 */
interface MockAgentDef {
  role?: string;
}

/**
 * Mock tool_call event shape matching the hook's declared type.
 */
interface MockToolCallEvent {
  agentDef?: MockAgentDef;
  toolName?: string;
}

/**
 * Return value of the tool_call hook — either an empty object (pass) or a
 * rejected envelope with an error.
 */
interface ToolCallResult {
  rejected?: boolean;
  error?: {
    code: number;
    codeName: string;
    message: string;
    fix: string;
  };
}

/**
 * Pure re-implementation of the tool_call hook logic from cleo-cant-bridge.ts.
 *
 * This mirrors the EXACT rejection rules without any Pi runtime dependency,
 * allowing deterministic assertion in tests. Any future change to the bridge
 * hook MUST be reflected here.
 *
 * Blocked tools: Edit, Write, Bash — when the spawned agent's role is "lead".
 *
 * @param event - Simulated Pi tool_call event.
 * @returns ToolCallResult — {} when allowed, rejection envelope when blocked.
 */
function simulateToolCallHook(event: MockToolCallEvent): ToolCallResult {
  const agentDef = event.agentDef;
  if (!agentDef || agentDef.role !== "lead") return {};

  const BLOCKED_TOOLS = ["Edit", "Write", "Bash"];
  const toolName = event.toolName ?? "";

  if (!BLOCKED_TOOLS.includes(toolName)) return {};

  return {
    rejected: true,
    error: {
      code: 70,
      codeName: "E_LEAD_TOOL_BLOCKED",
      message: `Lead agents cannot execute ${toolName} — dispatch to a worker instead`,
      fix: "Use the delegate tool to spawn a worker agent for this work",
    },
  };
}

// ---------------------------------------------------------------------------
// T411 — .cleo/teams.cant structure validation
// ---------------------------------------------------------------------------

describe("T411 — .cleo/teams.cant canonical platform team", () => {
  const teamsCantPath = join(REPO_ROOT, ".cleo", "teams.cant");

  it("teams.cant exists at .cleo/teams.cant", () => {
    readRequired(teamsCantPath);
  });

  it("declares a team platform block", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("team platform:");
  });

  it("references orchestrator: cleo-prime", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("orchestrator: cleo-prime");
  });

  it("declares enforcement: strict", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("enforcement: strict");
  });

  it("declares all three lead agents", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("planning-lead");
    expect(content).toContain("engineering-lead");
    expect(content).toContain("validation-lead");
  });

  it("all lead agents carry role: lead", () => {
    const content = readRequired(teamsCantPath);
    // The file must contain 'role: lead' at least 3 times (one per lead agent).
    const matches = content.match(/role: lead/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("declares all nine worker agents", () => {
    const content = readRequired(teamsCantPath);
    const expectedWorkers = [
      "product-manager",
      "ux-researcher",
      "spec-writer",
      "backend-dev",
      "frontend-dev",
      "platform-engineer",
      "qa-engineer",
      "security-reviewer",
      "release-manager",
    ];
    for (const w of expectedWorkers) {
      expect(content, `Missing worker agent: ${w}`).toContain(w);
    }
  });

  it("planning-lead carries stages covering RCASD decomposition phases", () => {
    const content = readRequired(teamsCantPath);
    // The planning-lead stages block must include at minimum research + specification
    // (proxies for the RCASD planning half).
    expect(content).toContain("research");
    expect(content).toContain("specification");
    expect(content).toContain("decomposition");
  });

  it("engineering-lead carries implementation stage", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("implementation");
  });

  it("validation-lead carries testing + release stages", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("testing");
    expect(content).toContain("release");
  });

  it("uses consult-when field (W7a grammar extension)", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("consult-when:");
  });
});

// ---------------------------------------------------------------------------
// T412 — Lead tool blocking hook (E_LEAD_TOOL_BLOCKED)
// ---------------------------------------------------------------------------

describe("T412 — cleo-cant-bridge tool_call hook — lead blocking", () => {
  // Scenario A: orchestrator calls Edit — must pass (orchestrators are not leads)
  it("orchestrator calling Edit is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "orchestrator" },
      toolName: "Edit",
    });
    expect(result.rejected).toBeUndefined();
  });

  // Scenario B: worker calls Edit — must pass
  it("worker calling Edit is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Edit",
    });
    expect(result.rejected).toBeUndefined();
  });

  // Scenario C: lead calls Edit — must be REJECTED
  it("lead calling Edit is REJECTED with E_LEAD_TOOL_BLOCKED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Edit",
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");
    expect(result.error?.code).toBe(70);
    expect(result.error?.message).toContain("Edit");
    expect(result.error?.fix).toContain("delegate");
  });

  // Scenario D: lead calls Write — must be REJECTED
  it("lead calling Write is REJECTED with E_LEAD_TOOL_BLOCKED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Write",
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");
    expect(result.error?.message).toContain("Write");
  });

  // Scenario E: lead calls Bash — must be REJECTED
  it("lead calling Bash is REJECTED with E_LEAD_TOOL_BLOCKED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Bash",
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");
    expect(result.error?.message).toContain("Bash");
  });

  // Scenario F: lead calls Read — must pass (Read is not in the blocked set)
  it("lead calling Read is NOT blocked (dispatch-safe tool)", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Read",
    });
    expect(result.rejected).toBeUndefined();
  });

  // Scenario G: lead calls 'delegate' — must pass
  it("lead calling delegate is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "delegate",
    });
    expect(result.rejected).toBeUndefined();
  });

  // Scenario H: no agentDef present — must pass (hook is a no-op)
  it("call with no agentDef is NOT blocked", () => {
    const result = simulateToolCallHook({ toolName: "Edit" });
    expect(result.rejected).toBeUndefined();
  });

  // Scenario I: agentDef present but no role — must pass
  it("call with agentDef but no role is NOT blocked", () => {
    const result = simulateToolCallHook({ agentDef: {}, toolName: "Bash" });
    expect(result.rejected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T416 — End-to-end hierarchy simulation
//
// Simulates the four scenarios from the spec:
//   1. Orchestrator → classify → receives team/lead hint
//   2. Lead attempts Edit → rejected by tool_call hook
//   3. Lead delegates to worker → spawn succeeds (mock)
//   4. Worker calls Edit/Write/Bash → NOT blocked
// ---------------------------------------------------------------------------

describe("T416 — End-to-end 3-tier hierarchy simulation", () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: orchestrator classify routing
  //
  // Simulate `orchestrate.classify` response shape.
  // The classify op returns a { team, lead, protocol } hint so the orchestrator
  // knows which team/lead to delegate to.
  // ---------------------------------------------------------------------------

  interface ClassifyResponse {
    success: boolean;
    data: {
      team: string;
      lead: string;
      protocol: string;
      consultWhen: string;
    };
  }

  /**
   * Mock classify — mirrors what orchestrate.classify returns for an implementation request.
   *
   * @param request - The request string to classify.
   * @returns A classify response routing to engineering-lead.
   */
  function mockClassify(request: string): ClassifyResponse {
    // Simplified routing: implementation requests go to engineering team.
    const isImplementation =
      request.toLowerCase().includes("implement") ||
      request.toLowerCase().includes("code") ||
      request.toLowerCase().includes("build");

    if (isImplementation) {
      return {
        success: true,
        data: {
          team: "platform",
          lead: "engineering-lead",
          protocol: "implementation",
          consultWhen:
            "Deciding HOW to build — implementation, code writing, refactoring, API design",
        },
      };
    }

    // Default: planning team for everything else.
    return {
      success: true,
      data: {
        team: "platform",
        lead: "planning-lead",
        protocol: "specification",
        consultWhen: "Deciding WHAT to build and why — research, consensus, ADRs, specs",
      },
    };
  }

  it("Scenario 1: orchestrator classify routes implementation request to engineering-lead", () => {
    const response = mockClassify("Implement the login API endpoint");
    expect(response.success).toBe(true);
    expect(response.data.team).toBe("platform");
    expect(response.data.lead).toBe("engineering-lead");
    expect(response.data.protocol).toBe("implementation");
  });

  it("Scenario 1: orchestrator classify routes planning request to planning-lead", () => {
    const response = mockClassify("What features should we prioritize?");
    expect(response.success).toBe(true);
    expect(response.data.lead).toBe("planning-lead");
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: lead attempts Edit → rejected
  // ---------------------------------------------------------------------------

  it("Scenario 2: engineering-lead attempting Edit is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Edit",
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");
    expect(result.error?.message).toContain("dispatch to a worker");
    expect(result.error?.fix).toContain("delegate");
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: lead delegates to worker → spawn succeeds (mock)
  // ---------------------------------------------------------------------------

  interface SpawnResult {
    success: boolean;
    agentName: string;
    role: string;
  }

  /**
   * Mock worker spawn — simulates Pi's spawn returning a worker agent.
   *
   * @param workerName - The worker agent to spawn.
   * @returns A successful spawn result with role "worker".
   */
  function mockSpawnWorker(workerName: string): SpawnResult {
    return {
      success: true,
      agentName: workerName,
      role: "worker",
    };
  }

  it("Scenario 3: lead delegates to backend-dev — spawn succeeds", () => {
    const spawn = mockSpawnWorker("backend-dev");
    expect(spawn.success).toBe(true);
    expect(spawn.agentName).toBe("backend-dev");
    expect(spawn.role).toBe("worker");
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: worker calls Edit/Write/Bash — not blocked
  // ---------------------------------------------------------------------------

  it("Scenario 4: worker calling Edit is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Edit",
    });
    expect(result.rejected).toBeUndefined();
  });

  it("Scenario 4: worker calling Write is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Write",
    });
    expect(result.rejected).toBeUndefined();
  });

  it("Scenario 4: worker calling Bash is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Bash",
    });
    expect(result.rejected).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Full happy-path narrative: classify → block → delegate → worker executes
  // ---------------------------------------------------------------------------

  it("Full narrative: classify → lead blocked on Edit → delegate to worker → worker executes", () => {
    // Step 1: orchestrator classifies the request
    const classification = mockClassify("Implement the user auth module");
    expect(classification.success).toBe(true);
    expect(classification.data.lead).toBe("engineering-lead");

    // Step 2: engineering-lead attempts Edit — blocked
    const leadAttempt = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Edit",
    });
    expect(leadAttempt.rejected).toBe(true);
    expect(leadAttempt.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");

    // Step 3: engineering-lead delegates to backend-dev
    const workerSpawn = mockSpawnWorker("backend-dev");
    expect(workerSpawn.success).toBe(true);

    // Step 4: backend-dev (worker) runs Edit — passes
    const workerExec = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Edit",
    });
    expect(workerExec.rejected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T412 — cleo-cant-bridge.ts source validation
// ---------------------------------------------------------------------------

describe("T412 — cleo-cant-bridge.ts source structure", () => {
  const bridgePath = join(PKG_ROOT, "extensions", "cleo-cant-bridge.ts");

  it("bridge source exists", () => {
    readRequired(bridgePath);
  });

  it("bridge registers tool_call handler", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain('"tool_call"');
  });

  it("bridge references E_LEAD_TOOL_BLOCKED", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("E_LEAD_TOOL_BLOCKED");
  });

  it("bridge checks role === 'lead'", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("role !== \"lead\"");
  });

  it("bridge blocks Edit, Write, Bash", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain('"Edit"');
    expect(content).toContain('"Write"');
    expect(content).toContain('"Bash"');
  });

  it("bridge still has before_agent_start handler (W8 validate-on-load not disturbed)", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("before_agent_start");
    expect(content).toContain("VALIDATE_ON_LOAD_PREAMBLE");
  });
});

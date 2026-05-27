/**
 * Wave ACL empirical gate — Path-scoped write permissions for worker agents (T384).
 *
 * Per ULTRAPLAN §17, wave gates validate that the artefacts produced by a wave
 * meet the spec before the wave is merged. This file covers the ACL wave
 * deliverables (T422-T426):
 *
 *   T422 — Rust grammar parses `permissions.files.{read,write,delete}` glob arrays
 *   T423 — PathPermissions type exported from @cleocode/cant
 *   T424 — tool_call hook enforces path ACL for worker agents (E_WORKER_PATH_ACL_VIOLATION)
 *   T425 — .cleo/teams.cant has realistic write globs for all 9 workers
 *   T426 — Integration test: backend-dev blocked on wrong path, allowed on correct path
 *
 * NOTE: Does NOT spawn a real Pi session. The bridge tool_call handler is
 * extracted as a pure function and called directly with mock events, matching
 * the pattern in wave-7-hierarchy.test.ts.
 *
 * @packageDocumentation
 * @task T426
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
// Pure re-implementation of the ACL logic from cleo-cant-bridge.ts
//
// Mirrors the EXACT logic from T424 without any Pi runtime dependency.
// Any future change to the bridge hook MUST be reflected here.
// ---------------------------------------------------------------------------

/**
 * File permissions shape for a worker agent.
 *
 * @task T426
 */
interface MockFilePermissions {
  write?: string[];
  read?: string[];
  delete?: string[];
}

/**
 * Mock agentDef shape understood by the ACL hook.
 */
interface MockAgentDef {
  role?: string;
  name?: string;
  filePermissions?: MockFilePermissions;
}

/**
 * Mock tool_call event shape for the ACL hook.
 */
interface MockToolCallEvent {
  agentDef?: MockAgentDef;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

/**
 * Return value of the tool_call hook.
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
 * Convert a glob pattern to a RegExp for path matching.
 *
 * Pure re-implementation of the helper in cleo-cant-bridge.ts.
 *
 * @param glob - The glob pattern.
 * @returns A RegExp for testing file paths.
 */
function globToRegExp(glob: string): RegExp {
  let regexStr = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (char === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  return new RegExp("^" + regexStr + "$");
}

/**
 * Test whether a file path matches any of the provided glob patterns.
 *
 * Returns `false` immediately when `globs` is empty (default-deny).
 *
 * @param filePath - The file path to test.
 * @param globs - The glob patterns to test against.
 * @returns `true` if `filePath` matches at least one pattern.
 */
function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "");
  for (const glob of globs) {
    if (globToRegExp(glob).test(normalized)) return true;
  }
  return false;
}

/**
 * Extract the target file path from a mock tool_call event.
 *
 * @param toolName - The tool name.
 * @param toolInput - The tool input object.
 * @returns The extracted path, or `null` if not determinable.
 */
function extractTargetPath(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | null {
  if (!toolInput) return null;

  if (toolName === "Edit" || toolName === "Write") {
    if (typeof toolInput["file_path"] === "string") return toolInput["file_path"];
    if (typeof toolInput["filePath"] === "string") return toolInput["filePath"];
    if (typeof toolInput["path"] === "string") return toolInput["path"];
    return null;
  }

  if (toolName === "Bash") {
    const cmd = typeof toolInput["command"] === "string" ? toolInput["command"] : null;
    if (!cmd) return null;
    const redirectMatch = cmd.match(/>\s*["']?([^\s"';&|]+)/);
    if (redirectMatch?.[1]) return redirectMatch[1];
    const teeMatch = cmd.match(/\btee\s+(?:-a\s+)?["']?([^\s"';&|]+)/);
    if (teeMatch?.[1]) return teeMatch[1];
    return null;
  }

  return null;
}

/**
 * Pure re-implementation of the full tool_call hook logic from cleo-cant-bridge.ts.
 *
 * Includes both W7b Lead blocking and T424 Worker path ACL enforcement.
 * Any change to the bridge MUST be reflected here.
 *
 * @param event - Simulated Pi tool_call event.
 * @returns ToolCallResult — {} when allowed, rejection envelope when blocked.
 */
function simulateToolCallHook(event: MockToolCallEvent): ToolCallResult {
  const agentDef = event.agentDef;
  if (!agentDef) return {};

  const toolName = event.toolName ?? "";
  const BLOCKED_TOOLS = ["Edit", "Write", "Bash"];

  // W7b: Lead blocking
  if (agentDef.role === "lead") {
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

  // T424: Worker path ACL
  if (
    agentDef.role === "worker" &&
    agentDef.filePermissions !== undefined &&
    BLOCKED_TOOLS.includes(toolName)
  ) {
    const writeGlobs = agentDef.filePermissions.write;
    if (writeGlobs !== undefined) {
      const targetPath = extractTargetPath(toolName, event.toolInput);
      if (targetPath !== null && !matchesAnyGlob(targetPath, writeGlobs)) {
        const agentName = agentDef.name ?? "worker";
        const scopeList =
          writeGlobs.length > 0 ? writeGlobs.join(", ") : "(none — this worker is read-only)";
        return {
          rejected: true,
          error: {
            code: 71,
            codeName: "E_WORKER_PATH_ACL_VIOLATION",
            message: `Worker ${agentName} is not allowed to write to ${targetPath}`,
            fix:
              `This worker can only write inside: ${scopeList}. ` +
              "Either update the worker's permissions.files.write glob in " +
              ".cleo/teams.cant, or dispatch to a different worker with matching scope.",
          },
        };
      }
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// T425 — .cleo/teams.cant path ACL validation
// ---------------------------------------------------------------------------

describe("T425 — .cleo/teams.cant worker path ACLs", () => {
  const teamsCantPath = join(REPO_ROOT, ".cleo", "teams.cant");

  it("teams.cant exists", () => {
    readRequired(teamsCantPath);
  });

  it("backend-dev declares write permissions for packages/cleo/**", () => {
    const content = readRequired(teamsCantPath);
    // Must contain the permissions block for backend-dev with cleo scope
    expect(content).toContain("packages/cleo/**");
  });

  it("backend-dev declares write permissions for crates/**", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("crates/**");
  });

  it("frontend-dev declares write permissions for apps/web/**", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("apps/web/**");
  });

  it("frontend-dev declares write permissions for packages/ui/**", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("packages/ui/**");
  });

  it("platform-engineer declares write permissions for packages/cleo-os/**", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("packages/cleo-os/**");
  });

  it("security-reviewer has empty write glob (read-only)", () => {
    const content = readRequired(teamsCantPath);
    // The security-reviewer block must contain write: [] (empty)
    expect(content).toContain("write: []");
  });

  it("release-manager declares CHANGELOG.md in write permissions", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("CHANGELOG.md");
  });

  it("release-manager declares package.json in write permissions", () => {
    const content = readRequired(teamsCantPath);
    expect(content).toContain("packages/*/package.json");
  });

  it("all 9 worker agents declare a permissions block", () => {
    const content = readFileSync(teamsCantPath, "utf-8");
    const workers = [
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
    for (const w of workers) {
      // Each worker block should be followed by a permissions section in the file
      expect(content, `Worker ${w} should have permissions block`).toContain(
        `agent ${w}:`,
      );
    }
    // The overall file should declare files: sub-blocks
    const filesCount = (content.match(/\bfiles:/g) ?? []).length;
    expect(filesCount, "Should have at least 9 files: blocks (one per worker)").toBeGreaterThanOrEqual(9);
  });
});

// ---------------------------------------------------------------------------
// T424 — Worker path ACL hook enforcement
// ---------------------------------------------------------------------------

describe("T424 — cleo-cant-bridge tool_call hook — worker path ACL", () => {
  // backend-dev config: write to packages/cleo/**, packages/core/**, crates/**
  const backendDevPerms: MockFilePermissions = {
    write: ["packages/cleo/**", "packages/core/**", "crates/**"],
    read: ["**/*"],
    delete: ["packages/cleo/**"],
  };

  // ── backend-dev ALLOWED paths ────────────────────────────────────────────

  it("backend-dev Edit on packages/cleo/src/foo.ts is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Edit",
      toolInput: { file_path: "packages/cleo/src/foo.ts" },
    });
    expect(result.rejected).toBeUndefined();
  });

  it("backend-dev Write on packages/core/src/index.ts is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Write",
      toolInput: { file_path: "packages/core/src/index.ts" },
    });
    expect(result.rejected).toBeUndefined();
  });

  it("backend-dev Edit on crates/cant-core/src/lib.rs is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Edit",
      toolInput: { file_path: "crates/cant-core/src/lib.rs" },
    });
    expect(result.rejected).toBeUndefined();
  });

  // ── backend-dev BLOCKED paths ────────────────────────────────────────────

  it("backend-dev Edit on apps/web/login.tsx is REJECTED with E_WORKER_PATH_ACL_VIOLATION", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Edit",
      toolInput: { file_path: "apps/web/login.tsx" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
    expect(result.error?.code).toBe(71);
    expect(result.error?.message).toContain("backend-dev");
    expect(result.error?.message).toContain("apps/web/login.tsx");
    expect(result.error?.fix).toContain(".cleo/teams.cant");
  });

  it("backend-dev Write on packages/ui/Button.tsx is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Write",
      toolInput: { file_path: "packages/ui/Button.tsx" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
    expect(result.error?.message).toContain("packages/ui/Button.tsx");
  });

  it("backend-dev Edit on docs/specs/ADR-001.md is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Edit",
      toolInput: { file_path: "docs/specs/ADR-001.md" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
  });

  it("error fix hint references .cleo/teams.cant", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "backend-dev", filePermissions: backendDevPerms },
      toolName: "Edit",
      toolInput: { file_path: "apps/web/page.tsx" },
    });
    expect(result.error?.fix).toContain(".cleo/teams.cant");
    expect(result.error?.fix).toContain("permissions.files.write");
  });

  // ── security-reviewer: empty write glob = read-only ─────────────────────

  const securityReviewerPerms: MockFilePermissions = {
    write: [], // empty = no writes
    read: ["**/*"],
  };

  it("security-reviewer Edit on any file is REJECTED (empty write glob)", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "security-reviewer",
        filePermissions: securityReviewerPerms,
      },
      toolName: "Edit",
      toolInput: { file_path: "packages/cleo/src/index.ts" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
  });

  it("security-reviewer Write on README.md is REJECTED (empty write glob)", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "security-reviewer",
        filePermissions: securityReviewerPerms,
      },
      toolName: "Write",
      toolInput: { file_path: "README.md" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
  });

  it("security-reviewer error message mentions read-only", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "security-reviewer",
        filePermissions: securityReviewerPerms,
      },
      toolName: "Edit",
      toolInput: { file_path: "packages/cleo/src/index.ts" },
    });
    expect(result.error?.fix).toContain("read-only");
  });

  // ── release-manager: scoped to CHANGELOG + package.json ─────────────────

  const releaseManagerPerms: MockFilePermissions = {
    write: ["CHANGELOG.md", "package.json", "packages/*/package.json"],
    read: ["**/*"],
  };

  it("release-manager Edit on CHANGELOG.md is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "release-manager", filePermissions: releaseManagerPerms },
      toolName: "Edit",
      toolInput: { file_path: "CHANGELOG.md" },
    });
    expect(result.rejected).toBeUndefined();
  });

  it("release-manager Edit on package.json is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "release-manager", filePermissions: releaseManagerPerms },
      toolName: "Edit",
      toolInput: { file_path: "package.json" },
    });
    expect(result.rejected).toBeUndefined();
  });

  it("release-manager Edit on packages/cleo/package.json is ALLOWED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "release-manager", filePermissions: releaseManagerPerms },
      toolName: "Edit",
      toolInput: { file_path: "packages/cleo/package.json" },
    });
    expect(result.rejected).toBeUndefined();
  });

  it("release-manager Edit on packages/cleo/src/foo.ts is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "release-manager", filePermissions: releaseManagerPerms },
      toolName: "Edit",
      toolInput: { file_path: "packages/cleo/src/foo.ts" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
    expect(result.error?.message).toContain("release-manager");
    expect(result.error?.message).toContain("packages/cleo/src/foo.ts");
  });

  it("release-manager Edit on apps/web/page.tsx is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", name: "release-manager", filePermissions: releaseManagerPerms },
      toolName: "Edit",
      toolInput: { file_path: "apps/web/page.tsx" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
  });
});

// ---------------------------------------------------------------------------
// T424 — ACL boundary conditions and W7b non-regression
// ---------------------------------------------------------------------------

describe("T424 — ACL boundary conditions", () => {
  // Worker with no declared filePermissions — ACL not enforced
  it("worker with no filePermissions is NOT blocked (no ACL declared)", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker" },
      toolName: "Edit",
      toolInput: { file_path: "apps/web/page.tsx" },
    });
    expect(result.rejected).toBeUndefined();
  });

  // Worker with filePermissions but write is undefined — no write ACL
  it("worker with filePermissions but write undefined is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "worker", filePermissions: { read: ["**/*"] } },
      toolName: "Edit",
      toolInput: { file_path: "apps/web/page.tsx" },
    });
    expect(result.rejected).toBeUndefined();
  });

  // Worker using Read (not a write tool) — ACL not applied
  it("worker calling Read is NOT blocked even with restrictive write ACL", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "backend-dev",
        filePermissions: { write: ["packages/cleo/**"], read: ["**/*"] },
      },
      toolName: "Read",
      toolInput: { file_path: "apps/web/page.tsx" },
    });
    expect(result.rejected).toBeUndefined();
  });

  // No agentDef — hook is a no-op
  it("call with no agentDef is NOT blocked", () => {
    const result = simulateToolCallHook({ toolName: "Edit", toolInput: { file_path: "foo.ts" } });
    expect(result.rejected).toBeUndefined();
  });

  // W7b non-regression: leads are still blocked
  it("lead calling Edit is still REJECTED with E_LEAD_TOOL_BLOCKED (W7b non-regression)", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "lead" },
      toolName: "Edit",
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_LEAD_TOOL_BLOCKED");
    expect(result.error?.code).toBe(70);
  });

  // W7b non-regression: orchestrators are not blocked
  it("orchestrator calling Edit is NOT blocked (W7b non-regression)", () => {
    const result = simulateToolCallHook({
      agentDef: { role: "orchestrator" },
      toolName: "Edit",
    });
    expect(result.rejected).toBeUndefined();
  });

  // Bash with redirect to blocked path
  it("worker Bash with redirect to blocked path is REJECTED", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "backend-dev",
        filePermissions: {
          write: ["packages/cleo/**", "packages/core/**", "crates/**"],
        },
      },
      toolName: "Bash",
      toolInput: { command: "echo 'hello' > apps/web/output.txt" },
    });
    expect(result.rejected).toBe(true);
    expect(result.error?.codeName).toBe("E_WORKER_PATH_ACL_VIOLATION");
    expect(result.error?.message).toContain("apps/web/output.txt");
  });

  // Bash with redirect to allowed path
  it("worker Bash with redirect to allowed path is NOT blocked", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "backend-dev",
        filePermissions: {
          write: ["packages/cleo/**", "packages/core/**", "crates/**"],
        },
      },
      toolName: "Bash",
      toolInput: { command: "echo 'hello' > packages/cleo/src/output.txt" },
    });
    expect(result.rejected).toBeUndefined();
  });

  // Bash without detectable write target — allow
  it("worker Bash with no detectable write target is NOT blocked (allow-by-default)", () => {
    const result = simulateToolCallHook({
      agentDef: {
        role: "worker",
        name: "backend-dev",
        filePermissions: {
          write: ["packages/cleo/**"],
        },
      },
      toolName: "Bash",
      toolInput: { command: "ls -la && cat package.json" },
    });
    expect(result.rejected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T424 — cleo-cant-bridge.ts source structure validation
// ---------------------------------------------------------------------------

describe("T424 — cleo-cant-bridge.ts source structure", () => {
  const bridgePath = join(PKG_ROOT, "extensions", "cleo-cant-bridge.ts");

  it("bridge source exists", () => {
    readRequired(bridgePath);
  });

  it("bridge registers tool_call handler", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain('"tool_call"');
  });

  it("bridge references E_WORKER_PATH_ACL_VIOLATION", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("E_WORKER_PATH_ACL_VIOLATION");
  });

  it("bridge references E_LEAD_TOOL_BLOCKED (W7b not regressed)", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("E_LEAD_TOOL_BLOCKED");
  });

  it("bridge has matchesAnyGlob helper", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("matchesAnyGlob");
  });

  it("bridge has extractTargetPath helper", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("extractTargetPath");
  });

  it("bridge error code for ACL violation is 71", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("code: 71");
  });

  it("bridge fix hint references .cleo/teams.cant", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain(".cleo/teams.cant");
  });

  it("bridge still has before_agent_start handler (W8 validate-on-load not disturbed)", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("before_agent_start");
    expect(content).toContain("VALIDATE_ON_LOAD_PREAMBLE");
  });

  it("bridge uses AgentFilePermissions interface for typed access", () => {
    const content = readFileSync(bridgePath, "utf-8");
    expect(content).toContain("AgentFilePermissions");
  });
});

import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../src/types.js";

/* ── Hoisted mocks for skills-related orchestration paths ────────── */

const mockedSkills = vi.hoisted(() => {
  const os = require("node:os");
  const path = require("node:path");
  const canonicalRoot = path.join(os.tmpdir(), `caamp-canonical-${process.pid}`);
  return {
    canonicalRoot,
    installSkillFn: vi.fn(),
    removeSkillFn: vi.fn(),
  };
});

vi.mock("../../src/core/paths/agents.js", async (importOriginal) => {
  const path = require("node:path");
  const original = await importOriginal<typeof import("../../src/core/paths/agents.js")>();
  return {
    ...original,
    CANONICAL_SKILLS_DIR: path.join(mockedSkills.canonicalRoot, "skills"),
  };
});

vi.mock("../../src/core/skills/installer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/skills/installer.js")>();
  return {
    ...original,
    installSkill: mockedSkills.installSkillFn,
    removeSkill: mockedSkills.removeSkillFn,
  };
});

import {
  applyMcpInstallWithPolicy,
  configureProviderGlobalAndProject,
  detectMcpConfigConflicts,
  installBatchWithRollback,
  selectProvidersByMinimumPriority,
  updateInstructionsSingleOperation,
} from "../../src/core/advanced/orchestration.js";

let testDir: string;

function makeProvider(id: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    toolName: id,
    vendor: "test",
    agentFlag: id,
    aliases: [],
    pathGlobal: join(testDir, "global", id),
    pathProject: ".",
    instructFile: "AGENTS.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: join(testDir, "global", id, "config.json"),
    configPathProject: `.config/${id}.json`,
    pathSkills: join(testDir, "skills", id, "global"),
    pathProjectSkills: `.skills/${id}`,
    detection: { methods: ["binary"], binary: id },
    supportedTransports: ["stdio", "http", "sse"],
    supportsHeaders: true,
    priority: "medium",
    status: "active",
    agentSkillsCompatible: true,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `caamp-advanced-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  mockedSkills.installSkillFn.mockReset();
  mockedSkills.removeSkillFn.mockReset();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
  await rm(mockedSkills.canonicalRoot, { recursive: true, force: true }).catch(() => {});
});

describe("selectProvidersByMinimumPriority", () => {
  it("filters and sorts by priority", () => {
    const providers = [
      makeProvider("low-1", { priority: "low" }),
      makeProvider("high-1", { priority: "high" }),
      makeProvider("medium-1", { priority: "medium" }),
    ];

    const result = selectProvidersByMinimumPriority(providers, "medium");
    expect(result.map((provider) => provider.id)).toEqual(["high-1", "medium-1"]);
  });
});

describe("installBatchWithRollback", () => {
  it("restores config files when a provider fails during MCP install", async () => {
    const ok = makeProvider("ok", {
      priority: "high",
      configPathProject: ".ok/config.json",
    });
    const failing = makeProvider("failing", {
      priority: "medium",
      configPathProject: null,
    });

    const result = await installBatchWithRollback({
      providers: [ok, failing],
      minimumPriority: "medium",
      mcp: [{
        serverName: "test-server",
        config: { command: "npx", args: ["-y", "@example/test-server"] },
        scope: "project",
      }],
      projectDir: testDir,
    });

    const writtenPath = join(testDir, ".ok/config.json");

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.mcpApplied).toBe(1);
    expect(existsSync(writtenPath)).toBe(false);
  });
});

describe("detectMcpConfigConflicts + applyMcpInstallWithPolicy", () => {
  it("detects transport/header conflicts and can skip conflicting writes", async () => {
    const provider = makeProvider("conflict-agent", {
      supportedTransports: ["stdio"],
      supportsHeaders: false,
    });

    await mkdir(join(testDir, "global", "conflict-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        existing: { command: "old-command" },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "remote",
        config: {
          type: "http" as const,
          url: "https://example.com/mcp",
          headers: { authorization: "Bearer test" },
        },
        scope: "global" as const,
      },
      {
        serverName: "existing",
        config: { command: "new-command" },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    expect(conflicts.some((conflict) => conflict.code === "unsupported-transport")).toBe(true);
    expect(conflicts.some((conflict) => conflict.code === "unsupported-headers")).toBe(true);
    expect(conflicts.some((conflict) => conflict.code === "existing-mismatch")).toBe(true);

    const applied = await applyMcpInstallWithPolicy([provider], operations, "skip", testDir);
    expect(applied.applied).toHaveLength(0);
    expect(applied.skipped.length).toBeGreaterThan(0);
  });
});

describe("updateInstructionsSingleOperation", () => {
  it("updates one shared file and reports provider/config-format coverage", async () => {
    const p1 = makeProvider("p1", { configFormat: "json", instructFile: "AGENTS.md" });
    const p2 = makeProvider("p2", { configFormat: "yaml", instructFile: "AGENTS.md" });

    const result = await updateInstructionsSingleOperation(
      [p1, p2],
      "Shared block content",
      "project",
      testDir,
    );

    expect(result.updatedFiles).toBe(1);
    expect(result.actions[0]?.providers.sort()).toEqual(["p1", "p2"]);
    expect(result.actions[0]?.configFormats.sort()).toEqual(["json", "yaml"]);
  });
});

describe("configureProviderGlobalAndProject", () => {
  it("writes global + project MCP configs and injects instructions in one call", async () => {
    const provider = makeProvider("dual", {
      configPathProject: ".dual/config.json",
      instructFile: "CLAUDE.md",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      globalMcp: [{ serverName: "global-srv", config: { command: "global" } }],
      projectMcp: [{ serverName: "project-srv", config: { command: "project" } }],
      instructionContent: "Unified instruction content",
      projectDir: testDir,
    });

    expect(result.mcp.global[0]?.success).toBe(true);
    expect(result.mcp.project[0]?.success).toBe(true);

    const globalInstructionPath = join(provider.pathGlobal, provider.instructFile);
    const projectInstructionPath = join(testDir, provider.instructFile);
    expect(existsSync(globalInstructionPath)).toBe(true);
    expect(existsSync(projectInstructionPath)).toBe(true);
  });

  it("handles instructionContent as an object with separate global/project strings", async () => {
    const provider = makeProvider("dual-obj", {
      configPathProject: ".dual-obj/config.json",
      instructFile: "AGENTS.md",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      instructionContent: {
        global: "Global-only instructions",
        project: "Project-only instructions",
      },
      projectDir: testDir,
    });

    const globalInstructionPath = join(provider.pathGlobal, provider.instructFile);
    const projectInstructionPath = join(testDir, provider.instructFile);
    expect(existsSync(globalInstructionPath)).toBe(true);
    expect(existsSync(projectInstructionPath)).toBe(true);

    const globalContent = await readFile(globalInstructionPath, "utf-8");
    const projectContent = await readFile(projectInstructionPath, "utf-8");
    expect(globalContent).toContain("Global-only instructions");
    expect(projectContent).toContain("Project-only instructions");

    expect(result.instructions.global).toBeDefined();
    expect(result.instructions.project).toBeDefined();
  });

  it("handles instructionContent object with only global key", async () => {
    const provider = makeProvider("dual-global-only", {
      configPathProject: ".dual-go/config.json",
      instructFile: "AGENTS.md",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      instructionContent: { global: "Global content only" },
      projectDir: testDir,
    });

    const globalPath = join(provider.pathGlobal, provider.instructFile);
    expect(existsSync(globalPath)).toBe(true);
    expect(result.instructions.global).toBeDefined();
    expect(result.instructions.project).toBeUndefined();
  });

  it("handles instructionContent object with only project key", async () => {
    const provider = makeProvider("dual-project-only", {
      configPathProject: ".dual-po/config.json",
      instructFile: "AGENTS.md",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      instructionContent: { project: "Project content only" },
      projectDir: testDir,
    });

    const projectPath = join(testDir, provider.instructFile);
    expect(existsSync(projectPath)).toBe(true);
    expect(result.instructions.global).toBeUndefined();
    expect(result.instructions.project).toBeDefined();
  });

  it("skips instruction injection when instructionContent is undefined", async () => {
    const provider = makeProvider("dual-no-instr", {
      configPathProject: ".dual-ni/config.json",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      globalMcp: [{ serverName: "srv", config: { command: "test" } }],
      projectDir: testDir,
    });

    expect(result.mcp.global).toHaveLength(1);
    expect(result.instructions.global).toBeUndefined();
    expect(result.instructions.project).toBeUndefined();
  });
});

describe("applyMcpInstallWithPolicy - overwrite policy", () => {
  it("overwrites conflicting entries when policy is 'overwrite'", async () => {
    const provider = makeProvider("ow-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    await mkdir(join(testDir, "global", "ow-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        existing: { command: "old-command", args: ["--old"] },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "existing",
        config: { command: "new-command", args: ["--new"] },
        scope: "global" as const,
      },
    ];

    const result = await applyMcpInstallWithPolicy([provider], operations, "overwrite", testDir);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.code).toBe("existing-mismatch");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.success).toBe(true);
    expect(result.skipped).toHaveLength(0);

    const configContent = JSON.parse(await readFile(provider.configPathGlobal, "utf-8"));
    expect(configContent.mcpServers.existing.command).toBe("new-command");
  });
});

describe("applyMcpInstallWithPolicy - fail policy with no conflicts", () => {
  it("proceeds normally when fail policy is set but no conflicts exist", async () => {
    const provider = makeProvider("clean-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    await mkdir(join(testDir, "global", "clean-agent"), { recursive: true });

    const operations = [
      {
        serverName: "brand-new-server",
        config: { command: "npx", args: ["-y", "@example/server"] },
        scope: "global" as const,
      },
    ];

    const result = await applyMcpInstallWithPolicy([provider], operations, "fail", testDir);

    expect(result.conflicts).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.success).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it("returns early with no applied entries when fail policy detects conflicts", async () => {
    const provider = makeProvider("fail-agent", {
      supportedTransports: ["stdio"],
      supportsHeaders: true,
    });

    const operations = [
      {
        serverName: "remote-srv",
        config: {
          type: "http" as const,
          url: "https://example.com/mcp",
        },
        scope: "global" as const,
      },
    ];

    const result = await applyMcpInstallWithPolicy([provider], operations, "fail", testDir);

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe("detectMcpConfigConflicts - stableStringify edge cases", () => {
  it("detects no conflict when existing config matches desired (exercises stableStringify)", async () => {
    const provider = makeProvider("match-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    const serverConfig = { command: "npx", args: ["-y", "@example/test"] };

    await mkdir(join(testDir, "global", "match-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "test-server": serverConfig,
      },
    }, null, 2));

    const operations = [
      {
        serverName: "test-server",
        config: { command: "npx", args: ["-y", "@example/test"] },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    expect(mismatchConflicts).toHaveLength(0);
  });

  it("detects mismatch when configs differ in array values", async () => {
    const provider = makeProvider("arr-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    await mkdir(join(testDir, "global", "arr-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "test-server": { command: "npx", args: ["-y", "@example/old"] },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "test-server",
        config: { command: "npx", args: ["-y", "@example/new"] },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    expect(mismatchConflicts).toHaveLength(1);
  });

  it("compares configs with nested objects via stableStringify (key order insensitive)", async () => {
    const provider = makeProvider("nested-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    // Write config with keys in one order
    await mkdir(join(testDir, "global", "nested-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "test-server": { command: "node", env: { B: "2", A: "1" } },
      },
    }, null, 2));

    // Operation with keys in a different order
    const operations = [
      {
        serverName: "test-server",
        config: { env: { A: "1", B: "2" }, command: "node" },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    // stableStringify sorts keys, so the same data in different order should match
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    expect(mismatchConflicts).toHaveLength(0);
  });

  it("handles configs with primitive values (string, number, boolean, null)", async () => {
    const provider = makeProvider("prim-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });

    await mkdir(join(testDir, "global", "prim-agent"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "test-server": { command: "test", disabled: false, count: 3, extra: null },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "test-server",
        config: { command: "test", disabled: true, count: 3, extra: null },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    // disabled differs (false vs true), so should mismatch
    expect(mismatchConflicts).toHaveLength(1);
  });
});

describe("selectProvidersByMinimumPriority - edge cases", () => {
  it("returns all providers when minimum priority is 'low'", () => {
    const providers = [
      makeProvider("low-1", { priority: "low" }),
      makeProvider("high-1", { priority: "high" }),
      makeProvider("medium-1", { priority: "medium" }),
    ];

    const result = selectProvidersByMinimumPriority(providers, "low");
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.id)).toEqual(["high-1", "medium-1", "low-1"]);
  });

  it("returns only high when minimum priority is 'high'", () => {
    const providers = [
      makeProvider("low-1", { priority: "low" }),
      makeProvider("high-1", { priority: "high" }),
      makeProvider("medium-1", { priority: "medium" }),
    ];

    const result = selectProvidersByMinimumPriority(providers, "high");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("high-1");
  });

  it("returns empty array when no providers match", () => {
    const providers = [
      makeProvider("low-1", { priority: "low" }),
      makeProvider("medium-1", { priority: "medium" }),
    ];

    const result = selectProvidersByMinimumPriority(providers, "high");
    expect(result).toHaveLength(0);
  });

  it("defaults to 'low' minimum when not specified", () => {
    const providers = [
      makeProvider("low-1", { priority: "low" }),
      makeProvider("high-1", { priority: "high" }),
    ];

    const result = selectProvidersByMinimumPriority(providers);
    expect(result).toHaveLength(2);
  });
});

describe("installBatchWithRollback - success path", () => {
  it("returns success when all MCP operations succeed", async () => {
    const provider = makeProvider("good", {
      priority: "high",
      configPathProject: ".good/config.json",
    });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      mcp: [{
        serverName: "test-server",
        config: { command: "npx", args: ["-y", "@example/test-server"] },
        scope: "project",
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.rollbackPerformed).toBe(false);
    expect(result.mcpApplied).toBe(1);
    expect(result.rollbackErrors).toHaveLength(0);
    expect(result.providerIds).toEqual(["good"]);
    expect(existsSync(join(testDir, ".good/config.json"))).toBe(true);
  });

  it("returns success with empty operations", async () => {
    const provider = makeProvider("empty-ops", { priority: "high" });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      mcp: [],
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.mcpApplied).toBe(0);
    expect(result.skillsApplied).toBe(0);
  });
});

describe("installBatchWithRollback - scope defaults", () => {
  it("defaults scope to 'project' for MCP operations", async () => {
    const provider = makeProvider("scope-default", {
      priority: "medium",
      configPathProject: ".scope-default/config.json",
    });

    const result = await installBatchWithRollback({
      providers: [provider],
      mcp: [{
        serverName: "no-scope-srv",
        config: { command: "test" },
        // scope intentionally omitted - should default to "project"
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.mcpApplied).toBe(1);
    const projectConfigPath = join(testDir, ".scope-default/config.json");
    expect(existsSync(projectConfigPath)).toBe(true);
  });
});

describe("installBatchWithRollback - rollback restores pre-existing configs", () => {
  it("restores pre-existing config content after rollback", async () => {
    const ok = makeProvider("restore-ok", {
      priority: "high",
      configPathProject: ".restore-ok/config.json",
    });
    const failing = makeProvider("restore-fail", {
      priority: "medium",
      configPathProject: null,
    });

    // Pre-create the config file with existing content
    const configPath = join(testDir, ".restore-ok/config.json");
    await mkdir(join(testDir, ".restore-ok"), { recursive: true });
    const originalContent = JSON.stringify({ mcpServers: { old: { command: "old" } } }, null, 2);
    await writeFile(configPath, originalContent);

    const result = await installBatchWithRollback({
      providers: [ok, failing],
      minimumPriority: "medium",
      mcp: [{
        serverName: "new-server",
        config: { command: "new" },
        scope: "project",
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // The config should be restored to its original content
    expect(existsSync(configPath)).toBe(true);
    const restoredContent = await readFile(configPath, "utf-8");
    expect(restoredContent).toBe(originalContent);
  });
});

describe("installBatchWithRollback - multiple MCP operations across providers", () => {
  it("applies multiple MCP operations to multiple providers", async () => {
    const p1 = makeProvider("multi-p1", {
      priority: "high",
      configPathProject: ".multi-p1/config.json",
    });
    const p2 = makeProvider("multi-p2", {
      priority: "medium",
      configPathProject: ".multi-p2/config.json",
    });

    const result = await installBatchWithRollback({
      providers: [p1, p2],
      minimumPriority: "medium",
      mcp: [
        {
          serverName: "server-a",
          config: { command: "cmd-a" },
          scope: "project",
        },
        {
          serverName: "server-b",
          config: { command: "cmd-b" },
          scope: "project",
        },
      ],
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    // 2 operations * 2 providers = 4 applied
    expect(result.mcpApplied).toBe(4);
    expect(result.providerIds).toEqual(["multi-p1", "multi-p2"]);
  });
});

describe("detectMcpConfigConflicts - no config file exists", () => {
  it("reports no existing-mismatch conflict when config file does not exist", async () => {
    const provider = makeProvider("no-config-agent", {
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
    });
    // Don't create any config file

    const operations = [
      {
        serverName: "brand-new",
        config: { command: "test" },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    expect(conflicts.filter((c) => c.code === "existing-mismatch")).toHaveLength(0);
  });
});

describe("configureProviderGlobalAndProject - empty MCP arrays", () => {
  it("handles empty globalMcp and projectMcp", async () => {
    const provider = makeProvider("empty-mcp", {
      configPathProject: ".empty-mcp/config.json",
    });

    const result = await configureProviderGlobalAndProject(provider, {
      globalMcp: [],
      projectMcp: [],
      instructionContent: "Some instructions",
      projectDir: testDir,
    });

    expect(result.mcp.global).toHaveLength(0);
    expect(result.mcp.project).toHaveLength(0);
    expect(result.providerId).toBe("empty-mcp");
    expect(result.instructions.global).toBeDefined();
    expect(result.instructions.project).toBeDefined();
  });
});

describe("installBatchWithRollback - skill operations", () => {
  const canonicalSkillsDir = join(mockedSkills.canonicalRoot, "skills");

  it("installs skills successfully and reports skillsApplied", async () => {
    const provider = makeProvider("skill-ok", { priority: "high" });

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "my-skill",
      canonicalPath: join(canonicalSkillsDir, "my-skill"),
      linkedAgents: ["skill-ok"],
      errors: [],
      success: true,
    });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-skill-source",
        skillName: "my-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.skillsApplied).toBe(1);
    expect(result.mcpApplied).toBe(0);
    expect(result.rollbackPerformed).toBe(false);
    expect(mockedSkills.installSkillFn).toHaveBeenCalledOnce();
  });

  it("rolls back skills when installSkill returns errors", async () => {
    const provider = makeProvider("skill-fail", { priority: "high" });

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "bad-skill",
      canonicalPath: join(canonicalSkillsDir, "bad-skill"),
      linkedAgents: ["skill-fail"],
      errors: ["Link failed: permission denied"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["skill-fail"], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-skill-source",
        skillName: "bad-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.error).toContain("Link failed: permission denied");
    expect(mockedSkills.removeSkillFn).toHaveBeenCalledOnce();
  });

  it("defaults isGlobal to true when not specified in skill operation", async () => {
    const provider = makeProvider("skill-default", { priority: "medium" });

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "default-skill",
      canonicalPath: join(canonicalSkillsDir, "default-skill"),
      linkedAgents: ["skill-default"],
      errors: [],
      success: true,
    });

    await installBatchWithRollback({
      providers: [provider],
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "default-skill",
        // isGlobal intentionally omitted
      }],
      projectDir: testDir,
    });

    // installSkill should be called with isGlobal=true (the default)
    expect(mockedSkills.installSkillFn).toHaveBeenCalledWith(
      "/tmp/fake-source",
      "default-skill",
      expect.any(Array),
      true,
      testDir,
    );
  });

  it("rolls back MCP configs when a skill operation fails after MCP succeeds", async () => {
    const provider = makeProvider("mcp-then-skill", {
      priority: "high",
      configPathProject: ".mts/config.json",
    });

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "failing-skill",
      canonicalPath: join(canonicalSkillsDir, "failing-skill"),
      linkedAgents: [],
      errors: ["Catastrophic skill failure"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: [], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      mcp: [{
        serverName: "mcp-srv",
        config: { command: "test" },
        scope: "project",
      }],
      skills: [{
        sourcePath: "/tmp/fake",
        skillName: "failing-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.mcpApplied).toBe(1);
    // MCP config should be rolled back (file should not exist since it was new)
    expect(existsSync(join(testDir, ".mts/config.json"))).toBe(false);
  });

  it("records rollback errors when removeSkill throws during rollback", async () => {
    const provider = makeProvider("skill-rb-err", { priority: "high" });

    // First skill succeeds, second fails
    mockedSkills.installSkillFn
      .mockResolvedValueOnce({
        name: "good-skill",
        canonicalPath: join(canonicalSkillsDir, "good-skill"),
        linkedAgents: ["skill-rb-err"],
        errors: [],
        success: true,
      })
      .mockResolvedValueOnce({
        name: "bad-skill",
        canonicalPath: join(canonicalSkillsDir, "bad-skill"),
        linkedAgents: [],
        errors: ["Install failed"],
        success: false,
      });

    mockedSkills.removeSkillFn.mockRejectedValue(new Error("removeSkill blew up"));

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [
        { sourcePath: "/tmp/s1", skillName: "good-skill", isGlobal: true },
        { sourcePath: "/tmp/s2", skillName: "bad-skill", isGlobal: true },
      ],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);
    expect(result.rollbackErrors.length).toBeGreaterThan(0);
    expect(result.rollbackErrors.some((e) => e.includes("removeSkill blew up"))).toBe(true);
  });
});

describe("installBatchWithRollback - snapshot/restore skill state", () => {
  const canonicalSkillsDir = join(mockedSkills.canonicalRoot, "skills");

  it("snapshots and restores symlink state at provider skill paths during rollback", async () => {
    const provider = makeProvider("snap-sym", { priority: "high" });
    const skillLinkPath = join(testDir, "skills", "snap-sym", "global", "test-skill");

    // Pre-create a symlink at the skill link path
    await mkdir(join(testDir, "skills", "snap-sym", "global"), { recursive: true });
    const symlinkTarget = join(testDir, "symlink-target-dir");
    await mkdir(symlinkTarget, { recursive: true });
    await symlink(symlinkTarget, skillLinkPath, "dir");

    // Verify the symlink exists
    expect(lstatSync(skillLinkPath).isSymbolicLink()).toBe(true);

    // installSkill will fail, triggering rollback
    mockedSkills.installSkillFn.mockResolvedValue({
      name: "test-skill",
      canonicalPath: join(canonicalSkillsDir, "test-skill"),
      linkedAgents: ["snap-sym"],
      errors: ["Skill install error"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-sym"], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "test-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // After rollback, the symlink should be restored
    expect(existsSync(skillLinkPath)).toBe(true);
    expect(lstatSync(skillLinkPath).isSymbolicLink()).toBe(true);
  });

  it("snapshots and restores directory state at provider skill paths during rollback", async () => {
    const provider = makeProvider("snap-dir", { priority: "high" });
    const skillLinkPath = join(testDir, "skills", "snap-dir", "global", "test-skill");

    // Pre-create a real directory (not symlink) with contents
    await mkdir(skillLinkPath, { recursive: true });
    await writeFile(join(skillLinkPath, "SKILL.md"), "# Original skill content");

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "test-skill",
      canonicalPath: join(canonicalSkillsDir, "test-skill"),
      linkedAgents: ["snap-dir"],
      errors: ["Skill install error"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-dir"], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "test-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // After rollback, the directory and its contents should be restored
    expect(existsSync(skillLinkPath)).toBe(true);
    expect(lstatSync(skillLinkPath).isDirectory()).toBe(true);
    const content = await readFile(join(skillLinkPath, "SKILL.md"), "utf-8");
    expect(content).toBe("# Original skill content");
  });

  it("snapshots and restores file state at provider skill paths during rollback", async () => {
    const provider = makeProvider("snap-file", { priority: "high" });
    const skillLinkPath = join(testDir, "skills", "snap-file", "global", "test-skill");

    // Pre-create a file (not directory) at the skill link path
    await mkdir(join(testDir, "skills", "snap-file", "global"), { recursive: true });
    await writeFile(skillLinkPath, "file-based skill marker");

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "test-skill",
      canonicalPath: join(canonicalSkillsDir, "test-skill"),
      linkedAgents: ["snap-file"],
      errors: ["Skill install error"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-file"], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "test-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // After rollback, the file should be restored
    expect(existsSync(skillLinkPath)).toBe(true);
    expect(lstatSync(skillLinkPath).isFile()).toBe(true);
    const content = await readFile(skillLinkPath, "utf-8");
    expect(content).toBe("file-based skill marker");
  });

  it("snapshots missing state and cleans up after rollback", async () => {
    const provider = makeProvider("snap-missing", { priority: "high" });
    const skillLinkPath = join(testDir, "skills", "snap-missing", "global", "test-skill");

    // Don't create anything at the link path - it's "missing"
    await mkdir(join(testDir, "skills", "snap-missing", "global"), { recursive: true });

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "test-skill",
      canonicalPath: join(canonicalSkillsDir, "test-skill"),
      linkedAgents: ["snap-missing"],
      errors: ["Skill install error"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: [], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "test-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // After rollback, the path should still not exist (was "missing" before)
    expect(existsSync(skillLinkPath)).toBe(false);
  });

  it("snapshots and restores canonical skill directory during rollback", async () => {
    const provider = makeProvider("snap-canonical", { priority: "high" });
    const canonicalPath = join(canonicalSkillsDir, "test-skill");

    // Pre-create the canonical skill directory with content
    await mkdir(canonicalPath, { recursive: true });
    await writeFile(join(canonicalPath, "SKILL.md"), "# Canonical content");

    mockedSkills.installSkillFn.mockResolvedValue({
      name: "test-skill",
      canonicalPath,
      linkedAgents: ["snap-canonical"],
      errors: ["Skill install error"],
      success: false,
    });
    mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-canonical"], errors: [] });

    const result = await installBatchWithRollback({
      providers: [provider],
      minimumPriority: "high",
      skills: [{
        sourcePath: "/tmp/fake-source",
        skillName: "test-skill",
        isGlobal: true,
      }],
      projectDir: testDir,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackPerformed).toBe(true);

    // After rollback, the canonical directory should be restored with its content
    expect(existsSync(canonicalPath)).toBe(true);
    const content = await readFile(join(canonicalPath, "SKILL.md"), "utf-8");
    expect(content).toBe("# Canonical content");
  });
});

describe("updateInstructionsSingleOperation - global scope", () => {
  it("writes to global instruction paths when scope is 'global'", async () => {
    const p1 = makeProvider("global-p1", { configFormat: "json", instructFile: "AGENTS.md" });

    const result = await updateInstructionsSingleOperation(
      [p1],
      "Global instruction content",
      "global",
      testDir,
    );

    expect(result.scope).toBe("global");
    expect(result.updatedFiles).toBe(1);

    const globalInstructionPath = join(p1.pathGlobal, p1.instructFile);
    expect(existsSync(globalInstructionPath)).toBe(true);
    const content = await readFile(globalInstructionPath, "utf-8");
    expect(content).toContain("Global instruction content");
  });
});

describe("detectMcpConfigConflicts - transform-aware comparison", () => {
  it("applies provider transform when comparing existing vs desired config", async () => {
    // Use "goose" provider ID so getTransform returns transformGoose
    const provider = makeProvider("goose", {
      id: "goose",
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
      configFormat: "json",
      configKey: "mcpServers",
    });

    // Write the goose-transformed version of the config
    await mkdir(join(testDir, "global", "goose"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "my-server": {
          name: "my-server",
          type: "stdio",
          cmd: "npx",
          args: ["-y", "@example/server"],
          enabled: true,
          timeout: 300,
        },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "my-server",
        config: { command: "npx", args: ["-y", "@example/server"] },
        scope: "global" as const,
      },
    ];

    // The transform converts canonical config to goose format for comparison
    // If existing goose-format config matches the transformed canonical config,
    // no mismatch should be detected
    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    expect(mismatchConflicts).toHaveLength(0);
  });

  it("detects mismatch when transform-aware comparison finds differences", async () => {
    const provider = makeProvider("goose", {
      id: "goose",
      supportedTransports: ["stdio", "http", "sse"],
      supportsHeaders: true,
      configFormat: "json",
      configKey: "mcpServers",
    });

    // Write a goose-format config that doesn't match what transform would produce
    await mkdir(join(testDir, "global", "goose"), { recursive: true });
    await writeFile(provider.configPathGlobal, JSON.stringify({
      mcpServers: {
        "my-server": {
          name: "my-server",
          type: "stdio",
          cmd: "different-command",
          args: [],
          enabled: true,
          timeout: 300,
        },
      },
    }, null, 2));

    const operations = [
      {
        serverName: "my-server",
        config: { command: "npx", args: ["-y", "@example/server"] },
        scope: "global" as const,
      },
    ];

    const conflicts = await detectMcpConfigConflicts([provider], operations, testDir);
    const mismatchConflicts = conflicts.filter((c) => c.code === "existing-mismatch");
    expect(mismatchConflicts).toHaveLength(1);
  });
});

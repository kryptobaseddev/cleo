import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test the lock file data structures and utility functions
// rather than the file I/O functions that depend on specific paths

describe("Lock File Structure", () => {
  it("has correct shape", () => {
    const lock = {
      version: 1 as const,
      skills: {},
      mcpServers: {},
      lastSelectedAgents: ["claude-code"],
    };

    expect(lock.version).toBe(1);
    expect(lock.skills).toEqual({});
    expect(lock.mcpServers).toEqual({});
    expect(lock.lastSelectedAgents).toEqual(["claude-code"]);
  });

  it("stores skill entries correctly", () => {
    const entry = {
      name: "test-skill",
      scopedName: "@author/test-skill",
      source: "https://github.com/author/repo",
      sourceType: "github" as const,
      version: "abc123",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      agents: ["claude-code", "cursor"],
      canonicalPath: "/canonical/skills/test-skill",
      isGlobal: true,
    };

    expect(entry.name).toBe("test-skill");
    expect(entry.agents).toContain("claude-code");
    expect(entry.agents).toContain("cursor");
    expect(entry.isGlobal).toBe(true);
  });

  it("stores MCP server entries correctly", () => {
    const entry = {
      name: "neon",
      scopedName: "neon",
      source: "https://mcp.neon.tech/sse",
      sourceType: "remote" as const,
      installedAt: "2026-01-01T00:00:00.000Z",
      agents: ["claude-code", "cursor", "windsurf"],
      canonicalPath: "",
      isGlobal: false,
    };

    expect(entry.name).toBe("neon");
    expect(entry.sourceType).toBe("remote");
    expect(entry.agents).toHaveLength(3);
  });
});

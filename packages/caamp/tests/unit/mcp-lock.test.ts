import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaampLockFile } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  readLockFile: vi.fn(),
  updateLockFile: vi.fn(),
}));

vi.mock("../../src/core/lock-utils.js", () => ({
  readLockFile: mocks.readLockFile,
  updateLockFile: mocks.updateLockFile,
}));

import {
  getLastSelectedAgents,
  getTrackedMcpServers,
  recordMcpInstall,
  removeMcpFromLock,
  saveLastSelectedAgents,
} from "../../src/core/mcp/lock.js";

function createLock(overrides: Partial<CaampLockFile> = {}): CaampLockFile {
  return {
    version: 1,
    skills: {},
    mcpServers: {},
    ...overrides,
  };
}

describe("mcp lock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T12:00:00.000Z"));
    mocks.readLockFile.mockReset();
    mocks.updateLockFile.mockReset();
  });

  it("records a new MCP install entry", async () => {
    const lock = createLock();
    mocks.updateLockFile.mockImplementation(async (updater: (draft: CaampLockFile) => void) => {
      updater(lock);
    });

    await recordMcpInstall("filesystem", "@modelcontextprotocol/server-filesystem", "package", ["claude-code"], false);

    expect(lock.mcpServers.filesystem).toEqual({
      name: "filesystem",
      scopedName: "filesystem",
      source: "@modelcontextprotocol/server-filesystem",
      sourceType: "package",
      installedAt: "2026-02-01T12:00:00.000Z",
      updatedAt: "2026-02-01T12:00:00.000Z",
      agents: ["claude-code"],
      canonicalPath: "",
      isGlobal: false,
    });
  });

  it("merges agents and preserves installedAt for existing entries", async () => {
    const lock = createLock({
      mcpServers: {
        filesystem: {
          name: "filesystem",
          scopedName: "filesystem",
          source: "old-source",
          sourceType: "package",
          installedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-05T00:00:00.000Z",
          agents: ["claude-code"],
          canonicalPath: "",
          isGlobal: true,
        },
      },
    });
    mocks.updateLockFile.mockImplementation(async (updater: (draft: CaampLockFile) => void) => {
      updater(lock);
    });

    await recordMcpInstall("filesystem", "new-source", "remote", ["claude-code", "cursor"], false);

    expect(lock.mcpServers.filesystem?.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(lock.mcpServers.filesystem?.updatedAt).toBe("2026-02-01T12:00:00.000Z");
    expect(lock.mcpServers.filesystem?.agents).toEqual(["claude-code", "cursor"]);
    expect(lock.mcpServers.filesystem?.source).toBe("new-source");
    expect(lock.mcpServers.filesystem?.sourceType).toBe("remote");
    expect(lock.mcpServers.filesystem?.isGlobal).toBe(false);
  });

  it("returns true when an MCP entry is removed", async () => {
    const lock = createLock({
      mcpServers: {
        filesystem: {
          name: "filesystem",
          scopedName: "filesystem",
          source: "src",
          sourceType: "package",
          installedAt: "2026-01-01T00:00:00.000Z",
          agents: ["claude-code"],
          canonicalPath: "",
          isGlobal: true,
        },
      },
    });
    mocks.updateLockFile.mockImplementation(async (updater: (draft: CaampLockFile) => void) => {
      updater(lock);
    });

    const removed = await removeMcpFromLock("filesystem");

    expect(removed).toBe(true);
    expect(lock.mcpServers.filesystem).toBeUndefined();
  });

  it("returns false when removal target is missing", async () => {
    const lock = createLock();
    mocks.updateLockFile.mockImplementation(async (updater: (draft: CaampLockFile) => void) => {
      updater(lock);
    });

    const removed = await removeMcpFromLock("missing-server");

    expect(removed).toBe(false);
  });

  it("returns tracked MCP entries from lock", async () => {
    mocks.readLockFile.mockResolvedValue(createLock({
      mcpServers: {
        filesystem: {
          name: "filesystem",
          scopedName: "filesystem",
          source: "source",
          sourceType: "package",
          installedAt: "2026-01-01T00:00:00.000Z",
          agents: ["claude-code"],
          canonicalPath: "",
          isGlobal: false,
        },
      },
    }));

    const tracked = await getTrackedMcpServers();
    expect(Object.keys(tracked)).toEqual(["filesystem"]);
  });

  it("saves and reads last selected agents", async () => {
    const lock = createLock();
    mocks.updateLockFile.mockImplementation(async (updater: (draft: CaampLockFile) => void) => {
      updater(lock);
    });
    mocks.readLockFile.mockResolvedValue(lock);

    await saveLastSelectedAgents(["claude-code", "cursor"]);
    const selected = await getLastSelectedAgents();

    expect(selected).toEqual(["claude-code", "cursor"]);
  });

  it("propagates update failures when recording installs", async () => {
    mocks.updateLockFile.mockRejectedValue(new Error("write failed"));

    await expect(
      recordMcpInstall("filesystem", "source", "package", ["claude-code"], true),
    ).rejects.toThrow("write failed");
  });
});

import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaampLockFile } from "../../src/types.js";

const mockedPaths = vi.hoisted(() => {
  const agentsHome = `/tmp/caamp-lock-utils-${process.pid}`;
  return {
    AGENTS_HOME: agentsHome,
    LOCK_FILE_PATH: `${agentsHome}/.caamp-lock.json`,
  };
});

vi.mock("../../src/core/paths/agents.js", () => ({
  AGENTS_HOME: mockedPaths.AGENTS_HOME,
  LOCK_FILE_PATH: mockedPaths.LOCK_FILE_PATH,
}));

import { readLockFile, updateLockFile, writeLockFile } from "../../src/core/lock-utils.js";

describe("lock-utils", () => {
  beforeEach(async () => {
    await rm(mockedPaths.AGENTS_HOME, { recursive: true, force: true });
  });

  it("returns empty lock shape when file is missing", async () => {
    const lock = await readLockFile();
    expect(lock).toEqual({ version: 1, skills: {}, mcpServers: {} });
  });

  it("writes lock file and reads it back", async () => {
    const expected: CaampLockFile = {
      version: 1,
      skills: {
        demo: {
          name: "demo",
          scopedName: "@test/demo",
          source: "github",
          sourceType: "github",
          agents: ["claude-code"],
          canonicalPath: "/tmp/demo",
          isGlobal: true,
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      mcpServers: {},
    };

    await writeLockFile(expected);

    expect(existsSync(mockedPaths.LOCK_FILE_PATH)).toBe(true);
    const content = await readFile(mockedPaths.LOCK_FILE_PATH, "utf-8");
    expect(content.endsWith("\n")).toBe(true);

    const loaded = await readLockFile();
    expect(loaded).toEqual(expected);
  });

  it("falls back to empty lock when json is invalid", async () => {
    await mkdir(mockedPaths.AGENTS_HOME, { recursive: true });
    await writeFile(mockedPaths.LOCK_FILE_PATH, "{bad-json", "utf-8");

    const lock = await readLockFile();
    expect(lock).toEqual({ version: 1, skills: {}, mcpServers: {} });
  });

  it("updateLockFile applies mutation and returns updated lock", async () => {
    const result = await updateLockFile((lock) => {
      lock.skills["alpha"] = {
        name: "alpha",
        scopedName: "@test/alpha",
        source: "github",
        sourceType: "github",
        agents: ["claude-code"],
        canonicalPath: "/tmp/alpha",
        isGlobal: true,
        installedAt: "2026-02-15T00:00:00.000Z",
      };
    });

    expect(result.skills["alpha"]).toBeDefined();
    expect(result.skills["alpha"].name).toBe("alpha");

    const persisted = await readLockFile();
    expect(persisted).toEqual(result);
  });

  it("updateLockFile creates lock file when none exists", async () => {
    expect(existsSync(mockedPaths.LOCK_FILE_PATH)).toBe(false);

    const result = await updateLockFile((lock) => {
      lock.mcpServers["test-server"] = {
        name: "test-server",
        command: "node",
        args: ["server.js"],
      } as never;
    });

    expect(existsSync(mockedPaths.LOCK_FILE_PATH)).toBe(true);
    expect(result.version).toBe(1);
    expect(result.skills).toEqual({});
    expect(result.mcpServers["test-server"]).toBeDefined();
  });

  it("updateLockFile properly modifies existing lock data", async () => {
    const initial: CaampLockFile = {
      version: 1,
      skills: {
        existing: {
          name: "existing",
          scopedName: "@test/existing",
          source: "github",
          sourceType: "github",
          agents: ["claude-code"],
          canonicalPath: "/tmp/existing",
          isGlobal: true,
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      mcpServers: {},
    };
    await writeLockFile(initial);

    const result = await updateLockFile((lock) => {
      lock.skills["new-skill"] = {
        name: "new-skill",
        scopedName: "@test/new-skill",
        source: "package",
        sourceType: "package",
        agents: ["claude-code"],
        canonicalPath: "/tmp/new-skill",
        isGlobal: false,
        installedAt: "2026-02-15T12:00:00.000Z",
      };
    });

    expect(Object.keys(result.skills)).toHaveLength(2);
    expect(result.skills["existing"].name).toBe("existing");
    expect(result.skills["new-skill"].name).toBe("new-skill");

    const persisted = await readLockFile();
    expect(persisted).toEqual(result);
  });

  describe("stale lock removal", () => {
    it("removes stale lock guard and allows acquisition", async () => {
      // Create the directory
      await mkdir(mockedPaths.AGENTS_HOME, { recursive: true });

      // Create a lock guard file with an old timestamp
      const lockGuardPath = `${mockedPaths.LOCK_FILE_PATH}.lock`;
      await writeFile(lockGuardPath, "", "utf-8");

      // Backdate the file's mtime to make it stale (>5 seconds old)
      const { utimes } = await import("node:fs/promises");
      const oldTime = new Date(Date.now() - 10_000);
      await utimes(lockGuardPath, oldTime, oldTime);

      // Now updateLockFile should succeed because it detects the stale lock and removes it
      const result = await updateLockFile((lock) => {
        lock.skills["stale-test"] = {
          name: "stale-test",
          scopedName: "@test/stale-test",
          source: "github",
          sourceType: "github",
          agents: ["claude-code"],
          canonicalPath: "/tmp/stale-test",
          isGlobal: true,
          installedAt: "2026-02-15T00:00:00.000Z",
        };
      });

      expect(result.skills["stale-test"]).toBeDefined();
    });

    it("acquireLockGuard succeeds when lock guard does not exist", async () => {
      // Simply calling writeLockFile should work when no lock guard exists
      const lock: CaampLockFile = {
        version: 1,
        skills: {},
        mcpServers: {},
      };
      await writeLockFile(lock);
      const loaded = await readLockFile();
      expect(loaded).toEqual(lock);
    });
  });
});

import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAFSCommandError } from "../../../../src/commands/advanced/lafs.js";
import {
  parseScope,
  requirePiHarness,
  resolveProjectDir,
} from "../../../../src/commands/pi/common.js";
import { PiHarness } from "../../../../src/core/harness/pi.js";
import { resetDetectionCache } from "../../../../src/core/registry/detection.js";
import { resetRegistry } from "../../../../src/core/registry/providers.js";

describe("caamp pi common helpers", () => {
  beforeEach(() => {
    resetRegistry();
    resetDetectionCache();
  });

  afterEach(() => {
    resetRegistry();
    resetDetectionCache();
  });

  describe("parseScope", () => {
    it("returns the default tier when the raw value is undefined", () => {
      expect(parseScope(undefined, "project")).toBe("project");
      expect(parseScope(undefined, "user")).toBe("user");
      expect(parseScope(undefined, "global")).toBe("global");
    });

    it("accepts valid tier names", () => {
      expect(parseScope("project", "user")).toBe("project");
      expect(parseScope("user", "project")).toBe("user");
      expect(parseScope("global", "project")).toBe("global");
    });

    it("throws a typed LAFSCommandError on unknown tier names", () => {
      try {
        parseScope("nonsense", "project");
        throw new Error("expected parseScope to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LAFSCommandError);
        const lafsErr = err as LAFSCommandError;
        expect(lafsErr.code).toBe("E_VALIDATION_SCHEMA");
        expect(lafsErr.message).toMatch(/nonsense/);
      }
    });
  });

  describe("resolveProjectDir", () => {
    it("returns undefined for non-project tiers regardless of explicit value", () => {
      expect(resolveProjectDir("user", undefined)).toBeUndefined();
      expect(resolveProjectDir("user", "/some/path")).toBeUndefined();
      expect(resolveProjectDir("global", undefined)).toBeUndefined();
      expect(resolveProjectDir("global", "/any")).toBeUndefined();
    });

    it("returns the explicit value when project tier + explicit set", () => {
      expect(resolveProjectDir("project", "/explicit/path")).toBe("/explicit/path");
    });

    it("falls back to cwd for project tier when no explicit value is given", () => {
      const cwd = process.cwd();
      expect(resolveProjectDir("project", undefined)).toBe(cwd);
      expect(resolveProjectDir("project", "")).toBe(cwd);
    });
  });

  describe("requirePiHarness", () => {
    /**
     * Ensure the real `~/.pi/agent` directory exists for this test so
     * Pi's registry-declared directory detection sees it. We create the
     * directory only if it is absent, and NEVER delete the real user
     * home contents — we only remove the directory we created when we
     * created it, and only when it is still empty.
     */
    async function ensurePiDirExists(): Promise<() => Promise<void>> {
      const piDir = join(homedir(), ".pi", "agent");
      let created = false;
      try {
        const fs = await import("node:fs");
        if (!fs.existsSync(piDir)) {
          await mkdir(piDir, { recursive: true });
          created = true;
        }
      } catch {
        // ignore
      }
      return async () => {
        if (!created) return;
        try {
          // Only remove if the directory is still empty — never nuke a
          // real Pi install.
          const fs = await import("node:fs");
          const entries = fs.readdirSync(piDir);
          if (entries.length === 0) {
            await rm(piDir, { recursive: false, force: true });
          }
        } catch {
          // ignore
        }
      };
    }

    it("returns a PiHarness instance when Pi's state directory is detectable", async () => {
      const cleanup = await ensurePiDirExists();
      try {
        resetDetectionCache();
        const harness = requirePiHarness();
        expect(harness).toBeInstanceOf(PiHarness);
        expect(harness.id).toBe("pi");
        expect(harness.provider.id).toBe("pi");
      } finally {
        await cleanup();
        resetDetectionCache();
      }
    });

    it("throws a typed LAFSCommandError when Pi cannot be detected anywhere", async () => {
      // Temporarily mask PATH so `which pi` cannot find the binary and
      // ensure no `~/.pi/agent` is mistakenly detected.
      const cleanup = await ensurePiDirExists();
      try {
        await cleanup(); // remove any dir we just created
        const fs = await import("node:fs");
        const piDir = join(homedir(), ".pi", "agent");
        if (fs.existsSync(piDir)) {
          // Pi is actually installed on this host — skip this case.
          return;
        }
        const originalPath = process.env["PATH"];
        try {
          process.env["PATH"] = "/nonexistent-caamp-test";
          resetDetectionCache();
          try {
            requirePiHarness();
            throw new Error("expected requirePiHarness to throw");
          } catch (err) {
            expect(err).toBeInstanceOf(LAFSCommandError);
            const lafsErr = err as LAFSCommandError;
            expect(lafsErr.code).toBe("E_NOT_FOUND_RESOURCE");
          }
        } finally {
          if (originalPath === undefined) {
            delete process.env["PATH"];
          } else {
            process.env["PATH"] = originalPath;
          }
          resetDetectionCache();
        }
      } finally {
        // no extra cleanup needed
      }
    });
  });
});

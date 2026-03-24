import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  execFileSync: vi.fn(),
  getAllProviders: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getAllProviders: mocks.getAllProviders,
}));

import {
  detectAllProviders,
  detectProjectProvider,
  detectProjectProviders,
  detectProvider,
  getInstalledProviders,
  resetDetectionCache,
} from "../../src/core/registry/detection.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    toolName: "Test",
    vendor: "Test",
    agentFlag: "test",
    aliases: [],
    pathGlobal: "",
    pathProject: ".test",
    instructFile: "AGENTS.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: "",
    configPathProject: null,
    pathSkills: "",
    pathProjectSkills: "",
    detection: { methods: ["binary"], binary: "test-bin" },
    supportedTransports: ["stdio"],
    supportsHeaders: false,
    priority: "medium",
    status: "active",
    agentSkillsCompatible: false,
    ...overrides,
  };
}

describe("detection engine", () => {
  beforeEach(() => {
    mocks.existsSync.mockReset();
    mocks.execFileSync.mockReset();
    mocks.getAllProviders.mockReset();
    resetDetectionCache();
  });

  it("detects provider via binary", () => {
    mocks.execFileSync.mockReturnValue("/usr/bin/test-bin");

    const result = detectProvider(provider());
    expect(result.installed).toBe(true);
    expect(result.methods).toEqual(["binary"]);
  });

  it("detects provider via directory", () => {
    mocks.existsSync.mockReturnValue(true);

    const result = detectProvider(provider({
      detection: { methods: ["directory"], directories: ["/opt/test"] },
    }));

    expect(result.installed).toBe(true);
    expect(result.methods).toEqual(["directory"]);
  });

  it("returns not installed when checks fail", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = detectProvider(provider());
    expect(result.installed).toBe(false);
    expect(result.methods).toEqual([]);
  });

  it("detects project provider path", () => {
    mocks.existsSync.mockReturnValue(true);
    expect(detectProjectProvider(provider({ pathProject: ".claude" }), "/repo")).toBe(true);
  });

  it("detects all providers and installed providers", () => {
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "installed") return "ok";
      throw new Error("missing");
    });

    const installed = provider({ id: "installed", detection: { methods: ["binary"], binary: "installed" } });
    const missing = provider({ id: "missing", detection: { methods: ["binary"], binary: "missing" } });
    mocks.getAllProviders.mockReturnValue([installed, missing]);

    const all = detectAllProviders();
    expect(all).toHaveLength(2);

    const onlyInstalled = getInstalledProviders();
    expect(onlyInstalled).toHaveLength(1);
    expect(onlyInstalled[0]?.id).toBe("installed");
  });

  it("adds projectDetected in detectProjectProviders", () => {
    const p = provider({ id: "proj", pathProject: ".proj", detection: { methods: [] } });
    mocks.getAllProviders.mockReturnValue([p]);
    mocks.existsSync.mockReturnValue(true);

    const result = detectProjectProviders("/repo");
    expect(result).toHaveLength(1);
    expect(result[0]?.projectDetected).toBe(true);
  });

  it("caches detectAllProviders results by default", () => {
    mocks.execFileSync.mockReturnValue("ok");
    const p = provider({ id: "cached", detection: { methods: ["binary"], binary: "cached-bin" } });
    mocks.getAllProviders.mockReturnValue([p]);

    const first = detectAllProviders();
    const second = detectAllProviders();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("supports forceRefresh to bypass detection cache", () => {
    mocks.execFileSync.mockReturnValue("ok");
    const p = provider({ id: "refresh", detection: { methods: ["binary"], binary: "refresh-bin" } });
    mocks.getAllProviders.mockReturnValue([p]);

    detectAllProviders();
    detectAllProviders({ forceRefresh: true });

    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });
});

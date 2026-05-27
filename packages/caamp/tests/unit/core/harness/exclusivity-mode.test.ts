/**
 * Tests for ADR-035 §D7 exclusivity mode wiring.
 *
 * Covers the 3-mode × Pi installed/absent matrix on
 * `resolveDefaultTargetProviders`, the one-time deprecation warning when
 * an explicit non-Pi target is supplied in `auto` mode, and the explicit
 * "install paths are unaffected" guarantee for
 * `dispatchInstallSkillAcrossProviders`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstalledProviders: vi.fn(),
  installSkillGeneric: vi.fn(),
}));

vi.mock("../../../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../../../src/core/skills/installer.js", () => ({
  installSkill: mocks.installSkillGeneric,
  removeSkill: vi.fn(),
}));

import {
  DEFAULT_EXCLUSIVITY_MODE,
  EXCLUSIVITY_MODE_ENV_VAR,
  getExclusivityMode,
  isExclusivityMode,
  PiRequiredError,
  resetExclusivityModeOverride,
  resetExclusivityWarningState,
  setExclusivityMode,
} from "../../../../src/core/config/caamp-config.js";
import {
  dispatchInstallSkillAcrossProviders,
  resolveDefaultTargetProviders,
} from "../../../../src/core/harness/index.js";
import { getProvider } from "../../../../src/core/registry/providers.js";

beforeEach(() => {
  mocks.getInstalledProviders.mockReset();
  mocks.installSkillGeneric.mockReset();
  resetExclusivityModeOverride();
  resetExclusivityWarningState();
  delete process.env[EXCLUSIVITY_MODE_ENV_VAR];
});

afterEach(() => {
  resetExclusivityModeOverride();
  resetExclusivityWarningState();
  delete process.env[EXCLUSIVITY_MODE_ENV_VAR];
});

// ── 1. Default + accessor sanity ─────────────────────────────────────

describe("getExclusivityMode", () => {
  it("defaults to 'auto' when no override and no env var are set", () => {
    expect(getExclusivityMode()).toBe(DEFAULT_EXCLUSIVITY_MODE);
    expect(getExclusivityMode()).toBe("auto");
  });

  it("reads the CAAMP_EXCLUSIVITY_MODE environment variable", () => {
    process.env[EXCLUSIVITY_MODE_ENV_VAR] = "force-pi";
    expect(getExclusivityMode()).toBe("force-pi");
  });

  it("ignores invalid env var values and falls through to the default", () => {
    process.env[EXCLUSIVITY_MODE_ENV_VAR] = "nonsense";
    expect(getExclusivityMode()).toBe("auto");
  });

  it("programmatic override beats the env var", () => {
    process.env[EXCLUSIVITY_MODE_ENV_VAR] = "legacy";
    setExclusivityMode("force-pi");
    expect(getExclusivityMode()).toBe("force-pi");
    resetExclusivityModeOverride();
    expect(getExclusivityMode()).toBe("legacy");
  });

  it("isExclusivityMode narrows the literal union", () => {
    expect(isExclusivityMode("auto")).toBe(true);
    expect(isExclusivityMode("force-pi")).toBe(true);
    expect(isExclusivityMode("legacy")).toBe(true);
    expect(isExclusivityMode("AUTO")).toBe(false);
    expect(isExclusivityMode("")).toBe(false);
  });
});

// ── 2. resolveDefaultTargetProviders matrix ──────────────────────────

describe("resolveDefaultTargetProviders — auto mode", () => {
  it("returns [pi] and emits no warning when Pi is installed", () => {
    const pi = getProvider("pi");
    if (!pi) throw new Error("pi provider missing from registry");
    mocks.getInstalledProviders.mockReturnValue([pi]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("auto");
    const result = resolveDefaultTargetProviders();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pi");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to high-tier providers and warns once when Pi is absent", () => {
    const claude = getProvider("claude-code");
    const cursor = getProvider("cursor");
    if (!claude || !cursor) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([claude, cursor]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("auto");
    const first = resolveDefaultTargetProviders();
    const second = resolveDefaultTargetProviders();

    expect(first.map((p) => p.id)).toEqual(["claude-code", "cursor"]);
    expect(second.map((p) => p.id)).toEqual(["claude-code", "cursor"]);
    // Warning fires exactly once across both calls.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Pi is not installed");
    warnSpy.mockRestore();
  });

  it("emits a one-time deprecation warning for explicit non-Pi targets when Pi is installed", () => {
    const pi = getProvider("pi");
    const claude = getProvider("claude-code");
    if (!pi || !claude) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([pi, claude]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("auto");
    const first = resolveDefaultTargetProviders({ explicit: [claude] });
    const second = resolveDefaultTargetProviders({ explicit: [claude] });

    expect(first).toEqual([claude]);
    expect(second).toEqual([claude]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "non-Pi provider explicitly is deprecated",
    );
    warnSpy.mockRestore();
  });

  it("does not warn when the explicit list contains Pi", () => {
    const pi = getProvider("pi");
    const claude = getProvider("claude-code");
    if (!pi || !claude) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([pi, claude]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("auto");
    const result = resolveDefaultTargetProviders({ explicit: [pi, claude] });

    expect(result).toEqual([pi, claude]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("resolveDefaultTargetProviders — force-pi mode", () => {
  it("returns [pi] when Pi is installed", () => {
    const pi = getProvider("pi");
    if (!pi) throw new Error("pi missing from registry");
    mocks.getInstalledProviders.mockReturnValue([pi]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("force-pi");
    const result = resolveDefaultTargetProviders();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pi");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("throws PiRequiredError when Pi is absent", () => {
    const claude = getProvider("claude-code");
    if (!claude) throw new Error("claude-code missing from registry");
    mocks.getInstalledProviders.mockReturnValue([claude]);

    setExclusivityMode("force-pi");

    expect(() => resolveDefaultTargetProviders()).toThrowError(PiRequiredError);

    try {
      resolveDefaultTargetProviders();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PiRequiredError);
      const piErr = err as PiRequiredError;
      expect(piErr.code).toBe("E_NOT_FOUND_RESOURCE");
      expect(piErr.message).toContain("force-pi");
    }
  });

  it("ignores explicit non-Pi selections when Pi is absent and still throws", () => {
    const claude = getProvider("claude-code");
    if (!claude) throw new Error("claude-code missing from registry");
    mocks.getInstalledProviders.mockReturnValue([claude]);

    setExclusivityMode("force-pi");

    expect(() =>
      resolveDefaultTargetProviders({ explicit: [claude] }),
    ).toThrowError(PiRequiredError);
  });
});

describe("resolveDefaultTargetProviders — legacy mode", () => {
  it("returns the primary harness when Pi is installed (matches v2026.4.5 behaviour)", () => {
    const pi = getProvider("pi");
    if (!pi) throw new Error("pi missing from registry");
    mocks.getInstalledProviders.mockReturnValue([pi]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("legacy");
    const result = resolveDefaultTargetProviders();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pi");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns installed high-tier providers when Pi is absent (no warning)", () => {
    const claude = getProvider("claude-code");
    const cursor = getProvider("cursor");
    if (!claude || !cursor) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([claude, cursor]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("legacy");
    const result = resolveDefaultTargetProviders();

    expect(result.map((p) => p.id)).toEqual(["claude-code", "cursor"]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns explicit selection verbatim with no warning even when Pi is installed", () => {
    const pi = getProvider("pi");
    const claude = getProvider("claude-code");
    if (!pi || !claude) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([pi, claude]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("legacy");
    const result = resolveDefaultTargetProviders({ explicit: [claude] });

    expect(result).toEqual([claude]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── 3. Install paths are UNAFFECTED by exclusivity mode ──────────────

describe("install paths are unaffected by exclusivityMode (ADR-035 §D7)", () => {
  it("dispatchInstallSkillAcrossProviders dispatches to non-Pi providers in force-pi mode with Pi absent", async () => {
    const claude = getProvider("claude-code");
    if (!claude) throw new Error("claude-code missing from registry");
    mocks.getInstalledProviders.mockReturnValue([claude]);
    mocks.installSkillGeneric.mockResolvedValue({
      name: "demo",
      canonicalPath: "/canonical/demo",
      linkedAgents: ["claude-code"],
      errors: [],
      success: true,
    });

    setExclusivityMode("force-pi");

    // Even though resolveDefaultTargetProviders would throw in this mode,
    // the install dispatcher does NOT call it — it routes the explicit
    // provider list straight to the generic installer. This is the
    // critical guarantee from ADR-035 §D7.
    const result = await dispatchInstallSkillAcrossProviders(
      "/source/demo",
      "demo",
      [claude],
      true,
    );

    expect(result.success).toBe(true);
    expect(result.linkedAgents).toContain("claude-code");
    expect(mocks.installSkillGeneric).toHaveBeenCalledTimes(1);
  });

  it("warning latches do not leak between unrelated calls in different modes", () => {
    const pi = getProvider("pi");
    const claude = getProvider("claude-code");
    if (!pi || !claude) throw new Error("registry missing fixtures");
    mocks.getInstalledProviders.mockReturnValue([pi, claude]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setExclusivityMode("auto");
    resolveDefaultTargetProviders({ explicit: [claude] });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // After explicit reset (e.g. simulating a new process), the warning
    // can fire again — proving the latch is real, not a one-shot import.
    resetExclusivityWarningState();
    resolveDefaultTargetProviders({ explicit: [claude] });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});


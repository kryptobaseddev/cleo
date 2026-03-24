/**
 * Tests for the CAAMP hooks normalizer module
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
  toNative,
  toCanonical,
  toNativeBatch,
  supportsHook,
  getHookSupport,
  getSupportedEvents,
  getUnsupportedEvents,
  getProvidersForEvent,
  getCommonEvents,
  getProviderSummary,
  buildHookMatrix,
  getHookSystemType,
  getHookConfigPath,
  getProviderOnlyEvents,
  translateToAll,
  resolveNativeEvent,
  getHookMappingsVersion,
  getCanonicalEvent,
  getAllCanonicalEvents,
  getCanonicalEventsByCategory,
  getProviderHookProfile,
  getMappedProviderIds,
  resetHookMappings,
} from "../../src/core/hooks/index.js";

describe("Hooks Normalizer", () => {
  beforeEach(() => {
    resetHookMappings();
  });

  describe("constants", () => {
    it("CANONICAL_HOOK_EVENTS has 16 events", () => {
      expect(CANONICAL_HOOK_EVENTS).toHaveLength(16);
    });

    it("HOOK_CATEGORIES has 5 categories", () => {
      expect(HOOK_CATEGORIES).toHaveLength(5);
      expect(HOOK_CATEGORIES).toContain("session");
      expect(HOOK_CATEGORIES).toContain("prompt");
      expect(HOOK_CATEGORIES).toContain("tool");
      expect(HOOK_CATEGORIES).toContain("agent");
      expect(HOOK_CATEGORIES).toContain("context");
    });
  });

  describe("getHookMappingsVersion", () => {
    it("returns a semver version string", () => {
      const version = getHookMappingsVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("getCanonicalEvent", () => {
    it("returns definition for SessionStart", () => {
      const def = getCanonicalEvent("SessionStart");
      expect(def.category).toBe("session");
      expect(def.description).toBeTruthy();
      expect(def.canBlock).toBe(false);
    });

    it("returns canBlock=true for PreToolUse", () => {
      const def = getCanonicalEvent("PreToolUse");
      expect(def.canBlock).toBe(true);
      expect(def.category).toBe("tool");
    });

    it("returns canBlock=true for PromptSubmit", () => {
      const def = getCanonicalEvent("PromptSubmit");
      expect(def.canBlock).toBe(true);
      expect(def.category).toBe("prompt");
    });
  });

  describe("getAllCanonicalEvents", () => {
    it("returns all 16 event definitions", () => {
      const events = getAllCanonicalEvents();
      expect(Object.keys(events)).toHaveLength(16);
      for (const event of CANONICAL_HOOK_EVENTS) {
        expect(events[event]).toBeDefined();
        expect(events[event].category).toBeTruthy();
      }
    });
  });

  describe("getCanonicalEventsByCategory", () => {
    it("returns session events", () => {
      const events = getCanonicalEventsByCategory("session");
      expect(events).toContain("SessionStart");
      expect(events).toContain("SessionEnd");
      expect(events).toHaveLength(2);
    });

    it("returns tool events", () => {
      const events = getCanonicalEventsByCategory("tool");
      expect(events).toContain("PreToolUse");
      expect(events).toContain("PostToolUse");
      expect(events).toContain("PostToolUseFailure");
      expect(events).toContain("PermissionRequest");
    });

    it("returns context events", () => {
      const events = getCanonicalEventsByCategory("context");
      expect(events).toContain("PreCompact");
      expect(events).toContain("PostCompact");
      expect(events).toContain("Notification");
      expect(events).toContain("ConfigChange");
    });
  });

  describe("getProviderHookProfile", () => {
    it("returns profile for claude-code", () => {
      const profile = getProviderHookProfile("claude-code");
      expect(profile).toBeDefined();
      expect(profile!.hookSystem).toBe("config");
      expect(profile!.experimental).toBe(false);
      expect(profile!.handlerTypes).toContain("command");
    });

    it("returns profile for kimi with no hooks", () => {
      const profile = getProviderHookProfile("kimi");
      expect(profile).toBeDefined();
      expect(profile!.hookSystem).toBe("none");
      expect(profile!.handlerTypes).toHaveLength(0);
    });

    it("returns undefined for unknown provider", () => {
      const profile = getProviderHookProfile("nonexistent-provider");
      expect(profile).toBeUndefined();
    });
  });

  describe("getMappedProviderIds", () => {
    it("returns all mapped provider IDs", () => {
      const ids = getMappedProviderIds();
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain("claude-code");
      expect(ids).toContain("cursor");
      expect(ids).toContain("gemini-cli");
      expect(ids).toContain("kimi");
    });
  });

  describe("toNative", () => {
    it("translates PreToolUse to Claude Code native name", () => {
      expect(toNative("PreToolUse", "claude-code")).toBe("PreToolUse");
    });

    it("translates PreToolUse to Gemini CLI native name", () => {
      expect(toNative("PreToolUse", "gemini-cli")).toBe("BeforeTool");
    });

    it("translates PreToolUse to Cursor native name", () => {
      expect(toNative("PreToolUse", "cursor")).toBe("preToolUse");
    });

    it("translates PreToolUse to OpenCode native name", () => {
      expect(toNative("PreToolUse", "opencode")).toBe("tool.execute.before");
    });

    it("translates PromptSubmit to Claude Code as UserPromptSubmit", () => {
      expect(toNative("PromptSubmit", "claude-code")).toBe("UserPromptSubmit");
    });

    it("translates PromptSubmit to Gemini CLI as BeforeAgent", () => {
      expect(toNative("PromptSubmit", "gemini-cli")).toBe("BeforeAgent");
    });

    it("translates ResponseComplete to Claude Code as Stop", () => {
      expect(toNative("ResponseComplete", "claude-code")).toBe("Stop");
    });

    it("returns null for unsupported event", () => {
      expect(toNative("PreToolUse", "kimi")).toBeNull();
    });

    it("returns null for unknown provider", () => {
      expect(toNative("PreToolUse", "nonexistent")).toBeNull();
    });

    it("returns null for PreModel on claude-code (not supported)", () => {
      expect(toNative("PreModel", "claude-code")).toBeNull();
    });

    it("translates PreModel to Gemini CLI as BeforeModel", () => {
      expect(toNative("PreModel", "gemini-cli")).toBe("BeforeModel");
    });
  });

  describe("toCanonical", () => {
    it("translates BeforeTool from gemini-cli to PreToolUse", () => {
      expect(toCanonical("BeforeTool", "gemini-cli")).toBe("PreToolUse");
    });

    it("translates UserPromptSubmit from claude-code to PromptSubmit", () => {
      expect(toCanonical("UserPromptSubmit", "claude-code")).toBe("PromptSubmit");
    });

    it("translates Stop from claude-code to ResponseComplete", () => {
      expect(toCanonical("Stop", "claude-code")).toBe("ResponseComplete");
    });

    it("translates tool.execute.before from opencode to PreToolUse", () => {
      expect(toCanonical("tool.execute.before", "opencode")).toBe("PreToolUse");
    });

    it("translates beforeSubmitPrompt from cursor to PromptSubmit", () => {
      expect(toCanonical("beforeSubmitPrompt", "cursor")).toBe("PromptSubmit");
    });

    it("returns null for provider-only events", () => {
      expect(toCanonical("StopFailure", "claude-code")).toBeNull();
    });

    it("returns null for unknown provider", () => {
      expect(toCanonical("PreToolUse", "nonexistent")).toBeNull();
    });
  });

  describe("toNativeBatch", () => {
    it("translates multiple events for a provider", () => {
      const results = toNativeBatch(
        ["SessionStart", "PreToolUse", "PreModel"],
        "gemini-cli",
      );
      expect(results).toHaveLength(3);
      expect(results[0].canonical).toBe("SessionStart");
      expect(results[0].native).toBe("SessionStart");
      expect(results[1].canonical).toBe("PreToolUse");
      expect(results[1].native).toBe("BeforeTool");
      expect(results[2].canonical).toBe("PreModel");
      expect(results[2].native).toBe("BeforeModel");
    });

    it("excludes unsupported events", () => {
      const results = toNativeBatch(
        ["SessionStart", "PreModel"],
        "claude-code",
      );
      expect(results).toHaveLength(1);
      expect(results[0].canonical).toBe("SessionStart");
    });

    it("returns empty for unknown provider", () => {
      expect(toNativeBatch(["SessionStart"], "nonexistent")).toHaveLength(0);
    });

    it("includes category and canBlock in results", () => {
      const results = toNativeBatch(["PreToolUse"], "claude-code");
      expect(results[0].category).toBe("tool");
      expect(results[0].canBlock).toBe(true);
      expect(results[0].providerId).toBe("claude-code");
    });
  });

  describe("supportsHook", () => {
    it("returns true for supported event", () => {
      expect(supportsHook("PreToolUse", "claude-code")).toBe(true);
    });

    it("returns false for unsupported event", () => {
      expect(supportsHook("PreToolUse", "kimi")).toBe(false);
    });

    it("returns false for unknown provider", () => {
      expect(supportsHook("PreToolUse", "nonexistent")).toBe(false);
    });

    it("returns true for PreModel on gemini-cli", () => {
      expect(supportsHook("PreModel", "gemini-cli")).toBe(true);
    });

    it("returns false for PreModel on claude-code", () => {
      expect(supportsHook("PreModel", "claude-code")).toBe(false);
    });
  });

  describe("getHookSupport", () => {
    it("returns full support details", () => {
      const result = getHookSupport("PreToolUse", "gemini-cli");
      expect(result.canonical).toBe("PreToolUse");
      expect(result.supported).toBe(true);
      expect(result.native).toBe("BeforeTool");
    });

    it("returns unsupported for kimi", () => {
      const result = getHookSupport("PreToolUse", "kimi");
      expect(result.supported).toBe(false);
      expect(result.native).toBeNull();
    });

    it("includes notes when available", () => {
      const result = getHookSupport("SessionStart", "opencode");
      expect(result.supported).toBe(true);
      expect(result.notes).toBeTruthy();
    });

    it("returns unsupported for unknown provider", () => {
      const result = getHookSupport("PreToolUse", "nonexistent");
      expect(result.supported).toBe(false);
    });
  });

  describe("getSupportedEvents", () => {
    it("returns many events for claude-code", () => {
      const events = getSupportedEvents("claude-code");
      expect(events.length).toBeGreaterThan(10);
      expect(events).toContain("PreToolUse");
      expect(events).toContain("SessionStart");
    });

    it("returns empty for kimi", () => {
      expect(getSupportedEvents("kimi")).toHaveLength(0);
    });

    it("returns empty for unknown provider", () => {
      expect(getSupportedEvents("nonexistent")).toHaveLength(0);
    });
  });

  describe("getUnsupportedEvents", () => {
    it("returns few events for claude-code", () => {
      const events = getUnsupportedEvents("claude-code");
      expect(events.length).toBeLessThan(5);
      expect(events).toContain("PreModel");
    });

    it("returns all events for kimi", () => {
      const events = getUnsupportedEvents("kimi");
      expect(events).toHaveLength(16);
    });

    it("returns all events for unknown provider", () => {
      const events = getUnsupportedEvents("nonexistent");
      expect(events).toHaveLength(16);
    });
  });

  describe("getProvidersForEvent", () => {
    it("returns multiple providers for SessionStart", () => {
      const providers = getProvidersForEvent("SessionStart");
      expect(providers).toContain("claude-code");
      expect(providers).toContain("cursor");
      expect(providers).toContain("gemini-cli");
      expect(providers).not.toContain("kimi");
    });

    it("returns fewer providers for PreModel", () => {
      const providers = getProvidersForEvent("PreModel");
      expect(providers).toContain("gemini-cli");
      expect(providers).toContain("opencode");
      expect(providers).not.toContain("claude-code");
    });
  });

  describe("getCommonEvents", () => {
    it("returns events common to claude-code and cursor", () => {
      const common = getCommonEvents(["claude-code", "cursor"]);
      expect(common).toContain("SessionStart");
      expect(common).toContain("PreToolUse");
      expect(common).not.toContain("ConfigChange");
    });

    it("returns empty for empty input", () => {
      expect(getCommonEvents([])).toHaveLength(0);
    });

    it("returns all supported events for single provider", () => {
      const common = getCommonEvents(["claude-code"]);
      const supported = getSupportedEvents("claude-code");
      expect(common).toEqual(supported);
    });

    it("returns empty when including kimi (no hooks)", () => {
      const common = getCommonEvents(["claude-code", "kimi"]);
      expect(common).toHaveLength(0);
    });
  });

  describe("getProviderSummary", () => {
    it("returns summary for claude-code", () => {
      const summary = getProviderSummary("claude-code");
      expect(summary).toBeDefined();
      expect(summary!.providerId).toBe("claude-code");
      expect(summary!.hookSystem).toBe("config");
      expect(summary!.experimental).toBe(false);
      expect(summary!.supportedCount).toBeGreaterThan(10);
      expect(summary!.totalCanonical).toBe(16);
      expect(summary!.coverage).toBeGreaterThan(70);
      expect(summary!.supported.length).toBe(summary!.supportedCount);
      expect(summary!.unsupported.length).toBe(16 - summary!.supportedCount);
      expect(summary!.providerOnly.length).toBeGreaterThan(0);
    });

    it("returns 0% coverage for kimi", () => {
      const summary = getProviderSummary("kimi");
      expect(summary!.coverage).toBe(0);
      expect(summary!.supportedCount).toBe(0);
    });

    it("returns undefined for unknown provider", () => {
      expect(getProviderSummary("nonexistent")).toBeUndefined();
    });

    it("marks cursor as experimental", () => {
      const summary = getProviderSummary("cursor");
      expect(summary!.experimental).toBe(true);
    });
  });

  describe("buildHookMatrix", () => {
    it("builds matrix for all providers", () => {
      const matrix = buildHookMatrix();
      expect(matrix.events).toHaveLength(16);
      expect(matrix.providers.length).toBeGreaterThan(0);
      expect(matrix.matrix.SessionStart).toBeDefined();
    });

    it("builds matrix for specified providers", () => {
      const matrix = buildHookMatrix(["claude-code", "gemini-cli"]);
      expect(matrix.providers).toHaveLength(2);
      expect(matrix.matrix.PreToolUse["claude-code"].supported).toBe(true);
      expect(matrix.matrix.PreToolUse["gemini-cli"].supported).toBe(true);
      expect(matrix.matrix.PreToolUse["gemini-cli"].nativeName).toBe("BeforeTool");
    });

    it("shows unsupported correctly", () => {
      const matrix = buildHookMatrix(["kimi"]);
      expect(matrix.matrix.PreToolUse["kimi"].supported).toBe(false);
    });
  });

  describe("getHookSystemType", () => {
    it("returns config for claude-code", () => {
      expect(getHookSystemType("claude-code")).toBe("config");
    });

    it("returns plugin for opencode", () => {
      expect(getHookSystemType("opencode")).toBe("plugin");
    });

    it("returns none for kimi", () => {
      expect(getHookSystemType("kimi")).toBe("none");
    });

    it("returns none for unknown provider", () => {
      expect(getHookSystemType("nonexistent")).toBe("none");
    });
  });

  describe("getHookConfigPath", () => {
    it("returns resolved path for gemini-cli", () => {
      const path = getHookConfigPath("gemini-cli");
      expect(path).toBeTruthy();
      expect(path).toContain(".gemini/settings.json");
    });

    it("returns null for kimi", () => {
      expect(getHookConfigPath("kimi")).toBeNull();
    });

    it("returns null for unknown provider", () => {
      expect(getHookConfigPath("nonexistent")).toBeNull();
    });
  });

  describe("getProviderOnlyEvents", () => {
    it("returns provider-only events for claude-code", () => {
      const events = getProviderOnlyEvents("claude-code");
      expect(events).toContain("StopFailure");
      expect(events).toContain("TeammateIdle");
      expect(events).toContain("WorktreeCreate");
    });

    it("returns empty for kimi", () => {
      expect(getProviderOnlyEvents("kimi")).toHaveLength(0);
    });

    it("returns empty for unknown provider", () => {
      expect(getProviderOnlyEvents("nonexistent")).toHaveLength(0);
    });
  });

  describe("translateToAll", () => {
    it("translates PreToolUse to all supporting providers", () => {
      const result = translateToAll("PreToolUse", [
        "claude-code",
        "gemini-cli",
        "cursor",
        "kimi",
      ]);
      expect(result["claude-code"]).toBe("PreToolUse");
      expect(result["gemini-cli"]).toBe("BeforeTool");
      expect(result["cursor"]).toBe("preToolUse");
      expect(result["kimi"]).toBeUndefined();
    });

    it("returns empty for event no one supports", () => {
      const result = translateToAll("ConfigChange", ["kimi", "antigravity"]);
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe("resolveNativeEvent", () => {
    it("resolves BeforeTool to gemini-cli PreToolUse", () => {
      const results = resolveNativeEvent("BeforeTool");
      expect(results.length).toBeGreaterThan(0);
      expect(results).toContainEqual({
        providerId: "gemini-cli",
        canonical: "PreToolUse",
      });
    });

    it("resolves Stop to claude-code and codex", () => {
      const results = resolveNativeEvent("Stop");
      const providerIds = results.map((r) => r.providerId);
      expect(providerIds).toContain("claude-code");
      expect(providerIds).toContain("codex");
      expect(results[0].canonical).toBe("ResponseComplete");
    });

    it("returns empty for unknown native event", () => {
      expect(resolveNativeEvent("NonExistentNativeEvent")).toHaveLength(0);
    });
  });
});

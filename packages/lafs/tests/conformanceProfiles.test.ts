import { describe, expect, it } from "vitest";
import {
  getChecksForTier,
  getConformanceProfiles,
  runEnvelopeConformance,
  validateConformanceProfiles,
} from "../src/index.js";

describe("conformance profiles", () => {
  it("loads machine-readable tier profiles", () => {
    const profiles = getConformanceProfiles();
    expect(profiles.version).toBeTruthy();
    expect(profiles.tiers.core.length).toBeGreaterThan(0);
    expect(profiles.tiers.standard.length).toBeGreaterThanOrEqual(profiles.tiers.core.length);
    expect(profiles.tiers.complete.length).toBeGreaterThanOrEqual(profiles.tiers.standard.length);
  });

  it("validates tier profiles against available checks", () => {
    const report = runEnvelopeConformance({
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-25T00:00:00Z",
        operation: "profiles.validate",
        requestId: "req_profiles",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: true,
      result: { ok: true },
    });

    const available = report.checks.map((check) => check.name);
    const validation = validateConformanceProfiles(available);
    expect(validation.valid).toBe(true);
  });

  it("filters checks by selected tier", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-25T00:00:00Z",
        operation: "profiles.tier",
        requestId: "req_profiles_tier",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: true,
      result: { ok: true },
    };

    const core = runEnvelopeConformance(envelope, { tier: "core" });
    const standard = runEnvelopeConformance(envelope, { tier: "standard" });
    const complete = runEnvelopeConformance(envelope, { tier: "complete" });

    expect(new Set(core.checks.map((c) => c.name))).toEqual(new Set(getChecksForTier("core")));
    expect(new Set(standard.checks.map((c) => c.name))).toEqual(
      new Set(getChecksForTier("standard")),
    );
    expect(new Set(complete.checks.map((c) => c.name))).toEqual(
      new Set(getChecksForTier("complete")),
    );
  });
});

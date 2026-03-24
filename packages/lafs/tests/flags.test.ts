import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveOutputFormat, runFlagConformance } from "../src/index.js";

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("LAFS flag semantics", () => {
  it("defaults to json when unspecified", () => {
    const resolved = resolveOutputFormat({});
    expect(resolved.format).toBe("json");
    expect(resolved.source).toBe("default");
  });

  it("passes for valid non-conflicting flags", () => {
    const input = load("fixtures/flags-valid.json");
    const report = runFlagConformance(input as never);
    expect(report.ok).toBe(true);
  });

  it("treats conflict fixture as conforming conflict behavior", () => {
    const input = load("fixtures/flags-conflict.json");
    const report = runFlagConformance(input as never);
    expect(report.ok).toBe(true);
  });
});

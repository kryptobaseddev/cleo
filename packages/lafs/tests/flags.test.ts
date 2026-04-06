import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveOutputFormat, runFlagConformance } from "../src/index.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function load(path: string): unknown {
  return JSON.parse(readFileSync(resolve(PKG_ROOT, path), "utf8")) as unknown;
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

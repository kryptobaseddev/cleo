import { describe, expect, it } from "vitest";
import {
  getTransform,
  transformCodex,
  transformCursor,
  transformGoose,
  transformOpenCode,
  transformZed,
} from "../../src/core/mcp/transforms.js";

describe("mcp transforms", () => {
  it("transforms goose remote and local configs", () => {
    expect(transformGoose("srv", { type: "sse", url: "https://x", headers: { Authorization: "t" } })).toEqual({
      name: "srv",
      type: "sse",
      uri: "https://x",
      headers: { Authorization: "t" },
      enabled: true,
      timeout: 300,
    });

    expect(transformGoose("srv", { command: "npx", args: ["-y", "pkg"], env: { A: "1" } })).toEqual({
      name: "srv",
      type: "stdio",
      cmd: "npx",
      args: ["-y", "pkg"],
      envs: { A: "1" },
      enabled: true,
      timeout: 300,
    });
  });

  it("transforms zed remote and local configs", () => {
    expect(transformZed("srv", { type: "http", url: "https://x" })).toEqual({
      source: "custom",
      type: "http",
      url: "https://x",
    });

    expect(transformZed("srv", { command: "node", args: ["server.js"], env: { NODE_ENV: "test" } })).toEqual({
      source: "custom",
      command: "node",
      args: ["server.js"],
      env: { NODE_ENV: "test" },
    });
  });

  it("transforms opencode remote and local configs", () => {
    expect(transformOpenCode("srv", { url: "https://x" })).toEqual({
      type: "remote",
      url: "https://x",
      enabled: true,
    });

    expect(transformOpenCode("srv", { command: "node", args: ["server.js"], env: { A: "1" } })).toEqual({
      type: "local",
      command: ["node", "server.js"],
      enabled: true,
      environment: { A: "1" },
    });
  });

  it("transforms codex remote and local configs", () => {
    expect(transformCodex("srv", { type: "sse", url: "https://x", headers: { X: "y" } })).toEqual({
      type: "sse",
      url: "https://x",
      headers: { X: "y" },
    });

    expect(transformCodex("srv", { command: "npx", args: ["-y", "pkg"], env: { A: "1" } })).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
      env: { A: "1" },
    });
  });

  it("transforms cursor remote and keeps local passthrough", () => {
    expect(transformCursor("srv", { type: "http", url: "https://x", headers: { X: "1" } })).toEqual({
      url: "https://x",
      headers: { X: "1" },
    });

    const local = { command: "npx", args: ["-y", "pkg"] };
    expect(transformCursor("srv", local)).toEqual(local);
  });

  it("returns transforms for known providers only", () => {
    expect(getTransform("goose")).toBeTypeOf("function");
    expect(getTransform("zed")).toBeTypeOf("function");
    expect(getTransform("opencode")).toBeTypeOf("function");
    expect(getTransform("codex")).toBeTypeOf("function");
    expect(getTransform("cursor")).toBeTypeOf("function");
    expect(getTransform("unknown")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_CARD_PATH,
  HTTP_EXTENSION_HEADER,
  LafsA2AResult,
  createLafsArtifact,
  createTextArtifact,
  isExtensionRequired,
} from "../src/index.js";

describe("A2A bridge upstream SDK alignment (T102)", () => {
  it("exposes upstream path/header constants", () => {
    expect(AGENT_CARD_PATH.endsWith(".well-known/agent-card.json")).toBe(true);
    expect(HTTP_EXTENSION_HEADER.toLowerCase()).toContain("a2a");
  });

  it("extracts LAFS envelope from A2A artifact task result", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: new Date().toISOString(),
        operation: "bridge.test",
        requestId: "req_bridge",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 1,
      },
      success: true,
      result: { ok: true },
    } as const;

    const task = {
      id: "task_1",
      kind: "task",
      contextId: "ctx_1",
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [createLafsArtifact(envelope)],
    };

    const wrapped = new LafsA2AResult(
      {
        jsonrpc: "2.0",
        id: "req_1",
        result: task,
      } as never,
      {},
      "req_1",
    );

    expect(wrapped.hasLafsEnvelope()).toBe(true);
    expect(wrapped.getLafsEnvelope()?.success).toBe(true);
  });

  it("evaluates required extension declarations", () => {
    const requiredCard = {
      capabilities: {
        extensions: [{ uri: "https://example.com/ext", required: true }],
      },
    };
    const optionalCard = {
      capabilities: {
        extensions: [{ uri: "https://example.com/ext", required: false }],
      },
    };

    expect(isExtensionRequired(requiredCard as never, "https://example.com/ext")).toBe(true);
    expect(isExtensionRequired(optionalCard as never, "https://example.com/ext")).toBe(false);
  });

  it("creates text artifacts with plain text parts", () => {
    const artifact = createTextArtifact("hello");
    expect(artifact.parts[0]?.kind).toBe("text");
  });
});

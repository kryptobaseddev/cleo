import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getErrorRegistry,
  validateEnvelope,
  createEnvelope,
  CATEGORY_ACTION_MAP,
  runEnvelopeConformance,
} from "../src/index.js";
import type { LAFSErrorCategory, LAFSAgentAction } from "../src/index.js";

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("Error registry agent-actionable fields", () => {
  const registry = getErrorRegistry();

  it("all 13 error registry entries have agentAction defined", () => {
    expect(registry.codes.length).toBe(13);
    for (const entry of registry.codes) {
      expect(entry.agentAction, `${entry.code} missing agentAction`).toBeDefined();
      expect(typeof entry.agentAction).toBe("string");
    }
  });

  it("all 13 entries have typeUri defined", () => {
    expect(registry.codes.length).toBe(13);
    for (const entry of registry.codes) {
      expect(entry.typeUri, `${entry.code} missing typeUri`).toBeDefined();
      expect(entry.typeUri).toMatch(/^https:\/\//);
    }
  });

  it("all 13 entries have docUrl defined", () => {
    expect(registry.codes.length).toBe(13);
    for (const entry of registry.codes) {
      expect(entry.docUrl, `${entry.code} missing docUrl`).toBeDefined();
      expect(entry.docUrl).toMatch(/^https:\/\//);
    }
  });
});

describe("CATEGORY_ACTION_MAP coverage", () => {
  const ALL_CATEGORIES: LAFSErrorCategory[] = [
    "VALIDATION",
    "AUTH",
    "PERMISSION",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMIT",
    "TRANSIENT",
    "INTERNAL",
    "CONTRACT",
    "MIGRATION",
  ];

  it("covers all 10 error categories", () => {
    expect(Object.keys(CATEGORY_ACTION_MAP).sort()).toEqual([...ALL_CATEGORIES].sort());
    for (const category of ALL_CATEGORIES) {
      expect(CATEGORY_ACTION_MAP[category], `${category} missing from CATEGORY_ACTION_MAP`).toBeDefined();
    }
  });
});

describe("normalizeError auto-populates agentAction", () => {
  it("populates agentAction from registry for registered code", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_RATE_LIMITED",
        message: "Too many requests",
      },
      meta: {
        operation: "test.op",
        requestId: "req_test_01",
      },
    });

    expect(envelope.error).toBeDefined();
    expect(envelope.error!.agentAction).toBe("wait");
  });

  it("falls back to CATEGORY_ACTION_MAP when code not in registry", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_CUSTOM_SOMETHING",
        message: "Custom error",
        category: "AUTH",
      },
      meta: {
        operation: "test.op",
        requestId: "req_test_02",
      },
    });

    expect(envelope.error).toBeDefined();
    // AUTH category maps to "authenticate"
    expect(envelope.error!.agentAction).toBe("authenticate");
  });

  it("preserves explicit agentAction over registry default", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_RATE_LIMITED",
        message: "Too many requests",
        agentAction: "escalate",
      },
      meta: {
        operation: "test.op",
        requestId: "req_test_03",
      },
    });

    expect(envelope.error).toBeDefined();
    expect(envelope.error!.agentAction).toBe("escalate");
  });

  it("auto-populates docUrl from registry", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_INTERNAL_UNEXPECTED",
        message: "Something went wrong",
      },
      meta: {
        operation: "test.op",
        requestId: "req_test_04",
      },
    });

    expect(envelope.error).toBeDefined();
    expect(envelope.error!.docUrl).toBe("https://lafs.dev/docs/errors/internal-unexpected");
  });
});

describe("New fixtures validate against schema", () => {
  it("valid-error-actionable.json validates", () => {
    const envelope = load("fixtures/valid-error-actionable.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("valid-error-escalation.json validates", () => {
    const envelope = load("fixtures/valid-error-escalation.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("valid-error-actionable.json passes full conformance", () => {
    const envelope = load("fixtures/valid-error-actionable.json");
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);

    const agentCheck = report.checks.find((c) => c.name === "agent_action_valid");
    expect(agentCheck).toBeDefined();
    expect(agentCheck!.pass).toBe(true);
  });

  it("valid-error-escalation.json passes full conformance", () => {
    const envelope = load("fixtures/valid-error-escalation.json");
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);

    const agentCheck = report.checks.find((c) => c.name === "agent_action_valid");
    expect(agentCheck).toBeDefined();
    expect(agentCheck!.pass).toBe(true);
  });

  it("conformance detects invalid agentAction value", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-03-15T00:00:00Z",
        operation: "test.op",
        requestId: "req_bad_action",
        transport: "sdk",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: false,
      result: null,
      error: {
        code: "E_VALIDATION_SCHEMA",
        message: "Bad input",
        category: "VALIDATION",
        retryable: false,
        retryAfterMs: null,
        details: {},
        agentAction: "invalid_action",
      },
    };
    // Schema validation will reject the invalid enum value
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
  });
});

/**
 * Tests for LAFS Discovery Middleware (A2A v1.0)
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { discoveryMiddleware, DiscoveryConfig } from "../src/discovery.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Handle ESM/CommonJS interop for AJV
const require = createRequire(import.meta.url);
const AjvModule = require("ajv") as { default?: new (opts: object) => unknown } | (new (opts: object) => unknown);
const AddFormatsModule = require("ajv-formats") as { default?: (ajv: unknown) => void } | ((ajv: unknown) => void);

const AjvCtor = (typeof AjvModule === "function" ? AjvModule : AjvModule.default) as new (opts: object) => {
  compile: (schema: unknown) => {
    (input: unknown): boolean;
    errors?: Array<{ instancePath?: string; message?: string }>;
  };
};

const addFormats = (typeof AddFormatsModule === "function" ? AddFormatsModule : AddFormatsModule.default) as (ajv: unknown) => void;

const agentCardSchemaPath = join(__dirname, "..", "schemas", "v1", "agent-card.schema.json");
const agentCardSchema = JSON.parse(readFileSync(agentCardSchemaPath, "utf-8"));

const ajv = new AjvCtor({ strict: true, allErrors: true });
addFormats(ajv);
const validateAgentCard = ajv.compile(agentCardSchema);

function createApp(config: DiscoveryConfig) {
  const app = express();
  app.use(discoveryMiddleware(config));
  app.use(express.json());
  return app;
}

const validConfig: DiscoveryConfig = {
  agent: {
    name: "test-agent",
    description: "A2A test agent",
    version: "1.0.0",
    url: "https://example.com/api/v1/envelope",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "envelope-processor",
        name: "Envelope Processor",
        description: "Process LAFS envelopes",
        tags: ["process", "validate"],
      },
    ],
  },
  cacheMaxAge: 3600,
};

describe("Discovery Middleware", () => {
  describe("GET /.well-known/agent-card.json", () => {
    it("should return the A2A Agent Card", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200)
        .expect("Content-Type", /json/);

      expect(response.body.name).toBe("test-agent");
      expect(response.body.capabilities).toBeDefined();
      expect(response.body.skills).toBeDefined();
      expect(response.body.defaultInputModes).toContain("application/json");
      expect(response.body.defaultOutputModes).toContain("application/json");
    });

    it("should validate against agent-card schema", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      const valid = validateAgentCard(response.body);
      if (!valid) {
        console.error("Agent Card validation errors:", validateAgentCard.errors);
      }
      expect(valid).toBe(true);
    });

    it("should support provider, security schemes, and docs metadata", async () => {
      const app = createApp({
        agent: {
          ...validConfig.agent,
          provider: {
            organization: "Cleo Code",
            url: "https://cleo.co",
          },
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
          security: [{ bearerAuth: [] }],
          documentationUrl: "https://docs.example.com/agent",
          iconUrl: "https://docs.example.com/icon.png",
        },
      });

      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.body.provider.organization).toBe("Cleo Code");
      expect(response.body.securitySchemes.bearerAuth.type).toBe("http");
      expect(response.body.documentationUrl).toBe("https://docs.example.com/agent");
      expect(response.body.iconUrl).toBe("https://docs.example.com/icon.png");
    });

    it("should include ETag header", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.headers.etag).toBeDefined();
      expect(response.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
    });

    it("should include Cache-Control header", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    });

    it("should return 304 Not Modified when ETag matches", async () => {
      const app = createApp(validConfig);

      const firstResponse = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      const etag = firstResponse.headers.etag;

      await request(app)
        .get("/.well-known/agent-card.json")
        .set("If-None-Match", etag || "")
        .expect(304);
    });

    it("should use custom schema URL", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        schemaUrl: "https://custom.example.com/schema.json",
      };

      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.body.$schema).toBe("https://custom.example.com/schema.json");
    });

    it("should use custom cache duration", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        cacheMaxAge: 7200,
      };

      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.headers["cache-control"]).toBe("public, max-age=7200");
    });
  });

  describe("HEAD /.well-known/agent-card.json", () => {
    it("should return 200 with headers but no body", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .head("/.well-known/agent-card.json")
        .expect(200);

      expect(response.body).toEqual({});
      expect(response.headers["content-type"]).toBeDefined();
      expect(response.headers.etag).toBeDefined();
    });

    it("should return Content-Length matching GET response", async () => {
      const app = createApp(validConfig);

      const getResponse = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      const headResponse = await request(app)
        .head("/.well-known/agent-card.json")
        .expect(200);

      const getBodyLength = Buffer.byteLength(getResponse.text);
      const headContentLength = parseInt(headResponse.headers["content-length"] || "0");

      expect(headContentLength).toBe(getBodyLength);
    });

    it("should return same ETag as GET request", async () => {
      const app = createApp(validConfig);

      const getResponse = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      const headResponse = await request(app)
        .head("/.well-known/agent-card.json")
        .expect(200);

      expect(headResponse.headers.etag).toBe(getResponse.headers.etag);
    });
  });

  describe("Error handling", () => {
    it("should reject configuration without 'agent'", () => {
      expect(() => {
        discoveryMiddleware({} as DiscoveryConfig);
      }).toThrow(/agent/);
    });

    it("should return 405 for unsupported methods", async () => {
      const app = createApp(validConfig);

      await request(app).post("/.well-known/agent-card.json").expect(405);
      await request(app).put("/.well-known/agent-card.json").expect(405);
      await request(app).delete("/.well-known/agent-card.json").expect(405);
    });
  });

  describe("Middleware options", () => {
    it("should allow custom path", async () => {
      const app = express();
      app.use(discoveryMiddleware(validConfig, { path: "/custom/discovery" }));

      await request(app).get("/custom/discovery").expect(200);
      await request(app).get("/.well-known/agent-card.json").expect(404);
    });

    it("should allow disabling HEAD requests", async () => {
      const app = express();
      app.use(discoveryMiddleware(validConfig, { enableHead: false }));

      await request(app).head("/.well-known/agent-card.json").expect(405);
    });

    it("should allow disabling ETag", async () => {
      const app = express();
      app.disable("etag");
      app.use(discoveryMiddleware(validConfig, { enableEtag: false }));

      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.headers.etag).toBeUndefined();
    });
  });
});

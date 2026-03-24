/**
 * Tests for LAFS Discovery Middleware
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { discoveryMiddleware, DiscoveryConfig, Capability } from "../src/discovery.js";
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

// Load discovery schema for validation
const schemaPath = join(__dirname, "..", "schemas", "v1", "discovery.schema.json");
const discoverySchema = JSON.parse(readFileSync(schemaPath, "utf-8"));
const agentCardSchemaPath = join(__dirname, "..", "schemas", "v1", "agent-card.schema.json");
const agentCardSchema = JSON.parse(readFileSync(agentCardSchemaPath, "utf-8"));

// Initialize AJV validator
const ajv = new AjvCtor({ strict: true, allErrors: true });
addFormats(ajv);
const validateDiscovery = ajv.compile(discoverySchema);
const validateAgentCard = ajv.compile(agentCardSchema);

/**
 * Helper to create Express app with discovery middleware
 */
function createApp(config: DiscoveryConfig) {
  const app = express();
  app.use(discoveryMiddleware(config));
  app.use(express.json());
  return app;
}

/**
 * Valid test configuration
 */
const validConfig: DiscoveryConfig = {
  service: {
    name: "test-service",
    version: "1.0.0",
    description: "Test LAFS service"
  },
  capabilities: [
    {
      name: "envelope-processor",
      version: "1.0.0",
      description: "Process LAFS envelopes",
      operations: ["process", "validate"]
    },
    {
      name: "context-ledger",
      version: "1.0.0",
      operations: ["read", "write"],
      optional: true
    }
  ],
  endpoints: {
    envelope: "/api/v1/envelope",
    context: "/api/v1/context",
    discovery: "https://example.com/.well-known/lafs.json"
  },
  cacheMaxAge: 3600,
  lafsVersion: "1.0.0"
};

const validAgentConfig: DiscoveryConfig = {
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
    it("should return A2A agent card as primary discovery document", async () => {
      const app = createApp(validAgentConfig);
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

    it("should not include legacy deprecation headers on primary path", async () => {
      const app = createApp(validAgentConfig);
      const response = await request(app)
        .get("/.well-known/agent-card.json")
        .expect(200);

      expect(response.headers.deprecation).toBeUndefined();
      expect(response.headers.sunset).toBeUndefined();
    });

    it("should validate against agent-card schema", async () => {
      const app = createApp(validAgentConfig);
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
          ...validAgentConfig.agent!,
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
  });

  describe("GET /.well-known/lafs.json", () => {
    it("should return valid JSON", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200)
        .expect("Content-Type", /json/);
      
      expect(response.body).toBeDefined();
      expect(typeof response.body).toBe("object");
    });

    it("should include all required fields", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.$schema).toBeDefined();
      expect(response.body.lafs_version).toBeDefined();
      expect(response.body.service).toBeDefined();
      expect(response.body.capabilities).toBeDefined();
      expect(response.body.endpoints).toBeDefined();
    });

    it("should validate against discovery.schema.json", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      const valid = validateDiscovery(response.body);
      
      if (!valid) {
        console.error("Validation errors:", validateDiscovery.errors);
      }
      
      expect(valid).toBe(true);
    });

    it("should include ETag header", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.headers.etag).toBeDefined();
      expect(response.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
    });

    it("should include Cache-Control header", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.headers["cache-control"]).toBeDefined();
      expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    });

    it("should return 304 Not Modified when ETag matches", async () => {
      const app = createApp(validConfig);
      
      // First request to get ETag
      const firstResponse = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      const etag = firstResponse.headers.etag;
      
      // Second request with If-None-Match
      await request(app)
        .get("/.well-known/lafs.json")
        .set("If-None-Match", etag || "")
        .expect(304);
    });

    it("should construct absolute URLs from relative paths", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        baseUrl: "https://api.example.com"
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.endpoints.envelope).toMatch(/^https:\/\//);
      expect(response.body.endpoints.context).toMatch(/^https:\/\//);
      expect(response.body.endpoints.discovery).toMatch(/^https:\/\//);
    });

    it("should preserve absolute URLs as-is", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        endpoints: {
          envelope: "https://custom.example.com/envelope",
          context: "https://custom.example.com/context",
          discovery: "https://custom.example.com/.well-known/lafs.json"
        }
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.endpoints.envelope).toBe("https://custom.example.com/envelope");
      expect(response.body.endpoints.context).toBe("https://custom.example.com/context");
    });

    it("should use custom schema URL", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        schemaUrl: "https://custom.example.com/schema.json"
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.$schema).toBe("https://custom.example.com/schema.json");
    });

    it("should use custom LAFS version", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        lafsVersion: "2.0.0"
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.lafs_version).toBe("2.0.0");
    });

    it("should use custom cache duration", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        cacheMaxAge: 7200
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.headers["cache-control"]).toBe("public, max-age=7200");
    });
  });

  describe("HEAD /.well-known/lafs.json", () => {
    it("should return 200 with headers but no body", async () => {
      const app = createApp(validConfig);
      const response = await request(app)
        .head("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body).toEqual({});
      expect(response.headers["content-type"]).toBeDefined();
      expect(response.headers.etag).toBeDefined();
    });

    it("should return Content-Length matching GET response", async () => {
      const app = createApp(validConfig);

      const getResponse = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);

      const headResponse = await request(app)
        .head("/.well-known/lafs.json")
        .expect(200);

      // Compare against actual response body length (raw text, not re-serialized)
      const getBodyLength = Buffer.byteLength(getResponse.text);
      const headContentLength = parseInt(headResponse.headers["content-length"] || "0");

      expect(headContentLength).toBe(getBodyLength);
    });

    it("should return same ETag as GET request", async () => {
      const app = createApp(validConfig);
      
      const getResponse = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      const headResponse = await request(app)
        .head("/.well-known/lafs.json")
        .expect(200);
      
      expect(headResponse.headers.etag).toBe(getResponse.headers.etag);
    });
  });

  describe("Error handling", () => {
    it("should reject invalid configuration (missing service.name)", () => {
      const invalidConfig = {
        ...validConfig,
        service: {
          ...validConfig.service,
          name: ""
        }
      };
      
      expect(() => {
        discoveryMiddleware(invalidConfig as DiscoveryConfig);
      }).toThrow();
    });

    it("should reject invalid configuration (missing service.version)", () => {
      const invalidConfig = {
        ...validConfig,
        service: {
          ...validConfig.service,
          version: ""
        }
      };

      expect(() => {
        discoveryMiddleware(invalidConfig as DiscoveryConfig);
      }).toThrow();
    });

    it("should reject invalid configuration (missing capabilities)", () => {
      const invalidConfig = {
        ...validConfig,
        capabilities: undefined as unknown as Capability[]
      };
      
      expect(() => {
        discoveryMiddleware(invalidConfig);
      }).toThrow();
    });

    it("should reject invalid configuration (missing endpoints.envelope)", () => {
      const invalidConfig = {
        ...validConfig,
        endpoints: {
          context: "/api/v1/context",
          discovery: "https://example.com/.well-known/lafs.json"
        }
      };
      
      expect(() => {
        discoveryMiddleware(invalidConfig as DiscoveryConfig);
      }).toThrow();
    });

    it("should return 405 for unsupported methods", async () => {
      const app = createApp(validConfig);
      
      await request(app)
        .post("/.well-known/lafs.json")
        .expect(405);
      
      await request(app)
        .put("/.well-known/lafs.json")
        .expect(405);
      
      await request(app)
        .delete("/.well-known/lafs.json")
        .expect(405);
    });
  });

  describe("Middleware options", () => {
    it("should allow custom path", async () => {
      const app = express();
      app.use(discoveryMiddleware(validConfig, { path: "/custom/discovery" }));
      
      // Should work on custom path
      await request(app)
        .get("/custom/discovery")
        .expect(200);
      
      // Should not work on default path
      await request(app)
        .get("/.well-known/lafs.json")
        .expect(404);
    });

    it("should allow disabling HEAD requests", async () => {
      const app = express();
      app.use(discoveryMiddleware(validConfig, { enableHead: false }));
      
      await request(app)
        .head("/.well-known/lafs.json")
        .expect(405);
    });

    it("should allow disabling ETag", async () => {
      const app = express();
      // Disable Express's default ETag
      app.disable("etag");
      app.use(discoveryMiddleware(validConfig, { enableEtag: false }));
      
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.headers.etag).toBeUndefined();
    });
  });

  describe("Edge cases", () => {
    it("should handle empty capabilities array (should fail validation)", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        capabilities: []
      };
      
      const app = createApp(config);
      
      // Should still work but fail schema validation (minItems: 1)
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      // Schema validation should fail for empty capabilities
      const valid = validateDiscovery(response.body);
      expect(valid).toBe(false);
    });

    it("should handle service without description", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        service: {
          name: "minimal-service",
          version: "1.0.0"
        }
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.service.name).toBe("minimal-service");
      expect(response.body.service.description).toBeUndefined();
    });

    it("should handle capability without description and optional flag", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        capabilities: [
          {
            name: "minimal-capability",
            version: "1.0.0",
            operations: ["op1"]
          }
        ]
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      const cap = response.body.capabilities[0];
      expect(cap.name).toBe("minimal-capability");
      expect(cap.description).toBeUndefined();
      expect(cap.optional).toBeUndefined();
    });

    it("should handle endpoints without context", async () => {
      const config: DiscoveryConfig = {
        ...validConfig,
        endpoints: {
          envelope: "/api/v1/envelope",
          discovery: "https://example.com/.well-known/lafs.json"
        }
      };
      
      const app = createApp(config);
      const response = await request(app)
        .get("/.well-known/lafs.json")
        .expect(200);
      
      expect(response.body.endpoints.envelope).toBeDefined();
      expect(response.body.endpoints.context).toBeUndefined();
      expect(response.body.endpoints.discovery).toBeDefined();
      
      // Validate against schema (context is optional)
      const valid = validateDiscovery(response.body);
      expect(valid).toBe(true);
    });
  });
});

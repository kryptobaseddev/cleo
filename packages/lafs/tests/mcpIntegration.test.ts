import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPResult } from "../src/mcpAdapter.js";
import { validateEnvelope } from "../src/validateEnvelope.js";
import type { LAFSEnvelope } from "../src/types.js";

// Test server setup
async function createTestServer() {
  const server = new Server(
    {
      name: "lafs-mcp-test-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Simulated database
  const simulatedDatabase = new Map([
    ["1", { id: "1", name: "Product A", value: 100, metadata: { category: "electronics" } }],
    ["2", { id: "2", name: "Product B", value: 200, metadata: { category: "clothing" } }],
    ["3", { id: "3", name: "Product C", value: 300, metadata: { category: "food" } }],
  ]);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "weather",
        description: "Get current weather for a location",
        inputSchema: {
          type: "object" as const,
          properties: {
            location: { type: "string" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] },
            _budget: { type: "number", minimum: 10, maximum: 10000 },
          },
          required: ["location"],
        },
      },
      {
        name: "calculator",
        description: "Perform mathematical calculations",
        inputSchema: {
          type: "object" as const,
          properties: {
            operation: { type: "string", enum: ["add", "subtract", "multiply", "divide", "sqrt"] },
            a: { type: "number" },
            b: { type: "number" },
            _budget: { type: "number", minimum: 10, maximum: 1000 },
          },
          required: ["operation", "a"],
        },
      },
      {
        name: "database_query",
        description: "Query the simulated database",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["get", "list", "search"] },
            id: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
            _budget: { type: "number", minimum: 10, maximum: 5000 },
          },
          required: ["action"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;
    const budget = typeof args?._budget === "number" ? args._budget : undefined;

    try {
      let result: Record<string, unknown>;

      switch (name) {
        case "weather": {
          const location = String(args?.location ?? "Unknown");
          const units = String(args?.units ?? "celsius");
          result = {
            location,
            temperature: units === "fahrenheit" ? 72 : 22,
            temperatureUnit: units,
            conditions: "sunny",
            humidity: 45,
            windSpeed: 10,
            windUnit: "km/h",
            forecast: [
              { day: "Today", high: 24, low: 18, condition: "sunny" },
              { day: "Tomorrow", high: 25, low: 19, condition: "partly cloudy" },
            ],
          };
          break;
        }

        case "calculator": {
          const operation = String(args?.operation);
          const a = Number(args?.a);
          const b = args?.b !== undefined ? Number(args?.b) : undefined;

          let calcResult: number;
          switch (operation) {
            case "add":
              if (b === undefined) throw new Error("Second operand required");
              calcResult = a + b;
              break;
            case "subtract":
              if (b === undefined) throw new Error("Second operand required");
              calcResult = a - b;
              break;
            case "multiply":
              if (b === undefined) throw new Error("Second operand required");
              calcResult = a * b;
              break;
            case "divide":
              if (b === undefined) throw new Error("Second operand required");
              if (b === 0) throw new Error("Cannot divide by zero");
              calcResult = a / b;
              break;
            case "sqrt":
              if (a < 0) throw new Error("Cannot calculate square root of negative number");
              calcResult = Math.sqrt(a);
              break;
            default:
              throw new Error(`Unknown operation: ${operation}`);
          }

          result = {
            operation,
            operands: { a, b },
            result: calcResult,
          };
          break;
        }

        case "database_query": {
          const action = String(args?.action);

          switch (action) {
            case "get": {
              const id = String(args?.id);
              const record = simulatedDatabase.get(id);
              if (!record) throw new Error(`Record ${id} not found`);
              result = { action, record, found: true };
              break;
            }
            case "list": {
              const records = Array.from(simulatedDatabase.values());
              result = { action, records, count: records.length };
              break;
            }
            case "search": {
              const query = String(args?.query ?? "").toLowerCase();
              const records = Array.from(simulatedDatabase.values()).filter((r) =>
                r.name.toLowerCase().includes(query)
              );
              result = { action, query, records, count: records.length };
              break;
            }
            default:
              throw new Error(`Unknown action: ${action}`);
          }
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const mcpResult: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };

      const envelope = wrapMCPResult(mcpResult, `tools/${name}`, budget);

      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const mcpResult: CallToolResult = {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };

      const envelope = wrapMCPResult(mcpResult, `tools/${name}`, budget);

      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: true,
      };
    }
  });

  return server;
}

// Test helper to extract envelope from MCP response
function extractEnvelope(result: unknown): LAFSEnvelope {
  const typedResult = result as { content: Array<{ type: string; text?: string }> };
  const textContent = typedResult.content.find((c) => c.type === "text");
  if (!textContent?.text) {
    throw new Error("No text content in response");
  }
  return JSON.parse(textContent.text) as LAFSEnvelope;
}

describe("MCP-LAFS Integration", () => {
  let client: Client;
  let server: Server;

  beforeAll(async () => {
    server = await createTestServer();
    client = new Client(
      {
        name: "lafs-mcp-test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  describe("Tool Discovery", () => {
    it("should list all available tools", async () => {
      const response = await client.listTools();
      expect(response.tools).toHaveLength(3);
      expect(response.tools.map((t) => t.name)).toContain("weather");
      expect(response.tools.map((t) => t.name)).toContain("calculator");
      expect(response.tools.map((t) => t.name)).toContain("database_query");
    });
  });

  describe("LAFS Envelope Validation", () => {
    it("should return valid LAFS envelope for weather tool", async () => {
      const result = await client.callTool({
        name: "weather",
        arguments: { location: "San Francisco", units: "celsius" },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(true);
      expect(envelope._meta.operation).toBe("tools/weather");
      expect(envelope.result).toHaveProperty("location", "San Francisco");
      expect(envelope.result).toHaveProperty("temperature");
      expect(envelope.result).toHaveProperty("conditions");
    });

    it("should return valid LAFS envelope for calculator tool", async () => {
      const result = await client.callTool({
        name: "calculator",
        arguments: { operation: "add", a: 5, b: 3 },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(true);
      expect(envelope.result).toHaveProperty("result", 8);
    });

    it("should return valid LAFS envelope for database query", async () => {
      const result = await client.callTool({
        name: "database_query",
        arguments: { action: "list" },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(true);
      expect(envelope.result).toHaveProperty("count", 3);
      expect(envelope.result).toHaveProperty("records");
      expect(Array.isArray((envelope.result as { records?: unknown })?.records)).toBe(true);
    });
  });

  describe("Budget Enforcement", () => {
    it("should include token estimate when budget is provided", async () => {
      const result = await client.callTool({
        name: "weather",
        arguments: {
          location: "San Francisco",
          _budget: 100,
        },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope._extensions).toBeDefined();
      expect(envelope._extensions?.["x-mcp-token-estimate"]).toBeDefined();
      const tokenEstimate = envelope._extensions?.["x-mcp-token-estimate"] as { estimated: number; truncated?: boolean };
      expect(tokenEstimate.estimated).toBeGreaterThan(0);
    });

    it("should enforce budget by truncating large responses", async () => {
      // Request with very small budget
      const result = await client.callTool({
        name: "database_query",
        arguments: {
          action: "list",
          _budget: 20, // Very small budget
        },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope._extensions).toBeDefined();
      const tokenEstimate = envelope._extensions?.["x-mcp-token-estimate"] as { estimated: number; truncated?: boolean };
      expect(tokenEstimate?.truncated).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should return valid LAFS error envelope for division by zero", async () => {
      const result = await client.callTool({
        name: "calculator",
        arguments: { operation: "divide", a: 10, b: 0 },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(false);
      expect(envelope.result).toBeNull();
      expect(envelope.error).toBeDefined();
      expect(envelope.error?.code).toMatch(/^E_/);
      expect(envelope.error?.category).toBeDefined();
      expect(envelope.error?.retryable).toBe(false);
    });

    it("should return valid LAFS error envelope for not found", async () => {
      const result = await client.callTool({
        name: "database_query",
        arguments: { action: "get", id: "nonexistent" },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(false);
      expect(envelope.error?.category).toBe("NOT_FOUND");
    });

    it("should return valid LAFS error envelope for validation errors", async () => {
      const result = await client.callTool({
        name: "calculator",
        arguments: { operation: "sqrt", a: -1 },
      });

      const envelope = extractEnvelope(result);
      const validation = validateEnvelope(envelope);

      expect(validation.valid).toBe(true);
      expect(envelope.success).toBe(false);
      expect(envelope.error?.message).toContain("square root");
    });

    it("should include retryable flag in error responses", async () => {
      // This tests that errors have proper retryable categorization
      const result = await client.callTool({
        name: "database_query",
        arguments: { action: "get", id: "999" },
      });

      const envelope = extractEnvelope(result);
      
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(typeof envelope.error?.retryable).toBe("boolean");
    });
  });

  describe("Envelope Schema Compliance", () => {
    it("should have all required LAFS envelope fields", async () => {
      const result = await client.callTool({
        name: "weather",
        arguments: { location: "Tokyo" },
      });

      const envelope = extractEnvelope(result);

      // Required fields
      expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(envelope._meta).toBeDefined();
      expect(envelope._meta.specVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(envelope._meta.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(envelope._meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(envelope._meta.operation).toBe("tools/weather");
      expect(envelope._meta.requestId).toBeDefined();
      expect(envelope._meta.transport).toBe("sdk");
      expect(typeof envelope._meta.strict).toBe("boolean");
      expect(["minimal", "standard", "full", "custom"]).toContain(envelope._meta.mvi);
      expect(typeof envelope._meta.contextVersion).toBe("number");
      expect(typeof envelope.success).toBe("boolean");
      expect(envelope.result).toBeDefined();
    });

    it("should properly handle success/error relationship", async () => {
      // Success case
      const successResult = await client.callTool({
        name: "calculator",
        arguments: { operation: "add", a: 1, b: 1 },
      });
      const successEnvelope = extractEnvelope(successResult);
      
      expect(successEnvelope.success).toBe(true);
      expect(successEnvelope.error === null || successEnvelope.error === undefined).toBe(true);
      expect(successEnvelope.result).not.toBeNull();

      // Error case
      const errorResult = await client.callTool({
        name: "calculator",
        arguments: { operation: "divide", a: 1, b: 0 },
      });
      const errorEnvelope = extractEnvelope(errorResult);
      
      expect(errorEnvelope.success).toBe(false);
      expect(errorEnvelope.error).toBeDefined();
      expect(errorEnvelope.result).toBeNull();
    });
  });

  describe("Adapter Functions", () => {
    it("should wrap MCP result correctly", () => {
      const mcpResult: CallToolResult = {
        content: [{ type: "text", text: '{"value": 42}' }],
        isError: false,
      };

      const envelope = wrapMCPResult(mcpResult, "test/operation");

      expect(envelope.success).toBe(true);
      expect(envelope.result).toEqual({ value: 42 });
      expect(envelope._meta.operation).toBe("test/operation");
    });

    it("should wrap MCP error correctly", () => {
      const mcpResult: CallToolResult = {
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      };

      const envelope = wrapMCPResult(mcpResult, "test/operation");

      expect(envelope.success).toBe(false);
      expect(envelope.result).toBeNull();
      expect(envelope.error).toBeDefined();
      expect(envelope.error?.message).toBe("Something went wrong");
    });
  });
});

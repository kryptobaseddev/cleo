/**
 * LAFS Discovery Example Server
 * 
 * Run with: npx tsx examples/discovery-server.ts
 * Or: npm run build && node dist/examples/discovery-server.js
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { discoveryMiddleware, DiscoveryConfig } from "../src/discovery.js";

const app: Express = express();
const PORT = process.env.PORT || 3000;

/**
 * LAFS-compliant envelope endpoint handler
 * Demonstrates proper LAFS envelope processing
 */
app.post("/api/v1/envelope", express.json(), (req: Request, res: Response) => {
  const envelope = req.body;
  
  // Validate basic envelope structure
  if (!envelope._meta) {
    return res.status(400).json({
      success: false,
      error: {
        code: "INVALID_ENVELOPE",
        message: "Missing _meta field",
        category: "VALIDATION",
        retryable: false,
        retryAfterMs: null,
        details: { missing: ["_meta"] }
      },
      result: null
    });
  }
  
  // Process the request (simplified example)
  const operation = envelope._meta.operation;
  
  // Echo back with success
  return res.json({
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: envelope._meta.specVersion || "1.0.0",
      schemaVersion: envelope._meta.schemaVersion || "1.0.0",
      timestamp: new Date().toISOString(),
      operation: `${operation}:response`,
      requestId: envelope._meta.requestId || crypto.randomUUID(),
      transport: "http",
      strict: envelope._meta.strict ?? true,
      mvi: envelope._meta.mvi || "standard",
      contextVersion: (envelope._meta.contextVersion || 0) + 1
    },
    success: true,
    result: {
      received: true,
      operation: operation,
      data: envelope.payload || null
    },
    error: null
  });
});

/**
 * Context ledger endpoint
 * Demonstrates context management capability
 */
app.get("/api/v1/context/:ledgerId", (req: Request, res: Response) => {
  const ledgerId = req.params.ledgerId;
  
  // Return mock context ledger
  res.json({
    $schema: "https://lafs.dev/schemas/v1/context-ledger.schema.json",
    ledgerId,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: [],
    checksum: "sha256:mock",
    maxEntries: 1000
  });
});

app.post("/api/v1/context/:ledgerId/entries", express.json(), (req: Request, res: Response) => {
  const ledgerId = req.params.ledgerId;
  const entry = req.body;
  
  res.json({
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      operation: "context:append",
      requestId: crypto.randomUUID(),
      transport: "http",
      strict: true,
      mvi: "standard",
      contextVersion: 2
    },
    success: true,
    result: {
      ledgerId,
      entryId: crypto.randomUUID(),
      committed: true,
      timestamp: new Date().toISOString()
    },
    error: null
  });
});

/**
 * Discovery configuration (A2A v1.0 Agent Card)
 */
const discoveryConfig: DiscoveryConfig = {
  agent: {
    name: "example-lafs-agent",
    description: "Example LAFS-compliant agent demonstrating A2A discovery",
    version: "1.0.0",
    url: "/api/v1/envelope",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "envelope-processor",
        name: "Envelope Processor",
        description: "Process and validate LAFS envelopes",
        tags: ["process", "validate", "transform"],
      },
      {
        id: "context-ledger",
        name: "Context Ledger",
        description: "Manage context ledgers for stateful operations",
        tags: ["read", "append", "query"],
      },
    ],
  },
  cacheMaxAge: 3600,
};

// Mount discovery middleware BEFORE other routes
// Serves /.well-known/agent-card.json per A2A v1.0 (RFC 8615)
app.use(discoveryMiddleware(discoveryConfig));

/**
 * Health check endpoint
 */
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: discoveryConfig.agent.name,
    version: discoveryConfig.agent.version,
    timestamp: new Date().toISOString()
  });
});

/**
 * Error handling middleware
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: err.message || "Internal server error",
      category: "INTERNAL",
      retryable: false,
      retryAfterMs: null,
      details: process.env.NODE_ENV === "development" ? { stack: err.stack } : {}
    },
    result: null
  });
});

/**
 * Start server
 */
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     LAFS Discovery Server Running                          ║
╠════════════════════════════════════════════════════════════╣
║  Agent:      ${discoveryConfig.agent.name.padEnd(45)}║
║  Version:    ${discoveryConfig.agent.version.padEnd(45)}║
║  Port:       ${String(PORT).padEnd(45)}║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    GET  /.well-known/agent-card.json  (A2A Agent Card)     ║
║    POST /api/v1/envelope              (Envelope processor) ║
║    GET  /api/v1/context/:id           (Context ledger)     ║
║    GET  /health                       (Health check)       ║
╚════════════════════════════════════════════════════════════╝

Test with:
  curl http://localhost:${PORT}/.well-known/agent-card.json | jq
  curl http://localhost:${PORT}/health | jq
  curl -X POST http://localhost:${PORT}/api/v1/envelope \
    -H "Content-Type: application/json" \
    -d '{"_meta":{"operation":"test","requestId":"123"},"payload":{"hello":"world"}}'
`);
});

/**
 * Graceful shutdown
 */
process.on("SIGTERM", () => {
  console.log("\nShutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\nShutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export default app;

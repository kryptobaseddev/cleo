/**
 * LAFS Discovery Example Server
 *
 * Run with: npx tsx examples/discovery-server.ts
 * Or: npm run build && node dist/examples/discovery-server.js
 */
import express from "express";
import { discoveryMiddleware } from "../src/discovery.js";
const app = express();
const PORT = process.env.PORT || 3000;
/**
 * LAFS-compliant envelope endpoint handler
 * Demonstrates proper LAFS envelope processing
 */
app.post("/api/v1/envelope", express.json(), (req, res) => {
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
    res.json({
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
app.get("/api/v1/context/:ledgerId", (req, res) => {
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
app.post("/api/v1/context/:ledgerId/entries", express.json(), (req, res) => {
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
 * Discovery configuration
 * Advertises all LAFS capabilities and endpoints
 */
const discoveryConfig = {
    service: {
        name: "example-lafs-service",
        version: "1.0.0",
        description: "Example LAFS-compliant API service demonstrating discovery protocol"
    },
    capabilities: [
        {
            name: "envelope-processor",
            version: "1.0.0",
            description: "Process and validate LAFS envelopes",
            operations: ["process", "validate", "transform"]
        },
        {
            name: "context-ledger",
            version: "1.0.0",
            description: "Manage context ledgers for stateful operations",
            operations: ["read", "append", "query"]
        },
        {
            name: "pagination-provider",
            version: "1.0.0",
            description: "Provide cursor and offset pagination for list endpoints",
            operations: ["cursor", "offset", "none"],
            optional: true
        }
    ],
    endpoints: {
        envelope: "/api/v1/envelope",
        context: "/api/v1/context",
        discovery: "https://lafs.dev/schemas/v1/discovery.schema.json"
    },
    cacheMaxAge: 3600,
    lafsVersion: "1.0.0"
};
// Mount discovery middleware BEFORE other routes
// This ensures /.well-known/lafs.json is served at the root
app.use(discoveryMiddleware(discoveryConfig));
/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        service: discoveryConfig.service?.name ?? discoveryConfig.agent?.name,
        version: discoveryConfig.service?.version ?? discoveryConfig.agent?.version,
        timestamp: new Date().toISOString()
    });
});
/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
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
╔════════════════════════════════════════════════════════╗
║     LAFS Discovery Server Running                      ║
╠════════════════════════════════════════════════════════╣
║  Service:    ${(discoveryConfig.service?.name ?? discoveryConfig.agent?.name ?? 'unknown').padEnd(43)}║
║  Version:    ${(discoveryConfig.service?.version ?? discoveryConfig.agent?.version ?? 'unknown').padEnd(43)}║
║  Port:       ${String(PORT).padEnd(43)}║
╠════════════════════════════════════════════════════════╣
║  Endpoints:                                            ║
║    GET  /.well-known/lafs.json  (Discovery document)   ║
║    POST /api/v1/envelope        (Envelope processor)   ║
║    GET  /api/v1/context/:id     (Context ledger)       ║
║    GET  /health                 (Health check)         ║
╚════════════════════════════════════════════════════════╝

Test with:
  curl http://localhost:${PORT}/.well-known/lafs.json | jq
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
//# sourceMappingURL=discovery-server.js.map
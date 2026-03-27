#!/usr/bin/env node
/**
 * MCP-LAFS Client Example
 *
 * A client that connects to the MCP-LAFS server and validates responses
 * are LAFS-compliant. Demonstrates budget negotiation and envelope validation.
 *
 * Usage: npx ts-node examples/mcp-lafs-client.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPResult } from "../src/mcpAdapter.js";
import { validateEnvelope } from "../src/validateEnvelope.js";
// Colors for console output
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
};
function logSuccess(message) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
}
function logError(message) {
    console.log(`${colors.red}✗${colors.reset} ${message}`);
}
function logInfo(message) {
    console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
}
function logHeader(message) {
    console.log(`\n${colors.cyan}${message}${colors.reset}`);
    console.log("=".repeat(message.length));
}
// Embedded server setup for in-memory testing
// In production, this would connect to an external server process
async function createEmbeddedServer() {
    const server = new Server({
        name: "lafs-mcp-server-embedded",
        version: "1.0.0",
    }, {
        capabilities: {
            tools: {},
        },
    });
    // Simulated database
    const simulatedDatabase = new Map([
        ["1", { id: "1", name: "Product A", value: 100 }],
        ["2", { id: "2", name: "Product B", value: 200 }],
        ["3", { id: "3", name: "Product C", value: 300 }],
    ]);
    // Tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "weather",
                description: "Get current weather for a location",
                inputSchema: {
                    type: "object",
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
                    type: "object",
                    properties: {
                        operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
                        a: { type: "number" },
                        b: { type: "number" },
                        _budget: { type: "number", minimum: 10, maximum: 1000 },
                    },
                    required: ["operation", "a", "b"],
                },
            },
            {
                name: "database_query",
                description: "Query the simulated database",
                inputSchema: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["get", "list", "search"] },
                        id: { type: "string" },
                        query: { type: "string" },
                        _budget: { type: "number", minimum: 10, maximum: 5000 },
                    },
                    required: ["action"],
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const budget = typeof args?._budget === "number" ? args._budget : undefined;
        try {
            let result;
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
                        forecast: [
                            { day: "Today", high: 24, low: 18, condition: "sunny" },
                            { day: "Tomorrow", high: 25, low: 19, condition: "partly cloudy" },
                            { day: "Day after", high: 23, low: 17, condition: "clear" },
                        ],
                    };
                    break;
                }
                case "calculator": {
                    const operation = String(args?.operation);
                    const a = Number(args?.a);
                    const b = Number(args?.b);
                    let calcResult;
                    switch (operation) {
                        case "add":
                            calcResult = a + b;
                            break;
                        case "subtract":
                            calcResult = a - b;
                            break;
                        case "multiply":
                            calcResult = a * b;
                            break;
                        case "divide":
                            if (b === 0)
                                throw new Error("Cannot divide by zero");
                            calcResult = a / b;
                            break;
                        default: throw new Error(`Unknown operation: ${operation}`);
                    }
                    result = {
                        operation,
                        expression: `${a} ${operation} ${b}`,
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
                            if (!record)
                                throw new Error(`Record ${id} not found`);
                            result = { action, record, found: true };
                            break;
                        }
                        case "list": {
                            const records = Array.from(simulatedDatabase.values());
                            result = { action, records, count: records.length, total: records.length };
                            break;
                        }
                        case "search": {
                            const query = String(args?.query ?? "").toLowerCase();
                            const records = Array.from(simulatedDatabase.values()).filter((r) => r.name.toLowerCase().includes(query));
                            result = { action, query, records, count: records.length, total: simulatedDatabase.size };
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
            const mcpResult = {
                content: [{ type: "text", text: JSON.stringify(result) }],
                isError: false,
            };
            const envelope = wrapMCPResult(mcpResult, `tools/${name}`, budget);
            return {
                content: [{ type: "text", text: JSON.stringify(envelope) }],
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const mcpResult = {
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
// Client class that connects and validates LAFS responses
class LAFSMCPClient {
    client;
    validations = [];
    constructor() {
        this.client = new Client({
            name: "lafs-mcp-client",
            version: "1.0.0",
        }, {
            capabilities: {},
        });
    }
    async connect(server) {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            this.client.connect(clientTransport),
            server.connect(serverTransport),
        ]);
    }
    async listTools() {
        const response = await this.client.listTools();
        return response.tools.map((t) => t.name);
    }
    async callTool(name, args) {
        const result = await this.client.callTool({
            name,
            arguments: args,
        });
        // Extract LAFS envelope from MCP response
        const content = result.content;
        const textContent = content.find((c) => c.type === "text");
        if (!textContent || !("text" in textContent) || !textContent.text) {
            throw new Error("No text content in MCP response");
        }
        const envelope = JSON.parse(textContent.text);
        // Validate against LAFS schema
        const validation = validateEnvelope(envelope);
        this.validations.push({
            tool: name,
            valid: validation.valid,
            errors: validation.errors,
        });
        return { envelope, validation };
    }
    getValidationSummary() {
        return {
            total: this.validations.length,
            passed: this.validations.filter((v) => v.valid).length,
            failed: this.validations.filter((v) => !v.valid).length,
        };
    }
    printValidationReport() {
        console.log("\n" + "=".repeat(60));
        console.log("LAFS VALIDATION REPORT");
        console.log("=".repeat(60));
        for (const validation of this.validations) {
            if (validation.valid) {
                logSuccess(`${validation.tool}: Valid LAFS envelope`);
            }
            else {
                logError(`${validation.tool}: Invalid LAFS envelope`);
                for (const error of validation.errors) {
                    console.log(`  - ${error}`);
                }
            }
        }
        const summary = this.getValidationSummary();
        console.log("\n" + "-".repeat(60));
        console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`);
        console.log("=".repeat(60));
    }
}
// Main demonstration
async function main() {
    logHeader("LAFS-MCP Integration Demo");
    logInfo("Starting embedded MCP server with LAFS envelope wrapping...");
    // Create and start embedded server
    const server = await createEmbeddedServer();
    const client = new LAFSMCPClient();
    await client.connect(server);
    logSuccess("Connected to MCP server\n");
    // List available tools
    logHeader("Available Tools");
    const tools = await client.listTools();
    for (const tool of tools) {
        console.log(`  • ${tool}`);
    }
    // Test 1: Weather tool
    logHeader("Test 1: Weather Tool (Standard)");
    try {
        const { envelope, validation } = await client.callTool("weather", {
            location: "San Francisco",
            units: "celsius",
        });
        if (validation.valid) {
            logSuccess("Response is valid LAFS envelope");
            console.log("\nResponse Metadata:");
            console.log(`  Spec Version: ${envelope._meta.specVersion}`);
            console.log(`  Operation: ${envelope._meta.operation}`);
            console.log(`  Success: ${envelope.success}`);
            console.log(`  Timestamp: ${envelope._meta.timestamp}`);
            console.log("\nResult:");
            console.log(JSON.stringify(envelope.result, null, 2));
        }
        else {
            logError("Response failed LAFS validation");
            validation.errors.forEach((e) => console.log(`  - ${e}`));
        }
    }
    catch (error) {
        logError(`Test failed: ${error instanceof Error ? error.message : error}`);
    }
    // Test 2: Calculator with budget
    logHeader("Test 2: Calculator Tool (With Budget)");
    try {
        const { envelope, validation } = await client.callTool("calculator", {
            operation: "multiply",
            a: 42,
            b: 100,
            _budget: 50,
        });
        if (validation.valid) {
            logSuccess("Response is valid LAFS envelope");
            const metaWithBudget = envelope._meta;
            if (metaWithBudget._tokenEstimate) {
                console.log("\nBudget Information:");
                console.log(`  Estimated Tokens: ${metaWithBudget._tokenEstimate.estimated}`);
                console.log(`  Truncated: ${metaWithBudget._tokenEstimate.truncated ?? false}`);
                if (metaWithBudget._tokenEstimate.originalEstimate) {
                    console.log(`  Original Estimate: ${metaWithBudget._tokenEstimate.originalEstimate}`);
                }
            }
            console.log("\nResult:");
            console.log(JSON.stringify(envelope.result, null, 2));
        }
        else {
            logError("Response failed LAFS validation");
            validation.errors.forEach((e) => console.log(`  - ${e}`));
        }
    }
    catch (error) {
        logError(`Test failed: ${error instanceof Error ? error.message : error}`);
    }
    // Test 3: Database query
    logHeader("Test 3: Database Query Tool");
    try {
        const { envelope, validation } = await client.callTool("database_query", {
            action: "list",
        });
        if (validation.valid) {
            logSuccess("Response is valid LAFS envelope");
            console.log("\nResult:");
            console.log(JSON.stringify(envelope.result, null, 2));
        }
        else {
            logError("Response failed LAFS validation");
            validation.errors.forEach((e) => console.log(`  - ${e}`));
        }
    }
    catch (error) {
        logError(`Test failed: ${error instanceof Error ? error.message : error}`);
    }
    // Test 4: Error handling
    logHeader("Test 4: Error Handling (Division by Zero)");
    try {
        const { envelope, validation } = await client.callTool("calculator", {
            operation: "divide",
            a: 10,
            b: 0,
        });
        if (validation.valid) {
            logSuccess("Error response is valid LAFS envelope");
            console.log("\nError Details:");
            console.log(`  Success: ${envelope.success}`);
            console.log(`  Error Code: ${envelope.error?.code}`);
            console.log(`  Category: ${envelope.error?.category}`);
            console.log(`  Retryable: ${envelope.error?.retryable}`);
            console.log(`  Message: ${envelope.error?.message}`);
        }
        else {
            logError("Error response failed LAFS validation");
            validation.errors.forEach((e) => console.log(`  - ${e}`));
        }
    }
    catch (error) {
        logError(`Test failed: ${error instanceof Error ? error.message : error}`);
    }
    // Test 5: Database not found
    logHeader("Test 5: Not Found Error");
    try {
        const { envelope, validation } = await client.callTool("database_query", {
            action: "get",
            id: "999",
        });
        if (validation.valid) {
            logSuccess("Not found error is valid LAFS envelope");
            console.log("\nError Details:");
            console.log(`  Success: ${envelope.success}`);
            console.log(`  Error Code: ${envelope.error?.code}`);
            console.log(`  Category: ${envelope.error?.category}`);
        }
        else {
            logError("Error response failed LAFS validation");
            validation.errors.forEach((e) => console.log(`  - ${e}`));
        }
    }
    catch (error) {
        logError(`Test failed: ${error instanceof Error ? error.message : error}`);
    }
    // Print final validation report
    client.printValidationReport();
    logHeader("Demo Complete");
    logInfo("All MCP tool responses are wrapped in LAFS-compliant envelopes");
    logInfo("This proves LAFS complements MCP by adding structured metadata");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=mcp-lafs-client.js.map
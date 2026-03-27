#!/usr/bin/env node
/**
 * MCP-LAFS Server Example
 *
 * A working MCP server that wraps all tool responses in LAFS-compliant envelopes.
 * Demonstrates how LAFS complements MCP by adding structured metadata and budget enforcement.
 *
 * Usage: npx ts-node examples/mcp-lafs-server.ts
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { wrapMCPResult } from "../src/mcpAdapter.js";
const simulatedDatabase = new Map([
    ["1", { id: "1", name: "Product A", value: 100, createdAt: new Date().toISOString() }],
    ["2", { id: "2", name: "Product B", value: 200, createdAt: new Date().toISOString() }],
    ["3", { id: "3", name: "Product C", value: 300, createdAt: new Date().toISOString() }],
]);
// Tool definitions
const TOOLS = [
    {
        name: "weather",
        description: "Get current weather for a location",
        inputSchema: {
            type: "object",
            properties: {
                location: {
                    type: "string",
                    description: "City name or coordinates",
                },
                units: {
                    type: "string",
                    enum: ["celsius", "fahrenheit"],
                    description: "Temperature units",
                    default: "celsius",
                },
                _budget: {
                    type: "number",
                    description: "Token budget for response (LAFS extension)",
                    minimum: 10,
                    maximum: 10000,
                },
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
                operation: {
                    type: "string",
                    enum: ["add", "subtract", "multiply", "divide", "power", "sqrt"],
                    description: "Mathematical operation to perform",
                },
                a: {
                    type: "number",
                    description: "First operand",
                },
                b: {
                    type: "number",
                    description: "Second operand (not needed for sqrt)",
                },
                _budget: {
                    type: "number",
                    description: "Token budget for response (LAFS extension)",
                    minimum: 10,
                    maximum: 1000,
                },
            },
            required: ["operation", "a"],
        },
    },
    {
        name: "database_query",
        description: "Query the simulated database",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["get", "list", "search"],
                    description: "Query action to perform",
                },
                id: {
                    type: "string",
                    description: "Record ID (for get action)",
                },
                query: {
                    type: "string",
                    description: "Search query (for search action)",
                },
                limit: {
                    type: "number",
                    description: "Maximum results to return",
                    default: 10,
                },
                _budget: {
                    type: "number",
                    description: "Token budget for response (LAFS extension)",
                    minimum: 10,
                    maximum: 5000,
                },
            },
            required: ["action"],
        },
    },
];
// Weather simulation
async function getWeather(location, units) {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Generate deterministic but varied weather based on location
    const hash = location.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const conditions = ["sunny", "cloudy", "rainy", "partly cloudy", "clear"];
    const condition = conditions[hash % conditions.length];
    // Temperature based on condition and some randomness
    let baseTemp = 20; // celsius
    if (condition === "sunny")
        baseTemp = 25;
    if (condition === "rainy")
        baseTemp = 15;
    if (condition === "clear")
        baseTemp = 22;
    const tempC = baseTemp + (hash % 10) - 5;
    const tempF = Math.round((tempC * 9) / 5 + 32);
    return {
        location,
        temperature: units === "fahrenheit" ? tempF : tempC,
        temperatureUnit: units,
        conditions: condition,
        humidity: 40 + (hash % 50),
        windSpeed: 5 + (hash % 20),
        windUnit: "km/h",
        forecast: [
            { day: "Today", high: tempC + 2, low: tempC - 3, condition },
            { day: "Tomorrow", high: tempC + 1, low: tempC - 4, condition: conditions[(hash + 1) % conditions.length] },
            { day: "Day after", high: tempC + 3, low: tempC - 2, condition: conditions[(hash + 2) % conditions.length] },
        ],
    };
}
// Calculator implementation
function calculate(operation, a, b) {
    let result;
    let expression;
    switch (operation) {
        case "add":
            if (b === undefined)
                throw new Error("Second operand (b) required for addition");
            result = a + b;
            expression = `${a} + ${b}`;
            break;
        case "subtract":
            if (b === undefined)
                throw new Error("Second operand (b) required for subtraction");
            result = a - b;
            expression = `${a} - ${b}`;
            break;
        case "multiply":
            if (b === undefined)
                throw new Error("Second operand (b) required for multiplication");
            result = a * b;
            expression = `${a} * ${b}`;
            break;
        case "divide":
            if (b === undefined)
                throw new Error("Second operand (b) required for division");
            if (b === 0)
                throw new Error("Cannot divide by zero");
            result = a / b;
            expression = `${a} / ${b}`;
            break;
        case "power":
            if (b === undefined)
                throw new Error("Second operand (b) required for power operation");
            result = Math.pow(a, b);
            expression = `${a} ^ ${b}`;
            break;
        case "sqrt":
            if (a < 0)
                throw new Error("Cannot calculate square root of negative number");
            result = Math.sqrt(a);
            expression = `sqrt(${a})`;
            break;
        default:
            throw new Error(`Unknown operation: ${operation}`);
    }
    return {
        operation,
        expression,
        operands: { a, b },
        result,
        resultType: Number.isInteger(result) ? "integer" : "float",
    };
}
// Database operations
function databaseQuery(action, id, query, limit) {
    switch (action) {
        case "get": {
            if (!id) {
                throw new Error("ID required for get action");
            }
            const record = simulatedDatabase.get(id);
            if (!record) {
                throw new Error(`Record with ID '${id}' not found`);
            }
            return {
                action,
                record,
                found: true,
            };
        }
        case "list": {
            const records = Array.from(simulatedDatabase.values()).slice(0, limit ?? 10);
            return {
                action,
                records,
                count: records.length,
                total: simulatedDatabase.size,
            };
        }
        case "search": {
            if (!query) {
                throw new Error("Query required for search action");
            }
            const queryLower = query.toLowerCase();
            const records = Array.from(simulatedDatabase.values())
                .filter((r) => r.name.toLowerCase().includes(queryLower))
                .slice(0, limit ?? 10);
            return {
                action,
                query,
                records,
                count: records.length,
                total: simulatedDatabase.size,
            };
        }
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}
// Create MCP server
const server = new Server({
    name: "lafs-mcp-server",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: TOOLS,
    };
});
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const budget = typeof args?._budget === "number" ? args._budget : undefined;
    try {
        let result;
        switch (name) {
            case "weather": {
                const location = String(args?.location ?? "");
                const units = String(args?.units ?? "celsius");
                if (!location) {
                    throw new Error("Location is required");
                }
                result = await getWeather(location, units);
                break;
            }
            case "calculator": {
                const operation = String(args?.operation ?? "");
                const a = Number(args?.a);
                const b = args?.b !== undefined ? Number(args?.b) : undefined;
                if (!operation || Number.isNaN(a)) {
                    throw new Error("Operation and operand 'a' are required");
                }
                result = calculate(operation, a, b);
                break;
            }
            case "database_query": {
                const action = String(args?.action ?? "");
                const id = args?.id !== undefined ? String(args?.id) : undefined;
                const query = args?.query !== undefined ? String(args?.query) : undefined;
                const limit = args?.limit !== undefined ? Number(args?.limit) : undefined;
                if (!action) {
                    throw new Error("Action is required");
                }
                result = databaseQuery(action, id, query, limit);
                break;
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
        // Create MCP result
        const mcpResult = {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
            isError: false,
        };
        // Wrap in LAFS envelope
        const envelope = wrapMCPResult(mcpResult, `tools/${name}`, budget);
        // Return the LAFS envelope as text content
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(envelope),
                },
            ],
        };
    }
    catch (error) {
        // Create error MCP result
        const errorMessage = error instanceof Error ? error.message : String(error);
        const mcpResult = {
            content: [
                {
                    type: "text",
                    text: errorMessage,
                },
            ],
            isError: true,
        };
        // Wrap in LAFS error envelope
        const envelope = wrapMCPResult(mcpResult, `tools/${name}`, budget);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(envelope),
                },
            ],
            isError: true,
        };
    }
});
// Start server
async function main() {
    const transport = new StdioServerTransport();
    console.error("LAFS-MCP Server starting...");
    console.error("Available tools: weather, calculator, database_query");
    console.error("All responses are wrapped in LAFS-compliant envelopes");
    await server.connect(transport);
    console.error("LAFS-MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=mcp-lafs-server.js.map
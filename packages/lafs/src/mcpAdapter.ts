import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type {
  LAFSEnvelope,
  LAFSMeta,
  LAFSError,
  TokenEstimate,
} from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * MCP Content Item - represents a single content entry from MCP
 */
interface MCPContentItem {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: unknown;
}

/**
 * Extract result from MCP content array
 * Attempts to parse JSON content, falls back to text representation
 */
function extractResultFromContent(content: MCPContentItem[]): Record<string, unknown> | null {
  if (!content || content.length === 0) {
    return null;
  }

  // Combine all text content
  const textParts: string[] = [];
  const otherContent: unknown[] = [];

  for (const item of content) {
    if (item.type === "text" && item.text) {
      textParts.push(item.text);
    } else {
      otherContent.push(item);
    }
  }

  // Try to parse as JSON if single text item looks like JSON
  if (textParts.length === 1) {
    const text = textParts[0]?.trim() ?? "";
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not valid JSON, treat as text
      }
    }
  }

  // Combine into result object
  const result: Record<string, unknown> = {};
  
  if (textParts.length > 0) {
    result.text = textParts.length === 1 ? textParts[0] : textParts.join("\n");
  }
  
  if (otherContent.length > 0) {
    result.content = otherContent;
  }

  return result;
}

/**
 * Estimate token count from content
 * Rough estimation: ~4 characters per token
 */
function estimateTokens(content: Record<string, unknown> | null): number {
  if (!content) return 0;
  const jsonString = JSON.stringify(content);
  return Math.ceil(jsonString.length / 4);
}

/**
 * Truncate content to fit within budget
 */
function truncateToBudget(
  content: Record<string, unknown> | null,
  budget: number
): { result: Record<string, unknown> | null; truncated: boolean; originalEstimate: number } {
  if (!content) return { result: null, truncated: false, originalEstimate: 0 };

  const originalEstimate = estimateTokens(content);
  
  if (originalEstimate <= budget) {
    return { result: content, truncated: false, originalEstimate };
  }

  // Calculate truncation ratio
  const ratio = budget / originalEstimate;
  const jsonString = JSON.stringify(content);
  const targetLength = Math.floor(jsonString.length * ratio);
  
  // Truncate the string and try to make it valid JSON
  let truncated = jsonString.slice(0, targetLength);
  
  // Close any open structures
  const openBraces = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length;
  const openBrackets = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length;
  
  truncated += "}".repeat(Math.max(0, openBraces));
  truncated += "]".repeat(Math.max(0, openBrackets));

  try {
    const parsed = JSON.parse(truncated);
    // Add truncation notice
    if (typeof parsed === "object" && parsed !== null) {
      (parsed as Record<string, unknown>)["_truncated"] = true;
      (parsed as Record<string, unknown>)["_originalTokens"] = originalEstimate;
      (parsed as Record<string, unknown>)["_budget"] = budget;
    }
    return { result: parsed as Record<string, unknown>, truncated: true, originalEstimate };
  } catch {
    // If parsing fails, return minimal result
    return {
      result: {
        _truncated: true,
        _error: "Content truncated due to budget constraints",
        _originalTokens: originalEstimate,
        _budget: budget,
      },
      truncated: true,
      originalEstimate,
    };
  }
}

/**
 * Convert MCP error to LAFS error format
 */
function convertMCPErrorToLAFS(
  mcpResult: CallToolResult,
  operation: string
): LAFSError {
  const content = mcpResult.content as MCPContentItem[];
  const errorText = content
    .filter((item): item is MCPContentItem & { type: "text"; text: string } => 
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");

  // Determine error category based on error text
  let category: LAFSError["category"] = "INTERNAL";
  let code = "E_MCP_INTERNAL_ERROR";
  let retryable = false;
  let retryAfterMs: number | null = null;

  const errorLower = errorText.toLowerCase();
  
  if (errorLower.includes("not found") || errorLower.includes("doesn't exist") || errorLower.includes("does not exist")) {
    category = "NOT_FOUND";
    code = "E_MCP_NOT_FOUND";
  } else if (errorLower.includes("rate limit") || errorLower.includes("too many requests")) {
    category = "RATE_LIMIT";
    code = "E_MCP_RATE_LIMIT";
    retryable = true;
    retryAfterMs = 60000; // 1 minute default
  } else if (errorLower.includes("auth") || errorLower.includes("unauthorized") || errorLower.includes("forbidden")) {
    category = "AUTH";
    code = "E_MCP_AUTH_ERROR";
  } else if (errorLower.includes("permission") || errorLower.includes("access denied")) {
    category = "PERMISSION";
    code = "E_MCP_PERMISSION_DENIED";
  } else if (errorLower.includes("validation") || errorLower.includes("invalid")) {
    category = "VALIDATION";
    code = "E_MCP_VALIDATION_ERROR";
  } else if (errorLower.includes("timeout") || errorLower.includes("transient")) {
    category = "TRANSIENT";
    code = "E_MCP_TRANSIENT_ERROR";
    retryable = true;
    retryAfterMs = 5000; // 5 seconds
  }

  return {
    code,
    message: errorText || "MCP tool execution failed",
    category,
    retryable,
    retryAfterMs,
    details: {
      operation,
      mcpError: true,
      contentTypes: content.map((c) => c.type),
    },
  };
}

/**
 * Wrap MCP tool result in LAFS envelope
 * 
 * @param mcpResult - The raw MCP CallToolResult
 * @param operation - The operation name (tool name)
 * @param budget - Optional token budget for response
 * @returns LAFS-compliant envelope
 */
export function wrapMCPResult(
  mcpResult: CallToolResult,
  operation: string,
  budget?: number
): LAFSEnvelope {
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();

  // Build base meta
  const meta: LAFSMeta & { _tokenEstimate?: TokenEstimate } = {
    specVersion: "1.0.0",
    schemaVersion: "1.0.0",
    timestamp,
    operation,
    requestId,
    transport: "sdk",
    strict: true,
    mvi: "standard",
    contextVersion: 1,
  };

  // Handle MCP error
  if (mcpResult.isError) {
    const error = convertMCPErrorToLAFS(mcpResult, operation);
    
    return {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: meta,
      success: false,
      result: null,
      error,
    };
  }

  // Extract result from MCP content
  let result = extractResultFromContent(mcpResult.content as MCPContentItem[]);
  let truncated = false;
  let originalEstimate = 0;
  let extensions: Record<string, unknown> | undefined;

  // Apply budget enforcement if specified
  if (budget !== undefined && budget > 0) {
    const budgetResult = truncateToBudget(result, budget);
    result = budgetResult.result;
    truncated = budgetResult.truncated;
    originalEstimate = budgetResult.originalEstimate;
    
    // Put token estimate in extensions to comply with strict schema
    extensions = {
      "x-mcp-token-estimate": {
        estimated: truncated ? budget : originalEstimate,
        truncated,
        originalEstimate: truncated ? originalEstimate : undefined,
      },
    };
  }

  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: meta,
    success: true,
    result,
    error: null,
    _extensions: extensions,
  };
}

/**
 * Create a LAFS error envelope for MCP adapter errors
 * 
 * @param message - Error message
 * @param operation - The operation being performed
 * @param category - Error category
 * @returns LAFS error envelope
 */
export function createAdapterErrorEnvelope(
  message: string,
  operation: string,
  category: LAFSError["category"] = "INTERNAL"
): LAFSEnvelope {
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();

  const error: LAFSError = {
    code: "E_MCP_ADAPTER_ERROR",
    message,
    category,
    retryable: category === "TRANSIENT" || category === "RATE_LIMIT",
    retryAfterMs: category === "RATE_LIMIT" ? 60000 : category === "TRANSIENT" ? 5000 : null,
    details: {
      operation,
      adapterError: true,
    },
  };

  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp,
      operation,
      requestId,
      transport: "sdk",
      strict: true,
      mvi: "standard",
      contextVersion: 1,
    },
    success: false,
    result: null,
    error,
  };
}

/**
 * Type guard to check if content is TextContent
 */
export function isTextContent(content: unknown): content is TextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    (content as { type: string }).type === "text" &&
    "text" in content &&
    typeof (content as { text: string }).text === "string"
  );
}

/**
 * Parse MCP text content as JSON if possible
 */
export function parseMCPTextContent(content: TextContent): unknown {
  try {
    return JSON.parse(content.text);
  } catch {
    return content.text;
  }
}

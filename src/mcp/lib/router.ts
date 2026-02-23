/**
 * Legacy Domain Router Types
 *
 * This file retains only the DomainRequest / DomainResponse interfaces
 * used by the gateway tool definitions (query.ts and mutate.ts) and
 * protocol enforcement. The DomainRouter class has been removed —
 * all routing now goes through the dispatch layer.
 *
 * @task T2911
 * @deprecated Use dispatch layer types for new code
 */

/**
 * Request from MCP gateway
 */
export interface DomainRequest {
  gateway: 'cleo_query' | 'cleo_mutate';
  domain: string;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Response from domain handler
 */
export interface DomainResponse {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    timestamp: string;
    duration_ms: number;
    [key: string]: unknown;
  };
  success: boolean;
  data?: unknown;
  partial?: boolean;
  error?: {
    code: string;
    exitCode?: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

/**
 * Domain handler interface (legacy - retained for type compatibility)
 */
export interface DomainHandler {
  query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse>;
  mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse>;
  getSupportedOperations(): { query: string[]; mutate: string[] };
}

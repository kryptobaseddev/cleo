/**
 * MCP Gateway Request and Response Types
 *
 * Defines the envelope format for cleo_query and cleo_mutate gateway operations.
 */

/**
 * Gateway type discriminator
 */
export type GatewayType = 'cleo_query' | 'cleo_mutate';

/**
 * Domain names for operation routing
 */
export type DomainName =
  | 'tasks'
  | 'session'
  | 'orchestrate'
  | 'research'
  | 'lifecycle'
  | 'validate'
  | 'release'
  | 'system';

/**
 * Base gateway request structure
 */
export interface GatewayRequest<TParams = unknown> {
  domain: DomainName;
  operation: string;
  params?: TParams;
}

/**
 * Metadata envelope for responses
 *
 * Per MCP-SERVER-SPECIFICATION Section 3.1, all responses include
 * duration_ms for operation timing.
 */
export interface Meta {
  gateway: GatewayType;
  domain: DomainName;
  operation: string;
  version: string;
  timestamp: string;
  duration_ms: number;
}

/**
 * Success response envelope
 */
export interface GatewayResponse<TData = unknown> {
  _meta: Meta;
  success: true;
  data: TData;
}

/**
 * Partial success response (for batch operations)
 */
export interface PartialSuccessResponse<TSucceeded = unknown, TFailed = unknown> {
  _meta: Meta;
  success: true;
  partial: true;
  data: {
    succeeded: TSucceeded[];
    failed: TFailed[];
  };
}

/**
 * Error response envelope
 */
export interface ErrorResponse {
  _meta: Meta;
  success: false;
  error: {
    code: string;
    exitCode: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{
      action: string;
      command: string;
    }>;
  };
}

/**
 * Union type for all possible responses
 */
export type Response<TData = unknown> =
  | GatewayResponse<TData>
  | ErrorResponse
  | PartialSuccessResponse;

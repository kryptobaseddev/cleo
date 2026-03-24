/**
 * A2A Protocol Bindings - Barrel Export
 *
 * Re-exports all binding modules and provides cross-binding
 * error code mapping for consistent error handling across transports.
 */

export * from './jsonrpc.js';
export * from './http.js';
export * from './grpc.js';

import { type A2AErrorType, JSONRPC_A2A_ERROR_CODES } from './jsonrpc.js';
import { A2A_HTTP_STATUS_CODES, A2A_ERROR_TYPE_URIS } from './http.js';
import { A2A_GRPC_STATUS_CODES, GRPC_STATUS_CODE, A2A_GRPC_ERROR_REASONS } from './grpc.js';

// ============================================================================
// Cross-Binding Error Mapping
// ============================================================================

/** Complete error code mapping across all three transports */
export interface ErrorCodeMapping {
  /** JSON-RPC numeric error code */
  jsonRpcCode: number;
  /** HTTP response status code */
  httpStatus: number;
  /** RFC 9457 Problem Details type URI */
  httpTypeUri: string;
  /** gRPC status name (e.g. NOT_FOUND) */
  grpcStatus: string;
  /** gRPC numeric status code */
  grpcCode: number;
}

/** All 9 A2A error types */
const ERROR_TYPES: A2AErrorType[] = [
  'TaskNotFound',
  'TaskNotCancelable',
  'PushNotificationNotSupported',
  'UnsupportedOperation',
  'ContentTypeNotSupported',
  'InvalidAgentResponse',
  'AuthenticatedExtendedCardNotConfigured',
  'ExtensionSupportRequired',
  'VersionNotSupported',
];

function buildMappings(): ReadonlyMap<A2AErrorType, ErrorCodeMapping> {
  const map = new Map<A2AErrorType, ErrorCodeMapping>();

  for (const errorType of ERROR_TYPES) {
    const grpcStatusName = A2A_GRPC_STATUS_CODES[errorType];
    map.set(errorType, {
      jsonRpcCode: JSONRPC_A2A_ERROR_CODES[errorType],
      httpStatus: A2A_HTTP_STATUS_CODES[errorType],
      httpTypeUri: A2A_ERROR_TYPE_URIS[errorType],
      grpcStatus: grpcStatusName,
      grpcCode: GRPC_STATUS_CODE[grpcStatusName],
    });
  }

  return map;
}

/** Precomputed cross-binding error mapping for all 9 A2A error types */
export const A2A_ERROR_MAPPINGS: ReadonlyMap<A2AErrorType, ErrorCodeMapping> = buildMappings();

/**
 * Get the complete error code mapping for a given A2A error type.
 * Returns consistent values across JSON-RPC, HTTP, and gRPC.
 */
export function getErrorCodeMapping(errorType: A2AErrorType): ErrorCodeMapping {
  const mapping = A2A_ERROR_MAPPINGS.get(errorType);
  if (!mapping) {
    throw new Error(`Unknown A2A error type: ${errorType}`);
  }
  return mapping;
}

// Also export A2A_GRPC_ERROR_REASONS for convenience (re-exported from grpc.ts via *)
// but explicitly reference it here so the cross-binding module is self-documenting
export { A2A_GRPC_ERROR_REASONS } from './grpc.js';

// ============================================================================
// Version Negotiation
// ============================================================================

export const SUPPORTED_A2A_VERSIONS = ['1.0'] as const;
export const DEFAULT_A2A_VERSION = '1.0' as const;

export function parseA2AVersionHeader(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function negotiateA2AVersion(requestedVersions: string[]): string | null {
  if (requestedVersions.length === 0) {
    return DEFAULT_A2A_VERSION;
  }

  const supported = new Set(SUPPORTED_A2A_VERSIONS);
  for (const version of requestedVersions) {
    if (supported.has(version as (typeof SUPPORTED_A2A_VERSIONS)[number])) {
      return version;
    }
  }
  return null;
}

/**
 * A2A Protocol Bindings - Barrel Export
 *
 * Re-exports all binding modules and provides cross-binding
 * error code mapping for consistent error handling across transports.
 *
 * @packageDocumentation
 */

export * from './grpc.js';
export * from './http.js';
export * from './jsonrpc.js';

import { A2A_GRPC_STATUS_CODES, GRPC_STATUS_CODE } from './grpc.js';
import { A2A_ERROR_TYPE_URIS, A2A_HTTP_STATUS_CODES } from './http.js';
import { type A2AErrorType, JSONRPC_A2A_ERROR_CODES } from './jsonrpc.js';

// ============================================================================
// Cross-Binding Error Mapping
// ============================================================================

/**
 * Complete error code mapping across all three transports.
 *
 * @remarks
 * Provides a unified view of how a single A2A error type maps to
 * JSON-RPC, HTTP, and gRPC error representations.
 */
export interface ErrorCodeMapping {
  /** JSON-RPC numeric error code (e.g. `-32001`) */
  jsonRpcCode: number;
  /** HTTP response status code (e.g. `404`) */
  httpStatus: number;
  /** RFC 9457 Problem Details type URI */
  httpTypeUri: string;
  /** gRPC status name (e.g. `"NOT_FOUND"`) */
  grpcStatus: string;
  /** gRPC numeric status code (e.g. `5`) */
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

/**
 * Precomputed cross-binding error mapping for all 9 A2A error types.
 *
 * @remarks
 * Built once at module load and immutable thereafter. Each entry maps an
 * A2A error type to its JSON-RPC, HTTP, and gRPC representations.
 */
export const A2A_ERROR_MAPPINGS: ReadonlyMap<A2AErrorType, ErrorCodeMapping> = buildMappings();

/**
 * Get the complete error code mapping for a given A2A error type.
 *
 * @remarks
 * Looks up the precomputed mapping from {@link A2A_ERROR_MAPPINGS}. Throws
 * if the error type is not one of the 9 known A2A error types.
 *
 * @param errorType - The A2A error type name (e.g. `"TaskNotFound"`)
 * @returns The {@link ErrorCodeMapping} with JSON-RPC, HTTP, and gRPC codes
 * @throws Error if the error type is not a known A2A error type
 *
 * @example
 * ```ts
 * const mapping = getErrorCodeMapping('TaskNotFound');
 * // { jsonRpcCode: -32001, httpStatus: 404, httpTypeUri: '...', grpcStatus: 'NOT_FOUND', grpcCode: 5 }
 * ```
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

/**
 * Supported A2A protocol versions.
 *
 * @remarks
 * Tuple of version strings that this implementation can handle.
 */
export const SUPPORTED_A2A_VERSIONS = ['1.0'] as const;

/**
 * Default A2A protocol version used when none is requested.
 *
 * @remarks
 * Applied when the client does not provide an `a2a-version` header.
 */
export const DEFAULT_A2A_VERSION = '1.0' as const;

/**
 * Parse the `a2a-version` header into an array of version strings.
 *
 * @remarks
 * Splits the comma-separated header value, trims whitespace, and filters
 * empty segments. Returns an empty array when the header is absent.
 *
 * @param headerValue - The raw `a2a-version` header value, or `undefined` if absent
 * @returns An array of version strings extracted from the header
 *
 * @example
 * ```ts
 * parseA2AVersionHeader('1.0, 2.0'); // ['1.0', '2.0']
 * parseA2AVersionHeader(undefined);   // []
 * ```
 */
export function parseA2AVersionHeader(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Negotiate an A2A protocol version from the client's requested versions.
 *
 * @remarks
 * Returns the first requested version that is also in {@link SUPPORTED_A2A_VERSIONS}.
 * Falls back to {@link DEFAULT_A2A_VERSION} when the request list is empty.
 * Returns `null` if no requested version is supported.
 *
 * @param requestedVersions - Array of version strings requested by the client
 * @returns The negotiated version string, or `null` if no common version exists
 *
 * @example
 * ```ts
 * negotiateA2AVersion(['1.0', '2.0']); // '1.0'
 * negotiateA2AVersion([]);              // '1.0' (default)
 * negotiateA2AVersion(['3.0']);          // null
 * ```
 */
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

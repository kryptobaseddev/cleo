import errorRegistry from '../schemas/v1/error-registry.json' with { type: 'json' };
import type { LAFSAgentAction } from './types.js';

/**
 * A single entry in the LAFS error-code registry.
 *
 * @remarks
 * Each entry defines the canonical error code, its category, human-readable
 * description, retry semantics, and transport-specific status mappings.
 */
export interface RegistryCode {
  /** The canonical LAFS error code (e.g., `"E_FORMAT_CONFLICT"`). */
  code: string;
  /** Broad error category (e.g., `"client"`, `"server"`, `"auth"`). */
  category: string;
  /** Human-readable description of when this error occurs. */
  description: string;
  /** Whether the operation that produced this error is safe to retry. */
  retryable: boolean;
  /** HTTP status code mapped to this error. */
  httpStatus: number;
  /** gRPC status string mapped to this error. */
  grpcStatus: string;
  /** CLI exit code mapped to this error. */
  cliExit: number;
  /**
   * Suggested agent action from the registry (e.g., `"retry"`, `"abort"`).
   * @defaultValue undefined
   */
  agentAction?: string;
  /**
   * RFC 9457 type URI for this error, used in Problem Details responses.
   * @defaultValue undefined
   */
  typeUri?: string;
  /**
   * URL pointing to human-readable documentation for this error.
   * @defaultValue undefined
   */
  docUrl?: string;
}

/**
 * Top-level shape of the LAFS error-registry JSON file.
 *
 * @remarks
 * Contains a version string for schema evolution and the complete list
 * of registered error codes.
 */
export interface ErrorRegistry {
  /** Semantic version of the error-registry schema. */
  version: string;
  /** All registered LAFS error codes. */
  codes: RegistryCode[];
}

/**
 * A transport-specific status value resolved from the error registry.
 *
 * @remarks
 * For HTTP and CLI, `value` is a number (status code / exit code).
 * For gRPC, `value` is a string (status name).
 */
export type TransportMapping = {
  /** The transport protocol this mapping applies to. */
  transport: 'http' | 'grpc' | 'cli';
  /** The transport-specific status value (numeric for HTTP/CLI, string for gRPC). */
  value: number | string;
};

/**
 * Loads the full LAFS error registry from the bundled JSON.
 *
 * @remarks
 * Returns the parsed `error-registry.json` as a typed {@link ErrorRegistry}.
 *
 * @returns The complete error registry with version and all registered codes.
 *
 * @example
 * ```ts
 * const registry = getErrorRegistry();
 * console.log(registry.version, registry.codes.length);
 * ```
 */
export function getErrorRegistry(): ErrorRegistry {
  return errorRegistry as ErrorRegistry;
}

/**
 * Checks whether a given error code exists in the LAFS error registry.
 *
 * @remarks
 * Performs a linear scan of the registry codes array. Suitable for
 * validation-time lookups; not optimized for hot-path usage.
 *
 * @param code - The error code string to look up (e.g., `"E_FORMAT_CONFLICT"`).
 * @returns `true` if the code is registered, `false` otherwise.
 *
 * @example
 * ```ts
 * isRegisteredErrorCode('E_FORMAT_CONFLICT'); // true
 * isRegisteredErrorCode('E_UNKNOWN');         // false
 * ```
 */
export function isRegisteredErrorCode(code: string): boolean {
  const registry = getErrorRegistry();
  return registry.codes.some((item) => item.code === code);
}

/**
 * Retrieves the full registry entry for a given error code.
 *
 * @remarks
 * Returns `undefined` when the code is not found, allowing callers to
 * distinguish between "code exists" and "code absent" without exceptions.
 *
 * @param code - The error code string to look up.
 * @returns The matching {@link RegistryCode} or `undefined` if not found.
 *
 * @example
 * ```ts
 * const entry = getRegistryCode('E_FORMAT_CONFLICT');
 * if (entry) {
 *   console.log(entry.httpStatus); // 409
 * }
 * ```
 */
export function getRegistryCode(code: string): RegistryCode | undefined {
  return getErrorRegistry().codes.find((item) => item.code === code);
}

/**
 * Returns the default agent action for a given error code.
 *
 * @remarks
 * Delegates to {@link getRegistryCode} and extracts the `agentAction`
 * field. Returns `undefined` when the code is unregistered or has no
 * default action.
 *
 * @param code - The error code string to look up.
 * @returns The {@link LAFSAgentAction} or `undefined` if unavailable.
 *
 * @example
 * ```ts
 * const action = getAgentAction('E_RATE_LIMIT');
 * console.log(action); // "retry"
 * ```
 */
export function getAgentAction(code: string): LAFSAgentAction | undefined {
  const entry = getRegistryCode(code);
  return entry?.agentAction as LAFSAgentAction | undefined;
}

/**
 * Returns the RFC 9457 type URI for a given error code.
 *
 * @remarks
 * Useful for constructing Problem Details responses. Returns `undefined`
 * when the code is unregistered or has no type URI.
 *
 * @param code - The error code string to look up.
 * @returns The type URI string or `undefined` if unavailable.
 *
 * @example
 * ```ts
 * const uri = getTypeUri('E_VALIDATION');
 * // "https://lafs.dev/errors/E_VALIDATION"
 * ```
 */
export function getTypeUri(code: string): string | undefined {
  const entry = getRegistryCode(code);
  return entry?.typeUri;
}

/**
 * Returns the documentation URL for a given error code.
 *
 * @remarks
 * Provides a link to human-readable docs for the error. Returns
 * `undefined` when the code is unregistered or has no doc URL.
 *
 * @param code - The error code string to look up.
 * @returns The documentation URL string or `undefined` if unavailable.
 *
 * @example
 * ```ts
 * const url = getDocUrl('E_VALIDATION');
 * // "https://lafs.dev/docs/errors/E_VALIDATION"
 * ```
 */
export function getDocUrl(code: string): string | undefined {
  const entry = getRegistryCode(code);
  return entry?.docUrl;
}

/**
 * Resolves the transport-specific status value for a given error code and transport.
 *
 * @remarks
 * Looks up the registry entry and extracts `httpStatus`, `grpcStatus`, or
 * `cliExit` depending on the requested transport. Returns `null` when the
 * error code is not registered.
 *
 * @param code - The error code string to look up.
 * @param transport - The transport protocol to resolve a mapping for.
 * @returns A {@link TransportMapping} or `null` if the code is unregistered.
 *
 * @example
 * ```ts
 * const mapping = getTransportMapping('E_NOT_FOUND', 'http');
 * console.log(mapping); // { transport: 'http', value: 404 }
 * ```
 */
export function getTransportMapping(
  code: string,
  transport: 'http' | 'grpc' | 'cli',
): TransportMapping | null {
  const registryCode = getRegistryCode(code);
  if (!registryCode) {
    return null;
  }

  if (transport === 'http') {
    return { transport, value: registryCode.httpStatus };
  }
  if (transport === 'grpc') {
    return { transport, value: registryCode.grpcStatus };
  }
  return { transport, value: registryCode.cliExit };
}

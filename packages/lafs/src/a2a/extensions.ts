/**
 * A2A Extensions Support
 *
 * Extension negotiation, LAFS extension builder, and Express middleware
 * for A2A Protocol v1.0+ compliance.
 *
 * @remarks
 * Implements extension negotiation per A2A spec Section 3.2.6. Extensions
 * are declared in an Agent Card and negotiated at request time via the
 * A2A-Extensions HTTP header. The middleware validates required extensions
 * and attaches negotiation results to `res.locals.a2aExtensions`.
 *
 * Reference: specs/external/extensions.md, A2A spec Section 3.2.6
 */

import type { AgentExtension } from '@a2a-js/sdk';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// ============================================================================
// Constants
// ============================================================================

/** Canonical LAFS extension URI */
export const LAFS_EXTENSION_URI = 'https://lafs.dev/extensions/envelope/v1';

/** Canonical A2A Extensions header per spec Section 3.2.6 */
export const A2A_EXTENSIONS_HEADER = 'A2A-Extensions';

/**
 * SDK header name (differs from spec).
 * Middleware checks both for SDK compatibility.
 */
const SDK_EXTENSIONS_HEADER = 'x-a2a-extensions';

// ============================================================================
// Types
// ============================================================================

/** LAFS extension parameters declared in Agent Card */
export interface LafsExtensionParams {
  /** Whether the agent supports context ledger tracking */
  supportsContextLedger: boolean;
  /** Whether the agent supports token budget enforcement */
  supportsTokenBudgets: boolean;
  /** URL of the JSON Schema for the LAFS envelope */
  envelopeSchema: string;
  /**
   * Classification of the extension's behavior.
   * @defaultValue undefined
   */
  kind?: ExtensionKind;
}

/**
 * Classification of an A2A extension's behavior.
 *
 * @remarks
 * Used to group activated extensions by their declared kind.
 * Valid values are `data-only`, `profile`, `method`, and `state-machine`.
 */
export type ExtensionKind = 'data-only' | 'profile' | 'method' | 'state-machine';
const VALID_EXTENSION_KINDS: ExtensionKind[] = ['data-only', 'profile', 'method', 'state-machine'];

/** Result of extension negotiation between client and agent */
export interface ExtensionNegotiationResult {
  /** URIs requested by the client */
  requested: string[];
  /** URIs that matched agent-declared extensions */
  activated: string[];
  /** Requested URIs not declared by the agent (ignored per spec) */
  unsupported: string[];
  /** Agent-required URIs not present in client request */
  missingRequired: string[];
  /** Activated extensions grouped by declared kind (when provided) */
  activatedByKind: Partial<Record<ExtensionKind, string[]>>;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Parse A2A-Extensions header value into URI array.
 *
 * @remarks
 * Splits comma-separated URIs, trims whitespace, and removes empty strings.
 * Returns an empty array when the header is absent or empty.
 *
 * @param headerValue - Raw header value string, or undefined if absent
 * @returns Array of trimmed extension URI strings
 *
 * @example
 * ```typescript
 * const uris = parseExtensionsHeader('https://lafs.dev/ext/v1, https://example.com/ext');
 * // => ['https://lafs.dev/ext/v1', 'https://example.com/ext']
 * ```
 */
export function parseExtensionsHeader(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);
}

/**
 * Negotiate extensions between client-requested and agent-declared sets.
 *
 * @remarks
 * Unsupported extensions are ignored per spec. Required agent extensions
 * not requested by the client are flagged in `missingRequired`. Activated
 * extensions are optionally grouped by their declared `kind` parameter.
 *
 * @param requestedUris - Extension URIs requested by the client
 * @param agentExtensions - Extensions declared in the agent's Agent Card
 * @returns Negotiation result with activated, unsupported, and missing required sets
 *
 * @example
 * ```typescript
 * const result = negotiateExtensions(
 *   ['https://lafs.dev/extensions/envelope/v1'],
 *   agentCard.capabilities.extensions,
 * );
 * if (result.missingRequired.length > 0) {
 *   throw new ExtensionSupportRequiredError(result.missingRequired);
 * }
 * ```
 */
export function negotiateExtensions(
  requestedUris: string[],
  agentExtensions: AgentExtension[],
): ExtensionNegotiationResult {
  const declared = new Map(agentExtensions.map((ext) => [ext.uri, ext]));
  const activated: string[] = [];
  const unsupported: string[] = [];

  for (const uri of requestedUris) {
    if (declared.has(uri)) {
      activated.push(uri);
    } else {
      unsupported.push(uri);
    }
  }

  const requestedSet = new Set(requestedUris);
  const missingRequired: string[] = [];
  for (const ext of agentExtensions) {
    if (ext.required && !requestedSet.has(ext.uri)) {
      missingRequired.push(ext.uri);
    }
  }

  const activatedByKind: Partial<Record<ExtensionKind, string[]>> = {};
  for (const uri of activated) {
    const ext = declared.get(uri);
    const kind =
      ext?.params && typeof ext.params === 'object'
        ? (ext.params as Record<string, unknown>)['kind']
        : undefined;
    if (typeof kind === 'string' && VALID_EXTENSION_KINDS.includes(kind as ExtensionKind)) {
      const typedKind = kind as ExtensionKind;
      if (!activatedByKind[typedKind]) {
        activatedByKind[typedKind] = [];
      }
      activatedByKind[typedKind]!.push(uri);
    }
  }

  return { requested: requestedUris, activated, unsupported, missingRequired, activatedByKind };
}

/**
 * Format activated extension URIs into header value.
 *
 * @remarks
 * Joins URIs with a comma separator suitable for the A2A-Extensions response header.
 *
 * @param activatedUris - Extension URIs that were successfully negotiated
 * @returns Comma-separated header value string
 *
 * @example
 * ```typescript
 * res.setHeader('A2A-Extensions', formatExtensionsHeader(result.activated));
 * ```
 */
export function formatExtensionsHeader(activatedUris: string[]): string {
  return activatedUris.join(',');
}

/** Options for building the LAFS extension declaration */
export interface BuildLafsExtensionOptions {
  /**
   * Whether the LAFS extension is required for all requests.
   * @defaultValue undefined
   */
  required?: boolean;
  /**
   * Whether the agent supports context ledger tracking.
   * @defaultValue undefined
   */
  supportsContextLedger?: boolean;
  /**
   * Whether the agent supports token budget enforcement.
   * @defaultValue undefined
   */
  supportsTokenBudgets?: boolean;
  /**
   * URL of the JSON Schema for the LAFS envelope.
   * @defaultValue undefined
   */
  envelopeSchema?: string;
}

/**
 * Build an A2A AgentExtension object declaring LAFS support.
 *
 * @remarks
 * Creates a fully-formed extension declaration suitable for inclusion in
 * Agent Card `capabilities.extensions[]`. Defaults to non-required with
 * the canonical LAFS envelope schema URL and `profile` kind.
 *
 * @param options - Configuration options for the LAFS extension declaration
 * @returns A2A AgentExtension object ready for inclusion in an Agent Card
 *
 * @example
 * ```typescript
 * const ext = buildLafsExtension({ required: true, supportsTokenBudgets: true });
 * agentCard.capabilities.extensions.push(ext);
 * ```
 */
export function buildLafsExtension(options?: BuildLafsExtensionOptions): AgentExtension {
  return {
    uri: LAFS_EXTENSION_URI,
    description: 'LAFS envelope protocol for structured agent responses',
    required: options?.required ?? false,
    params: {
      supportsContextLedger: options?.supportsContextLedger ?? false,
      supportsTokenBudgets: options?.supportsTokenBudgets ?? false,
      envelopeSchema: options?.envelopeSchema ?? 'https://lafs.dev/schemas/v1/envelope.schema.json',
      kind: 'profile',
    },
  };
}

/** Options for building a generic A2A extension declaration */
export interface BuildExtensionOptions {
  /** Canonical URI identifying the extension */
  uri: string;
  /** Human-readable description of what the extension provides */
  description: string;
  /**
   * Whether the extension is required for all requests.
   * @defaultValue undefined
   */
  required?: boolean;
  /** Classification of the extension's behavior */
  kind: ExtensionKind;
  /**
   * Additional parameters to include in the extension declaration.
   * @defaultValue undefined
   */
  params?: Record<string, unknown>;
}

/**
 * Build a generic A2A AgentExtension object.
 *
 * @remarks
 * Creates a fully-formed extension declaration with the specified kind
 * merged into params. Use {@link buildLafsExtension} for LAFS-specific declarations.
 *
 * @param options - Configuration for the extension declaration
 * @returns A2A AgentExtension object
 *
 * @example
 * ```typescript
 * const ext = buildExtension({
 *   uri: 'https://example.com/ext/v1',
 *   description: 'Custom extension',
 *   kind: 'data-only',
 * });
 * ```
 */
export function buildExtension(options: BuildExtensionOptions): AgentExtension {
  return {
    uri: options.uri,
    description: options.description,
    required: options.required ?? false,
    params: {
      kind: options.kind,
      ...(options.params ?? {}),
    },
  };
}

/**
 * Check whether a string is a valid extension kind.
 *
 * @remarks
 * Validates against the set of recognized kinds: `data-only`, `profile`,
 * `method`, and `state-machine`.
 *
 * @param kind - String value to validate
 * @returns True if the value is a recognized ExtensionKind
 *
 * @example
 * ```typescript
 * if (isValidExtensionKind(userInput)) {
 *   // userInput is now typed as ExtensionKind
 * }
 * ```
 */
export function isValidExtensionKind(kind: string): kind is ExtensionKind {
  return VALID_EXTENSION_KINDS.includes(kind as ExtensionKind);
}

/**
 * Validate an A2A extension declaration for correctness.
 *
 * @remarks
 * Checks that if a `kind` parameter is present, it must be one of the
 * recognized ExtensionKind values. Extensions without a kind are valid.
 *
 * @param extension - The AgentExtension to validate
 * @returns Object with `valid` boolean and optional `error` message
 *
 * @example
 * ```typescript
 * const { valid, error } = validateExtensionDeclaration(ext);
 * if (!valid) {
 *   console.error('Invalid extension:', error);
 * }
 * ```
 */
export function validateExtensionDeclaration(extension: AgentExtension): {
  valid: boolean;
  error?: string;
} {
  const kind =
    extension.params && typeof extension.params === 'object'
      ? (extension.params as Record<string, unknown>)['kind']
      : undefined;

  if (kind === undefined) {
    return { valid: true };
  }

  if (typeof kind !== 'string' || !isValidExtensionKind(kind)) {
    return { valid: false, error: `invalid extension kind: ${String(kind)}` };
  }

  return { valid: true };
}

// ============================================================================
// Error Class
// ============================================================================

/**
 * Error thrown when required A2A extensions are not supported by the client.
 *
 * @remarks
 * Uses JSON-RPC error code -32008, which is outside the SDK's range (stops at -32007).
 * Provides conversion methods for JSON-RPC, RFC 9457 Problem Details, and LAFS error formats.
 */
export class ExtensionSupportRequiredError extends Error {
  /** JSON-RPC error code for extension support required */
  readonly code = -32008 as const;
  /** HTTP status code returned for this error */
  readonly httpStatus = 400 as const;
  /** gRPC status code equivalent */
  readonly grpcStatus = 'FAILED_PRECONDITION' as const;
  /** URIs of the required extensions that the client did not provide */
  readonly missingExtensions: string[];

  /**
   * Create an ExtensionSupportRequiredError.
   *
   * @param missingExtensions - URIs of required extensions not provided by the client
   */
  constructor(missingExtensions: string[]) {
    super(`Required extensions not supported: ${missingExtensions.join(', ')}`);
    this.name = 'ExtensionSupportRequiredError';
    this.missingExtensions = missingExtensions;
  }

  /**
   * Convert to JSON-RPC error object.
   *
   * @remarks
   * Returns a JSON-RPC 2.0 compatible error with the missing extensions in `data`.
   *
   * @returns JSON-RPC error with code, message, and data containing missing extension URIs
   */
  toJSONRPCError(): { code: number; message: string; data: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      data: { missingExtensions: this.missingExtensions },
    };
  }

  /**
   * Convert to RFC 9457 Problem Details object with agent-actionable fields.
   *
   * @remarks
   * Includes `agentAction: 'retry_modified'` so consuming agents know they
   * should retry the request with the required extensions activated.
   *
   * @returns Problem Details object with `agentAction` field for agent-driven retry
   */
  toProblemDetails(): Record<string, unknown> & { agentAction: string } {
    return {
      type: 'https://a2a-protocol.org/errors/extension-support-required',
      title: 'Extension Support Required',
      status: this.httpStatus,
      detail: this.message,
      missingExtensions: this.missingExtensions,
      agentAction: 'retry_modified',
    };
  }

  /**
   * Convert to a LAFSError-compatible object.
   *
   * @remarks
   * Returns an object matching the LAFS error shape with category `CONTRACT`
   * and code `E_CONTRACT_EXTENSION_REQUIRED`. Marked as retryable since
   * the client can retry with the required extensions.
   *
   * @returns LAFS-compatible error object with code, message, category, and details
   */
  toLafsError(): {
    code: string;
    message: string;
    category: 'CONTRACT';
    retryable: boolean;
    retryAfterMs: null;
    details: Record<string, unknown>;
  } {
    return {
      code: 'E_CONTRACT_EXTENSION_REQUIRED',
      message: this.message,
      category: 'CONTRACT',
      retryable: true,
      retryAfterMs: null,
      details: {
        missingExtensions: this.missingExtensions,
        agentAction: 'retry_modified',
      },
    };
  }
}

// ============================================================================
// Express Middleware
// ============================================================================

/** Options for the extension negotiation middleware */
export interface ExtensionNegotiationMiddlewareOptions {
  /** Agent-declared extensions to negotiate against */
  extensions: AgentExtension[];
  /**
   * Return 400 if required extensions are missing.
   * @defaultValue undefined
   */
  enforceRequired?: boolean;
}

/**
 * Express middleware for A2A extension negotiation.
 *
 * @remarks
 * Parses the A2A-Extensions header (and X-A2A-Extensions for SDK compat),
 * validates against declared extensions, sets the response header with
 * activated extensions, and attaches the negotiation result to
 * `res.locals.a2aExtensions`. When `enforceRequired` is true (default),
 * returns a 400 RFC 9457 Problem Details response if required extensions
 * are missing.
 *
 * @param options - Middleware configuration with extensions and enforcement settings
 * @returns Express RequestHandler that performs extension negotiation
 *
 * @example
 * ```typescript
 * app.use(extensionNegotiationMiddleware({
 *   extensions: agentCard.capabilities.extensions,
 *   enforceRequired: true,
 * }));
 * ```
 */
export function extensionNegotiationMiddleware(
  options: ExtensionNegotiationMiddlewareOptions,
): RequestHandler {
  const { extensions, enforceRequired = true } = options;

  return function extensionNegotiationHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Check both canonical and SDK headers (Express normalizes to lowercase)
    const headerValue =
      (req.headers[A2A_EXTENSIONS_HEADER.toLowerCase()] as string | undefined) ??
      (req.headers[SDK_EXTENSIONS_HEADER] as string | undefined);

    const requested = parseExtensionsHeader(headerValue);
    const result = negotiateExtensions(requested, extensions);

    if (enforceRequired && result.missingRequired.length > 0) {
      const error = new ExtensionSupportRequiredError(result.missingRequired);
      res.setHeader('Content-Type', 'application/problem+json');
      res.status(error.httpStatus).json(error.toProblemDetails());
      return;
    }

    if (result.activated.length > 0) {
      res.setHeader(A2A_EXTENSIONS_HEADER, formatExtensionsHeader(result.activated));
    }

    res.locals['a2aExtensions'] = result;
    next();
  };
}

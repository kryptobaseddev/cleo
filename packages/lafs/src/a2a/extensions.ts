/**
 * A2A Extensions Support
 *
 * Extension negotiation, LAFS extension builder, and Express middleware
 * for A2A Protocol v1.0+ compliance.
 *
 * Reference: specs/external/extensions.md, A2A spec Section 3.2.6
 */

import type { AgentExtension } from '@a2a-js/sdk';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

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
  supportsContextLedger: boolean;
  supportsTokenBudgets: boolean;
  envelopeSchema: string;
  kind?: ExtensionKind;
}

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
 * Splits comma-separated URIs, trims whitespace, removes empty strings.
 */
export function parseExtensionsHeader(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map(uri => uri.trim())
    .filter(Boolean);
}

/**
 * Negotiate extensions between client-requested and agent-declared sets.
 * Unsupported extensions are ignored per spec. Required agent extensions
 * not requested by the client are flagged in missingRequired.
 */
export function negotiateExtensions(
  requestedUris: string[],
  agentExtensions: AgentExtension[]
): ExtensionNegotiationResult {
  const declared = new Map(agentExtensions.map(ext => [ext.uri, ext]));
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
    const kind = ext?.params && typeof ext.params === 'object'
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
 * Joins URIs with comma separator.
 */
export function formatExtensionsHeader(activatedUris: string[]): string {
  return activatedUris.join(',');
}

/** Options for building the LAFS extension declaration */
export interface BuildLafsExtensionOptions {
  required?: boolean;
  supportsContextLedger?: boolean;
  supportsTokenBudgets?: boolean;
  envelopeSchema?: string;
}

/**
 * Build an A2A AgentExtension object declaring LAFS support.
 * Suitable for inclusion in Agent Card capabilities.extensions[].
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

export interface BuildExtensionOptions {
  uri: string;
  description: string;
  required?: boolean;
  kind: ExtensionKind;
  params?: Record<string, unknown>;
}

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

export function isValidExtensionKind(kind: string): kind is ExtensionKind {
  return VALID_EXTENSION_KINDS.includes(kind as ExtensionKind);
}

export function validateExtensionDeclaration(extension: AgentExtension): { valid: boolean; error?: string } {
  const kind = extension.params && typeof extension.params === 'object'
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
 * Code -32008 (not in SDK, which stops at -32007).
 */
export class ExtensionSupportRequiredError extends Error {
  readonly code = -32008 as const;
  readonly httpStatus = 400 as const;
  readonly grpcStatus = 'FAILED_PRECONDITION' as const;
  readonly missingExtensions: string[];

  constructor(missingExtensions: string[]) {
    super(`Required extensions not supported: ${missingExtensions.join(', ')}`);
    this.name = 'ExtensionSupportRequiredError';
    this.missingExtensions = missingExtensions;
  }

  /** Convert to JSON-RPC error object */
  toJSONRPCError(): { code: number; message: string; data: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      data: { missingExtensions: this.missingExtensions },
    };
  }

  /** Convert to RFC 9457 Problem Details object with agent-actionable fields */
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

  /** Convert to a LAFSError-compatible object */
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
  /** Return 400 if required extensions are missing (default: true) */
  enforceRequired?: boolean;
}

/**
 * Express middleware for A2A extension negotiation.
 *
 * Parses A2A-Extensions header (and X-A2A-Extensions for SDK compat),
 * validates against declared extensions, sets response header with
 * activated extensions, attaches result to res.locals.a2aExtensions.
 */
export function extensionNegotiationMiddleware(
  options: ExtensionNegotiationMiddlewareOptions
): RequestHandler {
  const { extensions, enforceRequired = true } = options;

  return function extensionNegotiationHandler(
    req: Request,
    res: Response,
    next: NextFunction
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

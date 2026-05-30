/**
 * Gateway contract — the transport-agnostic CQRS dispatch shapes.
 *
 * Every operation flows through:
 *   GatewayRequest → Middleware → DomainHandler → GatewayResponse
 *
 * These shapes were promoted verbatim from `packages/cleo/src/dispatch/types.ts`
 * into `@cleocode/contracts/gateway` (R3-T2 · T11446 · SG-RUNTIME-UNIFICATION)
 * so that EVERY transport adapter — CLI, MCP, RPC, HTTP — shares one canonical,
 * zod-validated contract instead of the CLI owning a private copy. The CLI was
 * the only historical transport (`Source = 'cli'`); {@link GatewaySource} now
 * widens that to the four planned transports.
 *
 * Design: the zod schemas are the single source of truth (AC8 — runtime
 * validation at untrusted transport boundaries such as MCP/RPC/HTTP). The TS
 * types are derived via {@link https://zod.dev | z.infer}, so the static and
 * runtime contracts can never drift. The behavioral contracts that zod cannot
 * model (function types: {@link DomainHandler}, {@link Middleware},
 * {@link DispatchNext}) remain TS-only and reference the inferred data types.
 *
 * @epic T4820
 * @task T11446
 * @saga T11243
 */

import type { LAFSPage, MVILevel } from '@cleocode/lafs';
import { isMVILevel } from '@cleocode/lafs';
import { z } from 'zod';
import type { CanonicalDomain, Gateway, Tier } from './dispatch/identity.js';
import type { ProblemDetails } from './engine-result.js';

export { CANONICAL_DOMAINS } from './dispatch/identity.js';
export type { CanonicalDomain, Gateway, Tier };

/**
 * Frozen version of the gateway contract. Bump on any breaking change to the
 * request/response/error shapes; the freeze + spec are owned by R3-T8 (T11452).
 */
export const GATEWAY_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// GatewaySource — transport of origin
// ---------------------------------------------------------------------------

/** The four canonical transports a gateway request can originate from. */
export const GATEWAY_SOURCES = ['cli', 'mcp', 'rpc', 'http'] as const;

/** Where a gateway request originated. Widened from the historical CLI-only `'cli'`. */
export const gatewaySourceSchema = z.enum(GATEWAY_SOURCES);

/** Where a gateway request originated. */
export type GatewaySource = z.infer<typeof gatewaySourceSchema>;

/**
 * @deprecated Use {@link GatewaySource}. Retained as a structural alias so the
 * historical `import type { Source }` sites keep compiling unchanged.
 */
export type Source = GatewaySource;

// ---------------------------------------------------------------------------
// Foreign-type bridges (kept opaque to avoid re-deriving lafs/contracts schemas)
// ---------------------------------------------------------------------------

/** MVI verbosity level — validated through lafs's own {@link isMVILevel} guard (DRY SoT). */
const mviLevelSchema = z.custom<MVILevel>((v) => isMVILevel(v));

/** LAFS pagination envelope — produced internally; carried opaquely across transports. */
const lafsPageSchema = z.custom<LAFSPage>();

/** RFC 9457 Problem Details — produced internally from CleoError.toProblemDetails(). */
const problemDetailsSchema = z.custom<ProblemDetails>();

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * Canonical request shape produced by every transport adapter. The dispatcher
 * validates this against the OperationRegistry before passing it through the
 * middleware pipeline and into a {@link DomainHandler}.
 */
export const dispatchRequestSchema = z.object({
  /** CQRS gateway (command/query). */
  gateway: z.custom<Gateway>(),
  /** Target domain (canonical name). */
  domain: z.string(),
  /** Domain-specific operation name. */
  operation: z.string(),
  /** Operation parameters (already sanitized by middleware). */
  params: z.record(z.string(), z.unknown()).optional(),
  /** Which transport this request came from. */
  source: gatewaySourceSchema,
  /** Unique request identifier for tracing. */
  requestId: z.string(),
  /** Bound session ID, if any. */
  sessionId: z.string().optional(),
  /** Root session that originated the workflow/saga, if any. */
  originSessionId: z.string().optional(),
  /** Specific execution instance for this command/step, if any. */
  executionSessionId: z.string().optional(),
  /** LAFS field selection: filter response data to these fields only. */
  _fields: z.array(z.string()).optional(),
  /** LAFS envelope verbosity. Defaults to 'standard'. 'custom' is server-set via _fields. */
  _mvi: mviLevelSchema.optional(),
});

/** {@inheritDoc dispatchRequestSchema} */
export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;

// ---------------------------------------------------------------------------
// DispatchResponse + supporting shapes
// ---------------------------------------------------------------------------

/** Rate-limit metadata attached to every response. */
export const rateLimitMetaSchema = z.object({
  limit: z.number(),
  remaining: z.number(),
  resetMs: z.number(),
  category: z.string(),
});

/** {@inheritDoc rateLimitMetaSchema} */
export type RateLimitMeta = z.infer<typeof rateLimitMetaSchema>;

/** Structured error shape (LAFS-compatible). */
export const dispatchErrorSchema = z.object({
  /** Machine-readable error code (E_NOT_FOUND, E_VALIDATION_FAILED, …). */
  code: z.string(),
  /** LAFS exit code (1-99). */
  exitCode: z.number().optional(),
  /** Human-readable message. */
  message: z.string(),
  /** Additional structured details. */
  details: z.record(z.string(), z.unknown()).optional(),
  /** Copy-paste fix command. */
  fix: z.string().optional(),
  /** Alternative actions the caller can try. */
  alternatives: z.array(z.object({ action: z.string(), command: z.string() })).optional(),
  /** RFC 9457 Problem Details (populated from CleoError.toProblemDetails()). */
  problemDetails: problemDetailsSchema.optional(),
});

/** {@inheritDoc dispatchErrorSchema} */
export type DispatchError = z.infer<typeof dispatchErrorSchema>;

/**
 * Always-present metadata block on every {@link DispatchResponse}.
 *
 * The catch-all (`[key: string]: unknown`) makes this assignable to
 * `Record<string, unknown>` in covariant positions, eliminating the T9767
 * cast-chain anti-pattern at every responseMeta call site.
 *
 * @task T9767
 */
export const dispatchResponseMetaSchema = z
  .object({
    gateway: z.custom<Gateway>(),
    domain: z.string(),
    operation: z.string(),
    timestamp: z.string(),
    duration_ms: z.number(),
    source: gatewaySourceSchema,
    requestId: z.string(),
    rateLimit: rateLimitMetaSchema.optional(),
    /** Session ID that processed this request (T4959). */
    sessionId: z.string().optional(),
    /** Root session that originated the workflow/saga. */
    originSessionId: z.string().optional(),
    /** Specific execution instance for this command/step. */
    executionSessionId: z.string().optional(),
    /** Preserves protocol-level version for backward compat. */
    version: z.string().optional(),
  })
  .catchall(z.unknown());

/** {@inheritDoc dispatchResponseMetaSchema} */
export type DispatchResponseMeta = z.infer<typeof dispatchResponseMetaSchema>;

/**
 * Canonical response shape returned by the dispatcher. The CLI adapter
 * translates this into cliOutput() / cliError() + process.exit(); other
 * transports serialize it onto their wire.
 */
export const dispatchResponseSchema = z.object({
  /** Always-present metadata for every dispatch response. */
  meta: dispatchResponseMetaSchema,
  success: z.boolean(),
  data: z.unknown().optional(),
  page: lafsPageSchema.optional(),
  partial: z.boolean().optional(),
  error: dispatchErrorSchema.optional(),
});

/** {@inheritDoc dispatchResponseSchema} */
export type DispatchResponse = z.infer<typeof dispatchResponseSchema>;

// ---------------------------------------------------------------------------
// GatewayStreamEvent — for streaming transports (SSE/HTTP, RPC server-push)
// ---------------------------------------------------------------------------

/**
 * A single frame emitted by a streaming gateway operation. Unary transports
 * (CLI) never see these; streaming transports (Studio SSE, RPC server-push)
 * emit a sequence terminated by a `done` or `error` event.
 */
export const gatewayStreamEventSchema = z.object({
  /** Frame kind: incremental data, terminal success, or terminal error. */
  kind: z.enum(['data', 'done', 'error']),
  /** Monotonic sequence number within the stream (0-based). */
  seq: z.number(),
  /** Payload for `data`/`done` frames. */
  data: z.unknown().optional(),
  /** Error detail for `error` frames. */
  error: dispatchErrorSchema.optional(),
  /** Correlates the stream back to its originating request. */
  requestId: z.string(),
});

/** {@inheritDoc gatewayStreamEventSchema} */
export type GatewayStreamEvent = z.infer<typeof gatewayStreamEventSchema>;

// ---------------------------------------------------------------------------
// Behavioral contracts (function types — TS-only; zod cannot model functions)
// ---------------------------------------------------------------------------

/**
 * Contract for domain handlers.
 *
 * Each canonical domain (tasks, session, memory, check, pipeline, orchestrate,
 * tools, admin, nexus, sticky, intelligence) implements this interface.
 */
export interface DomainHandler {
  /** Execute a read-only query operation. */
  query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse>;
  /** Execute a state-modifying mutation operation. */
  mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse>;
  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] };
}

/** Async continuation that produces a {@link DispatchResponse}. */
export type DispatchNext = () => Promise<DispatchResponse>;

/**
 * Middleware function signature. Receives the request and a `next`
 * continuation; can short-circuit (e.g. rate-limit exceeded) or modify the
 * request/response.
 */
export type Middleware = (
  request: DispatchRequest,
  next: DispatchNext,
) => Promise<DispatchResponse>;

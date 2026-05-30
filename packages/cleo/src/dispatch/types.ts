/**
 * Unified CQRS Dispatch Layer — Shared Types (thin re-export shim).
 *
 * The canonical gateway contract was promoted to `@cleocode/contracts/gateway`
 * (R3-T2 · T11446 · SG-RUNTIME-UNIFICATION) so every transport adapter — not
 * just the CLI — shares one zod-validated contract. This file re-exports it so
 * the in-package import sites that reference `'./types.js'` keep compiling
 * unchanged (zero behavior change). New code SHOULD import from
 * `'@cleocode/contracts/gateway'` directly.
 *
 * @epic T4820
 * @task T11446
 */

// Parameter descriptors continue to live in the main contracts barrel.
export type { OperationParams, ParamCliDef, ParamDef, ParamType } from '@cleocode/contracts';
export type {
  CanonicalDomain,
  DispatchError,
  DispatchNext,
  DispatchRequest,
  DispatchResponse,
  DispatchResponseMeta,
  DomainHandler,
  Gateway,
  GatewaySource,
  GatewayStreamEvent,
  Middleware,
  RateLimitMeta,
  Source,
  Tier,
} from '@cleocode/contracts/gateway';
// Gateway contract (promoted SoT). `Source` is the deprecated alias of
// `GatewaySource`; widening the CLI-only `'cli'` to the 4-transport union is
// backward-compatible (every existing call site assigns `'cli'`).
export {
  CANONICAL_DOMAINS,
  dispatchErrorSchema,
  dispatchRequestSchema,
  dispatchResponseMetaSchema,
  dispatchResponseSchema,
  GATEWAY_CONTRACT_VERSION,
  GATEWAY_SOURCES,
  gatewaySourceSchema,
  gatewayStreamEventSchema,
  rateLimitMetaSchema,
} from '@cleocode/contracts/gateway';

/**
 * The transport-neutral gateway handler (relocated from `gateway/index.ts`,
 * T13126) so the light `@cleocode/runtime/gateway/dispatch` entry can export
 * it without loading the HTTP, MCP and RPC transports.
 *
 * @task T13126
 */

import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { Dispatcher, type DispatcherConfig } from './dispatcher.js';

/**
 * Transport-agnostic gateway entrypoint. Wraps a configured {@link Dispatcher}
 * (`compose(middlewares) → DomainHandler`) behind a single `handle()` call that
 * every transport adapter (CLI/MCP/RPC/HTTP) invokes uniformly. The adapter
 * owns wire concerns (error-render, `process.exit`, serialization); the handler
 * only resolves, validates, runs middleware, and returns a {@link DispatchResponse}.
 */
export interface GatewayHandler {
  /** Route one gateway request through the dispatch pipeline. */
  handle(req: DispatchRequest): Promise<DispatchResponse>;
}

/**
 * Build a {@link GatewayHandler} from a {@link DispatcherConfig} (injected
 * domain handlers + middleware). The returned handler is transport-neutral.
 */
export function createGatewayHandler(config: DispatcherConfig): GatewayHandler {
  const dispatcher = new Dispatcher(config);
  return { handle: (req: DispatchRequest): Promise<DispatchResponse> => dispatcher.dispatch(req) };
}

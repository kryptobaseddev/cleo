/**
 * Unified CQRS Dispatch Layer -- Middleware Pipeline
 *
 * Provides compose() to chain multiple Middleware functions together
 * into a single executable pipeline.
 *
 * @epic T4820
 * @task T4815
 */

import { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../types.js';

/**
 * Composes an array of Middleware functions into a single Middleware function.
 * Execution flows through the array from first to last, and returns bubble
 * back up from last to first.
 *
 * @param middlewares Array of middleware functions to chain
 * @returns A single composed Middleware function
 */
export function compose(middlewares: Middleware[]): Middleware {
  if (middlewares.length === 0) {
    return async (_req: DispatchRequest, next: DispatchNext) => next();
  }

  return async (request: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    let index = -1;

    async function dispatch(i: number): Promise<DispatchResponse> {
      if (i <= index) {
        throw new Error('next() called multiple times in middleware');
      }
      index = i;

      let fn: Middleware | undefined = middlewares[i];
      if (i === middlewares.length) {
        // We've reached the end of the middleware chain; call the final handler
        fn = async (_req, nxt) => nxt();
      }

      if (!fn) {
        return next();
      }

      return fn(request, async () => {
        if (i === middlewares.length) {
          return next();
        }
        return dispatch(i + 1);
      });
    }

    return dispatch(0);
  };
}

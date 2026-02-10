/**
 * Domain Operation Types
 *
 * Defines the structure for domain-specific operations and routing.
 */

import { DomainName } from './gateway.js';

/**
 * Operation metadata
 */
export interface OperationMeta {
  domain: DomainName;
  operation: string;
  description: string;
  gateway: 'cleo_query' | 'cleo_mutate';
  retryable?: boolean;
}

/**
 * Domain operation definition
 */
export interface DomainOperation<TParams = unknown, TResult = unknown> {
  meta: OperationMeta;
  params: TParams;
  result: TResult;
}

/**
 * Operation registry type for domain implementations
 */
export type OperationRegistry = Record<string, DomainOperation<any, any>>;

/**
 * Schema utilities for the CQRS dispatch layer.
 *
 * Provides getOperationSchema() — a convenience function that looks up an
 * OperationDef from the OPERATIONS registry and returns a JSON Schema object
 * suitable for MCP tool introspection.
 *
 * This bridges the registry (single source of truth) and the MCP gateway
 * definitions so that input_schema values are auto-derived, not hardcoded.
 *
 *  T4894
 *  T4901
 */

import type { Gateway } from '../types.js';
import { OPERATIONS } from '../registry.js';
import { buildMcpInputSchema, type JSONSchemaObject } from './param-utils.js';

/**
 * Permissive fallback schema returned when an operation has no declared params.
 *
 * An empty params array means "no declared params" (not "no params accepted"),
 * so we return an open object schema.
 */
const PERMISSIVE_SCHEMA: JSONSchemaObject = {
  type: 'object',
  properties: {},
  required: [],
};

/**
 * Look up an operation in the OPERATIONS registry and return a JSON Schema
 * object suitable for use as `input_schema.properties.params` or as a
 * stand-alone per-operation schema.
 *
 * @param domain    Canonical domain name (e.g. 'tasks', 'session')
 * @param operation Operation name (e.g. 'show', 'add')
 * @param gateway   Gateway ('query' or 'mutate')
 * @returns JSONSchemaObject derived from ParamDef[], or permissive fallback
 *
 * @example
 * // tasks.show → { type: 'object', properties: { taskId: {...} }, required: ['taskId'] }
 * getOperationSchema('tasks', 'show', 'query');
 *
 * // tasks.current → { type: 'object', properties: {}, required: [] }
 * getOperationSchema('tasks', 'current', 'query');
 */
export function getOperationSchema(
  domain: string,
  operation: string,
  gateway: Gateway,
): JSONSchemaObject {
  const def = OPERATIONS.find(
    o => o.domain === domain && o.operation === operation && o.gateway === gateway,
  );

  if (!def || (def.params ?? []).length === 0) {
    return PERMISSIVE_SCHEMA;
  }

  return buildMcpInputSchema(def);
}

/**
 * Return schemas for ALL operations of a given gateway.
 *
 * Useful for documentation generation and tool introspection endpoints.
 *
 * @returns Record keyed by "<domain>.<operation>" → JSONSchemaObject
 */
export function getAllOperationSchemas(
  gateway: Gateway,
): Record<string, JSONSchemaObject> {
  const result: Record<string, JSONSchemaObject> = {};

  for (const def of OPERATIONS) {
    if (def.gateway !== gateway) continue;
    const key = `${def.domain}.${def.operation}`;
    result[key] = (def.params ?? []).length === 0
      ? PERMISSIVE_SCHEMA
      : buildMcpInputSchema(def);
  }

  return result;
}

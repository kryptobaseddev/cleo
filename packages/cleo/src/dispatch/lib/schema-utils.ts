/**
 * Schema utilities for the CQRS dispatch layer.
 *
 * Provides getOperationSchema() — a convenience function that looks up an
 * OperationDef from the OPERATIONS registry and returns a JSON Schema object
 * suitable for tool introspection.
 *
 *  T4894
 *  T4901
 */

import { OPERATIONS, type OperationDef } from '../registry.js';
import type { Gateway } from '../types.js';
import type { JSONSchemaObject, JsonSchemaProperty, JsonSchemaType } from './param-utils.js';

/**
 * Build an input schema directly from cleo's OperationDef.
 *
 * Derives a JSON Schema object from the ParamDef array, filtering
 * hidden params and applying enum constraints.
 */
function buildInputSchema(def: OperationDef): JSONSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of def.params ?? []) {
    if (param.hidden) continue;

    const prop: JsonSchemaProperty = {
      type: param.type as JsonSchemaType,
      description: param.description,
    };

    if (param.enum) prop.enum = [...param.enum];

    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  return { type: 'object', properties, required };
}

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
    (o) => o.domain === domain && o.operation === operation && o.gateway === gateway,
  );

  if (!def || (def.params ?? []).length === 0) {
    return PERMISSIVE_SCHEMA;
  }

  return buildInputSchema(def);
}

/**
 * Return schemas for ALL operations of a given gateway.
 *
 * Useful for documentation generation and tool introspection endpoints.
 *
 * @returns Record keyed by "<domain>.<operation>" → JSONSchemaObject
 */
export function getAllOperationSchemas(gateway: Gateway): Record<string, JSONSchemaObject> {
  const result: Record<string, JSONSchemaObject> = {};

  for (const def of OPERATIONS) {
    if (def.gateway !== gateway) continue;
    const key = `${def.domain}.${def.operation}`;
    result[key] = (def.params ?? []).length === 0 ? PERMISSIVE_SCHEMA : buildInputSchema(def);
  }

  return result;
}

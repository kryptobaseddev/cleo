/**
 * Param derivation utilities for the CQRS dispatch layer.
 *
 * Converts `OperationDef.params` into the shapes required by:
 *  - Commander.js (CLI adapter): positionals + option strings
 *  - MCP JSON Schema (MCP adapter): input_schema object
 *
 *  T4894
 *  T4900
 */

import type { OperationDef } from '../registry.js';
import type { ParamDef } from '../types.js';

// ---------------------------------------------------------------------------
// JSON Schema subset for MCP input_schema
// ---------------------------------------------------------------------------

export type JsonSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description: string;
  enum?: readonly string[];
  items?: { type: JsonSchemaType };
}

export interface JSONSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

// ---------------------------------------------------------------------------
// 1. buildMcpInputSchema
// ---------------------------------------------------------------------------

/**
 * Build a JSON Schema `input_schema` object from an `OperationDef`.
 *
 * Algorithm:
 *  1. Iterate `def.params`
 *  2. Skip params where `mcp.hidden === true`
 *  3. Map ParamType → JSON Schema type
 *  4. Collect names where `required === true` into `required[]`
 *  5. Return { type: 'object', properties, required }
 */
export function buildMcpInputSchema(def: OperationDef): JSONSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of (def.params ?? [])) {
    // Skip CLI-only params from MCP schema
    if (param.mcp?.hidden === true) continue;

    const prop: JsonSchemaProperty = {
      type: paramTypeToJsonSchema(param.type),
      description: param.description,
    };

    if (param.type === 'array') {
      prop.items = { type: 'string' };
    }

    if (param.mcp?.enum) {
      prop.enum = param.mcp.enum;
    }

    properties[param.name] = prop;

    if (param.required) {
      required.push(param.name);
    }
  }

  return { type: 'object', properties, required };
}

function paramTypeToJsonSchema(t: ParamDef['type']): JsonSchemaType {
  switch (t) {
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'array':   return 'array';
  }
}

// ---------------------------------------------------------------------------
// 2. buildCommanderArgs
// ---------------------------------------------------------------------------

export interface CommanderArgSplit {
  /** Params that map to `.argument('<name>')` or `.argument('[name]')`. */
  positionals: ParamDef[];
  /** Params that map to `.option(...)` calls. */
  options: ParamDef[];
}

/**
 * Split `OperationDef.params` into positional arguments and option flags,
 * suitable for Commander.js registration.
 *
 * - `cli.positional === true` → goes into `positionals[]`
 * - everything else with a `cli` key → goes into `options[]`
 * - Params with no `cli` key → MCP-only; excluded from both arrays
 */
export function buildCommanderArgs(def: OperationDef): CommanderArgSplit {
  const positionals: ParamDef[] = [];
  const options: ParamDef[] = [];

  for (const param of (def.params ?? [])) {
    // Params with no cli key are MCP-only — skip for Commander
    if (param.cli === undefined) continue;

    if (param.cli.positional === true) {
      positionals.push(param);
    } else {
      options.push(param);
    }
  }

  return { positionals, options };
}

// ---------------------------------------------------------------------------
// 3. buildCommanderOptionString
// ---------------------------------------------------------------------------

/**
 * Build the Commander option string for a single non-positional ParamDef.
 *
 * Examples:
 *   { name:'taskId', type:'string', cli:{} }
 *     → '--taskId <taskId>'
 *   { name:'status', type:'string', cli:{short:'-s', flag:'status'} }
 *     → '-s, --status <status>'
 *   { name:'dryRun', type:'boolean', cli:{flag:'dry-run'} }
 *     → '--dry-run'
 *   { name:'limit', type:'number', cli:{} }
 *     → '--limit <limit>'
 */
export function buildCommanderOptionString(param: ParamDef): string {
  const flagName = param.cli?.flag ?? camelToKebab(param.name);
  const short    = param.cli?.short;

  // Boolean flags have no value placeholder
  if (param.type === 'boolean') {
    return short ? `${short}, --${flagName}` : `--${flagName}`;
  }

  const placeholder = `<${flagName}>`;
  return short
    ? `${short}, --${flagName} ${placeholder}`
    : `--${flagName} ${placeholder}`;
}

/**
 * Convert a camelCase string to kebab-case.
 * e.g. 'includeArchive' → 'include-archive'
 */
export function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase();
}

// ---------------------------------------------------------------------------
// 4. validateRequiredParamsDef
// ---------------------------------------------------------------------------

/**
 * Validates that all required parameters are present in the request.
 * Returns an array of missing parameter names.
 *
 * Replaces the old `requiredParams: string[]` check in registry.ts.
 */
export function validateRequiredParamsDef(
  def: OperationDef,
  params?: Record<string, unknown>,
): string[] {
  const provided = params ?? {};
  return (def.params ?? [])
    .filter((p: ParamDef) => p.required)
    .filter((p: ParamDef) => provided[p.name] === undefined || provided[p.name] === null || provided[p.name] === '')
    .map((p: ParamDef) => p.name);
}

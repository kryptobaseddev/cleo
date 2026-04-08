/**
 * Param derivation utilities (Core).
 *
 * Converts operation parameter definitions into the shapes required by:
 *  - Commander.js (CLI adapter): positionals + option strings
 *  - JSON Schema (dispatch adapter): input_schema object
 *
 * Canonical location: src/core/validation/param-utils.ts
 * Re-exported from: src/dispatch/lib/param-utils.ts (backward compat)
 *
 * @task T4894
 * @task T4900
 * @task T5706
 */

// Inlined from dispatch layer — these types define operation/param shapes
// used for building CLI args and dispatch schemas. Kept here to avoid
// core depending on dispatch (wrong direction).
interface OperationDef {
  gateway: string;
  domain: string;
  operation: string;
  description: string;
  tier: number;
  params?: ParamDef[];
  [key: string]: unknown;
}

type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object';

interface ParamCliDef {
  positional?: boolean;
  variadic?: boolean;
  alias?: string;
  flag?: string;
  short?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

interface ParamSchemaDef {
  name?: string;
  description?: string;
  enum?: string[];
  hidden?: boolean;
  [key: string]: unknown;
}

interface ParamDef {
  name: string;
  type: ParamType;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
  items?: { type: ParamType };
  cli?: ParamCliDef;
  /** Schema config for dispatch adapter. */
  dispatch?: ParamSchemaDef;
}

// ---------------------------------------------------------------------------
// JSON Schema subset for dispatch input_schema
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
// 1. buildDispatchInputSchema
// ---------------------------------------------------------------------------

/**
 * Build a JSON Schema `input_schema` object from an `OperationDef`.
 *
 * Algorithm:
 *  1. Iterate `def.params`
 *  2. Skip params where schema `dispatch.hidden === true`
 *  3. Map ParamType → JSON Schema type
 *  4. Collect names where `required === true` into `required[]`
 *  5. Return { type: 'object', properties, required }
 */
export function buildDispatchInputSchema(def: OperationDef): JSONSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const param of def.params ?? []) {
    // Skip CLI-only params from dispatch schema
    if (param.dispatch?.hidden === true) continue;

    const prop: JsonSchemaProperty = {
      type: paramTypeToJsonSchema(param.type),
      description: param.description,
    };

    if (param.type === 'array') {
      prop.items = { type: 'string' };
    }

    if (param.dispatch?.enum) {
      prop.enum = param.dispatch.enum;
    }

    properties[param.name] = prop;

    if (param.required) {
      required.push(param.name);
    }
  }

  return { type: 'object', properties, required };
}

/** @deprecated Use {@link buildDispatchInputSchema} instead. */
export const buildMcpInputSchema = buildDispatchInputSchema;

function paramTypeToJsonSchema(t: ParamDef['type']): JsonSchemaType {
  switch (t) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
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
 * - Params with no `cli` key → dispatch-only; excluded from both arrays
 */
export function buildCommanderArgs(def: OperationDef): CommanderArgSplit {
  const positionals: ParamDef[] = [];
  const options: ParamDef[] = [];

  for (const param of def.params ?? []) {
    // Params with no cli key are dispatch-only — skip for Commander
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
  const short = param.cli?.short;

  // Boolean flags have no value placeholder
  if (param.type === 'boolean') {
    return short ? `${short}, --${flagName}` : `--${flagName}`;
  }

  const placeholder = `<${flagName}>`;
  return short ? `${short}, --${flagName} ${placeholder}` : `--${flagName} ${placeholder}`;
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
    .filter(
      (p: ParamDef) =>
        provided[p.name] === undefined || provided[p.name] === null || provided[p.name] === '',
    )
    .map((p: ParamDef) => p.name);
}

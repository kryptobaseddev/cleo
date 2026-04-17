/**
 * ParamDef contract — canonical parameter descriptor for all CLEO operations.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the `ParamDef` type.
 * All packages that describe operation parameters MUST import from here.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/params
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The concrete value types a parameter can carry at runtime.
 * Drives JSON Schema `type` and citty argument/option parsing.
 */
export type ParamType = 'string' | 'number' | 'boolean' | 'array';

/**
 * CLI-specific decoration for a single parameter.
 *
 * Omit the entire `cli` key for parameters that have no CLI surface
 * (e.g. parameters only used internally by the dispatch engine).
 */
export interface ParamCliDef {
  /**
   * When `true`, the parameter is registered as a positional argument
   * (`<name>` or `[name]`) rather than a named option flag (`--name`).
   *
   * @default false
   */
  positional?: boolean;

  /**
   * Short single-character flag alias, e.g. `'-t'` for `--type`.
   * Only meaningful when `positional` is `false` or omitted.
   */
  short?: string;

  /**
   * Override the CLI flag name when it differs from the param `name`.
   * For example: `name: 'includeArchive'` but `flag: 'include-archive'`.
   * Defaults to the kebab-case form of `name`.
   */
  flag?: string;

  /**
   * For `array`-type params: when `true` the flag may be repeated on the CLI.
   * When `false` / omitted, the CLI accepts a single comma-separated string.
   *
   * @default false
   */
  variadic?: boolean;
}

/**
 * A fully-described parameter definition for a CLEO operation.
 *
 * One `ParamDef` entry drives:
 * - citty CLI: `.argument()` (positional) or `.option()` (named flag)
 * - JSON Schema generation for API clients
 * - Dispatch-layer validation against `requiredParams`
 */
export interface ParamDef {
  /**
   * Canonical camelCase parameter name.
   * Must match the key in the `params` dict sent to the dispatcher.
   */
  name: string;

  /** Runtime value type. Drives JSON Schema `type` and CLI parsing. */
  type: ParamType;

  /**
   * Whether this parameter must be present in every request.
   * Required parameters are also listed in `OperationDef.requiredParams`.
   */
  required: boolean;

  /** Human-readable description used in CLI help text and API docs. */
  description: string;

  /**
   * CLI-specific metadata.
   * Omit when the parameter is not exposed on the CLI surface.
   */
  cli?: ParamCliDef;

  /**
   * Allowed string values (JSON Schema `enum` constraint).
   * Use only for `string`-typed params with a finite set of valid values.
   */
  enum?: readonly string[];

  /**
   * When `true`, the parameter is excluded from JSON Schema generation.
   * Use for CLI-only params (e.g. `--dry-run`, `--offset`) that are not
   * part of the public API surface.
   *
   * @default false
   */
  hidden?: boolean;
}

/**
 * Ordered list of parameter definitions for a single operation.
 *
 * An empty array means "no declared params" — NOT "no params accepted".
 * Operations using `requiredParams: []` with no `params` key are legacy
 * entries that have not yet been migrated to the full `ParamDef` shape.
 */
export type OperationParams = ParamDef[];

// ---------------------------------------------------------------------------
// Citty integration
// ---------------------------------------------------------------------------

/**
 * Subset of citty's `ArgDef` used by the converter.
 * Only the fields that `ParamDef` can supply are included.
 */
export interface CittyArgDef {
  /** citty arg type ('boolean' | 'string' | 'enum' | 'positional') */
  type?: 'boolean' | 'string' | 'enum' | 'positional';
  /** Human-readable description shown in `--help` output */
  description?: string;
  /** Short flag alias (single character, without leading dash) */
  alias?: string;
  /** Whether the argument is required */
  required?: boolean;
  /** Allowed values for `enum`-typed args */
  options?: string[];
}

/**
 * Convert an array of `ParamDef` entries into a `Record<string, CittyArgDef>`
 * that can be passed directly to `defineCommand({ args: ... })`.
 *
 * Mapping rules:
 * - `type: 'boolean'`  → citty `type: 'boolean'`
 * - `type: 'string'`   → citty `type: 'string'`; `type: 'enum'` when `enum` is set
 * - `type: 'number'`   → citty `type: 'string'` (caller must `parseInt`/`parseFloat`)
 * - `type: 'array'`    → citty `type: 'string'` (caller handles splitting)
 * - `cli.positional`   → citty `type: 'positional'`
 * - `cli.short`        → citty `alias`
 * - `enum`             → citty `options` with citty `type: 'enum'`
 *
 * @param params - The `ParamDef[]` from an `OperationDef`.
 * @returns A `Record<string, CittyArgDef>` ready for use as `args` in `defineCommand`.
 */
export function paramsToCittyArgs(params: OperationParams): Record<string, CittyArgDef> {
  const result: Record<string, CittyArgDef> = {};

  for (const param of params) {
    const argName = param.cli?.flag ?? param.name;
    const arg: CittyArgDef = {
      description: param.description,
    };

    if (param.cli?.positional === true) {
      arg.type = 'positional';
      arg.required = param.required;
    } else if (param.enum !== undefined && param.enum.length > 0) {
      arg.type = 'enum';
      arg.options = [...param.enum];
      if (param.required) arg.required = true;
    } else if (param.type === 'boolean') {
      arg.type = 'boolean';
    } else {
      // string, number, and array all map to citty 'string'
      // (number/array require caller-side parsing after arg extraction)
      arg.type = 'string';
      if (param.required) arg.required = true;
    }

    if (param.cli?.short !== undefined) {
      arg.alias = param.cli.short.replace(/^-/, '');
    }

    result[argName] = arg;
  }

  return result;
}

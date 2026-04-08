/**
 * ParamDef-driven Commander help generator.
 *
 * Provides two functions:
 *  - `buildOperationHelp()` — emits a multi-section help string (Description,
 *    USAGE, ARGUMENTS, OPTIONS, PRECONDITIONS) from a ParamDef array and the
 *    static LAFS gate table.
 *  - `applyParamDefsToCommand()` — replaces hand-written `.option()` chains on
 *    a ShimCommand with generated calls derived from the same ParamDef array.
 *
 * Both functions read exactly the same source of truth that the dispatch
 * registry and `cleo schema` use, eliminating the duplication that caused
 * missing enum values, absent required indicators, and hidden gate docs.
 *
 * Gate lookup uses `describeOperation()` from `@cleocode/lafs`, which is the
 * public API over the static LAFS gate table in `operation-gates.ts`.
 *
 * @module
 * @epic T335
 * @task T339
 */

import { describeOperation, type OperationGateSchema } from '@cleocode/lafs';
import type { ParamDef } from '../dispatch/types.js';
import type { ShimCommand } from './commander-shim.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase identifier to kebab-case CLI flag name.
 *
 * @param name - camelCase string (e.g. `"dryRun"`)
 * @returns kebab-case string (e.g. `"dry-run"`)
 */
function toKebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Retrieve precondition gates for an operation key using the public
 * `describeOperation()` API from `@cleocode/lafs`.
 *
 * Parses `"tasks.add"` → `{ domain: "tasks", operation: "add" }` and calls
 * `describeOperation` with the minimum required fields so that the static
 * LAFS gate table lookup succeeds.
 *
 * @param operationKey - Fully-qualified operation key, e.g. `"tasks.add"`.
 * @param params - ParamDef array for the operation (may be empty).
 * @returns Array of {@link OperationGateSchema} entries, possibly empty.
 */
function getGatesForOperation(
  operationKey: string,
  params: readonly ParamDef[],
): OperationGateSchema[] {
  const dotIdx = operationKey.indexOf('.');
  if (dotIdx === -1) return [];

  const domain = operationKey.slice(0, dotIdx);
  const operation = operationKey.slice(dotIdx + 1);

  const schema = describeOperation(
    {
      gateway: 'query',
      domain,
      operation,
      description: '',
      params: params as Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'array';
        required: boolean;
        description: string;
        enum?: readonly string[];
        hidden?: boolean;
        cli?: {
          positional?: boolean;
          short?: string;
          flag?: string;
          variadic?: boolean;
        };
      }>,
      requiredParams: [],
    },
    { includeGates: true },
  );

  return schema.gates ?? [];
}

// ---------------------------------------------------------------------------
// buildOperationHelp
// ---------------------------------------------------------------------------

/**
 * Build a multi-section Commander-compatible help string from a ParamDef
 * array and the static LAFS gate table.
 *
 * Sections emitted:
 * - `Description:` — one-line operation summary
 * - `USAGE:` — positional args listed in required/optional angle/square brackets
 * - `ARGUMENTS:` — positional params with descriptions (omitted when none)
 * - `OPTIONS:` — flag params with type, enum values, and required indicator
 * - `PRECONDITIONS:` — gates sourced from `packages/lafs/src/operation-gates.ts`
 *   via `describeOperation()` (omitted when the gate table has no entry for
 *   this operation key)
 * - `Examples:` — pre-canned examples for the five seeded operations
 *
 * @param operationKey - Fully-qualified operation key, e.g. `"tasks.add"`.
 * @param description - One-line summary of the operation.
 * @param params - ParamDef array for the operation.
 * @returns Multi-line help string.
 */
export function buildOperationHelp(
  operationKey: string,
  description: string,
  params: readonly ParamDef[],
): string {
  // Derive the CLI noun from the operation key ("tasks.add" → "add")
  const cliName = operationKey.split('.').slice(1).join('.');

  const positionals = params.filter((p) => p.cli?.positional && !p.hidden);
  const flags = params.filter((p) => !p.cli?.positional && !p.hidden);

  // --- USAGE line ---
  const argTokens = positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(' ');
  const usageLine =
    `USAGE: cleo ${cliName}` +
    (flags.length > 0 ? ' [OPTIONS]' : '') +
    (argTokens ? ` ${argTokens}` : '');

  const lines: string[] = [];

  lines.push(`Description: ${description}`);
  lines.push('');
  lines.push(usageLine);

  // --- ARGUMENTS section ---
  if (positionals.length > 0) {
    lines.push('');
    lines.push('ARGUMENTS:');
    for (const p of positionals) {
      const indicator = p.required ? '(required)' : '(optional)';
      const namePad = p.name.padEnd(16);
      lines.push(`  ${namePad} ${p.description}  ${indicator}`);
    }
  }

  // --- OPTIONS section ---
  if (flags.length > 0) {
    lines.push('');
    lines.push('OPTIONS:');
    for (const p of flags) {
      const flagName = p.cli?.flag ?? toKebab(p.name);
      const short = p.cli?.short;
      const typeLabel = p.type !== 'boolean' ? ` <${p.type}>` : '';
      const flagStr = short
        ? `${short}, --${flagName}${typeLabel}`
        : `    --${flagName}${typeLabel}`;
      const enumSuffix = p.enum && p.enum.length > 0 ? `  [enum: ${p.enum.join('|')}]` : '';
      const reqSuffix = p.required ? '  [required]' : '';
      lines.push(`  ${flagStr.padEnd(32)} ${p.description}${enumSuffix}${reqSuffix}`);
    }
  }

  // --- PRECONDITIONS section ---
  const gates = getGatesForOperation(operationKey, params);
  if (gates.length > 0) {
    lines.push('');
    lines.push('PRECONDITIONS (gates that may fire):');
    for (const gate of gates) {
      lines.push(`  - ${gate.errorCode} [${gate.name}]: ${gate.description}`);
      for (const trigger of gate.triggers) {
        lines.push(`      * ${trigger}`);
      }
    }
  }

  // --- Examples section ---
  const EXAMPLES: Record<string, string[]> = {
    'tasks.add': [
      "  cleo add 'My task title'",
      "  cleo add 'My task' --priority high --parent T100",
      "  cleo add 'Fix login bug' --type bug --size small --acceptance 'Reproducer passes|CI green'",
    ],
    'tasks.complete': [
      '  cleo complete T123',
      '  cleo complete T123 --force',
      "  cleo complete T123 --verification-note 'All ACs verified in PR #456'",
    ],
    'tasks.show': ['  cleo show T123'],
    'tasks.find': ['  cleo find "auth"', '  cleo find --status active --limit 10'],
    'tasks.list': ['  cleo list --parent T100', '  cleo list --status active --priority high'],
  };

  const examples = EXAMPLES[operationKey];
  if (examples && examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of examples) {
      lines.push(ex);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// applyParamDefsToCommand
// ---------------------------------------------------------------------------

/**
 * Register Commander options and positional arguments on a ShimCommand from
 * a ParamDef array.
 *
 * Replaces hand-written `.option(...)` chains with a single call.
 *
 * Handles:
 * - Positional args (`cli.positional === true`) → `.argument()`
 * - Short aliases (`cli.short`) → `-s, --flag <type>`
 * - Flag name overrides (`cli.flag`) → `--custom-flag`
 * - Boolean flags (type === `'boolean'`) → no value placeholder
 * - Custom parse functions (`cli.parse`) → forwarded to `.option()`
 * - Enum constraints surfaced in the option description
 * - Required vs optional indicators appended to the description
 *
 * **Note:** The caller is still responsible for the `.action(...)` callback
 * because action bodies are command-specific and cannot be auto-generated.
 *
 * **Hybrid pattern:** Some commands keep hand-written `.option()` calls after
 * this call for options that have no ParamDef entry (e.g. `--dry-run`,
 * `--field`, `--format`, `--desc`). That is intentional — those options are
 * CLI-surface-only and do not belong in the dispatch registry.
 *
 * @param command - The ShimCommand returned by `.command(nameAndArgs)`.
 * @param params - The ParamDef array for this operation.
 * @param operationKey - `"tasks.add"` etc. Reserved for future hook or tracing
 *   use; currently not mutated on the shim since ShimCommand has no first-class
 *   help-text override API.
 */
export function applyParamDefsToCommand(
  command: ShimCommand,
  params: readonly ParamDef[],
  operationKey: string,
): void {
  // operationKey is reserved for future tracing/hook use.
  void operationKey;

  for (const p of params) {
    // Hidden params have no CLI surface — skip entirely.
    if (p.hidden) continue;

    if (p.cli?.positional) {
      // Positional arguments are registered via .argument()
      const spec = p.required ? `<${p.name}>` : `[${p.name}]`;
      command.argument(spec, p.description);
      continue;
    }

    // Build the flag string
    const flagName = p.cli?.flag ?? toKebab(p.name);
    const short = p.cli?.short;
    const typeLabel = p.type !== 'boolean' ? ` <${p.type}>` : '';
    const flagPart = short ? `${short}, --${flagName}${typeLabel}` : `--${flagName}${typeLabel}`;

    // Augment description with enum hint so agents see allowed values in --help
    const enumHint = p.enum && p.enum.length > 0 ? ` (${p.enum.join('|')})` : '';
    const reqHint = p.required ? ' [required]' : '';
    const fullDescription = `${p.description}${enumHint}${reqHint}`;

    if (p.required && p.type !== 'boolean') {
      // Use requiredOption for non-boolean required flags
      command.requiredOption(flagPart, fullDescription);
    } else if (p.cli?.parse) {
      command.option(flagPart, fullDescription, p.cli.parse as (val: string) => unknown);
    } else {
      command.option(flagPart, fullDescription);
    }
  }
}

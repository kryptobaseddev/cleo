/**
 * CLI `schema` command — operation introspection for agents.
 *
 * Allows agents to inspect the full parameter signature and declared precondition
 * gates for any CLEO operation before calling it, replacing trial-and-error.
 *
 * Usage:
 *   cleo schema <domain.operation>
 *   cleo schema tasks.add
 *   cleo schema tasks.add --format human
 *   cleo schema tasks.add --include-examples
 *
 * @task T340
 * @epic T335
 */

import { describeOperation, type OperationSchema } from '@cleocode/lafs';
import { defineCommand, showUsage } from 'citty';
import type { OperationDef } from '../../dispatch/registry.js';
import { OPERATIONS } from '../../dispatch/registry.js';
import { cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the target `OperationDef` from a `"domain.operation"` key.
 *
 * @param operationArg - The user-supplied string (e.g. `"tasks.add"`).
 * @returns The matching `OperationDef`, or `null` if not found.
 *
 * @remarks
 * The first dot separates domain from operation, so dotted operation names
 * like `"complexity.estimate"` are handled correctly.
 */
function resolveOperationDef(operationArg: string): OperationDef | null {
  const dotIdx = operationArg.indexOf('.');
  if (dotIdx === -1) {
    // No domain separator — search all domains for unambiguous match
    const matches = OPERATIONS.filter((op) => op.operation === operationArg);
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
    return null;
  }

  const domain = operationArg.slice(0, dotIdx);
  const operation = operationArg.slice(dotIdx + 1);

  return OPERATIONS.find((op) => op.domain === domain && op.operation === operation) ?? null;
}

/**
 * Format an `OperationSchema` as a human-readable summary table.
 *
 * @param schema - The operation schema to render.
 * @returns Multi-line human-readable string.
 */
function renderSchemaHuman(schema: OperationSchema): string {
  const lines: string[] = [];

  lines.push(`Operation : ${schema.operation}`);
  lines.push(`Gateway   : ${schema.gateway}`);
  lines.push(`Description: ${schema.description}`);
  lines.push('');

  lines.push('Parameters:');
  if (schema.params.length === 0) {
    lines.push('  (none declared)');
  } else {
    for (const p of schema.params) {
      const req = p.required ? '[required]' : '[optional]';
      const enumStr = p.enum ? `  enum: ${p.enum.join(' | ')}` : '';
      let cliStr = '';
      if (p.cli) {
        const parts: string[] = [];
        if (p.cli.positional) parts.push('positional');
        if (p.cli.short) parts.push(`short: ${p.cli.short}`);
        if (p.cli.flag) parts.push(`flag: --${p.cli.flag}`);
        if (parts.length > 0) cliStr = `  cli: ${parts.join(', ')}`;
      }
      lines.push(`  ${p.name} (${p.type}) ${req}`);
      lines.push(`    ${p.description}${enumStr}${cliStr}`);
    }
  }

  if (schema.gates !== undefined) {
    lines.push('');
    lines.push('Gates:');
    if (schema.gates.length === 0) {
      lines.push('  (none declared — see note on static gate table)');
    } else {
      for (const g of schema.gates) {
        lines.push(`  ${g.name} → ${g.errorCode}`);
        lines.push(`    ${g.description}`);
        for (const t of g.triggers) {
          lines.push(`    - ${t}`);
        }
      }
    }
  }

  if (schema.examples !== undefined && schema.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of schema.examples) {
      lines.push(`  ${ex.command}`);
      lines.push(`    ${ex.description}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Native citty command for `cleo schema <operation>`.
 *
 * Does NOT dispatch through the main dispatcher — schema introspection is
 * pure metadata over the registry and does not require a live session or DB.
 */
export const schemaCommand = defineCommand({
  meta: {
    name: 'schema',
    description: 'Introspect a CLEO operation: show params, types, enums, and declared gates',
  },
  args: {
    operation: {
      type: 'positional',
      description: 'Operation key in domain.operation format (e.g. tasks.add)',
      required: false,
    },
    format: {
      type: 'string',
      description: 'Output format: json (default) or human (pretty table)',
      default: 'json',
    },
    'include-gates': {
      type: 'boolean',
      description: 'Include precondition gates in output (default: true)',
      default: true,
    },
    'include-examples': {
      type: 'boolean',
      description: 'Include usage examples in output (default: false)',
      default: false,
    },
  },
  async run({ args, cmd }) {
    if (!args.operation) {
      await showUsage(cmd);
      return;
    }
    const format = args.format ?? 'json';
    const includeGates = args['include-gates'] !== false;
    const includeExamples = args['include-examples'] === true;

    const def = resolveOperationDef(args.operation);

    if (def === null) {
      cliError(
        `Unknown operation: "${args.operation}". Run \`cleo schema --list\` to see all operations.`,
        4,
        {
          name: 'E_NOT_FOUND',
          fix: 'cleo schema --list',
        },
      );
      process.exit(4);
      return;
    }

    const schema: OperationSchema = describeOperation(def, {
      includeGates,
      includeExamples,
    });

    if (format === 'human') {
      console.log(renderSchemaHuman(schema));
      return;
    }

    cliOutput(schema, {
      command: 'schema',
      operation: `schema.${args.operation}`,
      message: `Schema for ${schema.operation}`,
    });
  },
});

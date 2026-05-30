/**
 * describeSchema — pure-functional SDK tool that returns a JSON descriptor of
 * all drizzle tables and their columns, sourced from the tasks-schema barrel.
 *
 * This is a Category B SDK Tool: harness-agnostic, no I/O, no database
 * connection required. The drizzle schema objects are introspected statically
 * via `getTableColumns` and the internal `ExtraConfigBuilder` symbol.
 *
 * @arch SDK Tool (Category B) — T10071 / Epic T9835 / Saga T9831
 * @task T10071
 *
 * @example
 * ```typescript
 * import { describeSchema } from './describe-schema.js';
 *
 * const descriptor = describeSchema();
 * console.log(descriptor.tables.map((t) => t.name));
 * // => ['tasks', 'task_dependencies', 'sessions', ...]
 *
 * const tasksCols = descriptor.tables.find((t) => t.name === 'tasks')?.columns;
 * console.log(tasksCols?.map((c) => c.name));
 * // => ['id', 'title', 'status', ...]
 * ```
 */

import type {
  SchemaColumn,
  SchemaDescriptor,
  SchemaIndex,
  SchemaTableDescriptor,
} from '@cleocode/contracts';
import type { Column, Table } from 'drizzle-orm';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../store/schema/index.js';
import { defineSdkTool } from './sdk-tool.js';

/** Internal drizzle symbol that holds the extra-config builder (indexes, checks, FKs). */
const ExtraConfigBuilder = Symbol.for('drizzle:ExtraConfigBuilder');

/** Narrow IndexBuilder interface — only the runtime fields we need. */
interface IndexBuilderRuntime {
  config: {
    name: string;
    unique: boolean;
  };
}

function isTable(value: unknown): value is Table {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.for('drizzle:IsDrizzleTable') in (value as Record<symbol, unknown>)
  );
}

function isIndexBuilder(value: unknown): value is IndexBuilderRuntime {
  return (
    value !== null &&
    typeof value === 'object' &&
    'config' in (value as object) &&
    typeof (value as IndexBuilderRuntime).config?.name === 'string'
  );
}

/** Drizzle table extended with internal ExtraConfigBuilder symbol. */
interface TableWithExtraConfig {
  [ExtraConfigBuilder]?: (cols: Record<string, Column>) => unknown;
}

/** Extract index descriptors from a drizzle table's ExtraConfigBuilder. */
function extractIndexes(table: Table & TableWithExtraConfig): SchemaIndex[] {
  const builder = table[ExtraConfigBuilder];
  if (typeof builder !== 'function') return [];

  const columns = getTableColumns(table);
  let rawConfig: unknown;
  try {
    rawConfig = builder(columns);
  } catch {
    return [];
  }

  const entries: unknown[] = Array.isArray(rawConfig)
    ? rawConfig
    : typeof rawConfig === 'object' && rawConfig !== null
      ? Object.values(rawConfig)
      : [];

  const indexes: SchemaIndex[] = [];
  for (const entry of entries) {
    if (isIndexBuilder(entry)) {
      indexes.push({ name: entry.config.name, unique: entry.config.unique ?? false });
    }
  }
  return indexes;
}

/** Build a full table descriptor from a drizzle table object. */
function describeTable(table: Table & TableWithExtraConfig): SchemaTableDescriptor {
  const name = getTableName(table);
  const rawColumns = getTableColumns(table);

  const columns: SchemaColumn[] = Object.values(rawColumns).map((col) => ({
    name: col.name,
    type: col.getSQLType(),
    notNull: col.notNull,
    primaryKey: col.primary,
  }));

  const indexes = extractIndexes(table);

  return { name, columns, indexes };
}

/**
 * Return a static JSON descriptor of all drizzle tables in the tasks schema.
 *
 * No database connection is required — introspection is performed on the
 * drizzle table objects exported from `packages/core/src/store/schema/`.
 *
 * @returns SchemaDescriptor with one entry per drizzle table
 *
 * @example
 * ```typescript
 * const { tables } = describeSchema();
 * const tasksTable = tables.find((t) => t.name === 'tasks');
 * // => { name: 'tasks', columns: [...], indexes: [...] }
 * ```
 */
export function describeSchema(): SchemaDescriptor {
  const tables: SchemaTableDescriptor[] = [];

  for (const value of Object.values(schema)) {
    if (isTable(value)) {
      tables.push(describeTable(value as Table & TableWithExtraConfig));
    }
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));

  return { tables };
}

/**
 * Registered SDK tool wrapping describeSchema for external discovery.
 *
 * @example
 * ```typescript
 * import { describeSchemaRegistered } from './describe-schema.js';
 * const result = describeSchemaRegistered.invoke({});
 * ```
 */
export const describeSchemaRegistered = defineSdkTool<Record<string, never>, SchemaDescriptor>({
  identity: {
    name: 'describe-schema',
    description: 'Returns a JSON descriptor of all drizzle tables and columns in the tasks schema.',
    version: '1.0.0',
  },
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: {
    type: 'object',
    properties: {
      tables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            columns: { type: 'array', items: { type: 'object' } },
            indexes: { type: 'array', items: { type: 'object' } },
          },
          required: ['name', 'columns', 'indexes'],
        },
      },
    },
    required: ['tables'],
  },
  fn: () => describeSchema(),
});

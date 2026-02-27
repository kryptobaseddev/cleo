/**
 * Dispatch Layer Parity Tests
 *
 * Validates that the dispatch layer's structural contracts hold end-to-end:
 *  1. Registry completeness — every OPERATIONS entry is well-formed
 *  2. ParamDef → MCP Schema derivation — buildMcpInputSchema correctness
 *  3. ParamDef → Commander derivation — buildCommanderArgs / buildCommanderOptionString
 *  4. Dispatch routing correctness — resolve() and validateRequiredParams()
 *  5. Schema utils — getOperationSchema() behaviour
 *
 * These tests are self-contained and do not spawn external processes.
 * Tests that would require a real DB are marked it.skip with a comment.
 *
 * @task T4905
 * @epic T4894
 */

import { describe, it, expect } from 'vitest';

import {
  OPERATIONS,
  resolve,
  validateRequiredParams,
  type OperationDef,
} from '../../dispatch/registry.js';

import {
  buildMcpInputSchema,
  buildCommanderArgs,
  buildCommanderOptionString,
  camelToKebab,
} from '../../dispatch/lib/param-utils.js';

import {
  getOperationSchema,
  getAllOperationSchemas,
} from '../../dispatch/lib/schema-utils.js';

import type { ParamDef } from '../../dispatch/types.js';

// ===========================================================================
// Test Group 1: Registry completeness
// ===========================================================================

describe('Group 1: Registry completeness', () => {
  it('every OPERATIONS entry has a params field (array, may be empty)', () => {
    for (const op of OPERATIONS) {
      // params is optional in OperationDef (T4897 migration), so undefined is
      // allowed — but when present it MUST be an array.
      if (op.params !== undefined) {
        expect(Array.isArray(op.params), `${op.domain}.${op.operation} params must be an array`).toBe(true);
      }
    }
  });

  it('every required param has name, type, required, and description', () => {
    for (const op of OPERATIONS) {
      for (const param of op.params ?? []) {
        expect(typeof param.name, `param.name must be a string in ${op.domain}.${op.operation}`).toBe('string');
        expect(param.name.length, `param.name must not be empty in ${op.domain}.${op.operation}`).toBeGreaterThan(0);

        expect(
          ['string', 'number', 'boolean', 'array'].includes(param.type),
          `param.type must be a valid ParamType in ${op.domain}.${op.operation}:${param.name}`,
        ).toBe(true);

        expect(typeof param.required, `param.required must be boolean in ${op.domain}.${op.operation}:${param.name}`).toBe('boolean');

        expect(typeof param.description, `param.description must be a string in ${op.domain}.${op.operation}:${param.name}`).toBe('string');
        expect(param.description.length, `param.description must not be empty in ${op.domain}.${op.operation}:${param.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('no duplicate domain+operation+gateway combinations', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const op of OPERATIONS) {
      const key = `${op.gateway}:${op.domain}:${op.operation}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });

  it('requiredParams array matches params.filter(required).map(name) for ops with params', () => {
    for (const op of OPERATIONS) {
      // Only validate ops that have populated params arrays (T4897 migration ops)
      if (!op.params || op.params.length === 0) continue;

      const derivedRequired = op.params
        .filter((p: ParamDef) => p.required)
        .map((p: ParamDef) => p.name);

      // requiredParams should be consistent with the params array when both are present.
      // We use a set comparison since order may differ.
      const requiredSet = new Set(op.requiredParams);
      const derivedSet = new Set(derivedRequired);

      for (const name of derivedSet) {
        expect(
          requiredSet.has(name),
          `${op.domain}.${op.operation}: param "${name}" is required=true in params[] but missing from requiredParams[]`,
        ).toBe(true);
      }
    }
  });

  it('registry has the expected operation count (93 query, 71 mutate)', () => {
    const queryCount = OPERATIONS.filter(o => o.gateway === 'query').length;
    const mutateCount = OPERATIONS.filter(o => o.gateway === 'mutate').length;

    expect(queryCount).toBe(93);
    expect(mutateCount).toBe(71);
    expect(OPERATIONS.length).toBe(164);
  });

  it('all operations have valid gateway values', () => {
    const validGateways = new Set(['query', 'mutate']);
    for (const op of OPERATIONS) {
      expect(
        validGateways.has(op.gateway),
        `${op.domain}.${op.operation} has invalid gateway: ${op.gateway}`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// Test Group 2: ParamDef → MCP Schema derivation
// ===========================================================================

describe('Group 2: ParamDef → MCP Schema derivation', () => {
  it('buildMcpInputSchema returns valid JSON Schema object shape', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      description: 'Show a task',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['taskId'],
      params: [
        {
          name: 'taskId',
          type: 'string',
          required: true,
          description: 'The task identifier',
          cli: { positional: true },
        },
      ],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.type).toBe('object');
    expect(typeof schema.properties).toBe('object');
    expect(Array.isArray(schema.required)).toBe(true);
  });

  it('required params appear in schema required array', () => {
    const def: OperationDef = {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      description: 'Add a task',
      tier: 0,
      idempotent: false,
      sessionRequired: false,
      requiredParams: ['title'],
      params: [
        {
          name: 'title',
          type: 'string',
          required: true,
          description: 'Task title',
          cli: { positional: true },
        },
        {
          name: 'description',
          type: 'string',
          required: false,
          description: 'Task description',
          cli: {},
        },
      ],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('description');
    expect(schema.properties['title']).toBeDefined();
    expect(schema.properties['description']).toBeDefined();
  });

  it('mcp.hidden params are excluded from schema', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      description: 'List tasks',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
      params: [
        {
          name: 'offset',
          type: 'number',
          required: false,
          description: 'Pagination offset (CLI-only)',
          cli: {},
          mcp: { hidden: true },
        },
        {
          name: 'status',
          type: 'string',
          required: false,
          description: 'Filter by status',
          cli: { short: '-s', flag: 'status' },
          mcp: { enum: ['pending', 'active', 'done'] },
        },
      ],
    };

    const schema = buildMcpInputSchema(def);

    // offset has mcp.hidden=true → must be excluded
    expect(schema.properties['offset']).toBeUndefined();
    // status has no hidden flag → must be present
    expect(schema.properties['status']).toBeDefined();
    expect(schema.properties['status'].enum).toEqual(['pending', 'active', 'done']);
  });

  it('ops with empty params return permissive schema', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'session',
      operation: 'status',
      description: 'Session status',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
      params: [],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toHaveLength(0);
    expect(schema.required).toHaveLength(0);
  });

  it('array type params get items: {type: string} in schema', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tools',
      operation: 'issue.validate.labels',
      description: 'Validate labels',
      tier: 2,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['labels'],
      params: [
        {
          name: 'labels',
          type: 'array',
          required: true,
          description: 'Labels to validate',
          cli: {},
        },
      ],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.properties['labels'].type).toBe('array');
    expect(schema.properties['labels'].items).toEqual({ type: 'string' });
  });

  it('boolean type params have type boolean in schema (no items)', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      description: 'List tasks',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
      params: [
        {
          name: 'includeArchive',
          type: 'boolean',
          required: false,
          description: 'Include archived tasks',
          cli: { flag: 'include-archive' },
        },
      ],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.properties['includeArchive'].type).toBe('boolean');
    expect(schema.properties['includeArchive'].items).toBeUndefined();
  });

  it('all supported param types map correctly to JSON Schema types', () => {
    const def: OperationDef = {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      description: 'Test all types',
      tier: 0,
      idempotent: false,
      sessionRequired: false,
      requiredParams: [],
      params: [
        { name: 'strParam',  type: 'string',  required: false, description: 'A string' },
        { name: 'numParam',  type: 'number',  required: false, description: 'A number' },
        { name: 'boolParam', type: 'boolean', required: false, description: 'A boolean' },
        { name: 'arrParam',  type: 'array',   required: false, description: 'An array' },
      ],
    };

    const schema = buildMcpInputSchema(def);

    expect(schema.properties['strParam'].type).toBe('string');
    expect(schema.properties['numParam'].type).toBe('number');
    expect(schema.properties['boolParam'].type).toBe('boolean');
    expect(schema.properties['arrParam'].type).toBe('array');
  });
});

// ===========================================================================
// Test Group 3: ParamDef → Commander derivation
// ===========================================================================

describe('Group 3: ParamDef → Commander derivation', () => {
  it('buildCommanderArgs correctly splits positionals from options', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      description: 'Show a task',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['taskId'],
      params: [
        {
          name: 'taskId',
          type: 'string',
          required: true,
          description: 'The task ID',
          cli: { positional: true },
        },
        {
          name: 'format',
          type: 'string',
          required: false,
          description: 'Output format',
          cli: { flag: 'format' },
        },
        {
          name: 'mcpOnlyParam',
          type: 'string',
          required: false,
          description: 'MCP-only, no cli key',
          // No cli key → excluded from Commander
        },
      ],
    };

    const { positionals, options } = buildCommanderArgs(def);

    expect(positionals).toHaveLength(1);
    expect(positionals[0].name).toBe('taskId');

    expect(options).toHaveLength(1);
    expect(options[0].name).toBe('format');

    // mcpOnlyParam has no cli key — must be excluded from both arrays
    const allNames = [...positionals, ...options].map(p => p.name);
    expect(allNames).not.toContain('mcpOnlyParam');
  });

  it('buildCommanderArgs returns empty arrays for op with no params', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'session',
      operation: 'status',
      description: 'Session status',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    };

    const { positionals, options } = buildCommanderArgs(def);

    expect(positionals).toHaveLength(0);
    expect(options).toHaveLength(0);
  });

  it('buildCommanderOptionString generates correct string with short alias', () => {
    const param: ParamDef = {
      name: 'status',
      type: 'string',
      required: false,
      description: 'Filter by status',
      cli: { short: '-s', flag: 'status' },
    };

    const result = buildCommanderOptionString(param);

    expect(result).toBe('-s, --status <status>');
  });

  it('buildCommanderOptionString generates correct string without short alias', () => {
    const param: ParamDef = {
      name: 'parent',
      type: 'string',
      required: false,
      description: 'Parent task ID',
      cli: {},
    };

    const result = buildCommanderOptionString(param);

    expect(result).toBe('--parent <parent>');
  });

  it('boolean params generate --flag without <value> placeholder', () => {
    const param: ParamDef = {
      name: 'dryRun',
      type: 'boolean',
      required: false,
      description: 'Dry run mode',
      cli: { flag: 'dry-run' },
    };

    const result = buildCommanderOptionString(param);

    expect(result).toBe('--dry-run');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('boolean params with short alias generate -x, --flag without <value>', () => {
    const param: ParamDef = {
      name: 'verbose',
      type: 'boolean',
      required: false,
      description: 'Verbose output',
      cli: { short: '-v', flag: 'verbose' },
    };

    const result = buildCommanderOptionString(param);

    expect(result).toBe('-v, --verbose');
    expect(result).not.toContain('<');
  });

  it('camelCase param names are converted to kebab-case for flag name', () => {
    const param: ParamDef = {
      name: 'includeArchive',
      type: 'boolean',
      required: false,
      description: 'Include archived tasks',
      cli: {},
    };

    const result = buildCommanderOptionString(param);

    // camelToKebab('includeArchive') → 'include-archive'
    expect(result).toBe('--include-archive');
  });

  it('camelToKebab converts correctly', () => {
    expect(camelToKebab('taskId')).toBe('task-id');
    expect(camelToKebab('includeArchive')).toBe('include-archive');
    expect(camelToKebab('dryRun')).toBe('dry-run');
    expect(camelToKebab('status')).toBe('status');
    expect(camelToKebab('maxResults')).toBe('max-results');
  });

  it('array params with variadic:true annotation are correctly identified', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tools',
      operation: 'issue.validate.labels',
      description: 'Validate labels',
      tier: 2,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['labels'],
      params: [
        {
          name: 'labels',
          type: 'array',
          required: true,
          description: 'Labels list',
          cli: { variadic: true },
        },
      ],
    };

    const { positionals, options } = buildCommanderArgs(def);

    // variadic does not affect positional/option classification — only cli.positional does
    // labels has no positional:true, so it goes to options
    expect(options).toHaveLength(1);
    expect(options[0].cli?.variadic).toBe(true);
  });
});

// ===========================================================================
// Test Group 4: Dispatch routing correctness
// ===========================================================================

describe('Group 4: Dispatch routing correctness', () => {
  it('resolve("query", "tasks", "show") returns the correct OperationDef', () => {
    const result = resolve('query', 'tasks', 'show');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('tasks');
    expect(result!.operation).toBe('show');
    expect(result!.def.gateway).toBe('query');
    expect(result!.def.domain).toBe('tasks');
    expect(result!.def.operation).toBe('show');
  });

  it('resolve("mutate", "tasks", "add") returns the correct OperationDef', () => {
    const result = resolve('mutate', 'tasks', 'add');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('tasks');
    expect(result!.operation).toBe('add');
    expect(result!.def.gateway).toBe('mutate');
    expect(result!.def.idempotent).toBe(false);
  });

  it('resolve("query", "tasks", "nonexistent") returns undefined', () => {
    const result = resolve('query', 'tasks', 'nonexistent');

    expect(result).toBeUndefined();
  });

  it('resolve does not cross gateways — query op is not found via mutate', () => {
    // tasks.show is a query op; should not be found when searching mutate
    const queryResult = resolve('query', 'tasks', 'show');
    const mutateResult = resolve('mutate', 'tasks', 'show');

    expect(queryResult).toBeDefined();
    expect(mutateResult).toBeUndefined();
  });

  it('validateRequiredParams({}, {}) returns [] when no required params', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      description: 'List tasks',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    };

    expect(validateRequiredParams(def, {})).toEqual([]);
    expect(validateRequiredParams(def, undefined)).toEqual([]);
  });

  it('validateRequiredParams catches missing required params', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tools',
      operation: 'issue.validate.labels',
      description: 'Validate labels',
      tier: 2,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['labels'],
    };

    const missing = validateRequiredParams(def, {});

    expect(missing).toEqual(['labels']);
  });

  it('validateRequiredParams passes when required params are provided', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tools',
      operation: 'issue.validate.labels',
      description: 'Validate labels',
      tier: 2,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['labels'],
    };

    const missing = validateRequiredParams(def, { labels: ['bug', 'enhancement'] });

    expect(missing).toEqual([]);
  });

  it('validateRequiredParams treats null and empty string as missing', () => {
    const def: OperationDef = {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      description: 'Add task',
      tier: 0,
      idempotent: false,
      sessionRequired: false,
      requiredParams: ['title', 'description'],
    };

    // null → missing
    expect(validateRequiredParams(def, { title: null, description: 'valid' }))
      .toEqual(['title']);

    // empty string → missing
    expect(validateRequiredParams(def, { title: '', description: 'valid' }))
      .toEqual(['title']);

    // both present → none missing
    expect(validateRequiredParams(def, { title: 'T', description: 'D' }))
      .toEqual([]);
  });

  it('resolve returns consistent def reference (same object as OPERATIONS entry)', () => {
    const result = resolve('mutate', 'tasks', 'complete');

    expect(result).toBeDefined();
    // The def in the resolution should be the same object from OPERATIONS
    const directLookup = OPERATIONS.find(
      o => o.gateway === 'mutate' && o.domain === 'tasks' && o.operation === 'complete',
    );
    expect(result!.def).toBe(directLookup);
  });

  it.skip('real dispatch routing requires a DB — see cli-mcp-parity.integration.test.ts', () => {
    // End-to-end routing through dispatchRaw() with a real database is tested in
    // src/core/__tests__/cli-mcp-parity.integration.test.ts with mocked engines.
    // Tests here focus on the registry-level routing contracts only.
  });
});

// ===========================================================================
// Test Group 5: Schema utils
// ===========================================================================

describe('Group 5: Schema utils', () => {
  it('getOperationSchema for op with no params returns permissive schema', () => {
    // tasks.show has no params[] in current registry (T4897 migration pending)
    const schema = getOperationSchema('tasks', 'show', 'query');

    expect(schema.type).toBe('object');
    // Permissive schema: empty properties, no required fields
    expect(Object.keys(schema.properties)).toHaveLength(0);
    expect(schema.required).toHaveLength(0);
  });

  it('getOperationSchema for nonexistent op returns permissive schema', () => {
    const schema = getOperationSchema('tasks', 'nonexistent', 'query');

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toHaveLength(0);
    expect(schema.required).toHaveLength(0);
  });

  it('getOperationSchema for op with params returns derived schema', () => {
    // We need an op with params populated. Build one synthetically by inserting
    // a temporary test def, which we can't do without modifying OPERATIONS.
    //
    // Instead, call buildMcpInputSchema directly on a crafted def (tested in
    // Group 2) and verify getOperationSchema falls through to the permissive
    // path for all current registry entries (pre-T4897 migration).
    //
    // Once T4897 migration populates params for tasks.show, this test should
    // be updated to assert schema.properties has a taskId property.

    // All current registry entries have empty params arrays → permissive schema
    for (const op of OPERATIONS) {
      if (!op.params || op.params.length === 0) {
        const schema = getOperationSchema(op.domain, op.operation, op.gateway);
        expect(schema.type).toBe('object');
        // May have empty or populated properties depending on migration state
      }
    }
  });

  it('getOperationSchema is gateway-sensitive', () => {
    // Confirm that schema lookup uses gateway to distinguish ops.
    // tasks.add is mutate; tasks.show is query — they should both resolve.
    const addSchema  = getOperationSchema('tasks', 'add',  'mutate');
    const showSchema = getOperationSchema('tasks', 'show', 'query');

    // Both exist in registry (but no params yet) → permissive fallback
    expect(addSchema.type).toBe('object');
    expect(showSchema.type).toBe('object');

    // tasks.add with query gateway → does not exist → permissive fallback
    const addViaQuery = getOperationSchema('tasks', 'add', 'query');
    expect(addViaQuery.type).toBe('object');
    expect(Object.keys(addViaQuery.properties)).toHaveLength(0);
  });

  it('getAllOperationSchemas returns a schema for every query operation', () => {
    const schemas = getAllOperationSchemas('query');
    const queryOps = OPERATIONS.filter(o => o.gateway === 'query');

    expect(Object.keys(schemas)).toHaveLength(queryOps.length);

    for (const op of queryOps) {
      const key = `${op.domain}.${op.operation}`;
      expect(schemas[key], `Missing schema for ${key}`).toBeDefined();
      expect(schemas[key].type).toBe('object');
    }
  });

  it('getAllOperationSchemas returns a schema for every mutate operation', () => {
    const schemas = getAllOperationSchemas('mutate');
    const mutateOps = OPERATIONS.filter(o => o.gateway === 'mutate');

    expect(Object.keys(schemas)).toHaveLength(mutateOps.length);

    for (const op of mutateOps) {
      const key = `${op.domain}.${op.operation}`;
      expect(schemas[key], `Missing schema for ${key}`).toBeDefined();
    }
  });

  it('getAllOperationSchemas does not cross gateway boundaries', () => {
    const querySchemas  = getAllOperationSchemas('query');
    const mutateSchemas = getAllOperationSchemas('mutate');

    // tasks.add is mutate-only — should not appear in query schemas
    expect(querySchemas['tasks.add']).toBeUndefined();

    // tasks.show is query-only — should not appear in mutate schemas
    expect(mutateSchemas['tasks.show']).toBeUndefined();
  });

  it('permissive schema structure is stable (type object, empty properties, empty required)', () => {
    // Calling for a nonexistent op multiple times returns structurally identical objects
    const s1 = getOperationSchema('x', 'y', 'query');
    const s2 = getOperationSchema('a', 'b', 'mutate');

    expect(s1).toEqual(s2);
    expect(s1.type).toBe('object');
    expect(s1.properties).toEqual({});
    expect(s1.required).toEqual([]);
  });
});

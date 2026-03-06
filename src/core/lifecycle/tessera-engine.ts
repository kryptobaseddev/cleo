/**
 * Tessera Instantiation Engine
 *
 * Provides template management and instantiation for parameterized
 * WarpChain workflows. Wraps buildDefaultChain() with template
 * variables and manages the template registry.
 *
 * @task T5409
 */

import type {
  TesseraTemplate,
  TesseraInstantiationInput,
  TesseraVariable,
} from '../../types/tessera.js';
import type { WarpChain, WarpChainInstance } from '../../types/warp-chain.js';
import { buildDefaultChain } from './default-chain.js';
import { validateChain } from '../validation/chain-validation.js';
import { addChain, showChain, createInstance } from './chain-store.js';

const DEFAULT_TESSERA_ID = 'tessera-rcasd';
const TASK_ID_PATTERN = /^T\d+$/;
const PLACEHOLDER_EXACT = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;
const PLACEHOLDER_GLOBAL = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function valueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateVariableType(name: string, varDef: TesseraVariable, value: unknown): void {
  switch (varDef.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid variable type for "${name}": expected string, got ${valueType(value)}`);
      }
      return;
    }

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid variable type for "${name}": expected finite number, got ${valueType(value)}`);
      }
      return;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid variable type for "${name}": expected boolean, got ${valueType(value)}`);
      }
      return;
    }

    case 'taskId':
    case 'epicId': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid variable type for "${name}": expected ${varDef.type}, got ${valueType(value)}`);
      }
      if (!TASK_ID_PATTERN.test(value)) {
        throw new Error(`Invalid variable format for "${name}": expected ${varDef.type} like "T1234", got "${value}"`);
      }
      return;
    }

    default: {
      throw new Error(`Unsupported variable type for "${name}": ${String(varDef.type)}`);
    }
  }
}

function substituteTemplateValue(
  value: unknown,
  variables: Record<string, unknown>,
  path: string,
): unknown {
  if (typeof value === 'string') {
    const exact = value.match(PLACEHOLDER_EXACT);
    if (exact) {
      const variableName = exact[1];
      if (!hasOwn(variables, variableName)) {
        throw new Error(`Unknown template variable "${variableName}" at ${path}`);
      }
      return variables[variableName];
    }

    return value.replace(PLACEHOLDER_GLOBAL, (_full, variableName: string) => {
      if (!hasOwn(variables, variableName)) {
        throw new Error(`Unknown template variable "${variableName}" at ${path}`);
      }
      return String(variables[variableName]);
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => substituteTemplateValue(entry, variables, `${path}[${index}]`));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = substituteTemplateValue(nested, variables, `${path}.${key}`);
    }
    return out;
  }

  return value;
}

function resolveVariables(
  template: TesseraTemplate,
  inputVariables: Record<string, unknown>,
): Record<string, unknown> {
  const variableKeys = Object.keys(template.variables).sort();
  const allowedVariables = new Set(variableKeys);

  for (const key of Object.keys(inputVariables).sort()) {
    if (!allowedVariables.has(key)) {
      throw new Error(
        `Unknown variable: ${key}. Allowed variables: ${variableKeys.join(', ')}`,
      );
    }
  }

  const resolvedVariables: Record<string, unknown> = {};

  for (const key of variableKeys) {
    const varDef = template.variables[key];
    const hasInput = hasOwn(inputVariables, key);
    const inputValue = hasInput ? inputVariables[key] : undefined;

    if (inputValue === undefined) {
      if (varDef.required) {
        throw new Error(`Missing required variable: ${key}`);
      }

      if (hasOwn(template.defaultValues, key)) {
        const defaultValue = template.defaultValues[key];
        validateVariableType(key, varDef, defaultValue);
        resolvedVariables[key] = defaultValue;
      } else if (varDef.default !== undefined) {
        validateVariableType(key, varDef, varDef.default);
        resolvedVariables[key] = varDef.default;
      }
      continue;
    }

    validateVariableType(key, varDef, inputValue);
    resolvedVariables[key] = inputValue;
  }

  return resolvedVariables;
}

/**
 * Build the default RCASD Tessera template.
 *
 * Wraps buildDefaultChain() with template variables:
 * - epicId (required, type 'epicId')
 * - projectName (optional, type 'string', default 'unnamed')
 * - skipResearch (optional, type 'boolean', default false)
 *
 * @task T5409
 */
export function buildDefaultTessera(): TesseraTemplate {
  const chain = buildDefaultChain();

  return {
    ...chain,
    id: DEFAULT_TESSERA_ID,
    tessera: DEFAULT_TESSERA_ID,
    variables: {
      epicId: {
        name: 'epicId',
        type: 'epicId',
        description: 'The epic task ID to bind this pipeline to',
        required: true,
      },
      projectName: {
        name: 'projectName',
        type: 'string',
        description: 'Name of the project for labeling',
        required: false,
        default: 'unnamed',
      },
      skipResearch: {
        name: 'skipResearch',
        type: 'boolean',
        description: 'Whether to skip the research stage',
        required: false,
        default: false,
      },
    },
    archetypes: ['lifecycle', 'rcasd'],
    defaultValues: {
      projectName: 'unnamed',
      skipResearch: false,
    },
    category: 'lifecycle',
  };
}

/** In-memory template registry. */
const templates: Map<string, TesseraTemplate> = new Map();

/** Ensure the default template is registered. */
function ensureDefaults(): void {
  if (!templates.has(DEFAULT_TESSERA_ID)) {
    templates.set(DEFAULT_TESSERA_ID, buildDefaultTessera());
  }
}

/**
 * Instantiate a Tessera template into a concrete WarpChainInstance.
 *
 * Steps:
 * 1. Validate all required variables are provided
 * 2. Apply defaults for missing optional variables
 * 3. Construct concrete WarpChain from template
 * 4. Validate chain via validateChain()
 * 5. Store via createInstance() from chain-store
 * 6. Return instance
 *
 * @task T5409
 */
export async function instantiateTessera(
  template: TesseraTemplate,
  input: TesseraInstantiationInput,
  projectRoot: string,
): Promise<WarpChainInstance> {
  // 1. Resolve and validate input variables
  const inputVariables =
    input.variables && typeof input.variables === 'object'
      ? input.variables
      : {};
  const resolvedVariables = resolveVariables(template, inputVariables);

  // 2. Build chain from template with deep substitution
  const chainSeed: WarpChain = {
    id: template.id,
    name: template.name,
    version: template.version,
    description: template.description,
    shape: template.shape,
    gates: template.gates,
    tessera: template.id,
    metadata: template.metadata,
  };
  const substituted = substituteTemplateValue(chainSeed, resolvedVariables, 'chain');
  const chain = substituted as WarpChain;
  chain.metadata = {
    ...(chain.metadata ?? {}),
    variables: resolvedVariables,
  };

  // 3. Validate the chain
  const validation = validateChain(chain);
  if (validation.errors.length > 0) {
    throw new Error(`Tessera chain validation failed: ${validation.errors.join('; ')}`);
  }

  // 4. Store chain if not already stored, then create instance
  const existing = await showChain(chain.id, projectRoot);
  if (!existing) {
    await addChain(chain, projectRoot);
  }

  // 5. Create and return instance
  return createInstance(
    {
      chainId: chain.id,
      epicId: input.epicId,
      variables: resolvedVariables,
    },
    projectRoot,
  );
}

/**
 * List all registered Tessera templates.
 *
 * @task T5409
 */
export function listTesseraTemplates(): TesseraTemplate[] {
  ensureDefaults();
  return Array.from(templates.values());
}

/**
 * Find a Tessera template by ID.
 *
 * @task T5409
 */
export function showTessera(id: string): TesseraTemplate | null {
  ensureDefaults();
  return templates.get(id) ?? null;
}

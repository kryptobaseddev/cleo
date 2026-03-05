/**
 * Tessera Instantiation Engine
 *
 * Provides template management and instantiation for parameterized
 * WarpChain workflows. Wraps buildDefaultChain() with template
 * variables and manages the template registry.
 *
 * @task T5409
 */

import type { TesseraTemplate, TesseraInstantiationInput } from '../../types/tessera.js';
import type { WarpChain, WarpChainInstance } from '../../types/warp-chain.js';
import { buildDefaultChain } from './default-chain.js';
import { validateChain } from '../validation/chain-validation.js';
import { addChain, showChain, createInstance } from './chain-store.js';

const DEFAULT_TESSERA_ID = 'tessera-rcasd';

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
  // 1. Validate required variables
  for (const [key, varDef] of Object.entries(template.variables)) {
    if (varDef.required && !(key in input.variables) && input.variables[key] === undefined) {
      throw new Error(`Missing required variable: ${key}`);
    }
  }

  // 2. Apply defaults for missing optional variables
  const resolvedVariables: Record<string, unknown> = { ...template.defaultValues };
  for (const [key, value] of Object.entries(input.variables)) {
    resolvedVariables[key] = value;
  }

  // 3. Construct concrete WarpChain from template
  const chain: WarpChain = {
    id: template.id,
    name: template.name,
    version: template.version,
    description: template.description,
    shape: template.shape,
    gates: template.gates,
    tessera: template.id,
    metadata: { variables: resolvedVariables },
  };

  // 4. Validate the chain
  const validation = validateChain(chain);
  if (validation.errors.length > 0) {
    throw new Error(`Tessera chain validation failed: ${validation.errors.join('; ')}`);
  }

  // 5. Store chain if not already stored, then create instance
  const existing = await showChain(chain.id, projectRoot);
  if (!existing) {
    await addChain(chain, projectRoot);
  }

  // 6. Create and return instance
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

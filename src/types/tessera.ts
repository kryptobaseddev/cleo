/**
 * Tessera Type Definitions
 *
 * Tessera templates extend WarpChain with variable bindings,
 * archetype classification, and instantiation inputs for
 * parameterized pipeline creation.
 *
 * @task T5408
 */

import type { WarpChain } from './warp-chain.js';

/** A variable declaration within a Tessera template. */
export interface TesseraVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'taskId' | 'epicId';
  description: string;
  required: boolean;
  default?: unknown;
}

/** A parameterized WarpChain template with variable bindings. */
export interface TesseraTemplate extends WarpChain {
  variables: Record<string, TesseraVariable>;
  archetypes: string[];
  defaultValues: Record<string, unknown>;
  category: 'lifecycle' | 'hotfix' | 'research' | 'security-audit' | 'custom';
}

/** Input for instantiating a Tessera template into a concrete chain. */
export interface TesseraInstantiationInput {
  templateId: string;
  epicId: string;
  variables: Record<string, unknown>;
}

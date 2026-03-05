/**
 * WarpChain Storage — CRUD operations for chain definitions and instances.
 *
 * Uses tasks.db (main database) via the native SQLite adapter.
 * Tables: warp_chains, warp_chain_instances (defined in chain-schema.ts).
 *
 * @task T5403
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../store/sqlite.js';
import { warpChains, warpChainInstances } from '../../store/chain-schema.js';
import { eq } from 'drizzle-orm';
import { validateChain } from '../validation/chain-validation.js';
import type { WarpChain, WarpChainInstance, GateResult } from '../../types/warp-chain.js';

/**
 * Store a validated WarpChain definition.
 *
 * Validates the chain before storing. Throws if validation fails.
 *
 * @task T5403
 */
export async function addChain(chain: WarpChain, projectRoot: string): Promise<void> {
  const validation = validateChain(chain);
  if (validation.errors.length > 0) {
    throw new Error(`Chain validation failed: ${validation.errors.join('; ')}`);
  }

  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  await db.insert(warpChains).values({
    id: chain.id,
    name: chain.name,
    version: chain.version,
    description: chain.description,
    definition: JSON.stringify(chain),
    validated: true,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Retrieve a WarpChain definition by ID.
 *
 * @task T5403
 */
export async function showChain(id: string, projectRoot: string): Promise<WarpChain | null> {
  const db = await getDb(projectRoot);
  const rows = await db.select().from(warpChains).where(eq(warpChains.id, id));

  if (rows.length === 0) return null;
  return JSON.parse(rows[0].definition) as WarpChain;
}

/**
 * List all stored WarpChain definitions.
 *
 * @task T5403
 */
export async function listChains(projectRoot: string): Promise<WarpChain[]> {
  const db = await getDb(projectRoot);
  const rows = await db.select().from(warpChains);
  return rows.map((row) => JSON.parse(row.definition) as WarpChain);
}

/**
 * Create a chain instance binding a chain to an epic.
 *
 * @task T5403
 */
export async function createInstance(
  params: {
    chainId: string;
    epicId: string;
    variables?: Record<string, unknown>;
    stageToTask?: Record<string, string>;
  },
  projectRoot: string,
): Promise<WarpChainInstance> {
  const chain = await showChain(params.chainId, projectRoot);
  if (!chain) {
    throw new Error(`Chain "${params.chainId}" not found`);
  }

  const id = `wci-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const variables = params.variables ?? {};
  const stageToTask = params.stageToTask ?? {};

  const db = await getDb(projectRoot);
  await db.insert(warpChainInstances).values({
    id,
    chainId: params.chainId,
    epicId: params.epicId,
    variables: JSON.stringify(variables),
    stageToTask: JSON.stringify(stageToTask),
    status: 'pending',
    currentStage: chain.shape.entryPoint,
    gateResults: JSON.stringify([]),
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    chainId: params.chainId,
    epicId: params.epicId,
    variables,
    stageToTask,
    status: 'pending',
    currentStage: chain.shape.entryPoint,
    createdAt: now,
    createdBy: 'system',
  };
}

/**
 * Retrieve a chain instance by ID.
 *
 * @task T5403
 */
export async function showInstance(
  id: string,
  projectRoot: string,
): Promise<WarpChainInstance | null> {
  const db = await getDb(projectRoot);
  const rows = await db.select().from(warpChainInstances).where(eq(warpChainInstances.id, id));

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    chainId: row.chainId,
    epicId: row.epicId,
    variables: row.variables ? JSON.parse(row.variables) : {},
    stageToTask: row.stageToTask ? JSON.parse(row.stageToTask) : {},
    status: row.status as WarpChainInstance['status'],
    currentStage: row.currentStage ?? '',
    createdAt: row.createdAt ?? '',
    createdBy: 'system',
  };
}

/**
 * Advance a chain instance to the next stage, recording gate results.
 *
 * @task T5403
 */
export async function advanceInstance(
  id: string,
  nextStage: string,
  gateResults: GateResult[],
  projectRoot: string,
): Promise<WarpChainInstance> {
  const instance = await showInstance(id, projectRoot);
  if (!instance) {
    throw new Error(`Chain instance "${id}" not found`);
  }

  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  // Merge new gate results with existing
  const existingResults: GateResult[] = [];
  const row = (await db.select().from(warpChainInstances).where(eq(warpChainInstances.id, id)))[0];
  if (row?.gateResults) {
    existingResults.push(...(JSON.parse(row.gateResults) as GateResult[]));
  }
  const allResults = [...existingResults, ...gateResults];

  await db.update(warpChainInstances)
    .set({
      currentStage: nextStage,
      gateResults: JSON.stringify(allResults),
      status: 'active',
      updatedAt: now,
    })
    .where(eq(warpChainInstances.id, id));

  return {
    ...instance,
    currentStage: nextStage,
    status: 'active',
  };
}

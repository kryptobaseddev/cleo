/**
 * Drizzle ORM schema for WarpChain storage in tasks.db.
 *
 * Tables: warp_chains, warp_chain_instances
 * Stores chain definitions and runtime instances bound to epics.
 *
 * @task T5403
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Chain instance status values. */
export const WARP_CHAIN_INSTANCE_STATUSES = [
  'pending',
  'active',
  'completed',
  'failed',
  'cancelled',
] as const;

// === WARP_CHAINS TABLE ===

/** Stored WarpChain definitions (serialized as JSON). */
export const warpChains = sqliteTable(
  'warp_chains',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description'),
    definition: text('definition').notNull(), // JSON-serialized WarpChain
    validated: integer('validated', { mode: 'boolean' }).default(false),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_warp_chains_name').on(table.name)],
);

// === WARP_CHAIN_INSTANCES TABLE ===

/** Runtime chain instances bound to epics. */
export const warpChainInstances = sqliteTable(
  'warp_chain_instances',
  {
    id: text('id').primaryKey(),
    chainId: text('chain_id')
      .notNull()
      .references(() => warpChains.id),
    epicId: text('epic_id').notNull(),
    variables: text('variables'), // JSON
    stageToTask: text('stage_to_task'), // JSON
    status: text('status').notNull().default('pending'),
    currentStage: text('current_stage'),
    gateResults: text('gate_results'), // JSON array of GateResult
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_warp_instances_chain').on(table.chainId),
    index('idx_warp_instances_epic').on(table.epicId),
    index('idx_warp_instances_status').on(table.status),
  ],
);

// === TYPE EXPORTS ===

export type WarpChainRow = typeof warpChains.$inferSelect;
export type NewWarpChainRow = typeof warpChains.$inferInsert;
export type WarpChainInstanceRow = typeof warpChainInstances.$inferSelect;
export type NewWarpChainInstanceRow = typeof warpChainInstances.$inferInsert;

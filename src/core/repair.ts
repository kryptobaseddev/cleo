/**
 * Repair functions for fixable data integrity issues.
 *
 * Extracted from upgrade.ts Step 2 for reuse by both `upgrade` and `validate --fix`.
 * Each function returns a list of actions taken (or previewed in dry-run mode).
 *
 * @task T4699
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskFile } from '../types/task.js';
import { computeChecksum } from '../store/json.js';

/**
 * Read the current schema version from schemas/todo.schema.json (single source of truth).
 * Falls back to '2.10.0' if the schema file cannot be read.
 */
export function getCurrentSchemaVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(__dirname, '..', '..', 'schemas', 'todo.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    return schema.schemaVersion ?? '2.10.0';
  } catch {
    return '2.10.0';
  }
}

/** A single repair action with status. */
export interface RepairAction {
  action: string;
  status: 'applied' | 'skipped' | 'preview';
  details: string;
}

/**
 * Set size='medium' on tasks missing the size field.
 */
export function repairMissingSizes(
  data: TaskFile,
  dryRun: boolean,
): RepairAction[] {
  const missingSizes = data.tasks.filter((t) => !t.size);
  if (missingSizes.length === 0) return [];

  if (dryRun) {
    return [{
      action: 'fix_missing_sizes',
      status: 'preview',
      details: `Would set size='medium' for ${missingSizes.length} task(s)`,
    }];
  }

  for (const t of missingSizes) {
    t.size = 'medium';
  }
  return [{
    action: 'fix_missing_sizes',
    status: 'applied',
    details: `Set size='medium' for ${missingSizes.length} task(s)`,
  }];
}

/**
 * Set completedAt on done tasks that are missing it.
 */
export function repairMissingCompletedAt(
  data: TaskFile,
  dryRun: boolean,
): RepairAction[] {
  const doneMissingDate = data.tasks.filter((t) => t.status === 'done' && !t.completedAt);
  if (doneMissingDate.length === 0) return [];

  if (dryRun) {
    return [{
      action: 'fix_completed_at',
      status: 'preview',
      details: `Would set completedAt for ${doneMissingDate.length} done task(s)`,
    }];
  }

  const now = new Date().toISOString();
  for (const t of doneMissingDate) {
    t.completedAt = now;
  }
  return [{
    action: 'fix_completed_at',
    status: 'applied',
    details: `Set completedAt for ${doneMissingDate.length} done task(s)`,
  }];
}

/**
 * Recompute and fix checksum mismatch in _meta.
 */
export function repairChecksum(
  data: TaskFile,
  dryRun: boolean,
): RepairAction[] {
  const storedChecksum = data._meta?.checksum;
  const computedCk = computeChecksum(data.tasks);

  if (storedChecksum === computedCk) return [];

  if (dryRun) {
    return [{
      action: 'fix_checksum',
      status: 'preview',
      details: `Would update checksum from ${storedChecksum ?? 'none'} to ${computedCk}`,
    }];
  }

  data._meta.checksum = computedCk;
  return [{
    action: 'fix_checksum',
    status: 'applied',
    details: `Updated checksum to ${computedCk}`,
  }];
}

/**
 * Add missing _meta.schemaVersion field.
 */
export function repairSchemaVersion(
  data: TaskFile,
  dryRun: boolean,
  currentVersion: string = getCurrentSchemaVersion(),
): RepairAction[] {
  const schemaVersion = data._meta?.schemaVersion;

  if (schemaVersion) return [];

  if (dryRun) {
    return [{
      action: 'add_schema_version',
      status: 'preview',
      details: `Would set _meta.schemaVersion to ${currentVersion}`,
    }];
  }

  data._meta = data._meta ?? {} as typeof data._meta;
  data._meta.schemaVersion = currentVersion;
  return [{
    action: 'add_schema_version',
    status: 'applied',
    details: `Set _meta.schemaVersion to ${currentVersion}`,
  }];
}

/**
 * Run all repair functions on a TaskFile.
 * Returns all actions. Caller is responsible for saving the data.
 */
export function runAllRepairs(
  data: TaskFile,
  dryRun: boolean,
): RepairAction[] {
  const actions: RepairAction[] = [];

  actions.push(...repairSchemaVersion(data, dryRun));
  actions.push(...repairMissingCompletedAt(data, dryRun));
  actions.push(...repairMissingSizes(data, dryRun));
  // Checksum must be last since other repairs modify data
  actions.push(...repairChecksum(data, dryRun));

  return actions;
}

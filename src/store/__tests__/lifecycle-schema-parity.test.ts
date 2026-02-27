import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_STAGE_NAMES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  LIFECYCLE_GATE_RESULTS,
  LIFECYCLE_EVIDENCE_TYPES,
} from '../schema.js';
import { PIPELINE_STAGES, CONTRIBUTION_STAGE } from '../../core/lifecycle/stages.js';

function getMigrationSqlFiles(): Array<{ name: string; sql: string }> {
  const projectRoot = process.cwd();
  const drizzleDir = join(projectRoot, 'drizzle');
  const migrationDirs = readdirSync(drizzleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (migrationDirs.length === 0) {
    throw new Error('No drizzle migration directories found');
  }

  return migrationDirs.map((name) => ({
    name,
    sql: readFileSync(join(drizzleDir, name, 'migration.sql'), 'utf-8'),
  }));
}

function getLatestPipelineMigrationSql(): string {
  const migrations = getMigrationSqlFiles();
  const pipelineMigrations = migrations.filter(({ sql }) =>
    sql.includes('chk_lifecycle_pipelines_status') || sql.includes('__new_lifecycle_pipelines'),
  );
  const latest = pipelineMigrations[pipelineMigrations.length - 1];
  if (!latest) {
    throw new Error('No lifecycle_pipelines migration found');
  }
  return latest.sql;
}

function getLatestStageMigrationSql(): string {
  const migrations = getMigrationSqlFiles();
  const stageMigrations = migrations.filter(({ sql }) =>
    sql.includes('chk_lifecycle_stages_stage_name') || sql.includes('__new_lifecycle_stages'),
  );
  const latest = stageMigrations[stageMigrations.length - 1];
  if (!latest) {
    throw new Error('No lifecycle_stages migration found');
  }
  return latest.sql;
}

describe('lifecycle schema parity guardrails', () => {
  it('keeps store lifecycle stage names aligned with core lifecycle stages', () => {
    expect(LIFECYCLE_STAGE_NAMES).toEqual([...PIPELINE_STAGES, CONTRIBUTION_STAGE]);
  });

  it('ensures latest pipeline migration contains all LIFECYCLE_PIPELINE_STATUSES', () => {
    const sql = getLatestPipelineMigrationSql();
    for (const status of LIFECYCLE_PIPELINE_STATUSES) {
      expect(sql, `Missing pipeline status '${status}' in latest pipeline migration`).toContain(`'${status}'`);
    }
  });

  it('ensures latest stage migration contains all LIFECYCLE_STAGE_STATUSES and stage names', () => {
    const sql = getLatestStageMigrationSql();

    for (const stageName of LIFECYCLE_STAGE_NAMES) {
      expect(sql, `Missing stage name '${stageName}' in latest stage migration`).toContain(`'${stageName}'`);
    }

    for (const status of LIFECYCLE_STAGE_STATUSES) {
      expect(sql, `Missing stage status '${status}' in latest stage migration`).toContain(`'${status}'`);
    }

    if (sql.includes('chk_lifecycle_gate_results_result')) {
      for (const result of LIFECYCLE_GATE_RESULTS) {
        expect(sql).toContain(`'${result}'`);
      }
    }

    if (sql.includes('chk_lifecycle_evidence_type')) {
      for (const type of LIFECYCLE_EVIDENCE_TYPES) {
        expect(sql).toContain(`'${type}'`);
      }
    }
  });
});

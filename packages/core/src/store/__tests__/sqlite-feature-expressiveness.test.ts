/**
 * Contract tests for the T10567 SQLite expressiveness matrix.
 *
 * @task T10567
 */

import { describe, expect, it } from 'vitest';
import {
  getSqliteFeatureExpressivenessEntry,
  SQLITE_FEATURE_EXPRESSIVENESS_MATRIX,
  SQLITE_SCHEMA_TS_DOCUMENTATION_GAPS,
} from '../tasks-schema.js';

const requiredIndexKeys = [
  'index.plain',
  'index.composite',
  'index.unique',
  'index.partial',
  'index.expression',
] as const;

const requiredSqlFeatureKeys = [
  'constraint.check',
  'constraint.foreign-key',
  'programmability.trigger',
  'column.generated',
] as const;

describe('T10567 SQLite feature expressiveness matrix', () => {
  it('classifies plain, composite, unique, partial, and expression indexes', () => {
    for (const key of requiredIndexKeys) {
      expect(getSqliteFeatureExpressivenessEntry(key), `missing ${key}`).toBeDefined();
    }

    expect(getSqliteFeatureExpressivenessEntry('index.plain')?.expressiveness).toBe(
      'schema-supported',
    );
    expect(getSqliteFeatureExpressivenessEntry('index.composite')?.expressiveness).toBe(
      'schema-supported',
    );
    expect(getSqliteFeatureExpressivenessEntry('index.unique')?.expressiveness).toBe(
      'schema-supported',
    );
    expect(getSqliteFeatureExpressivenessEntry('index.partial')?.expressiveness).toBe(
      'schema-supported-with-sql-template',
    );
    expect(getSqliteFeatureExpressivenessEntry('index.expression')?.expressiveness).toBe(
      'schema-supported-with-sql-template',
    );
  });

  it('classifies CHECK, FK, trigger, and generated SQL support', () => {
    for (const key of requiredSqlFeatureKeys) {
      expect(getSqliteFeatureExpressivenessEntry(key), `missing ${key}`).toBeDefined();
    }

    expect(getSqliteFeatureExpressivenessEntry('constraint.check')?.expressiveness).toBe(
      'dual-source-required',
    );
    expect(getSqliteFeatureExpressivenessEntry('constraint.foreign-key')?.expressiveness).toBe(
      'schema-supported',
    );
    expect(getSqliteFeatureExpressivenessEntry('programmability.trigger')?.expressiveness).toBe(
      'raw-sql-required',
    );
    expect(getSqliteFeatureExpressivenessEntry('column.generated')?.expressiveness).toBe(
      'raw-sql-required',
    );
  });

  it('lists schema TypeScript documentation gaps for raw SQL semantics', () => {
    expect(SQLITE_SCHEMA_TS_DOCUMENTATION_GAPS.map((gap) => gap.key)).toEqual([
      'gap.check-constraints',
      'gap.raw-sql-triggers',
      'gap.generated-columns',
      'gap.expression-indexes',
    ]);
    expect(SQLITE_SCHEMA_TS_DOCUMENTATION_GAPS.every((gap) => gap.guidance.length > 40)).toBe(true);
  });

  it('uses stable unique keys for downstream PM-Core consumers', () => {
    const keys = SQLITE_FEATURE_EXPRESSIVENESS_MATRIX.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SQLITE_FEATURE_EXPRESSIVENESS_MATRIX).toHaveLength(9);
  });
});

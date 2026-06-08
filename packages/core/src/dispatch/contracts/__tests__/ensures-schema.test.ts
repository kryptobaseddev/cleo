/**
 * Tests for T11762 ST-1b (T11901) — ensures-schema accessors in core.
 *
 * Asserts the bodied accessor layer over the cantbook `ensures.schema` Zod
 * registry: {@link getEnsuresSchema} resolves the registered spec for
 * `task_tree` / `evidence`, returns `null` for an unknown name, and
 * {@link listEnsuresSchemaNames} enumerates exactly the registered set.
 * {@link defineEnsuresSchema} registers an additional spec without mutating the
 * immutable contracts data.
 *
 * @task T11901
 * @epic T11762
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  defineEnsuresSchema,
  type EnsuresSchemaSpec,
  getEnsuresSchema,
  listEnsuresSchemaNames,
} from '../ensures-schema.js';

describe('getEnsuresSchema', () => {
  it('resolves the registered spec for task_tree', () => {
    const spec = getEnsuresSchema('task_tree');
    expect(spec).not.toBeNull();
    expect(spec?.name).toBe('task_tree');
    // contextKey defaults to the schema name (the `context['task_tree']` convention).
    expect(spec?.contextKey).toBe('task_tree');
    expect(spec?.schema).toBeDefined();
  });

  it('resolves the registered spec for evidence', () => {
    const spec = getEnsuresSchema('evidence');
    expect(spec).not.toBeNull();
    expect(spec?.name).toBe('evidence');
    expect(spec?.contextKey).toBe('evidence');
    expect(spec?.schema).toBeDefined();
  });

  it('returns the schema carried by the spec, usable for safeParse', () => {
    const spec = getEnsuresSchema('task_tree');
    if (!spec) throw new Error('task_tree spec missing');
    // A valid task_tree shape parses; an empty array (the bespoke validator's
    // rejection case) does not — confirming the accessor hands back the live
    // ST-1 validator, not a stub.
    expect(spec.schema.safeParse([{ title: 'x', acceptance: ['a'] }]).success).toBe(true);
    expect(spec.schema.safeParse([]).success).toBe(false);
  });

  it('returns null for an unknown schema name', () => {
    expect(getEnsuresSchema('not_a_real_schema')).toBeNull();
    expect(getEnsuresSchema('')).toBeNull();
  });
});

describe('listEnsuresSchemaNames', () => {
  it('enumerates both registered names (task_tree, evidence)', () => {
    const names = listEnsuresSchemaNames();
    expect(names).toContain('task_tree');
    expect(names).toContain('evidence');
  });

  it('every enumerated name resolves to a non-null spec', () => {
    for (const name of listEnsuresSchemaNames()) {
      const spec = getEnsuresSchema(name);
      expect(spec).not.toBeNull();
      expect(spec?.name).toBe(name);
    }
  });
});

describe('defineEnsuresSchema', () => {
  it('registers an additional spec resolvable via getEnsuresSchema', () => {
    const spec: EnsuresSchemaSpec = {
      name: '__test_extra_schema__',
      contextKey: '__test_extra_schema__',
      schema: z.string().min(1),
    };
    expect(getEnsuresSchema(spec.name)).toBeNull();

    defineEnsuresSchema(spec);

    const resolved = getEnsuresSchema(spec.name);
    expect(resolved).not.toBeNull();
    expect(resolved?.name).toBe(spec.name);
    expect(listEnsuresSchemaNames()).toContain(spec.name);
  });
});

/**
 * Coverage for the nexus schema-residency audit (gh#1298 · T12158).
 *
 * Builds real SQLite stores rather than mocking, because the defect under test
 * is a property of what is ON DISK versus what the schema source declares — a
 * mock would encode the assumption the audit exists to check.
 *
 * @task T12158
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanNexusSchemaResidency } from '../nexus-schema-residency.js';

let root: string;
let projectRoot: string;
let cleoHome: string;

/** Create a store at `path` with the given tables, each seeded with `rows`. */
function makeStore(path: string, tables: readonly string[], rows = 0): void {
  const db = new DatabaseSync(path); // test fixture — raw open is allowed in tests
  try {
    for (const t of tables) {
      db.exec(`CREATE TABLE "${t}" (id TEXT PRIMARY KEY)`);
      for (let i = 0; i < rows; i++) db.exec(`INSERT INTO "${t}" (id) VALUES ('r${i}')`);
    }
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-residency-'));
  projectRoot = join(root, 'project');
  cleoHome = join(root, 'home');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(cleoHome, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const projectDb = () => join(projectRoot, '.cleo', 'cleo.db');
const globalDb = () => join(cleoHome, 'cleo.db');

describe('scanNexusSchemaResidency', () => {
  it('reports nothing when residency is correct', () => {
    makeStore(projectDb(), ['nexus_nodes', 'nexus_relations']);
    makeStore(globalDb(), ['nexus_project_registry', 'nexus_sigils']);

    const scan = scanNexusSchemaResidency(projectRoot, cleoHome);
    expect(scan.bothStoresExist).toBe(true);
    expect(scan.findings).toEqual([]);
  });

  it('flags an EMPTY graph table left in the global store as safe to drop', () => {
    // The gh#1298 shape: T11538 moved the table project-ward, T11539 removed it
    // from the global schema source, and no migration dropped it from disk.
    makeStore(projectDb(), ['nexus_nodes']);
    makeStore(globalDb(), ['nexus_nodes', 'nexus_project_registry']);

    const scan = scanNexusSchemaResidency(projectRoot, cleoHome);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]).toMatchObject({
      table: 'nexus_nodes',
      kind: 'orphaned-in-global',
      rows: 0,
      safeToDrop: true,
    });
    expect(scan.safeToDropCount).toBe(1);
    expect(scan.needsDecisionCount).toBe(0);
  });

  it('refuses to call a POPULATED orphan safe to drop', () => {
    // An install that used nexus BEFORE the residency move wrote its graph rows
    // to the global store, and no migration relocated them. There, these rows
    // may be the only copy — a data-migration question, not a cleanup.
    makeStore(projectDb(), ['nexus_nodes']);
    makeStore(globalDb(), ['nexus_nodes'], 3);

    const scan = scanNexusSchemaResidency(projectRoot, cleoHome);
    expect(scan.findings[0]).toMatchObject({ rows: 3, safeToDrop: false });
    expect(scan.safeToDropCount).toBe(0);
    expect(scan.needsDecisionCount).toBe(1);
  });

  it('flags a fall-through registry table that exists in BOTH schemas', () => {
    // The invariant nexus depends on and does not assert: a bare name must
    // resolve in exactly one schema. Present in both, SQLite answers from
    // `main` — the project — while every caller believes it read the global
    // registry. Never auto-fixable: which copy is authoritative IS the question.
    makeStore(projectDb(), ['nexus_project_registry']);
    makeStore(globalDb(), ['nexus_project_registry']);

    const scan = scanNexusSchemaResidency(projectRoot, cleoHome);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]).toMatchObject({
      table: 'nexus_project_registry',
      kind: 'ambiguous-fallthrough',
      safeToDrop: false,
    });
  });

  it('returns an empty audit rather than throwing when a store is absent', () => {
    makeStore(projectDb(), ['nexus_nodes']);
    const scan = scanNexusSchemaResidency(projectRoot, cleoHome);
    expect(scan.bothStoresExist).toBe(false);
    expect(scan.findings).toEqual([]);
  });
});

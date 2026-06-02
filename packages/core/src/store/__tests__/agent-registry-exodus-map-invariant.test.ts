/**
 * Agent-Registry exodus-map ⇔ consolidated-schema invariant (the DHQ-046 catcher).
 *
 * The single test that makes the physical `signaldock_* → agent_registry_*` rename
 * (T11622) safe: it asserts that the exodus `AGENT_REGISTRY_DB_MAP` VALUES exactly
 * equal the `sqliteTable` names declared in `cleo-global/agent-registry.ts`. If the
 * map and the schema ever disagree, exodus would copy rows into a table the
 * consolidated schema does not create — silently reproducing the DHQ-046 N→0
 * deficit (migration parity != data visibility). This test fails the build the
 * instant they drift.
 *
 * Map VALUES are read through the public `resolveConsolidatedTableName('signaldock',
 * <bareKey>)` resolver (the source-descriptor name stays `"signaldock"` because the
 * legacy on-disk file is genuinely `signaldock.db`). Schema NAMES are read via
 * drizzle `getTableConfig`.
 *
 * @task T11622 (Signaldock → Agent Registry rename + runtime cutover; folds T11578 AC2)
 * @saga T11586 (SG-AGENT-IDENTITY)
 * @epic T11248 / T11249
 */

import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { resolveConsolidatedTableName } from '../exodus/table-name-map.js';
import * as agentRegistrySchema from '../schema/cleo-global/agent-registry.js';

/**
 * The bare legacy keys present in `AGENT_REGISTRY_DB_MAP` (the shape of the legacy
 * on-disk `signaldock.db`). Kept here as the test's authoritative key-set so a
 * dropped map entry is caught (the resolver would return an `unknown` identity
 * mapping for a missing key, which this test asserts against).
 */
const LEGACY_BARE_KEYS: readonly string[] = [
  'users',
  'organization',
  'agents',
  'claim_codes',
  'agent_capabilities',
  'agent_skills',
  'agent_connections',
  'accounts',
  'sessions',
  'verifications',
  'org_agent_keys',
  'capabilities',
  'skills',
];

/**
 * Collect every `agent_registry_*` physical table name declared by the
 * consolidated schema module via drizzle introspection.
 */
function consolidatedTableNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(agentRegistrySchema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as SQLiteTable);
    } catch {
      continue; // not a sqliteTable export (enum const / type)
    }
    if (config && typeof config.name === 'string') {
      names.add(config.name);
    }
  }
  return names;
}

/**
 * Resolve the consolidated TARGET for a legacy bare key through the exodus map.
 */
function mapTarget(bareKey: string): string {
  const resolution = resolveConsolidatedTableName('signaldock', bareKey);
  // Every registry key must be an explicit `mapped` entry — never an `unknown`
  // identity fallback (that would mean the key was dropped from the map).
  expect(resolution.kind, `AGENT_REGISTRY_DB_MAP must map bare '${bareKey}' explicitly`).toBe(
    'mapped',
  );
  if (resolution.kind !== 'mapped') throw new Error('unreachable');
  return resolution.targetName;
}

describe('T11622 — Agent-Registry exodus-map ⇔ consolidated-schema invariant (DHQ-046 catcher)', () => {
  it('every consolidated agent_registry_* sqliteTable name carries the agent_registry_ prefix', () => {
    const names = consolidatedTableNames();
    expect(names.size).toBe(13);
    for (const name of names) {
      expect(name, `consolidated table '${name}' must carry the agent_registry_ prefix`).toMatch(
        /^agent_registry_/,
      );
    }
  });

  it('AGENT_REGISTRY_DB_MAP VALUES exactly equal the declared sqliteTable names', () => {
    const schemaNames = consolidatedTableNames();
    const mappedTargets = new Set(LEGACY_BARE_KEYS.map(mapTarget));

    // Bidirectional set equality — no map value may point at a table the schema
    // does not declare, and no schema table may lack a map entry.
    const missingFromMap = [...schemaNames].filter((n) => !mappedTargets.has(n));
    const missingFromSchema = [...mappedTargets].filter((n) => !schemaNames.has(n));

    expect(
      missingFromMap,
      `consolidated tables with NO AGENT_REGISTRY_DB_MAP value (exodus would copy 0 rows): ${missingFromMap.join(', ')}`,
    ).toEqual([]);
    expect(
      missingFromSchema,
      `map values pointing at non-existent consolidated tables (DHQ-046 N→0 risk): ${missingFromSchema.join(', ')}`,
    ).toEqual([]);
    expect(mappedTargets).toEqual(schemaNames);
  });

  it('the legacy signaldock.db sessions table maps to agent_registry_sessions (not tasks_sessions)', () => {
    // Disambiguation guard: a bare `sessions` also exists in tasks.db.
    expect(mapTarget('sessions')).toBe('agent_registry_sessions');
  });
});

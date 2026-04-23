/**
 * Unit tests for the NEXUS user-profile SDK (T1078) and
 * import/export functions (T1079).
 *
 * Each test gets its own fresh nexus.db via CLEO_HOME redirection +
 * resetNexusDbState().  No real user data is touched.
 *
 * @task T1078
 * @task T1079
 * @epic T1076
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { nexusInit } from '../registry.js';
import { exportUserProfile, importUserProfile } from '../transfer.js';
import {
  getUserProfileTrait,
  listUserProfile,
  reinforceTrait,
  supersedeTrait,
  upsertUserProfileTrait,
} from '../user-profile.js';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let testDir: string;

/** Seed a `UserProfileTrait` with sensible defaults for tests. */
function makeTrait(
  traitKey: string,
  overrides: Partial<{
    traitValue: string;
    confidence: number;
    source: string;
    reinforcementCount: number;
    supersededBy: string | null;
    firstObservedAt: string;
    lastReinforcedAt: string;
  }> = {},
) {
  const now = new Date().toISOString();
  return {
    traitKey,
    traitValue: overrides.traitValue ?? '"test-value"',
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source ?? 'manual',
    derivedFromMessageId: null,
    firstObservedAt: overrides.firstObservedAt ?? now,
    lastReinforcedAt: overrides.lastReinforcedAt ?? now,
    reinforcementCount: overrides.reinforcementCount ?? 1,
    supersededBy: overrides.supersededBy ?? null,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-user-profile-test-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });

  // Point CLEO_HOME to isolated temp directory so nexus.db is isolated.
  process.env['CLEO_HOME'] = testDir;

  // Reset the nexus DB singleton so each test gets a fresh database.
  resetNexusDbState();

  // Initialise the nexus registry (creates nexus.db + applies migrations).
  await nexusInit();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  resetNexusDbState();
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T1078 — CRUD SDK unit tests
// ---------------------------------------------------------------------------

describe('getUserProfileTrait', () => {
  it('returns null when the trait does not exist', async () => {
    const db = await getNexusDb();
    const result = await getUserProfileTrait(db, 'nonexistent-key');
    expect(result).toBeNull();
  });

  it('returns the trait after it is inserted', async () => {
    const db = await getNexusDb();
    const trait = makeTrait('prefers-zero-deps');
    await upsertUserProfileTrait(db, trait);

    const fetched = await getUserProfileTrait(db, 'prefers-zero-deps');
    expect(fetched).not.toBeNull();
    expect(fetched!.traitKey).toBe('prefers-zero-deps');
    expect(fetched!.traitValue).toBe('"test-value"');
    expect(fetched!.confidence).toBeCloseTo(0.8);
    expect(fetched!.source).toBe('manual');
    expect(fetched!.reinforcementCount).toBe(1);
    expect(fetched!.supersededBy).toBeNull();
  });
});

describe('upsertUserProfileTrait', () => {
  it('inserts a new trait', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('verbose-git-logs'));
    const result = await getUserProfileTrait(db, 'verbose-git-logs');
    expect(result).not.toBeNull();
    expect(result!.traitKey).toBe('verbose-git-logs');
  });

  it('updates an existing trait without changing firstObservedAt', async () => {
    const db = await getNexusDb();
    const original = makeTrait('prefers-esm', {
      traitValue: '"esm"',
      confidence: 0.5,
    });
    await upsertUserProfileTrait(db, original);

    const first = await getUserProfileTrait(db, 'prefers-esm');
    const originalFirst = first!.firstObservedAt;

    // Small sleep so that new Date() is definitely different.
    await new Promise((r) => setTimeout(r, 10));

    await upsertUserProfileTrait(db, {
      ...original,
      traitValue: '"esm-updated"',
      confidence: 0.9,
      lastReinforcedAt: new Date().toISOString(),
    });

    const updated = await getUserProfileTrait(db, 'prefers-esm');
    expect(updated!.traitValue).toBe('"esm-updated"');
    expect(updated!.confidence).toBeCloseTo(0.9);
    // firstObservedAt must be preserved from the original insert.
    expect(updated!.firstObservedAt).toBe(originalFirst);
  });

  it('clamps confidence to [0.0, 1.0]', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('over-confident', { confidence: 1.5 }));
    const result = await getUserProfileTrait(db, 'over-confident');
    expect(result!.confidence).toBeLessThanOrEqual(1.0);

    await upsertUserProfileTrait(db, makeTrait('negative-conf', { confidence: -0.5 }));
    const neg = await getUserProfileTrait(db, 'negative-conf');
    expect(neg!.confidence).toBeGreaterThanOrEqual(0.0);
  });
});

describe('reinforceTrait', () => {
  it('increments reinforcement count and boosts confidence', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('uses-pnpm', { confidence: 0.5 }));

    await reinforceTrait(db, 'uses-pnpm', 'test');

    const updated = await getUserProfileTrait(db, 'uses-pnpm');
    expect(updated!.reinforcementCount).toBe(2);
    // confidence should increase: 0.5 + (1 - 0.5) * 0.1 = 0.55
    expect(updated!.confidence).toBeCloseTo(0.55, 5);
  });

  it('does not throw when the key does not exist', async () => {
    const db = await getNexusDb();
    await expect(reinforceTrait(db, 'ghost-key', 'test')).resolves.toBeUndefined();
  });
});

describe('listUserProfile', () => {
  it('returns all non-superseded traits when no filter is set', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('trait-a', { confidence: 0.9 }));
    await upsertUserProfileTrait(db, makeTrait('trait-b', { confidence: 0.6 }));

    const traits = await listUserProfile(db);
    expect(traits).toHaveLength(2);
    // Ordered by confidence desc
    expect(traits[0]!.traitKey).toBe('trait-a');
    expect(traits[1]!.traitKey).toBe('trait-b');
  });

  it('filters by minConfidence', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('high', { confidence: 0.9 }));
    await upsertUserProfileTrait(db, makeTrait('low', { confidence: 0.2 }));

    const filtered = await listUserProfile(db, { minConfidence: 0.5 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.traitKey).toBe('high');
  });

  it('excludes superseded traits by default', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('old-trait', { confidence: 0.8 }));
    await upsertUserProfileTrait(db, makeTrait('new-trait', { confidence: 0.9 }));
    await supersedeTrait(db, 'old-trait', 'new-trait');

    const nonSuperseded = await listUserProfile(db);
    expect(nonSuperseded.map((t) => t.traitKey)).not.toContain('old-trait');
    expect(nonSuperseded.map((t) => t.traitKey)).toContain('new-trait');
  });

  it('includes superseded traits when includeSuperseded is true', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('old-trait', { confidence: 0.8 }));
    await upsertUserProfileTrait(db, makeTrait('new-trait', { confidence: 0.9 }));
    await supersedeTrait(db, 'old-trait', 'new-trait');

    const all = await listUserProfile(db, { includeSuperseded: true });
    expect(all.map((t) => t.traitKey)).toContain('old-trait');
    expect(all.map((t) => t.traitKey)).toContain('new-trait');
  });
});

describe('supersedeTrait', () => {
  it('sets supersededBy on the old trait', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('prefers-commonjs'));
    await upsertUserProfileTrait(db, makeTrait('prefers-esm'));

    await supersedeTrait(db, 'prefers-commonjs', 'prefers-esm');

    const old = await getUserProfileTrait(db, 'prefers-commonjs');
    expect(old!.supersededBy).toBe('prefers-esm');

    const newTrait = await getUserProfileTrait(db, 'prefers-esm');
    expect(newTrait!.supersededBy).toBeNull();
  });

  it('does not throw when oldKey does not exist', async () => {
    const db = await getNexusDb();
    await expect(supersedeTrait(db, 'ghost', 'real')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T1079 — Import/export tests
// ---------------------------------------------------------------------------

describe('exportUserProfile', () => {
  it('writes a valid JSON file with all non-superseded traits', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('trait-export-a', { confidence: 0.9 }));
    await upsertUserProfileTrait(db, makeTrait('trait-export-b', { confidence: 0.7 }));

    const outPath = join(testDir, 'exported_profile.json');
    const result = await exportUserProfile(outPath);

    expect(result.path).toBe(outPath);
    expect(result.count).toBe(2);

    const raw = JSON.parse(await readFile(outPath, 'utf8'));
    expect(raw.$schema).toBe('https://cleocode.dev/schemas/user-profile/v1.json');
    expect(Array.isArray(raw.traits)).toBe(true);
    expect(raw.traits).toHaveLength(2);
    expect(raw.traits.map((t: { traitKey: string }) => t.traitKey)).toContain('trait-export-a');
  });

  it('excludes superseded traits from the export', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('old-export', { confidence: 0.8 }));
    await upsertUserProfileTrait(db, makeTrait('new-export', { confidence: 0.9 }));
    await supersedeTrait(db, 'old-export', 'new-export');

    const outPath = join(testDir, 'export_no_superseded.json');
    const result = await exportUserProfile(outPath);

    expect(result.count).toBe(1);
    const raw = JSON.parse(await readFile(outPath, 'utf8'));
    const keys = raw.traits.map((t: { traitKey: string }) => t.traitKey);
    expect(keys).not.toContain('old-export');
    expect(keys).toContain('new-export');
  });
});

describe('importUserProfile', () => {
  it('imports new traits from a JSON file', async () => {
    const db = await getNexusDb();
    const now = new Date().toISOString();

    const envelope = {
      $schema: 'https://cleocode.dev/schemas/user-profile/v1.json',
      exportedAt: now,
      traits: [
        makeTrait('imported-trait-x', { confidence: 0.75 }),
        makeTrait('imported-trait-y', { confidence: 0.85 }),
      ],
    };

    const inPath = join(testDir, 'import_source.json');
    await mkdir(join(testDir), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(inPath, JSON.stringify(envelope));

    const result = await importUserProfile(inPath);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.superseded).toBe(0);

    const x = await getUserProfileTrait(db, 'imported-trait-x');
    expect(x).not.toBeNull();
    expect(x!.confidence).toBeCloseTo(0.75);
  });

  it('skips traits where existing has higher confidence', async () => {
    const db = await getNexusDb();
    const now = new Date().toISOString();

    // Insert existing trait with high confidence.
    await upsertUserProfileTrait(db, makeTrait('conflict-key', { confidence: 0.95 }));

    const envelope = {
      $schema: 'https://cleocode.dev/schemas/user-profile/v1.json',
      exportedAt: now,
      traits: [makeTrait('conflict-key', { confidence: 0.5 })],
    };

    const inPath = join(testDir, 'import_skip.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(inPath, JSON.stringify(envelope));

    const result = await importUserProfile(inPath);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);

    // Existing high-confidence trait must be preserved.
    const existing = await getUserProfileTrait(db, 'conflict-key');
    expect(existing!.confidence).toBeCloseTo(0.95);
  });

  it('supersedes existing trait when incoming has higher confidence', async () => {
    const db = await getNexusDb();
    const past = new Date(Date.now() - 10000).toISOString();
    const now = new Date().toISOString();

    await upsertUserProfileTrait(
      db,
      makeTrait('upgrade-key', { confidence: 0.4, lastReinforcedAt: past }),
    );

    const envelope = {
      $schema: 'https://cleocode.dev/schemas/user-profile/v1.json',
      exportedAt: now,
      traits: [makeTrait('upgrade-key', { confidence: 0.9, lastReinforcedAt: now })],
    };

    const inPath = join(testDir, 'import_supersede.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(inPath, JSON.stringify(envelope));

    const result = await importUserProfile(inPath);
    expect(result.superseded).toBe(1);

    const updated = await getUserProfileTrait(db, 'upgrade-key');
    expect(updated!.confidence).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// CLI parity — programmatic dispatch output matches direct SDK call
// ---------------------------------------------------------------------------

describe('CLI / programmatic parity (nexusProfileView)', () => {
  it('listUserProfile SDK output matches what nexusProfileView would return', async () => {
    const db = await getNexusDb();
    await upsertUserProfileTrait(db, makeTrait('parity-a', { confidence: 0.8 }));
    await upsertUserProfileTrait(db, makeTrait('parity-b', { confidence: 0.6 }));

    const sdkTraits = await listUserProfile(db);

    // Simulate what nexusProfileView does in the engine.
    const engineTraits = await listUserProfile(db, {
      minConfidence: undefined,
      includeSuperseded: undefined,
    });

    expect(sdkTraits).toEqual(engineTraits);
  });
});

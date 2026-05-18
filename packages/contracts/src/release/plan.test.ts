/**
 * Zod schema tests for the Release Plan envelope (T9527).
 *
 * Validates the canonical SPEC-T9345 §6.1 shape against the Zod schema defined
 * in {@link ./plan.ts}. Coverage targets:
 *
 * - Happy-path parse round-trip
 * - Each enum field rejects unknown literal values
 * - Required fields cannot be missing
 * - `evidenceAtoms` stays permissive (verb-level enforcement, NOT contract)
 * - All 8 `status` FSM values parse
 * - `meta` is forward-compat (unknown keys pass through via `.catchall`)
 *
 * @task T9527
 */

import { describe, expect, it } from 'vitest';
import {
  GATE_NAME,
  GATE_STATUS,
  IMPACT,
  PLATFORM_TUPLE,
  PUBLISHER,
  parseReleasePlan,
  RELEASE_CHANNEL,
  RELEASE_KIND,
  RELEASE_PLAN_SCHEMA_URL,
  RELEASE_PLAN_SCHEMA_VERSION,
  RELEASE_SCHEME,
  RELEASE_STATUS,
  RESOLVED_SOURCE,
  ReleaseGateSchema,
  type ReleasePlan,
  ReleasePlanChangelogSchema,
  ReleasePlanMetaSchema,
  ReleasePlanSchema,
  ReleasePlanTaskSchema,
  ReleasePlatformMatrixEntrySchema,
  ReleasePreflightSummarySchema,
  safeParseReleasePlan,
  TASK_KIND,
} from './plan.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Returns a fresh deep clone of a minimal-but-complete valid plan. Each test
 * mutates its own copy to test field-level rejection paths.
 */
function makeValidPlan(): ReleasePlan {
  return {
    $schema: RELEASE_PLAN_SCHEMA_URL,
    version: 'v2026.6.0',
    resolvedVersion: 'v2026.6.0',
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId: 'T9999',
    releaseKind: 'regular',
    createdAt: '2026-06-01T12:00:00Z',
    createdBy: 'cleo-prime',
    previousVersion: 'v2026.5.74',
    previousTag: 'v2026.5.74',
    previousShippedAt: '2026-05-15T08:00:00Z',
    tasks: [
      {
        id: 'T10001',
        kind: 'feat',
        impact: 'minor',
        userFacingSummary: 'Add release plan schema',
        evidenceAtoms: ['commit:abc123', 'test-run:vitest.json', 'tool:lint'],
        ivtrPhaseAtPlan: 'released',
        epicAncestor: 'T9999',
      },
    ],
    changelog: {
      features: ['T10001'],
      fixes: [],
      chores: [],
      breaking: [],
    },
    gates: [
      {
        name: 'test',
        atom: 'tool:test',
        status: 'passed',
        lastVerifiedAt: '2026-06-01T11:50:00Z',
        resolvedCommand: 'pnpm run test',
        resolvedSource: 'project-context',
      },
    ],
    platformMatrix: [
      {
        platform: 'linux-x64',
        publisher: 'npm',
        package: '@cleocode/cleo',
        smoke: true,
      },
    ],
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
      preflightWarnings: [],
    },
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'planned',
    meta: {
      firstEverRelease: false,
      unresolvedTools: [],
      archetype: 'monorepo-w-workspaces',
    },
  };
}

// ─── Constant tuples ─────────────────────────────────────────────────────────

describe('Release plan constant tuples', () => {
  it('exports an 8-state status FSM', () => {
    expect(RELEASE_STATUS).toEqual([
      'planned',
      'pr-opened',
      'pr-merged',
      'published',
      'reconciled',
      'rolled_back',
      'failed',
      'cancelled',
    ]);
    expect(RELEASE_STATUS).toHaveLength(8);
  });

  it('exports the 4-channel set (latest|beta|alpha|rc)', () => {
    expect(new Set(RELEASE_CHANNEL)).toEqual(new Set(['latest', 'beta', 'alpha', 'rc']));
  });

  it('exports the 3-scheme set including calver-suffix', () => {
    expect(RELEASE_SCHEME).toContain('calver');
    expect(RELEASE_SCHEME).toContain('semver');
    expect(RELEASE_SCHEME).toContain('calver-suffix');
  });

  it('exports release-kind variants', () => {
    expect(new Set(RELEASE_KIND)).toEqual(new Set(['regular', 'hotfix', 'prerelease']));
  });

  it('exports the 4-status gate enum', () => {
    expect(new Set(GATE_STATUS)).toEqual(new Set(['passed', 'failed', 'skipped', 'unresolved']));
  });

  it('exports canonical gate names (R-310)', () => {
    expect(GATE_NAME).toContain('test');
    expect(GATE_NAME).toContain('build');
    expect(GATE_NAME).toContain('lint');
    expect(GATE_NAME).toContain('typecheck');
    expect(GATE_NAME).toContain('audit');
    expect(GATE_NAME).toContain('security-scan');
  });

  it('exports platform tuples aligned with T1737', () => {
    expect(PLATFORM_TUPLE).toContain('linux-x64');
    expect(PLATFORM_TUPLE).toContain('linux-arm64');
    expect(PLATFORM_TUPLE).toContain('macos-x64');
    expect(PLATFORM_TUPLE).toContain('macos-arm64');
    expect(PLATFORM_TUPLE).toContain('windows-x64');
    expect(PLATFORM_TUPLE).toContain('any');
  });

  it('exports publisher backends covering npm/cargo/docker/pypi/github-release/binary', () => {
    expect(new Set(PUBLISHER)).toEqual(
      new Set(['npm', 'cargo', 'docker', 'pypi', 'github-release', 'binary']),
    );
  });

  it('exports task-kind classification', () => {
    expect(TASK_KIND).toContain('feat');
    expect(TASK_KIND).toContain('fix');
    expect(TASK_KIND).toContain('hotfix');
    expect(TASK_KIND).toContain('breaking');
  });

  it('exports SemVer impact tuple', () => {
    expect(IMPACT).toEqual(['major', 'minor', 'patch']);
  });

  it('exports resolved-source attribution per ADR-061', () => {
    expect(RESOLVED_SOURCE).toEqual(['project-context', 'language-default', 'legacy-alias']);
  });

  it('exposes a stable schema version + URL', () => {
    expect(RELEASE_PLAN_SCHEMA_VERSION).toBe('1.0.0');
    expect(RELEASE_PLAN_SCHEMA_URL).toBe('https://cleocode.io/schemas/release-plan/v1.json');
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('ReleasePlanSchema — happy path', () => {
  it('parses a complete valid plan', () => {
    const plan = parseReleasePlan(makeValidPlan());
    expect(plan.version).toBe('v2026.6.0');
    expect(plan.status).toBe('planned');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.id).toBe('T10001');
    expect(plan.platformMatrix[0]?.publisher).toBe('npm');
  });

  it('safeParse returns success for a valid plan', () => {
    const result = safeParseReleasePlan(makeValidPlan());
    expect(result.success).toBe(true);
  });

  it('round-trips through JSON.stringify / parse', () => {
    const original = makeValidPlan();
    const serialized = JSON.stringify(original);
    const reparsed = parseReleasePlan(JSON.parse(serialized));
    expect(reparsed).toEqual(original);
  });

  it('accepts a first-ever release with null previousVersion + meta.firstEverRelease', () => {
    const plan = makeValidPlan();
    plan.previousVersion = null;
    plan.previousTag = null;
    plan.previousShippedAt = null;
    plan.meta = { firstEverRelease: true };
    expect(() => parseReleasePlan(plan)).not.toThrow();
  });
});

// ─── Status FSM coverage ─────────────────────────────────────────────────────

describe('ReleasePlanSchema — status FSM', () => {
  it.each(RELEASE_STATUS)('accepts status = "%s"', (status) => {
    const plan = makeValidPlan();
    plan.status = status;
    expect(() => parseReleasePlan(plan)).not.toThrow();
  });

  it('rejects unknown status literals', () => {
    const plan = { ...makeValidPlan(), status: 'in-flight' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });
});

// ─── Enum rejection per field ────────────────────────────────────────────────

describe('ReleasePlanSchema — enum rejection', () => {
  it('rejects unknown channel', () => {
    const plan = { ...makeValidPlan(), channel: 'canary' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown scheme', () => {
    const plan = { ...makeValidPlan(), scheme: 'rolling' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown releaseKind', () => {
    const plan = { ...makeValidPlan(), releaseKind: 'patch' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown task kind', () => {
    const plan = makeValidPlan();
    plan.tasks[0] = { ...plan.tasks[0]!, kind: 'misc' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown impact', () => {
    const plan = makeValidPlan();
    plan.tasks[0] = { ...plan.tasks[0]!, impact: 'huge' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown gate name', () => {
    const plan = makeValidPlan();
    plan.gates[0] = { ...plan.gates[0]!, name: 'fmt' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown gate status', () => {
    const plan = makeValidPlan();
    plan.gates[0] = { ...plan.gates[0]!, status: 'flaky' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown platform tuple', () => {
    const plan = makeValidPlan();
    plan.platformMatrix[0] = { ...plan.platformMatrix[0]!, platform: 'haiku-x64' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown publisher', () => {
    const plan = makeValidPlan();
    plan.platformMatrix[0] = { ...plan.platformMatrix[0]!, publisher: 'gemfury' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects unknown resolvedSource', () => {
    const plan = makeValidPlan();
    plan.gates[0] = { ...plan.gates[0]!, resolvedSource: 'env-override' as never };
    expect(() => parseReleasePlan(plan)).toThrow();
  });
});

// ─── Required-field rejection ────────────────────────────────────────────────

describe('ReleasePlanSchema — required fields', () => {
  it('rejects missing version', () => {
    const plan = makeValidPlan() as Partial<ReleasePlan>;
    delete plan.version;
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects missing epicId', () => {
    const plan = makeValidPlan() as Partial<ReleasePlan>;
    delete plan.epicId;
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects empty epicId string', () => {
    const plan = { ...makeValidPlan(), epicId: '' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects missing tasks array', () => {
    const plan = makeValidPlan() as Partial<ReleasePlan>;
    delete plan.tasks;
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects missing changelog object', () => {
    const plan = makeValidPlan() as Partial<ReleasePlan>;
    delete plan.changelog;
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects missing preflightSummary', () => {
    const plan = makeValidPlan() as Partial<ReleasePlan>;
    delete plan.preflightSummary;
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects missing epicAncestor on a task row', () => {
    const plan = makeValidPlan();
    const taskWithoutAncestor = { ...plan.tasks[0]! } as Partial<ReleasePlan['tasks'][number]>;
    delete taskWithoutAncestor.epicAncestor;
    plan.tasks[0] = taskWithoutAncestor as ReleasePlan['tasks'][number];
    expect(() => parseReleasePlan(plan)).toThrow();
  });

  it('rejects malformed createdAt timestamp', () => {
    const plan = { ...makeValidPlan(), createdAt: 'yesterday' };
    expect(() => parseReleasePlan(plan)).toThrow();
  });
});

// ─── Evidence atoms (contract permissive — R-301 verb-enforced) ─────────────

describe('ReleasePlanTaskSchema — evidenceAtoms', () => {
  it('accepts a string[] for evidenceAtoms', () => {
    const result = ReleasePlanTaskSchema.parse({
      id: 'T1',
      kind: 'feat',
      impact: 'patch',
      userFacingSummary: '',
      evidenceAtoms: ['commit:abc'],
      epicAncestor: 'E1',
    });
    expect(result.evidenceAtoms).toEqual(['commit:abc']);
  });

  it('permits an empty evidenceAtoms array at the contract layer (R-301 is verb-enforced)', () => {
    const result = ReleasePlanTaskSchema.safeParse({
      id: 'T1',
      kind: 'feat',
      impact: 'patch',
      userFacingSummary: '',
      evidenceAtoms: [],
      epicAncestor: 'E1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-array evidenceAtoms', () => {
    const result = ReleasePlanTaskSchema.safeParse({
      id: 'T1',
      kind: 'feat',
      impact: 'patch',
      userFacingSummary: '',
      evidenceAtoms: 'commit:abc',
      epicAncestor: 'E1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string atom entries (NonEmptyString)', () => {
    const result = ReleasePlanTaskSchema.safeParse({
      id: 'T1',
      kind: 'feat',
      impact: 'patch',
      userFacingSummary: '',
      evidenceAtoms: [''],
      epicAncestor: 'E1',
    });
    expect(result.success).toBe(false);
  });
});

// ─── meta forward-compat ─────────────────────────────────────────────────────

describe('ReleasePlanMetaSchema — forward compatibility', () => {
  it('preserves unknown keys via catchall', () => {
    const result = ReleasePlanMetaSchema.parse({
      firstEverRelease: false,
      futureField: 'someValue',
      anotherUnknown: { nested: true },
    });
    expect((result as Record<string, unknown>).futureField).toBe('someValue');
    expect((result as Record<string, unknown>).anotherUnknown).toEqual({ nested: true });
  });

  it('still validates known fields strictly', () => {
    const result = ReleasePlanMetaSchema.safeParse({
      firstEverRelease: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully-empty meta object', () => {
    expect(() => ReleasePlanMetaSchema.parse({})).not.toThrow();
  });
});

// ─── Nested-schema sanity ────────────────────────────────────────────────────

describe('Nested schemas — sanity', () => {
  it('ReleaseGateSchema requires lastVerifiedAt to be ISO-8601', () => {
    const result = ReleaseGateSchema.safeParse({
      name: 'test',
      atom: 'tool:test',
      status: 'passed',
      lastVerifiedAt: 'Tuesday',
    });
    expect(result.success).toBe(false);
  });

  it('ReleasePlatformMatrixEntrySchema applies smoke=true default when omitted', () => {
    const result = ReleasePlatformMatrixEntrySchema.parse({
      platform: 'any',
      publisher: 'npm',
      package: '@cleocode/lafs',
    });
    expect(result.smoke).toBe(true);
  });

  it('ReleasePreflightSummarySchema requires the four boolean preflight gates', () => {
    const result = ReleasePreflightSummarySchema.safeParse({
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      // doubleListingClean omitted
    });
    expect(result.success).toBe(false);
  });

  it('ReleasePlanChangelogSchema applies empty-array defaults for omitted buckets', () => {
    const result = ReleasePlanChangelogSchema.parse({});
    expect(result.features).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.chores).toEqual([]);
    expect(result.breaking).toEqual([]);
  });

  it('ReleasePlanSchema accepts plans with no tasks (e.g. config-only releases)', () => {
    const plan = makeValidPlan();
    plan.tasks = [];
    plan.changelog.features = [];
    expect(() => parseReleasePlan(plan)).not.toThrow();
  });

  it('safeParseReleasePlan surfaces issues for bad enums', () => {
    const result = safeParseReleasePlan({ ...makeValidPlan(), channel: 'invalid-channel' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ─── Schema export sanity ────────────────────────────────────────────────────

describe('ReleasePlanSchema — module surface', () => {
  it('exports a Zod object schema at the top level', () => {
    expect(typeof ReleasePlanSchema.parse).toBe('function');
    expect(typeof ReleasePlanSchema.safeParse).toBe('function');
  });
});

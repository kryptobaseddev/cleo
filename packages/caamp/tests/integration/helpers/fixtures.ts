/**
 * Reusable test fixtures for skills CLI integration tests.
 *
 * Eliminates ~250 LOC of duplicated literal objects (install results, tracked
 * skill records, audit findings, marketplace hits, etc.) from
 * `packages/caamp/tests/integration/skills-commands-coverage.test.ts` (T9836).
 *
 * @remarks
 * Each factory returns a strongly-typed object using interfaces imported from
 * the `@cleocode/caamp` package boundary. Callers may pass an `overrides`
 * partial to override specific fields without re-declaring the entire shape.
 * NO inline / synthetic types — every shape is wired to a real exported
 * contract per AGENTS.md "Type Safety (ZERO TOLERANCE)".
 *
 * @public
 */

import type {
  AuditFinding,
  AuditResult,
  AuditSeverity,
  LockEntry,
} from '../../../src/types.js';
import type { MarketplaceResult } from '../../../src/core/marketplace/types.js';
import type {
  GitFetchResult,
} from '../../../src/core/sources/github.js';
import type {
  SkillInstallResult,
} from '../../../src/core/skills/installer.js';

/**
 * Build a successful {@link SkillInstallResult}.
 *
 * @remarks
 * Replaces ~19 inline copies of:
 * ```typescript
 * mocks.installSkill.mockResolvedValue({
 *   success: true, canonicalPath: "/tmp/canonical/demo",
 *   linkedAgents: ["claude-code"], errors: [],
 * });
 * ```
 *
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function installSuccess(
  overrides: Partial<SkillInstallResult> = {},
): SkillInstallResult {
  return {
    name: 'demo',
    success: true,
    canonicalPath: '/tmp/canonical/demo',
    linkedAgents: ['claude-code'],
    errors: [],
    ...overrides,
  };
}

/**
 * Build a failed {@link SkillInstallResult}.
 *
 * @param errors - Error message list (must be non-empty for `success=false`).
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function installFailure(
  errors: string[] = ['cannot link', 'permission denied'],
  overrides: Partial<SkillInstallResult> = {},
): SkillInstallResult {
  return {
    name: 'demo',
    success: false,
    canonicalPath: '',
    linkedAgents: [],
    errors,
    ...overrides,
  };
}

/**
 * Build a {@link LockEntry} (tracked-skill record) with sensible GitHub
 * source defaults.
 *
 * @remarks
 * Replaces ~14 inline copies of the 8-field tracked-skill literal used by
 * `getTrackedSkills.mockResolvedValue({...})` in the update + check tests.
 *
 * @param name - Skill name (used for both `name` and `scopedName` by default).
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function trackedSkill(
  name: string,
  overrides: Partial<LockEntry> = {},
): LockEntry {
  return {
    name,
    scopedName: name,
    source: 'owner/repo',
    sourceType: 'github',
    agents: ['claude-code'],
    canonicalPath: '/path',
    isGlobal: true,
    installedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Build a single {@link AuditFinding} of the requested severity.
 *
 * @remarks
 * Replaces ~12 inline copies of:
 * ```typescript
 * { rule: { id: "CI001", severity: "critical", name: "...", description: "..." },
 *   line: 5, context: "rm -rf /" }
 * ```
 *
 * @param severity - Audit severity level.
 * @param ruleId - Optional rule id override (defaults to a severity-keyed id).
 *
 * @public
 */
export function scanFinding(
  severity: AuditSeverity,
  ruleId?: string,
): AuditFinding {
  const id = ruleId ?? defaultRuleId(severity);
  const name = defaultRuleName(severity);
  return {
    rule: {
      id,
      name,
      description: `${name} issue`,
      severity,
      category: 'injection',
      pattern: /placeholder/,
    },
    line: 5,
    column: 1,
    match: 'placeholder',
    context: 'placeholder context',
  };
}

/** @internal */
function defaultRuleId(severity: AuditSeverity): string {
  switch (severity) {
    case 'critical':
      return 'CI001';
    case 'high':
      return 'H001';
    case 'medium':
      return 'M001';
    case 'low':
      return 'L001';
    case 'info':
      return 'I001';
  }
}

/** @internal */
function defaultRuleName(severity: AuditSeverity): string {
  switch (severity) {
    case 'critical':
      return 'Command Injection';
    case 'high':
      return 'High Risk';
    case 'medium':
      return 'Medium Risk';
    case 'low':
      return 'Low Risk';
    case 'info':
      return 'Info';
  }
}

/**
 * Build a single-file {@link AuditResult} with no findings (passed).
 *
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function passingAuditResult(
  overrides: Partial<AuditResult> = {},
): AuditResult {
  return {
    file: '/skills/good/SKILL.md',
    findings: [],
    score: 100,
    passed: true,
    ...overrides,
  };
}

/**
 * Build a {@link MarketplaceResult} hit.
 *
 * @remarks
 * Replaces ~8 inline copies of the marketplace result literal in the
 * `skills find` section.
 *
 * @param name - Short skill name.
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function marketplaceHit(
  name: string,
  overrides: Partial<MarketplaceResult> = {},
): MarketplaceResult {
  return {
    name,
    scopedName: `@author/${name}`,
    description: `Test skill ${name}`,
    author: 'author',
    stars: 100,
    githubUrl: `https://github.com/author/${name}`,
    repoFullName: `author/${name}`,
    path: `skills/${name}/SKILL.md`,
    source: 'skillsmp',
    ...overrides,
  };
}

/**
 * Build a {@link GitFetchResult} clone fixture with a no-op cleanup.
 *
 * @param overrides - Partial overrides for any field.
 *
 * @public
 */
export function clonedRepo(
  overrides: Partial<GitFetchResult> = {},
): GitFetchResult {
  return {
    localPath: '/tmp/cloned',
    cleanup: async () => {
      /* no-op */
    },
    ...overrides,
  };
}

/**
 * Build an "update-available" {@link checkSkillUpdate} response.
 *
 * @public
 */
export function updateAvailable(
  overrides: Partial<{
    hasUpdate: boolean;
    currentVersion?: string;
    latestVersion?: string;
    status: 'up-to-date' | 'update-available' | 'unknown';
  }> = {},
): {
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  status: 'up-to-date' | 'update-available' | 'unknown';
} {
  return {
    hasUpdate: true,
    currentVersion: 'abc123',
    latestVersion: 'def456',
    status: 'update-available',
    ...overrides,
  };
}

/**
 * Build an "up-to-date" {@link checkSkillUpdate} response.
 *
 * @public
 */
export function upToDate(): {
  hasUpdate: false;
  status: 'up-to-date';
} {
  return { hasUpdate: false, status: 'up-to-date' };
}

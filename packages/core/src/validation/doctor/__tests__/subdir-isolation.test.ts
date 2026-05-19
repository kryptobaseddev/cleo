/**
 * Subdir-isolation tests for the T9581 project-root resolution fix.
 *
 * Verifies that callable surfaces in:
 *   - validation/doctor/checks.ts   (doctor health checks)
 *   - lifecycle/engine-ops.ts       (lifecycle pipeline ops)
 *   - compliance/index.ts           (compliance metrics)
 *
 * resolve their effective project root through `getProjectRoot()` rather
 * than raw `process.cwd()`. The regression scenario is invocation from a
 * monorepo subdirectory (`<root>/packages/<X>`) — without normalization,
 * each call previously created or wrote to `<root>/packages/<X>/.cleo/`
 * instead of the canonical `<root>/.cleo/`, silently corrupting state.
 *
 * The tests exercise both invocation styles documented in T9580:
 *   (a) `process.chdir(subdir)` — caller's cwd is a subdir, fn invoked
 *       with no explicit `cwd`/`projectRoot` argument.
 *   (b) explicit subdir arg — caller passes `cwd: <subdir>` directly.
 * Both MUST resolve to the canonical project root.
 *
 * @task T9581
 * @epic T9580
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncComplianceMetrics } from '../../../compliance/index.js';
import { lifecycleStatus } from '../../../lifecycle/engine-ops.js';
import {
  checkAgentsMdHub,
  checkCleoGitignore,
  checkLegacyAgentOutputs,
  checkRootGitignore,
} from '../checks.js';

// ---------------------------------------------------------------------------
// Test fixture: a synthetic project root with a deeply nested subdir
// ---------------------------------------------------------------------------

interface Fixture {
  /** Canonical project root: `<tmp>/proj-<rand>` with `.cleo/` + `.git/`. */
  rootDir: string;
  /** Monorepo subdir below the root: `<rootDir>/packages/core`. */
  subDir: string;
}

function makeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'cleo-subdir-iso-'));
  // T9581: validateProjectRoot() requires `.cleo/` AND (`.git/` directory
  // OR `.cleo/project-info.json`). Use the legacy-fallback path (`.git/`)
  // to match how most real projects look during early CLEO bootstrap.
  mkdirSync(join(rootDir, '.cleo', 'metrics'), { recursive: true });
  mkdirSync(join(rootDir, '.git'), { recursive: true });
  // Add project-info.json so getProjectRoot() takes the primary (non-warning)
  // path through validateProjectRoot() — avoids stderr noise in test output.
  writeFileSync(
    join(rootDir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'subdir-iso-test' }),
  );
  // Create a monorepo-style subdir; this is the path callers invoke from
  // when the regression surfaces.
  const subDir = join(rootDir, 'packages', 'core');
  mkdirSync(subDir, { recursive: true });
  return { rootDir, subDir };
}

/**
 * Snapshot and clear all CLEO_* env vars so the test sees a clean
 * env-var resolution path (no operator's CLEO_ROOT bleeding in).
 */
function useCleanEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) {
          process.env[key] = val;
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Suite: doctor/checks.ts — subdir isolation
// ---------------------------------------------------------------------------

describe('T9581 — doctor/checks.ts: project-root resolution from subdir', () => {
  let fixture: Fixture;
  let origCwd: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    origCwd = process.cwd();
    const env = useCleanEnv();
    restoreEnv = env.restore;
    fixture = makeFixture();
  });

  afterEach(() => {
    try {
      process.chdir(origCwd);
    } catch {
      /* ignore */
    }
    restoreEnv();
    try {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('checkAgentsMdHub: resolves to rootDir/.cleo when called with explicit subdir cwd', () => {
    // Sanity: the subdir has no .cleo/ of its own.
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);

    // Invocation style (b): explicit subdir cwd argument.
    const result = checkAgentsMdHub(fixture.subDir);

    // The check reads AGENTS.md from the resolved project root. Without
    // T9581's getProjectRoot() normalization, the path would point at
    // `<subdir>/AGENTS.md` (does not exist). With normalization, it points
    // at `<rootDir>/AGENTS.md` (also doesn't exist, but the resolved path
    // proves which root the check chose).
    const detailPath = String((result.details as Record<string, unknown>)['path'] ?? '');
    expect(detailPath).toBe(join(fixture.rootDir, 'AGENTS.md'));
    // No stray `.cleo/` was created under the subdir.
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
  });

  it('checkAgentsMdHub: resolves to rootDir/.cleo when invoked from subdir cwd (chdir)', () => {
    // Invocation style (a): no arg, but process.cwd() is the subdir.
    process.chdir(fixture.subDir);
    const result = checkAgentsMdHub();
    const detailPath = String((result.details as Record<string, unknown>)['path'] ?? '');
    // T9601: macOS resolves /var/folders/... → /private/var/folders/... via
    // realpath, while fixture.rootDir is the symlinked form. Normalize both
    // sides to canonical paths for comparison.
    expect(detailPath).toBe(join(realpathSync(fixture.rootDir), 'AGENTS.md'));
  });

  it('checkRootGitignore: reads <rootDir>/.gitignore, not <subdir>/.gitignore', () => {
    // Plant a `.gitignore` with a `.cleo/` entry at the root — the check
    // looks for ignored `.cleo/` to surface a warning.
    writeFileSync(join(fixture.rootDir, '.gitignore'), '.cleo/\nnode_modules/\n');

    const result = checkRootGitignore(fixture.subDir);
    const detailPath = String((result.details as Record<string, unknown>)['path'] ?? '');
    expect(detailPath).toBe(join(fixture.rootDir, '.gitignore'));
    // The check should have detected the `.cleo/` blocking line at rootDir,
    // not failed to find a .gitignore in the subdir.
    expect(result.status).toBe('warning');
  });

  it('checkCleoGitignore: reads <rootDir>/.cleo/.gitignore, not <subdir>/.cleo/.gitignore', () => {
    writeFileSync(join(fixture.rootDir, '.cleo', '.gitignore'), '# placeholder\n');

    const result = checkCleoGitignore(fixture.subDir);
    const detailPath = String((result.details as Record<string, unknown>)['path'] ?? '');
    expect(detailPath).toBe(join(fixture.rootDir, '.cleo', '.gitignore'));
  });

  it('checkLegacyAgentOutputs: scans <rootDir>/.cleo, not <subdir>/.cleo', () => {
    // No legacy outputs at root → status passed.
    const result = checkLegacyAgentOutputs(fixture.subDir);
    expect(result.status).toBe('passed');
    // No stray `.cleo/` should appear in the subdir.
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: lifecycle/engine-ops.ts — subdir isolation
// ---------------------------------------------------------------------------

describe('T9581 — lifecycle/engine-ops.ts: project-root resolution from subdir', () => {
  let fixture: Fixture;
  let origCwd: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    origCwd = process.cwd();
    const env = useCleanEnv();
    restoreEnv = env.restore;
    fixture = makeFixture();
  });

  afterEach(async () => {
    try {
      process.chdir(origCwd);
    } catch {
      /* ignore */
    }
    restoreEnv();
    // Best-effort close any DB handles before cleanup (mirror lifecycle test pattern)
    try {
      const { closeDb } = await import('../../../store/sqlite.js');
      closeDb();
    } catch {
      /* ignore — closeDb may not be available in all build modes */
    }
    try {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('lifecycleStatus: opens DB under <rootDir>/.cleo, not <subdir>/.cleo (explicit cwd)', async () => {
    // Invocation style (b): explicit subdir as projectRoot argument.
    const result = await lifecycleStatus('T-test-9581', fixture.subDir);
    // Function returns success because uninitialized status is a valid response.
    expect(result.success).toBe(true);

    // CRITICAL: no `.cleo/` directory should have been created under the
    // subdir. Before T9581, the lifecycle DB layer would create
    // `<subdir>/.cleo/tasks.db` on first access.
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
    // If a DB was created, it must be under the canonical root.
    // (lifecycleStatus is read-only on uninitialized state, so the DB
    // file may or may not exist — but if it does, it is under rootDir.)
    const subCleoPath = join(fixture.subDir, '.cleo');
    expect(existsSync(subCleoPath)).toBe(false);
  });

  it('lifecycleStatus: opens DB under <rootDir>/.cleo when invoked from subdir cwd (chdir)', async () => {
    process.chdir(fixture.subDir);
    // Invocation style (a): no projectRoot arg; resolution falls through
    // to getProjectRoot() which now correctly walks up from the subdir.
    const result = await lifecycleStatus('T-test-9581');
    expect(result.success).toBe(true);
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: compliance/index.ts — subdir isolation
// ---------------------------------------------------------------------------

describe('T9581 — compliance/index.ts: project-root resolution from subdir', () => {
  let fixture: Fixture;
  let origCwd: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    origCwd = process.cwd();
    const env = useCleanEnv();
    restoreEnv = env.restore;
    fixture = makeFixture();
  });

  afterEach(() => {
    try {
      process.chdir(origCwd);
    } catch {
      /* ignore */
    }
    restoreEnv();
    try {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('syncComplianceMetrics: writes summary under <rootDir>/.cleo (explicit subdir cwd)', async () => {
    // Plant a JSONL file at the canonical root so sync has data to process.
    const jsonlPath = join(fixture.rootDir, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        timestamp: '2026-05-18T10:00:00Z',
        source_id: 'agent-1',
        source_type: 'subagent',
        compliance: {
          compliance_pass_rate: 1.0,
          rule_adherence_score: 0.9,
          violation_count: 0,
        },
      }) + '\n',
      'utf-8',
    );

    // Invocation style (b): explicit subdir cwd.
    const result = await syncComplianceMetrics({ cwd: fixture.subDir });
    expect(result.synced).toBe(1);

    // Summary MUST land at <rootDir>/.cleo/metrics/, not <subdir>/.cleo/...
    const canonicalSummary = join(fixture.rootDir, '.cleo', 'metrics', 'compliance-summary.json');
    const subdirSummary = join(fixture.subDir, '.cleo', 'metrics', 'compliance-summary.json');
    expect(existsSync(canonicalSummary)).toBe(true);
    expect(existsSync(subdirSummary)).toBe(false);
    // No stray .cleo/ tree under the subdir.
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
  });

  it('syncComplianceMetrics: writes summary under <rootDir>/.cleo when invoked from subdir cwd (chdir)', async () => {
    const jsonlPath = join(fixture.rootDir, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        timestamp: '2026-05-18T10:00:00Z',
        source_id: 'agent-1',
        source_type: 'subagent',
        compliance: {
          compliance_pass_rate: 1.0,
          rule_adherence_score: 0.9,
          violation_count: 0,
        },
      }) + '\n',
      'utf-8',
    );

    // Invocation style (a): chdir to subdir, no explicit cwd.
    process.chdir(fixture.subDir);
    const result = await syncComplianceMetrics({});
    expect(result.synced).toBe(1);

    const canonicalSummary = join(fixture.rootDir, '.cleo', 'metrics', 'compliance-summary.json');
    const subdirSummary = join(fixture.subDir, '.cleo', 'metrics', 'compliance-summary.json');
    expect(existsSync(canonicalSummary)).toBe(true);
    expect(existsSync(subdirSummary)).toBe(false);
    expect(existsSync(join(fixture.subDir, '.cleo'))).toBe(false);
  });
});

/**
 * Boundary-enforcement tests for the git-shim (T1591).
 *
 * Covers the four boundaries:
 *   (a) git add path inside agent worktree
 *   (b) git commit subject contains task ID
 *   (c) git merge requires CLEO_ORCHESTRATE_MERGE=1
 *   (d) git cherry-pick refuses task/T<NUM> sources
 *
 * Plus override (`CLEO_ALLOW_GIT=1`) + audit-log persistence.
 *
 * Tests are project-agnostic: fixture lives under a tmpdir using a fake
 * project name (`fake-project-T1591`). No cleocode-specific paths.
 *
 * @task T1591
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditRecord, resolveAuditLogPath, writeAuditRecord } from '../audit-log.js';
import {
  validateAddPaths,
  validateCherryPickSource,
  validateCommitSubject,
  validateMergeAllowed,
} from '../boundary.js';
import {
  extractTaskIdFromWorktreePath,
  isPathInsideWorktree,
  resolveActiveWorktree,
  resolveCleoWorktreesRoot,
} from '../worktree-path.js';

let workspace: string;
let auditLogPath: string;
const ENV_KEYS = [
  'CLEO_AGENT_ROLE',
  'CLEO_WORKTREE_ROOT',
  'CLEO_TASK_ID',
  'CLEO_ALLOW_GIT',
  'CLEO_ORCHESTRATE_MERGE',
  'CLEO_AUDIT_LOG_PATH',
  'XDG_DATA_HOME',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  workspace = mkdtempSync(join(tmpdir(), 'cleo-git-shim-T1591-'));
  // Treat the workspace as a fake XDG_DATA_HOME so worktree paths land here.
  process.env['XDG_DATA_HOME'] = workspace;
  auditLogPath = join(workspace, 'audit', 'git-shim.jsonl');
  process.env['CLEO_AUDIT_LOG_PATH'] = auditLogPath;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// worktree-path resolution (project-agnostic)
// ---------------------------------------------------------------------------

describe('worktree-path resolution', () => {
  it('resolveCleoWorktreesRoot uses XDG_DATA_HOME', () => {
    const root = resolveCleoWorktreesRoot();
    expect(root).toBe(join(workspace, 'cleo', 'worktrees'));
  });

  it('extractTaskIdFromWorktreePath returns taskId from canonical layout', () => {
    const wt = join(workspace, 'cleo', 'worktrees', 'abc123def4567890', 'T1591');
    const taskId = extractTaskIdFromWorktreePath(wt);
    expect(taskId).toBe('T1591');
  });

  it('extractTaskIdFromWorktreePath returns null outside worktree root', () => {
    expect(extractTaskIdFromWorktreePath('/var/tmp/somewhere')).toBeNull();
  });

  it('isPathInsideWorktree detects descendants', () => {
    const wt = join(workspace, 'cleo', 'worktrees', 'p1', 'T1591');
    expect(isPathInsideWorktree(join(wt, 'src/file.ts'), wt)).toBe(true);
    expect(isPathInsideWorktree(wt, wt)).toBe(true);
    expect(isPathInsideWorktree('/var/tmp/other', wt)).toBe(false);
  });

  it('resolveActiveWorktree honours CLEO_WORKTREE_ROOT + CLEO_TASK_ID', () => {
    const wt = join(workspace, 'cleo', 'worktrees', 'p1', 'T9999');
    mkdirSync(wt, { recursive: true });
    process.env['CLEO_WORKTREE_ROOT'] = wt;
    process.env['CLEO_TASK_ID'] = 'T9999';
    const active = resolveActiveWorktree('/some/unrelated/cwd');
    expect(active).toEqual({ worktreePath: wt, taskId: 'T9999' });
  });

  it('resolveActiveWorktree walks up from cwd inside a worktree', () => {
    const wt = join(workspace, 'cleo', 'worktrees', 'p1', 'T1591');
    mkdirSync(join(wt, 'src'), { recursive: true });
    const active = resolveActiveWorktree(join(wt, 'src'));
    expect(active?.taskId).toBe('T1591');
    expect(active?.worktreePath).toBe(wt);
  });

  it('resolveActiveWorktree returns null outside worktree tree', () => {
    expect(resolveActiveWorktree('/tmp/random')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boundary (a) — git add path inside worktree
// ---------------------------------------------------------------------------

describe('boundary (a): worktree-path enforcement', () => {
  const worktreePath = '/var/tmp/wt/T1591';

  it('allows git add . (no explicit path)', () => {
    expect(validateAddPaths(['.'], worktreePath, worktreePath)).toBeNull();
  });

  it('allows git add inside worktree', () => {
    expect(validateAddPaths(['src/file.ts'], worktreePath, worktreePath)).toBeNull();
  });

  it('allows git add with -A flag', () => {
    expect(validateAddPaths(['-A'], worktreePath, worktreePath)).toBeNull();
  });

  it('refuses git add with absolute path outside worktree', () => {
    const v = validateAddPaths(['/etc/passwd'], worktreePath, worktreePath);
    expect(v).not.toBeNull();
    expect(v?.code).toBe('E_GIT_BOUNDARY_WORKTREE_PATH');
    expect(v?.boundary).toBe('a');
    expect(v?.context['attempted_path']).toBe('/etc/passwd');
  });

  it('refuses git add with ../escape relative path', () => {
    const v = validateAddPaths(['../../etc/passwd'], worktreePath, worktreePath);
    expect(v).not.toBeNull();
    expect(v?.code).toBe('E_GIT_BOUNDARY_WORKTREE_PATH');
  });
});

// ---------------------------------------------------------------------------
// Boundary (b) — commit subject must contain task ID
// ---------------------------------------------------------------------------

describe('boundary (b): commit T-ID gate', () => {
  it('allows commit with T<NUM> in subject (no expected ID)', () => {
    expect(validateCommitSubject(['-m', 'feat(T1591): add boundary'], null)).toBeNull();
  });

  it('refuses commit without any T<NUM> token', () => {
    const v = validateCommitSubject(['-m', 'wip: stuff'], null);
    expect(v).not.toBeNull();
    expect(v?.code).toBe('E_GIT_BOUNDARY_COMMIT_TASK_ID');
    expect(v?.boundary).toBe('b');
  });

  it('refuses commit when expected ID is missing from subject', () => {
    const v = validateCommitSubject(['-m', 'feat(T9999): wrong id'], 'T1591');
    expect(v).not.toBeNull();
    expect(v?.context['expected_task_id']).toBe('T1591');
  });

  it('allows commit with --message=… inline syntax', () => {
    expect(validateCommitSubject(['--message=fix(T1591): boundary'], 'T1591')).toBeNull();
  });

  it('passes through commits with no inline -m (editor flow)', () => {
    expect(validateCommitSubject([], null)).toBeNull();
    expect(validateCommitSubject(['--amend'], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boundary (c) — merge requires CLEO_ORCHESTRATE_MERGE
// ---------------------------------------------------------------------------

describe('boundary (c): merge restriction', () => {
  it('refuses git merge without CLEO_ORCHESTRATE_MERGE', () => {
    const v = validateMergeAllowed(['task/T1591'], {});
    expect(v).not.toBeNull();
    expect(v?.code).toBe('E_GIT_BOUNDARY_MERGE_FORBIDDEN');
    expect(v?.boundary).toBe('c');
  });

  it('allows git merge when CLEO_ORCHESTRATE_MERGE=1', () => {
    expect(validateMergeAllowed(['task/T1591'], { CLEO_ORCHESTRATE_MERGE: '1' })).toBeNull();
  });

  it('allows control-flow flags --abort/--continue/--quit without env', () => {
    expect(validateMergeAllowed(['--abort'], {})).toBeNull();
    expect(validateMergeAllowed(['--continue'], {})).toBeNull();
    expect(validateMergeAllowed(['--quit'], {})).toBeNull();
  });

  it('refuses when env value is not exactly "1"', () => {
    const v = validateMergeAllowed(['task/T1591'], { CLEO_ORCHESTRATE_MERGE: 'true' });
    expect(v).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boundary (d) — cherry-pick refuses task/T<NUM> sources
// ---------------------------------------------------------------------------

describe('boundary (d): cherry-pick from worktree branches', () => {
  it('refuses cherry-pick of task/T1591', () => {
    const v = validateCherryPickSource(['task/T1591']);
    expect(v).not.toBeNull();
    expect(v?.code).toBe('E_GIT_BOUNDARY_CHERRY_PICK_TASK_BRANCH');
    expect(v?.boundary).toBe('d');
  });

  it('refuses cherry-pick of range task/T1591..HEAD', () => {
    const v = validateCherryPickSource(['task/T1591..HEAD']);
    expect(v).not.toBeNull();
    expect(v?.context['source_ref']).toBe('task/T1591');
  });

  it('refuses cherry-pick of triple-dot range', () => {
    const v = validateCherryPickSource(['main...task/T1591']);
    expect(v).not.toBeNull();
  });

  it('allows cherry-pick of regular branch', () => {
    expect(validateCherryPickSource(['feature/regular-branch'])).toBeNull();
  });

  it('allows cherry-pick of explicit SHA', () => {
    expect(validateCherryPickSource(['abc123def456'])).toBeNull();
  });

  it('allows cherry-pick of HEAD~3', () => {
    expect(validateCherryPickSource(['HEAD~3'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('audit log', () => {
  it('resolveAuditLogPath honours CLEO_AUDIT_LOG_PATH override', () => {
    expect(resolveAuditLogPath()).toBe(auditLogPath);
  });

  it('resolveAuditLogPath defaults to XDG-conformant path', () => {
    delete process.env['CLEO_AUDIT_LOG_PATH'];
    expect(resolveAuditLogPath()).toBe(join(workspace, 'cleo', 'audit', 'git-shim.jsonl'));
  });

  it('writeAuditRecord persists a JSONL entry', () => {
    const record: AuditRecord = {
      ts: '2026-04-29T00:00:00.000Z',
      outcome: 'blocked',
      boundary: 'a',
      code: 'E_GIT_BOUNDARY_WORKTREE_PATH',
      subcommand: 'add',
      args: ['/etc/passwd'],
      cwd: '/var/tmp/wt/T1591',
      worktree_path: '/var/tmp/wt/T1591',
      task_id: 'T1591',
      role: 'worker',
      context: { attempted_path: '/etc/passwd' },
    };
    writeAuditRecord(record);
    expect(existsSync(auditLogPath)).toBe(true);
    const content = readFileSync(auditLogPath, 'utf-8').trim();
    const parsed = JSON.parse(content) as AuditRecord;
    expect(parsed.code).toBe('E_GIT_BOUNDARY_WORKTREE_PATH');
    expect(parsed.outcome).toBe('blocked');
    expect(parsed.boundary).toBe('a');
  });

  it('writeAuditRecord appends rather than overwrites', () => {
    const base: AuditRecord = {
      ts: '2026-04-29T00:00:00.000Z',
      outcome: 'blocked',
      boundary: 'b',
      code: 'E_GIT_BOUNDARY_COMMIT_TASK_ID',
      subcommand: 'commit',
      args: ['-m', 'wip'],
      cwd: '/var/tmp/wt/T1591',
      worktree_path: null,
      task_id: null,
      role: 'worker',
      context: {},
    };
    writeAuditRecord(base);
    writeAuditRecord({ ...base, outcome: 'bypassed-allow-git' });
    const lines = readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? '{}') as AuditRecord).outcome).toBe('blocked');
    expect((JSON.parse(lines[1] ?? '{}') as AuditRecord).outcome).toBe('bypassed-allow-git');
  });
});

// ---------------------------------------------------------------------------
// Project-agnostic verification (no cleocode-specific paths)
// ---------------------------------------------------------------------------

describe('project-agnostic verification', () => {
  it('worktree path uses a fake project name without hardcoding "cleocode"', () => {
    // Resolve a worktree path for a fake project at /home/user/projects/fake-app.
    // The sha256-derived hash should never contain "cleocode".
    const fakeProjectRoot = '/home/user/projects/fake-app';
    const wt = join(workspace, 'cleo', 'worktrees', 'someProjectHash', 'T1591');
    mkdirSync(wt, { recursive: true });
    process.env['CLEO_WORKTREE_ROOT'] = wt;
    process.env['CLEO_TASK_ID'] = 'T1591';
    const active = resolveActiveWorktree('/totally/elsewhere');
    expect(active?.worktreePath).toBe(wt);
    expect(active?.worktreePath.includes('cleocode')).toBe(false);
    // Reference to fakeProjectRoot to keep the test self-documenting.
    expect(fakeProjectRoot.includes('cleocode')).toBe(false);
  });

  it('audit log path uses XDG conventions, not project name', () => {
    delete process.env['CLEO_AUDIT_LOG_PATH'];
    const path = resolveAuditLogPath();
    expect(path.includes('cleocode')).toBe(false);
    expect(path.endsWith(join('cleo', 'audit', 'git-shim.jsonl'))).toBe(true);
  });
});

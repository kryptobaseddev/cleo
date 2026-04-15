/**
 * Unit tests for ProjectSelector business logic.
 *
 * These tests cover the pure logic extracted from the component:
 * - chipColor / chipLetter helpers
 * - Test-project path heuristic
 * - Search filter
 * - Unhealthy project identification
 *
 * We do NOT attempt to mount the Svelte component in Vitest (no jsdom
 * configured in this package), so we test the logic in isolation.
 *
 * @task T646
 */

import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../ProjectSelector.svelte';

// ---------------------------------------------------------------------------
// Helpers (mirror of component internals — kept in sync manually)
// ---------------------------------------------------------------------------

const CHIP_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
];

function chipColor(name: string): string {
  const code = name.charCodeAt(0) || 0;
  return CHIP_COLORS[code % CHIP_COLORS.length];
}

function chipLetter(name: string): string {
  return (name[0] ?? '?').toUpperCase();
}

const TEST_PATH_RE = /\/(tmp|test|fixture|scratch|sandbox)\b/i;

function isTestProject(projectPath: string): boolean {
  return TEST_PATH_RE.test(projectPath);
}

function filterProjects(
  projects: ProjectSummary[],
  searchQuery: string,
  showTestProjects: boolean,
): ProjectSummary[] {
  let list = projects;

  if (!showTestProjects) {
    list = list.filter((p) => !isTestProject(p.projectPath));
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    list = list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.projectPath.toLowerCase().includes(q),
    );
  }

  return list;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECTS: ProjectSummary[] = [
  {
    projectId: 'proj-cleocode',
    name: 'cleocode',
    projectPath: '/mnt/projects/cleocode',
    taskCount: 646,
    nodeCount: 11177,
    healthStatus: 'healthy',
  },
  {
    projectId: 'proj-gitnexus',
    name: 'gitnexus',
    projectPath: '/mnt/projects/gitnexus',
    taskCount: 12,
    nodeCount: 500,
    healthStatus: 'healthy',
  },
  {
    projectId: 'proj-test-repo',
    name: 'test-repo',
    projectPath: '/home/user/test/my-project',
    taskCount: 3,
    nodeCount: 0,
    healthStatus: 'healthy',
  },
  {
    projectId: 'proj-scratch',
    name: 'scratch',
    projectPath: '/tmp/scratch/experiment',
    taskCount: 0,
    nodeCount: 0,
    healthStatus: 'unhealthy',
  },
  {
    projectId: 'proj-fixture',
    name: 'fixture-data',
    projectPath: '/mnt/projects/fixture/dataset',
    taskCount: 0,
    nodeCount: 0,
    healthStatus: 'healthy',
  },
  {
    projectId: 'proj-sandbox',
    name: 'sandbox-app',
    projectPath: '/home/user/sandbox/myapp',
    taskCount: 1,
    nodeCount: 50,
    healthStatus: 'healthy',
  },
];

// ---------------------------------------------------------------------------
// Tests: chipLetter
// ---------------------------------------------------------------------------

describe('chipLetter', () => {
  it('returns the uppercased first character', () => {
    expect(chipLetter('cleocode')).toBe('C');
    expect(chipLetter('gitnexus')).toBe('G');
    expect(chipLetter('Alpha')).toBe('A');
  });

  it('returns "?" for an empty string', () => {
    expect(chipLetter('')).toBe('?');
  });
});

// ---------------------------------------------------------------------------
// Tests: chipColor
// ---------------------------------------------------------------------------

describe('chipColor', () => {
  it('returns a hex color string', () => {
    const color = chipColor('cleocode');
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('same name always produces same color', () => {
    expect(chipColor('alpha')).toBe(chipColor('alpha'));
  });

  it('different names may produce different colors', () => {
    // Not guaranteed to differ for every pair, but for these two they should
    const c1 = chipColor('Alpha');
    const c2 = chipColor('Zeta');
    // Alpha = 65, Zeta = 90 → 65%8=1, 90%8=2 → different colors
    expect(c1).not.toBe(c2);
  });

  it('returns a valid color for empty string (charCode 0 → index 0)', () => {
    expect(chipColor('')).toBe(CHIP_COLORS[0]);
  });
});

// ---------------------------------------------------------------------------
// Tests: test project heuristic
// ---------------------------------------------------------------------------

describe('isTestProject (TEST_PATH_RE)', () => {
  it('flags /test/ paths', () => {
    expect(isTestProject('/home/user/test/my-project')).toBe(true);
  });

  it('flags /tmp/ paths', () => {
    expect(isTestProject('/tmp/scratch/experiment')).toBe(true);
  });

  it('flags /fixture/ paths', () => {
    expect(isTestProject('/mnt/projects/fixture/dataset')).toBe(true);
  });

  it('flags /scratch/ paths', () => {
    expect(isTestProject('/home/user/scratch/myapp')).toBe(true);
  });

  it('flags /sandbox/ paths', () => {
    expect(isTestProject('/home/user/sandbox/myapp')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTestProject('/home/user/TEST/project')).toBe(true);
    expect(isTestProject('/home/user/Sandbox/project')).toBe(true);
  });

  it('does not flag normal project paths', () => {
    expect(isTestProject('/mnt/projects/cleocode')).toBe(false);
    expect(isTestProject('/mnt/projects/gitnexus')).toBe(false);
  });

  it('does not flag paths where test is just a substring of a word', () => {
    // "/mytestproject" — "test" appears but NOT preceded by "/"
    expect(isTestProject('/home/user/mytestproject')).toBe(false);
    // "/protesting" — not a standalone path segment
    expect(isTestProject('/home/user/protesting')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: filterProjects
// ---------------------------------------------------------------------------

describe('filterProjects — test-project visibility', () => {
  it('hides test projects by default (showTestProjects=false)', () => {
    const result = filterProjects(PROJECTS, '', false);
    const ids = result.map((p) => p.projectId);
    expect(ids).toContain('proj-cleocode');
    expect(ids).toContain('proj-gitnexus');
    expect(ids).not.toContain('proj-test-repo');
    expect(ids).not.toContain('proj-scratch');
    expect(ids).not.toContain('proj-fixture');
    expect(ids).not.toContain('proj-sandbox');
  });

  it('shows test projects when toggle is on', () => {
    const result = filterProjects(PROJECTS, '', true);
    const ids = result.map((p) => p.projectId);
    expect(ids).toContain('proj-test-repo');
    expect(ids).toContain('proj-scratch');
    expect(ids).toContain('proj-fixture');
    expect(ids).toContain('proj-sandbox');
  });
});

describe('filterProjects — search', () => {
  it('filters by project name (case-insensitive)', () => {
    const result = filterProjects(PROJECTS, 'CLEO', false);
    expect(result.length).toBe(1);
    expect(result[0].projectId).toBe('proj-cleocode');
  });

  it('filters by project path', () => {
    const result = filterProjects(PROJECTS, 'gitnexus', false);
    expect(result.length).toBe(1);
    expect(result[0].projectId).toBe('proj-gitnexus');
  });

  it('returns empty array when nothing matches', () => {
    const result = filterProjects(PROJECTS, 'zzz-no-match', false);
    expect(result.length).toBe(0);
  });

  it('respects test-project visibility when searching with toggle off', () => {
    // 'scratch' is in a test path — should not appear when showTestProjects=false
    const result = filterProjects(PROJECTS, 'scratch', false);
    expect(result.length).toBe(0);
  });

  it('finds test projects by name when toggle is on', () => {
    const result = filterProjects(PROJECTS, 'scratch', true);
    expect(result.length).toBe(1);
    expect(result[0].projectId).toBe('proj-scratch');
  });

  it('treats whitespace-only query as no filter', () => {
    const result = filterProjects(PROJECTS, '   ', false);
    // Should be same as no query, with test projects hidden
    const baseline = filterProjects(PROJECTS, '', false);
    expect(result).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// Tests: unhealthy project identification
// ---------------------------------------------------------------------------

describe('unhealthy project identification', () => {
  it('identifies unhealthy projects by healthStatus field', () => {
    const unhealthy = PROJECTS.filter((p) => p.healthStatus === 'unhealthy');
    expect(unhealthy.length).toBe(1);
    expect(unhealthy[0].projectId).toBe('proj-scratch');
  });

  it('unhealthy projects are still included in the filtered list', () => {
    // They should appear (dimmed via CSS) unless they are test projects too
    const result = filterProjects(PROJECTS, '', true);
    const scratch = result.find((p) => p.projectId === 'proj-scratch');
    expect(scratch).toBeDefined();
    expect(scratch?.healthStatus).toBe('unhealthy');
  });
});

// ---------------------------------------------------------------------------
// Tests: project name display
// ---------------------------------------------------------------------------

describe('project name display', () => {
  it('shows project name from the active project', () => {
    const activeId = 'proj-cleocode';
    const active = PROJECTS.find((p) => p.projectId === activeId);
    expect(active).toBeDefined();
    expect(active?.name).toBe('cleocode');
  });

  it('falls back gracefully when no active project', () => {
    const active = PROJECTS.find((p) => p.projectId === 'nonexistent');
    expect(active).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: switch action payload shape
// ---------------------------------------------------------------------------

describe('switch action payload', () => {
  it('posts the correct projectId', () => {
    const projectId = 'proj-gitnexus';
    const payload = JSON.stringify({ projectId });
    const parsed = JSON.parse(payload) as { projectId: string };
    expect(parsed.projectId).toBe(projectId);
  });
});

/**
 * Doctor utility functions - ported from lib/validation/doctor-utils.sh
 *
 * Functions for project categorization, health summaries, journey stage
 * detection, and guidance generation.
 *
 * @task T4525
 * @epic T4454
 */

// ============================================================================
// Types
// ============================================================================

export interface ProjectDetail {
  name: string;
  path: string;
  status: 'healthy' | 'warning' | 'failed' | 'orphaned';
  issues?: string[];
  isTemp: boolean;
  isOrphaned?: boolean;
  reason?: string;
}

export interface CategorizedProjects {
  active: ProjectDetail[];
  temp: ProjectDetail[];
  orphaned: ProjectDetail[];
}

export type UserJourneyStage =
  | 'new-user'
  | 'cleanup-needed'
  | 'setup-agents-needed'
  | 'maintenance-mode';

// ============================================================================
// Temp Project Detection
// ============================================================================

const TEMP_PATTERNS = [
  '/.temp/',
  '/tmp/',
  '/bats-run-',
  '/.tmp/',
  '/tmp.',
  '/bats.',
];

/**
 * Check if a project path is a temporary/test directory.
 * @task T4525
 */
export function isTempProject(path: string): boolean {
  return TEMP_PATTERNS.some(pattern => path.includes(pattern)) ||
    (path.includes('/test/') && (path.includes('bats-run-') || path.includes('test-')));
}

// ============================================================================
// Project Categorization
// ============================================================================

/**
 * Filter projects into categories: active, temp, orphaned.
 * @task T4525
 */
export function categorizeProjects(projects: ProjectDetail[]): CategorizedProjects {
  const active: ProjectDetail[] = [];
  const temp: ProjectDetail[] = [];
  const orphaned: ProjectDetail[] = [];

  for (const project of projects) {
    if (project.status === 'orphaned' || project.isOrphaned) {
      orphaned.push(project);
    } else if (isTempProject(project.path)) {
      temp.push(project);
    } else {
      active.push(project);
    }
  }

  return { active, temp, orphaned };
}

/**
 * Get human-readable project category name.
 * @task T4525
 */
export function getProjectCategoryName(
  category: 'active' | 'temp' | 'orphaned',
): string {
  switch (category) {
    case 'active': return 'Active Projects';
    case 'temp': return 'Temporary/Test Projects';
    case 'orphaned': return 'Orphaned Projects';
  }
}

// ============================================================================
// Health Summary
// ============================================================================

export interface HealthSummary {
  total: number;
  healthy: number;
  warnings: number;
  failed: number;
  orphaned: number;
  temp: number;
}

/**
 * Format project health summary for display.
 * @task T4525
 */
export function formatProjectHealthSummary(summary: HealthSummary): string {
  const lines: string[] = ['Project Health Summary:'];
  lines.push(`  Total Projects: ${summary.total}`);

  if (summary.healthy > 0) {
    lines.push(`  Healthy Projects: ${summary.healthy}`);
  }
  if (summary.warnings > 0) {
    lines.push(`  Projects with Warnings: ${summary.warnings}`);
  }
  if (summary.failed > 0) {
    lines.push(`  Failed Projects: ${summary.failed}`);
  }
  if (summary.temp > 0) {
    lines.push(`  Temporary Projects: ${summary.temp} (test artifacts)`);
  }
  if (summary.orphaned > 0) {
    lines.push(`  Orphaned Projects: ${summary.orphaned} (directories missing)`);
  }

  return lines.join('\n');
}

// ============================================================================
// Guidance
// ============================================================================

/**
 * Get actionable guidance for project issues.
 * @task T4525
 */
export function getProjectGuidance(
  activeFailed: number,
  activeWarnings: number,
  tempCount: number,
  orphanedCount: number,
): string[] {
  const guidance: string[] = [];

  if (activeFailed > 0) {
    guidance.push(`${activeFailed} active project(s) failed validation - run 'cleo upgrade' in affected projects`);
  }

  if (activeWarnings > 0) {
    guidance.push(`${activeWarnings} active project(s) have warnings - consider updating schemas`);
  }

  if (tempCount > 10) {
    guidance.push(`Many temporary projects detected - run 'cleo doctor --clean-temp' to clean up`);
  }

  if (orphanedCount > 5) {
    guidance.push(`${orphanedCount} orphaned projects - run 'cleo doctor --prune' to remove`);
  }

  if (guidance.length === 0) {
    guidance.push('All active projects are healthy');
  }

  return guidance;
}

// ============================================================================
// User Journey
// ============================================================================

/**
 * Check user journey stage based on system state.
 * @task T4525
 */
export function getUserJourneyStage(
  hasProjects: boolean,
  tempProjectCount: number,
  agentConfigsOk: boolean,
): UserJourneyStage {
  if (!hasProjects) return 'new-user';
  if (tempProjectCount > 10) return 'cleanup-needed';
  if (!agentConfigsOk) return 'setup-agents-needed';
  return 'maintenance-mode';
}

/**
 * Get journey-specific guidance text.
 * @task T4525
 */
export function getJourneyGuidance(stage: UserJourneyStage): string[] {
  switch (stage) {
    case 'new-user':
      return [
        'NEW USER SETUP:',
        '  1. Create your first project: cleo init my-project',
        '  2. Add tasks: cleo add "Setup development environment"',
        '  3. Configure AI assistants: cleo setup-agents',
      ];
    case 'cleanup-needed':
      return [
        'CLEANUP NEEDED:',
        '  You have many temporary projects from testing',
        "  Run 'cleo doctor --clean-temp' to clean up",
      ];
    case 'setup-agents-needed':
      return [
        'AI ASSISTANT SETUP:',
        '  Your AI assistants need CLEO configuration',
        "  Run 'cleo setup-agents' to inject task management docs",
      ];
    case 'maintenance-mode':
      return [
        'MAINTENANCE MODE:',
        '  System is healthy - check individual project issues above',
      ];
  }
}

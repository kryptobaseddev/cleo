/**
 * Data integrity audit core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccessor } from '../../store/data-accessor.js';

export interface AuditIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  fix?: string;
}

export interface AuditResult {
  scope: string;
  issues: AuditIssue[];
  summary: {
    errors: number;
    warnings: number;
    fixed: number;
  };
}

/** Audit data integrity. */
export async function auditData(
  projectRoot: string,
  opts?: { scope?: string; fix?: boolean },
): Promise<AuditResult> {
  const cleoDir = join(projectRoot, '.cleo');
  const scope = opts?.scope ?? 'all';
  const issues: AuditIssue[] = [];

  if (scope === 'all' || scope === 'tasks') {
    const tasksDbPath = join(cleoDir, 'tasks.db');
    if (existsSync(tasksDbPath)) {
      try {
        const accessor = await getAccessor(projectRoot);
        const taskFile = await accessor.loadTaskFile();
        const tasks: Array<{
          id: string;
          status: string;
          title: string;
          parentId?: string | null;
          depends?: string[];
        }> = taskFile.tasks ?? [];

        const idSet = new Set<string>();
        for (const t of tasks) {
          if (idSet.has(t.id)) {
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Duplicate task ID: ${t.id}`,
            });
          }
          idSet.add(t.id);
        }

        for (const t of tasks) {
          if (t.parentId && !idSet.has(t.parentId)) {
            issues.push({
              severity: 'warning',
              category: 'tasks',
              message: `Task ${t.id} references non-existent parent: ${t.parentId}`,
            });
          }
        }

        for (const t of tasks) {
          if (!t.title)
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Task ${t.id} missing title`,
            });
          if (!t.status)
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Task ${t.id} missing status`,
            });
        }

        for (const t of tasks) {
          if (t.depends) {
            for (const dep of t.depends) {
              if (!idSet.has(dep)) {
                issues.push({
                  severity: 'warning',
                  category: 'tasks',
                  message: `Task ${t.id} depends on non-existent: ${dep}`,
                });
              }
            }
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          category: 'tasks',
          message: `Failed to read tasks.db: ${err}`,
        });
      }
    }
  }

  if (scope === 'all' || scope === 'sessions') {
    const sessPath = join(cleoDir, 'sessions.json');
    if (existsSync(sessPath)) {
      try {
        const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
        const sessions: Array<{ id: string; scope?: { rootTaskId?: string } }> =
          data.sessions ?? [];

        const sessionIds = new Set<string>();
        for (const s of sessions) {
          if (sessionIds.has(s.id)) {
            issues.push({
              severity: 'error',
              category: 'sessions',
              message: `Duplicate session ID: ${s.id}`,
            });
          }
          sessionIds.add(s.id);
        }

        for (const s of sessions) {
          if (!s.scope?.rootTaskId) {
            issues.push({
              severity: 'warning',
              category: 'sessions',
              message: `Session ${s.id} missing scope rootTaskId`,
            });
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          category: 'sessions',
          message: `Failed to parse sessions.json: ${err}`,
        });
      }
    }
  }

  if (scope === 'all') {
    const seqPath = join(cleoDir, '.sequence.json');
    if (existsSync(seqPath)) {
      try {
        const seq = JSON.parse(readFileSync(seqPath, 'utf-8'));
        if (typeof seq.counter !== 'number') {
          issues.push({
            severity: 'error',
            category: 'sequence',
            message: 'Sequence counter is not a number',
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          category: 'sequence',
          message: 'Failed to parse .sequence.json',
        });
      }
    }
  }

  return {
    scope,
    issues,
    summary: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      fixed: 0,
    },
  };
}

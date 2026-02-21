/**
 * System cleanup core module.
 * @task T4783
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

export interface CleanupResult {
  target: string;
  deleted: number;
  items: string[];
  dryRun: boolean;
}

/** Cleanup stale data (sessions, backups, logs). */
export function cleanupSystem(
  projectRoot: string,
  params: { target: string; olderThan?: string; dryRun?: boolean },
): CleanupResult {
  if (!params.target) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'target is required (sessions|backups|logs|archive)');
  }

  const cleoDir = join(projectRoot, '.cleo');
  const dryRun = params.dryRun ?? false;
  const items: string[] = [];

  switch (params.target) {
    case 'sessions': {
      const sessPath = join(cleoDir, 'sessions.json');
      if (existsSync(sessPath)) {
        try {
          const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
          const sessions = data.sessions ?? [];
          const stale = sessions.filter((s: { status: string; lastActivity?: string; id: string }) => {
            if (s.status !== 'active') return false;
            if (params.olderThan && s.lastActivity) {
              return s.lastActivity < params.olderThan;
            }
            const cutoff = new Date(Date.now() - 86400000).toISOString();
            return s.lastActivity && s.lastActivity < cutoff;
          });
          for (const s of stale) {
            items.push((s as { id: string }).id);
          }
          if (!dryRun && stale.length > 0) {
            const staleIds = new Set(stale.map((s: { id: string }) => s.id));
            data.sessions = sessions.filter((s: { id: string }) => !staleIds.has(s.id));
            writeFileSync(sessPath, JSON.stringify(data, null, 2), 'utf-8');
          }
        } catch {
          // skip
        }
      }
      break;
    }
    case 'backups': {
      const backupBaseDir = join(cleoDir, 'backups');
      if (existsSync(backupBaseDir)) {
        for (const typeDir of readdirSync(backupBaseDir)) {
          const fullDir = join(backupBaseDir, typeDir);
          try {
            for (const file of readdirSync(fullDir)) {
              if (file.endsWith('.meta.json')) {
                const metaFilePath = join(fullDir, file);
                try {
                  const meta = JSON.parse(readFileSync(metaFilePath, 'utf-8'));
                  if (params.olderThan && meta.timestamp < params.olderThan) {
                    items.push(file.replace('.meta.json', ''));
                    if (!dryRun) {
                      unlinkSync(metaFilePath);
                      for (const bf of readdirSync(fullDir)) {
                        if (bf.includes(meta.backupId)) {
                          try { unlinkSync(join(fullDir, bf)); } catch { /* skip */ }
                        }
                      }
                    }
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }
        }
      }
      break;
    }
    case 'logs': {
      const auditPattern = /^audit-log-.*\.json$/;
      if (existsSync(cleoDir)) {
        for (const file of readdirSync(cleoDir)) {
          if (auditPattern.test(file)) {
            items.push(file);
            if (!dryRun) {
              try { unlinkSync(join(cleoDir, file)); } catch { /* skip */ }
            }
          }
        }
      }
      break;
    }
    default:
      throw new CleoError(ExitCode.INVALID_INPUT, `Invalid cleanup target: ${params.target}`);
  }

  return { target: params.target, deleted: dryRun ? 0 : items.length, items, dryRun };
}

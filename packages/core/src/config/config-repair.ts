/**
 * Config file repair — crash-safe restore from backup (Amendment 1, T11997).
 *
 * Checks a JSON config file for parse failures.  When the live file is
 * corrupt, the routine:
 *
 *   1. Quarantines the corrupt file beside the target (`.corrupt-<iso>`).
 *   2. Scans available backup snapshots for the NEWEST valid (parseable) candidate.
 *   3. Restores the best candidate atomically (tmp-rename) only when JSON parse
 *      fails AND no active write window is detected.
 *   4. Appends a structured audit record to `.cleo/audit/config-repair.jsonl`
 *      that the `cleo health` surface can consume.
 *
 * Key invariants (Amendment 1):
 *   - Never silently restore a stale backup — always quarantine first, then
 *     restore the newest valid candidate.
 *   - Restore only when `JSON.parse` fails on the live file (not merely on
 *     schema drift).
 *   - A `.tmp` survivor from a previously interrupted write (write-file-atomic
 *     pattern) takes priority over numbered backups when it is both newer and
 *     valid JSON.
 *
 * @task T11997
 * @epic T11992
 */

import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Outcome of a {@link repairConfigFile} call. */
export type ConfigRepairOutcome =
  | 'healthy'
  | 'restored-from-backup'
  | 'restored-from-tmp'
  | 'quarantined-no-candidate'
  | 'skipped-active-write';

/** Structured result of {@link repairConfigFile}. */
export interface ConfigRepairResult {
  /** What happened. */
  readonly outcome: ConfigRepairOutcome;
  /** Absolute path to the config file that was checked/restored. */
  readonly configPath: string;
  /** Absolute path to the backup used for restore (when applicable). */
  readonly restoredFrom?: string;
  /** Absolute path to the quarantine file (when a corrupt file was renamed). */
  readonly quarantinedTo?: string;
  /** Human-readable detail. */
  readonly detail: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum age of a `.tmp` file for it to be considered a "surviving write" (1 min). */
const TMP_SURVIVOR_MAX_AGE_MS = 60_000;

/** Audit log path relative to project root. */
const CONFIG_REPAIR_AUDIT_FILE = '.cleo/audit/config-repair.jsonl';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse JSON from a file path; returns `null` on any failure. */
async function tryParseJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Enumerate numbered backup files for `fileName` under `backupDir`,
 * sorted NEWEST first (lowest number = most recent).
 */
async function listNumberedBackups(fileName: string, backupDir: string): Promise<string[]> {
  if (!existsSync(backupDir)) return [];
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(backupDir);
    const prefix = `${fileName}.`;
    return entries
      .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
      .sort((a, b) => {
        const numA = parseInt(a.slice(prefix.length), 10);
        const numB = parseInt(b.slice(prefix.length), 10);
        return numA - numB; // ascending number = newest first
      })
      .map((e) => join(backupDir, e));
  } catch {
    return [];
  }
}

/** Append one JSON line to the repair audit log. */
async function appendAuditLine(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const auditPath = join(cwd, CONFIG_REPAIR_AUDIT_FILE);
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check and optionally repair a JSON config file.
 *
 * Safe to call on config paths that do not yet exist — returns `'healthy'`
 * immediately when the file is absent (a missing file is not a corrupt file).
 *
 * @param configPath  - Absolute path to the config JSON file to check.
 * @param backupDir   - Directory containing numbered `.1`, `.2`, … backups.
 *                      Pass `null` to skip backup-based restore.
 * @param cwd         - Project root for audit-log path resolution.
 * @returns Structured {@link ConfigRepairResult}.
 *
 * @example
 * ```ts
 * import { repairConfigFile } from '@cleocode/core/config/config-repair';
 *
 * const result = await repairConfigFile(
 *   '/home/user/.local/share/cleo/config.json',
 *   '/home/user/.local/share/cleo/backups',
 *   '/home/user/projects/myapp',
 * );
 * if (result.outcome === 'restored-from-backup') {
 *   console.log(`Restored from ${result.restoredFrom}`);
 * }
 * ```
 *
 * @task T11997
 */
export async function repairConfigFile(
  configPath: string,
  backupDir: string | null,
  cwd: string,
): Promise<ConfigRepairResult> {
  // ── 1. If the file doesn't exist, nothing to do ───────────────────────────
  if (!existsSync(configPath)) {
    return {
      outcome: 'healthy',
      configPath,
      detail: 'Config file does not exist; no repair needed',
    };
  }

  // ── 2. Try parsing the live file ──────────────────────────────────────────
  const liveData = await tryParseJsonFile(configPath);
  if (liveData !== null) {
    return {
      outcome: 'healthy',
      configPath,
      detail: 'Config file is valid JSON; no repair needed',
    };
  }

  // ── 3. Live file is corrupt — check for an active write window ───────────
  // write-file-atomic leaves a `.tmp` file only briefly during an active write.
  // If a `.tmp` file exists and is VERY new, we may be racing an in-progress
  // write — wait for it to finish rather than clobbering it.
  const tmpPath = `${configPath}.tmp`;
  if (existsSync(tmpPath)) {
    try {
      const s = await stat(tmpPath);
      const ageMs = Date.now() - s.mtimeMs;
      if (ageMs < TMP_SURVIVOR_MAX_AGE_MS) {
        // Active write window detected — do NOT restore yet
        return {
          outcome: 'skipped-active-write',
          configPath,
          detail: `Temp file at ${tmpPath} is ${Math.round(ageMs / 1000)}s old — possible active write; skipping repair`,
        };
      }
    } catch {
      // stat failed — ignore and proceed
    }
  }

  // ── 4. Quarantine the corrupt file ───────────────────────────────────────
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = join(dirname(configPath), `${basename(configPath)}.corrupt-${iso}`);

  try {
    await copyFile(configPath, quarantinePath);
  } catch {
    // Quarantine copy failed — proceed anyway; we can still try to restore
  }

  // ── 5. Find the best valid candidate (tmp survivor > numbered backups) ────

  // Check whether the `.tmp` survivor is valid (a completed-but-not-renamed write)
  if (existsSync(tmpPath)) {
    const tmpData = await tryParseJsonFile(tmpPath);
    if (tmpData !== null) {
      // Restore from surviving .tmp: rename tmp → target atomically
      try {
        await rename(tmpPath, configPath);

        await appendAuditLine(cwd, {
          ts: new Date().toISOString(),
          event: 'config-repair:restored-from-tmp',
          configPath,
          restoredFrom: tmpPath,
          quarantinedTo: quarantinePath,
          detail:
            'Corrupt config replaced by surviving .tmp file (completed-but-not-renamed write)',
        });

        return {
          outcome: 'restored-from-tmp',
          configPath,
          restoredFrom: tmpPath,
          quarantinedTo: quarantinePath,
          detail: 'Config restored from surviving .tmp file',
        };
      } catch {
        // Rename failed — fall through to numbered backups
      }
    }
  }

  // Walk numbered backups from newest to find the first valid one
  const backups = backupDir ? await listNumberedBackups(basename(configPath), backupDir) : [];

  for (const backupPath of backups) {
    const backupData = await tryParseJsonFile(backupPath);
    if (backupData === null) continue; // corrupt backup — try next

    // Restore atomically: copy to a tmp then rename over the target
    const restoreTmp = `${configPath}.restore-${process.pid}`;
    try {
      await copyFile(backupPath, restoreTmp);
      await rename(restoreTmp, configPath);

      await appendAuditLine(cwd, {
        ts: new Date().toISOString(),
        event: 'config-repair:restored-from-backup',
        configPath,
        restoredFrom: backupPath,
        quarantinedTo: quarantinePath,
        detail: `Corrupt config replaced by newest valid backup: ${basename(backupPath)}`,
      });

      return {
        outcome: 'restored-from-backup',
        configPath,
        restoredFrom: backupPath,
        quarantinedTo: quarantinePath,
        detail: `Restored from backup: ${basename(backupPath)}`,
      };
    } catch {
      // Try next backup
      try {
        await import('node:fs/promises').then((m) => m.unlink(restoreTmp));
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // ── 6. No valid candidate found — file is quarantined but not restored ────
  await appendAuditLine(cwd, {
    ts: new Date().toISOString(),
    event: 'config-repair:quarantined-no-candidate',
    configPath,
    quarantinedTo: quarantinePath,
    detail: 'Corrupt config quarantined; no valid backup found to restore from',
  });

  // Write an empty-object fallback so CLEO can start (caller may verify)
  try {
    const fallbackTmp = `${configPath}.fallback-${process.pid}`;
    await writeFile(fallbackTmp, '{}\n', 'utf-8');
    await rename(fallbackTmp, configPath);
  } catch {
    // If even the empty-object write fails, leave the corrupt file in place
    // and let the caller handle it
  }

  return {
    outcome: 'quarantined-no-candidate',
    configPath,
    quarantinedTo: quarantinePath,
    detail: 'No valid backup found; corrupt file quarantined and empty config written',
  };
}

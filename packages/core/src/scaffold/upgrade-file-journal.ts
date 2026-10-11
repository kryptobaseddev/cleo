/**
 * Backed-up, change-only file writes for `cleo upgrade` (T13409).
 *
 * Upgrade edits files the project owns (AGENTS.md, CLAUDE.md, `.cleo/.gitignore`,
 * `.worktreeinclude`, `project-context.json`). Every edit goes through a journal:
 * an unchanged file is never rewritten, and a changed file's previous bytes are
 * copied under `.cleo/backups/upgrade/<stamp>/` before the new bytes land. The
 * journal's entries are listed in the upgrade result so the owner sees every
 * path that changed and where its backup is.
 *
 * Also holds the line-merge used for `.gitignore`-style files: upgrade only ever
 * appends the template lines a file is missing, never drops or reorders the
 * user's lines.
 *
 * @task T13409
 */

import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { writeFileAtomic } from '../tools/fs.js';

/** One file an upgrade changed. */
export interface UpgradeFileChange {
  /** Absolute path of the changed file. */
  path: string;
  /** Absolute path of the copy holding its previous bytes; `null` when the file was created. */
  backupPath: string | null;
}

/** Records the files one upgrade run changed and where their backups are. */
export interface UpgradeFileJournal {
  /** Project root; backups keep each file's path relative to it. */
  readonly projectRoot: string;
  /** Directory receiving this run's backups. */
  readonly backupDir: string;
  /** Files changed so far, in write order. */
  readonly changes: UpgradeFileChange[];
}

/**
 * Create the journal for one upgrade run.
 *
 * @param projectRoot - Absolute project root.
 * @param cleoDir - The project's `.cleo` directory.
 * @returns An empty journal whose backups land in `<cleoDir>/backups/upgrade/<stamp>/`.
 */
export function createUpgradeFileJournal(projectRoot: string, cleoDir: string): UpgradeFileJournal {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    projectRoot,
    backupDir: join(cleoDir, 'backups', 'upgrade', stamp),
    changes: [],
  };
}

/** Backup location for `path`: its project-relative path, or its absolute path re-rooted. */
function backupPathFor(journal: UpgradeFileJournal, path: string): string {
  const rel = relative(journal.projectRoot, path);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  return join(journal.backupDir, inside ? rel : join('_external', path.replace(/^[/\\]+/, '')));
}

/**
 * Copy `path`'s current bytes into the journal's backup directory and record the change.
 *
 * Call before replacing a file whose new content differs. A missing file is
 * recorded as created, with no backup.
 *
 * @param journal - The run's journal.
 * @param path - Absolute path about to change.
 * @returns The recorded change.
 */
export async function backupBeforeChange(
  journal: UpgradeFileJournal,
  path: string,
): Promise<UpgradeFileChange> {
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = backupPathFor(journal, path);
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(path, backupPath);
  }
  const change = { path, backupPath };
  journal.changes.push(change);
  return change;
}

/**
 * Write `content` to `path` only when it differs from what is there, backing
 * the old bytes up first when a journal is given.
 *
 * @param path - Absolute file path.
 * @param content - New file content.
 * @param journal - The run's journal; omitted outside upgrade (init writes fresh files).
 * @returns `true` when the file was written, `false` when it already held `content`.
 */
export async function writeIfChanged(
  path: string,
  content: string,
  journal?: UpgradeFileJournal,
): Promise<boolean> {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return false;
  if (journal) await backupBeforeChange(journal, path);
  await writeFileAtomic({ path, content });
  return true;
}

/**
 * Append the template's rule lines that `existing` lacks, keeping every user
 * line, comment and their order byte-for-byte.
 *
 * Only non-blank, non-comment lines count; comparison trims whitespace. The
 * appended lines keep the template's relative order, so an allow rule still
 * follows the deny rule it depends on.
 *
 * @param existing - Current file content.
 * @param template - Shipped template content.
 * @param header - Comment line written above the appended lines.
 * @returns The merged content, and the lines that were appended.
 */
export function appendMissingLines(
  existing: string,
  template: string,
  header: string,
): { content: string; added: string[] } {
  const isRule = (line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#');
  const present = new Set(
    existing
      .split(/\r?\n/)
      .filter(isRule)
      .map((line) => line.trim()),
  );
  const added = [
    ...new Set(
      template
        .split(/\r?\n/)
        .filter(isRule)
        .map((line) => line.trim())
        .filter((line) => !present.has(line)),
    ),
  ];
  if (added.length === 0) return { content: existing, added };
  const base = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  return { content: `${base}\n${header}\n${added.join('\n')}\n`, added };
}

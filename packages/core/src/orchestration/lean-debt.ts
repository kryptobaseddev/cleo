/**
 * Lean-debt ledger: every deliberate shortcut in one place (T13664).
 *
 * ct-lean asks for a `shortcut: <the limit>, <when to upgrade>` comment on
 * every shortcut with a known limit (the convention comes from Ponytail 5.1.0,
 * DietrichGebert, MIT, which also used `ponytail:`). `cleo lean debt` collects
 * them so a deferral cannot quietly become permanent, and `--file-tasks`
 * turns each one into a `lean-debt` task, so the ledger lives in the task
 * store instead of rotting in a file.
 *
 * @task T13664
 * @epic T13418
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { LeanDebtItem, LeanDebtReport } from '@cleocode/contracts';

/** Label every filed debt task carries. */
export const LEAN_DEBT_LABEL = 'lean-debt';

/** Markers scanned when the caller names none. */
const DEFAULT_MARKERS: readonly string[] = ['shortcut', 'ponytail'];

/** Paths never scanned (vendored, generated, build output). */
const EXCLUDE_PATHSPECS: readonly string[] = [
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/vendor/**',
];

/** Most `git grep` output read (bytes); a repo with more markers is truncated. */
const MAX_GREP_BYTES = 16 * 1024 * 1024;

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse one `git grep -n` line (`path:line:content`) into a ledger item, or
 * `null` when the content holds no marker comment.
 *
 * @param raw - one output line.
 * @param markers - the marker words.
 */
export function parseLeanDebtLine(raw: string, markers: readonly string[]): LeanDebtItem | null {
  const m = /^(.+?):(\d+):(.*)$/.exec(raw);
  if (!m) return null;
  const file = m[1] ?? '';
  const lineNo = m[2] ?? '0';
  const content = m[3] ?? '';
  const words = markers.map(escapeRegExp).join('|');
  // The comment prefix keeps prose that merely mentions the convention out.
  const hit = new RegExp(
    `(?:#|//|/\\*|--|<!--|;)\\s?(${words}):\\s*(.*?)\\s*(?:\\*/|-->)?\\s*$`,
    'i',
  ).exec(content);
  if (!hit) return null;
  const marker = (hit[1] ?? '').toLowerCase();
  const text = hit[2] ?? '';
  const comma = text.indexOf(',');
  const ceiling = (comma === -1 ? text : text.slice(0, comma)).trim();
  const upgradeRaw = comma === -1 ? '' : text.slice(comma + 1).trim();
  const upgrade = upgradeRaw === '' ? null : upgradeRaw;
  const key = createHash('sha256').update(`${file}\0${marker}\0${text}`).digest('hex').slice(0, 12);
  return {
    file,
    line: Number(lineNo),
    marker,
    text,
    ceiling,
    upgrade,
    noTrigger: upgrade === null,
    key,
  };
}

/**
 * Scan the git-tracked files of `projectRoot` for marker comments.
 *
 * @param projectRoot - the repository root.
 * @param markers - marker words (default `shortcut`, `ponytail`).
 * @returns the items, grouped by file in path order.
 */
export function scanLeanDebt(
  projectRoot: string,
  markers: readonly string[] = DEFAULT_MARKERS,
): LeanDebtItem[] {
  const words = markers.map(escapeRegExp).join('|');
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        'grep',
        '-n',
        '-I',
        '-i',
        '-E',
        `(#|//|/\\*|--|<!--|;) ?(${words}):`,
        '--',
        '.',
        ...EXCLUDE_PATHSPECS,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        maxBuffer: MAX_GREP_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    // `git grep` exits 1 when nothing matches: an empty, clean ledger.
    if (err instanceof Error && 'status' in err && err.status === 1) return [];
    throw err;
  }
  return out
    .split('\n')
    .map((line) => parseLeanDebtLine(line, markers))
    .filter((item): item is LeanDebtItem => item !== null)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The description line that ties a filed task to its marker. */
export function leanDebtKeyLine(key: string): string {
  return `lean-debt-key: ${key}`;
}

/**
 * Build the ledger, and with `fileTasks` file one `lean-debt` task per marker
 * that has none yet (matched by its key), under `parentId`.
 *
 * @param opts - project root, markers, and the filing options.
 * @returns the report.
 */
export async function leanDebtReport(opts: {
  readonly projectRoot: string;
  readonly markers?: readonly string[];
  readonly fileTasks?: boolean;
  readonly parentId?: string;
}): Promise<LeanDebtReport> {
  const items = scanLeanDebt(opts.projectRoot, opts.markers);
  const filed: { key: string; taskId: string }[] = [];
  const alreadyFiled: string[] = [];
  if (opts.fileTasks && items.length > 0) {
    // The same check addTask makes, run before the first filing so an unbound
    // caller files nothing instead of failing partway through the ledger.
    const { requireActiveSession } = await import('../sessions/session-enforcement.js');
    await requireActiveSession('tasks.add', opts.projectRoot);
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const { addTask } = await import('../tasks/add.js');
    const accessor = await getTaskAccessor(opts.projectRoot);
    // An empty excludeStatus keeps archived rows: a debt task that was done,
    // cancelled or archived still counts as filed.
    const { tasks } = await accessor.queryTasks({ label: LEAN_DEBT_LABEL, excludeStatus: [] });
    const known = new Set(
      tasks.flatMap((t) => /lean-debt-key: ([0-9a-f]{12})/.exec(t.description ?? '')?.[1] ?? []),
    );
    for (const item of items) {
      if (known.has(item.key)) {
        alreadyFiled.push(item.key);
        continue;
      }
      const result = await addTask(
        {
          title: `Lean debt: ${item.ceiling || item.text}`.slice(0, 120),
          description: [
            `Deliberate shortcut at ${item.file}:${item.line}: ${item.text}`,
            item.upgrade
              ? `Upgrade trigger: ${item.upgrade}`
              : 'No upgrade trigger named (no-trigger).',
            leanDebtKeyLine(item.key),
          ].join('\n'),
          acceptance: [
            `The shortcut at ${item.file} is removed, or its comment names a current limit and upgrade trigger`,
          ],
          labels: [LEAN_DEBT_LABEL],
          ...(opts.parentId ? { parentId: opts.parentId } : {}),
        },
        opts.projectRoot,
        accessor,
      );
      filed.push({ key: item.key, taskId: result.task.id });
      known.add(item.key);
    }
  }
  return {
    items,
    noTriggerCount: items.filter((i) => i.noTrigger).length,
    filed,
    alreadyFiled,
  };
}

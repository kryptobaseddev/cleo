/**
 * Task-to-Changelog generation.
 *
 * Generates CHANGELOG.md content from CLEO task metadata.
 * Groups tasks by labels (features, fixes, docs, etc.) and
 * formats as conventional changelog sections.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { readJson } from '../../store/json.js';

/** Label-to-category mapping for changelog sections. */
const LABEL_CATEGORIES: Record<string, string> = {
  feature: 'Features',
  feat: 'Features',
  enhancement: 'Features',
  bug: 'Bug Fixes',
  fix: 'Bug Fixes',
  bugfix: 'Bug Fixes',
  hotfix: 'Bug Fixes',
  docs: 'Documentation',
  documentation: 'Documentation',
  refactor: 'Refactoring',
  cleanup: 'Refactoring',
  chore: 'Refactoring',
  test: 'Testing',
  testing: 'Testing',
  breaking: 'Breaking Changes',
  'breaking-change': 'Breaking Changes',
};

/** Task info for changelog generation. */
interface ChangelogTask {
  id: string;
  title: string;
  labels: string[];
  parentId?: string;
  completedAt?: string;
}

/**
 * Discover task IDs for a release from completed tasks.
 * Optionally filtered by date range or specific task IDs.
 */
export async function discoverReleaseTasks(
  options: {
    since?: string;
    until?: string;
    taskIds?: string[];
  } = {},
  cwd?: string,
): Promise<ChangelogTask[]> {
  const todoPath = join(getCleoDir(cwd), 'todo.json');
  const archivePath = join(getCleoDir(cwd), 'todo-archive.json');

  const tasks: ChangelogTask[] = [];

  // Read from todo.json and archive
  for (const path of [todoPath, archivePath]) {
    if (!existsSync(path)) continue;

    const data = await readJson<{ tasks: Array<Record<string, unknown>> }>(path);
    if (!data?.tasks) continue;

    for (const task of data.tasks) {
      const id = task.id as string;
      const status = task.status as string;
      const completedAt = task.completedAt as string | undefined;

      // Only completed tasks
      if (status !== 'done') continue;

      // Filter by IDs if specified
      if (options.taskIds?.length && !options.taskIds.includes(id)) continue;

      // Filter by date range
      if (options.since && completedAt && completedAt < options.since) continue;
      if (options.until && completedAt && completedAt > options.until) continue;

      tasks.push({
        id,
        title: task.title as string,
        labels: (task.labels as string[]) ?? [],
        parentId: task.parentId as string | undefined,
        completedAt,
      });
    }
  }

  return tasks;
}

/** Categorize a task based on its labels. Returns the section name. */
function categorizeTask(task: ChangelogTask): string {
  for (const label of task.labels) {
    const category = LABEL_CATEGORIES[label.toLowerCase()];
    if (category) return category;
  }
  return 'Other Changes';
}

/** Grouped changelog sections. */
export interface ChangelogSection {
  title: string;
  entries: Array<{ taskId: string; description: string }>;
}

/** Group tasks into changelog sections. */
export function groupTasksIntoSections(tasks: ChangelogTask[]): ChangelogSection[] {
  const groups = new Map<string, Array<{ taskId: string; description: string }>>();

  for (const task of tasks) {
    const section = categorizeTask(task);
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push({
      taskId: task.id,
      description: task.title,
    });
  }

  // Order: Breaking Changes first, then Features, Bug Fixes, etc.
  const sectionOrder = [
    'Breaking Changes',
    'Features',
    'Bug Fixes',
    'Documentation',
    'Refactoring',
    'Testing',
    'Other Changes',
  ];

  return sectionOrder
    .filter(title => groups.has(title))
    .map(title => ({ title, entries: groups.get(title)! }));
}

/** Generate changelog markdown for a version. */
export function generateChangelogMarkdown(
  version: string,
  date: string,
  sections: ChangelogSection[],
): string {
  const lines: string[] = [];
  lines.push(`## [${version}] - ${date}`);
  lines.push('');

  for (const section of sections) {
    lines.push(`### ${section.title}`);
    lines.push('');
    for (const entry of section.entries) {
      lines.push(`- ${entry.description} (${entry.taskId})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Format changelog data as JSON. */
export function formatChangelogJson(
  version: string,
  date: string,
  sections: ChangelogSection[],
): Record<string, unknown> {
  return {
    version,
    date,
    sections: sections.map(s => ({
      title: s.title,
      entries: s.entries,
    })),
    totalEntries: sections.reduce((sum, s) => sum + s.entries.length, 0),
  };
}

/** Write changelog content to a file. */
export function writeChangelogFile(
  filePath: string,
  content: string,
): void {
  writeFileSync(filePath, content, 'utf-8');
}

/** Append a new release section to an existing CHANGELOG.md. */
export function appendToChangelog(
  filePath: string,
  newContent: string,
): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# Changelog\n\n${newContent}`, 'utf-8');
    return;
  }

  const existing = readFileSync(filePath, 'utf-8');
  // Insert after the first heading
  const headerMatch = existing.match(/^# .+\n/m);
  if (headerMatch) {
    const insertPos = (headerMatch.index ?? 0) + headerMatch[0].length;
    const updated = existing.slice(0, insertPos) + '\n' + newContent + existing.slice(insertPos);
    writeFileSync(filePath, updated, 'utf-8');
  } else {
    appendFileSync(filePath, '\n' + newContent);
  }
}

/**
 * Full changelog generation: discover tasks, group, generate, write.
 */
export async function generateChangelog(
  version: string,
  options: {
    since?: string;
    until?: string;
    taskIds?: string[];
    outputPath?: string;
    append?: boolean;
  } = {},
  cwd?: string,
): Promise<Record<string, unknown>> {
  const date = new Date().toISOString().split('T')[0]!;
  const tasks = await discoverReleaseTasks(
    { since: options.since, until: options.until, taskIds: options.taskIds },
    cwd,
  );

  if (tasks.length === 0) {
    return { success: true, result: { version, date, sections: [], totalEntries: 0, message: 'No tasks found' } };
  }

  const sections = groupTasksIntoSections(tasks);
  const markdown = generateChangelogMarkdown(version, date, sections);

  const outputPath = options.outputPath ?? 'CHANGELOG.md';
  if (options.append) {
    appendToChangelog(outputPath, markdown);
  } else {
    writeChangelogFile(outputPath, `# Changelog\n\n${markdown}`);
  }

  return {
    success: true,
    result: formatChangelogJson(version, date, sections),
  };
}

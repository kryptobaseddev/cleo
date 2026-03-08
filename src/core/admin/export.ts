/**
 * Core export logic — export tasks to various portable formats.
 *
 * Extracted from CLI export command for dispatch layer access.
 *
 * @task T5323, T5328
 */

import { writeFile } from 'node:fs/promises';
import { getAccessor } from '../../store/data-accessor.js';
import type { Task } from '../../types/task.js';

export type ExportFormat = 'json' | 'csv' | 'tsv' | 'markdown' | 'todowrite';

function taskToCsvRow(task: Task, delimiter: string): string {
  const escapeField = (val: string) => {
    if (val.includes(delimiter) || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };
  return [
    escapeField(task.id),
    escapeField(task.title),
    escapeField(task.status),
    escapeField(task.priority),
    escapeField(task.type ?? 'task'),
    escapeField(task.parentId ?? ''),
    escapeField(task.phase ?? ''),
    escapeField((task.depends ?? []).join(',')),
    escapeField(task.createdAt ?? ''),
  ].join(delimiter);
}

function taskToMarkdown(task: Task): string {
  const status = task.status === 'done' ? 'x' : ' ';
  const priority = task.priority === 'critical' ? '!!!' : task.priority === 'high' ? '!!' : '';
  return `- [${status}] **${task.id}** ${priority} ${task.title}`;
}

function taskToTodoWrite(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    content: task.title,
    status:
      task.status === 'done' ? 'completed' : task.status === 'active' ? 'in_progress' : 'pending',
    priority: task.priority === 'critical' ? 'high' : task.priority,
  };
}

export interface ExportParams {
  format?: ExportFormat;
  output?: string;
  status?: string;
  parent?: string;
  phase?: string;
  cwd?: string;
}

export interface ExportResult {
  format: ExportFormat;
  taskCount: number;
  file?: string;
  content?: string;
}

/**
 * Export tasks to a portable format.
 * Returns the formatted content and metadata.
 */
export async function exportTasks(params: ExportParams): Promise<ExportResult> {
  const accessor = await getAccessor(params.cwd);
  const data = await accessor.loadTaskFile();

  let tasks = data.tasks;

  if (params.status) {
    const statuses = params.status.split(',').map((s) => s.trim());
    tasks = tasks.filter((t) => statuses.includes(t.status));
  }
  if (params.parent) {
    tasks = tasks.filter((t) => t.parentId === params.parent);
  }
  if (params.phase) {
    tasks = tasks.filter((t) => t.phase === params.phase);
  }

  const format: ExportFormat = params.format ?? 'json';
  let content: string;

  switch (format) {
    case 'json': {
      content = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          projectName: data.project?.name ?? 'Unknown',
          taskCount: tasks.length,
          tasks,
        },
        null,
        2,
      );
      break;
    }
    case 'csv': {
      const header = 'id,title,status,priority,type,parentId,phase,depends,createdAt';
      const rows = tasks.map((t) => taskToCsvRow(t, ','));
      content = [header, ...rows].join('\n');
      break;
    }
    case 'tsv': {
      const header = 'id\ttitle\tstatus\tpriority\ttype\tparentId\tphase\tdepends\tcreatedAt';
      const rows = tasks.map((t) => taskToCsvRow(t, '\t'));
      content = [header, ...rows].join('\n');
      break;
    }
    case 'markdown': {
      const lines = [`# ${data.project?.name ?? 'Tasks'}\n`];
      const byStatus = new Map<string, Task[]>();
      for (const t of tasks) {
        const list = byStatus.get(t.status) ?? [];
        list.push(t);
        byStatus.set(t.status, list);
      }
      for (const [status, statusTasks] of byStatus) {
        lines.push(`\n## ${status}\n`);
        for (const t of statusTasks) {
          lines.push(taskToMarkdown(t));
        }
      }
      content = lines.join('\n');
      break;
    }
    case 'todowrite': {
      const items = tasks.map(taskToTodoWrite);
      content = JSON.stringify(items, null, 2);
      break;
    }
    default:
      throw new Error(`Unknown format: ${format}. Valid: json, csv, tsv, markdown, todowrite`);
  }

  if (params.output) {
    await writeFile(params.output, content);
    return { format, taskCount: tasks.length, file: params.output };
  }

  return { format, taskCount: tasks.length, content };
}

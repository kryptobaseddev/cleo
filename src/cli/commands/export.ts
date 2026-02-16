/**
 * CLI export command - export tasks to various formats.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson } from '../../store/json.js';
import { getTodoPath } from '../../core/paths.js';
import { writeFile } from 'node:fs/promises';
import type { Task, TodoFile } from '../../types/task.js';

type ExportFormat = 'json' | 'csv' | 'tsv' | 'markdown' | 'todowrite';

function taskToCsvRow(task: Task, delimiter: string): string {
  const escape = (val: string) => {
    if (val.includes(delimiter) || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };
  return [
    escape(task.id),
    escape(task.title),
    escape(task.status),
    escape(task.priority),
    escape(task.type ?? 'task'),
    escape(task.parentId ?? ''),
    escape(task.phase ?? ''),
    escape((task.depends ?? []).join(',')),
    escape(task.createdAt ?? ''),
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
    status: task.status === 'done' ? 'completed' : task.status === 'active' ? 'in_progress' : 'pending',
    priority: task.priority === 'critical' ? 'high' : task.priority,
  };
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export tasks to CSV, TSV, JSON, markdown, or TodoWrite format')
    .option('--export-format <format>', 'Export format: json, csv, tsv, markdown, todowrite', 'json')
    .option('--output <file>', 'Output file path (stdout if omitted)')
    .option('--status <statuses>', 'Filter by status (comma-separated)')
    .option('--parent <id>', 'Filter by parent task')
    .option('--phase <phase>', 'Filter by phase')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json found. Run: cleo init');
        }

        let tasks = data.tasks;

        // Apply filters
        if (opts['status']) {
          const statuses = (opts['status'] as string).split(',').map((s) => s.trim());
          tasks = tasks.filter((t) => statuses.includes(t.status));
        }
        if (opts['parent']) {
          const parentId = opts['parent'] as string;
          tasks = tasks.filter((t) => t.parentId === parentId);
        }
        if (opts['phase']) {
          const phase = opts['phase'] as string;
          tasks = tasks.filter((t) => t.phase === phase);
        }

        const format = (opts['exportFormat'] as ExportFormat) || 'json';
        let output: string;

        switch (format) {
          case 'json': {
            output = JSON.stringify({
              exportedAt: new Date().toISOString(),
              projectName: data.project?.name ?? 'Unknown',
              taskCount: tasks.length,
              tasks,
            }, null, 2);
            break;
          }
          case 'csv': {
            const header = 'id,title,status,priority,type,parentId,phase,depends,createdAt';
            const rows = tasks.map((t) => taskToCsvRow(t, ','));
            output = [header, ...rows].join('\n');
            break;
          }
          case 'tsv': {
            const header = 'id\ttitle\tstatus\tpriority\ttype\tparentId\tphase\tdepends\tcreatedAt';
            const rows = tasks.map((t) => taskToCsvRow(t, '\t'));
            output = [header, ...rows].join('\n');
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
            output = lines.join('\n');
            break;
          }
          case 'todowrite': {
            const items = tasks.map(taskToTodoWrite);
            output = JSON.stringify(items, null, 2);
            break;
          }
          default:
            throw new CleoError(ExitCode.INVALID_INPUT, `Unknown format: ${format}. Valid: json, csv, tsv, markdown, todowrite`);
        }

        if (opts['output']) {
          await writeFile(opts['output'] as string, output);
          console.log(formatSuccess({
            exported: true,
            format,
            taskCount: tasks.length,
            file: opts['output'] as string,
          }));
        } else {
          // Write directly to stdout for piping
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

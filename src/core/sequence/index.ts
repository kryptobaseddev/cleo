/**
 * Task ID sequence management core module.
 * @task T4538
 * @epic T4454
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../store/json.js';
import { getTodoPath, getArchivePath } from '../paths.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TodoFile } from '../../types/task.js';

function getSequencePath(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.cleo', '.sequence.json');
}

interface SequenceState {
  counter: number;
  lastId: string;
  checksum: string;
}

function readSequence(cwd?: string): SequenceState | null {
  const path = getSequencePath(cwd);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getMaxIdFromTasks(tasks: Array<{ id: string }>): number {
  let max = 0;
  for (const t of tasks) {
    const match = t.id.match(/^T(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > max) max = num;
    }
  }
  return max;
}

/** Show current sequence state. */
export async function showSequence(cwd?: string): Promise<Record<string, unknown>> {
  const seq = readSequence(cwd);
  if (!seq) {
    throw new CleoError(ExitCode.NOT_FOUND, 'Sequence file not found');
  }
  return {
    counter: seq.counter,
    lastId: seq.lastId,
    checksum: seq.checksum,
    nextId: `T${seq.counter + 1}`,
  };
}

/** Check sequence integrity. */
export async function checkSequence(cwd?: string): Promise<Record<string, unknown>> {
  const seq = readSequence(cwd);
  if (!seq) {
    throw new CleoError(ExitCode.NOT_FOUND, 'Sequence file not found');
  }

  const todoData = await readJson<TodoFile>(getTodoPath(cwd));
  const archiveData = await readJson<{ archivedTasks: Array<{ id: string }> }>(getArchivePath(cwd));

  const allTasks = [
    ...(todoData?.tasks ?? []),
    ...(archiveData?.archivedTasks ?? []),
  ];

  const maxId = getMaxIdFromTasks(allTasks);
  const valid = seq.counter >= maxId;

  return {
    counter: seq.counter,
    maxIdInData: maxId,
    valid,
    ...(valid ? {} : {
      issue: `Counter (${seq.counter}) is behind max ID (T${maxId})`,
      fix: 'Run cleo sequence repair',
    }),
  };
}

/** Repair sequence if behind. */
export async function repairSequence(cwd?: string): Promise<Record<string, unknown>> {
  const seqPath = getSequencePath(cwd);
  const seq = readSequence(cwd);

  const todoData = await readJson<TodoFile>(getTodoPath(cwd));
  const archiveData = await readJson<{ archivedTasks: Array<{ id: string }> }>(getArchivePath(cwd));

  const allTasks = [
    ...(todoData?.tasks ?? []),
    ...(archiveData?.archivedTasks ?? []),
  ];

  const maxId = getMaxIdFromTasks(allTasks);
  const oldCounter = seq?.counter ?? 0;

  if (oldCounter >= maxId) {
    return { repaired: false, message: 'Sequence already valid', counter: oldCounter };
  }

  const newCounter = maxId;
  const newSeq: SequenceState = {
    counter: newCounter,
    lastId: `T${newCounter}`,
    checksum: `repair-${Date.now()}`,
  };

  writeFileSync(seqPath, JSON.stringify(newSeq, null, 2));

  return {
    repaired: true,
    oldCounter,
    newCounter,
    message: `Sequence repaired: ${oldCounter} -> ${newCounter}`,
  };
}

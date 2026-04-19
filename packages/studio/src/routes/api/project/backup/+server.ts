/**
 * Project backup endpoints.
 *
 * GET  /api/project/backup  — list snapshot files under
 *                             `<projectPath>/.cleo/backups/sqlite/`
 * POST /api/project/backup  — create a new snapshot via
 *                             `cleo backup add --json`
 *
 * The GET reads the filesystem directly (read-only) so the UI can render
 * without shelling out; the POST delegates to the CLI so vacuum + atomic
 * rename are handled identically to `cleo session end`.
 *
 * @task T990
 * @wave 1E
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import { recordAudit } from '$lib/server/audit-log.js';
import { executeCliAction } from '$lib/server/cli-action.js';
import type { RequestHandler } from './$types';

interface BackupFile {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'tasks' | 'brain' | 'config' | 'project-info' | 'other';
}

function classify(name: string): BackupFile['kind'] {
  if (name.startsWith('tasks-')) return 'tasks';
  if (name.startsWith('brain-')) return 'brain';
  if (name.startsWith('config-')) return 'config';
  if (name.startsWith('project-info-')) return 'project-info';
  return 'other';
}

export const GET: RequestHandler = ({ locals }) => {
  const dir = join(locals.projectCtx.projectPath, '.cleo', 'backups', 'sqlite');
  let files: BackupFile[] = [];
  try {
    const entries = readdirSync(dir);
    files = entries
      .map((filename): BackupFile | null => {
        const full = join(dir, filename);
        try {
          const st = statSync(full);
          if (!st.isFile()) return null;
          return {
            filename,
            path: full,
            sizeBytes: st.size,
            createdAt: st.mtime.toISOString(),
            kind: classify(filename),
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is BackupFile => f !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    files = [];
  }

  return json({ success: true, data: { backups: files, dir } });
};

interface BackupBody {
  note?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  let body: BackupBody = {};
  try {
    const raw = await request.json();
    if (raw && typeof raw === 'object') {
      body = raw as BackupBody;
    }
  } catch {
    // empty body is fine
  }

  const args: string[] = ['backup', 'add', '--json'];
  if (typeof body.note === 'string' && body.note.trim()) {
    args.push('--note', body.note.trim());
  }

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.backup',
    target: locals.projectCtx.projectId || locals.projectCtx.projectPath,
    result: 'initiated',
    detail: body.note ?? null,
  });

  const response = await executeCliAction(args, {
    errorCode: 'E_BACKUP_FAILED',
    meta: { note: body.note },
  });

  recordAudit(locals.projectCtx.projectPath, {
    actor: 'studio-admin',
    action: 'project.backup',
    target: locals.projectCtx.projectId || locals.projectCtx.projectPath,
    result: response.status === 200 ? 'success' : 'failure',
  });

  return response;
};

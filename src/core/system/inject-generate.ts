/**
 * MVI injection generation core module.
 * @task T4783
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../store/json.js';
import { getTaskPath, getSessionsPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface InjectGenerateResult {
  injection: string;
  sizeBytes: number;
  version: string;
}

interface SessionRecord {
  id: string;
  status: string;
  name?: string;
  scope?: { type: string; rootTaskId: string };
  focus?: { currentTask?: string | null };
}

/** Generate Minimum Viable Injection (MVI) markdown. */
export async function generateInjection(
  projectRoot: string,
  accessor?: DataAccessor,
): Promise<InjectGenerateResult> {
  // Read project state
  let version = 'unknown';
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || 'unknown';
    }
  } catch {
    // fallback
  }

  // Active session & focus
  let activeSessionName: string | null = null;
  let focusTask: string | null = null;
  let sessionScope: string | null = null;

  const taskFile = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(projectRoot));

  if (taskFile) {
    focusTask = taskFile.focus?.currentTask ?? null;
    activeSessionName = taskFile._meta?.activeSession ?? null;
  }

  // Try sessions.json for richer session data
  try {
    const sessionsPath = getSessionsPath(projectRoot);
    if (existsSync(sessionsPath)) {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as { sessions: SessionRecord[] };
      const active = sessionsData.sessions?.find(s => s.status === 'active');
      if (active) {
        activeSessionName = active.name || active.id;
        focusTask = active.focus?.currentTask ?? focusTask;
        sessionScope = `${active.scope?.type}:${active.scope?.rootTaskId}`;
      }
    }
  } catch {
    // fallback to tasks.json data
  }

  // Storage engine is always sqlite (ADR-006)
  const storageEngine = 'sqlite';

  // Build MVI markdown
  const mvi = buildMviMarkdown({
    version,
    storageEngine,
    activeSessionName,
    focusTask,
    sessionScope,
  });

  const sizeBytes = Buffer.byteLength(mvi, 'utf-8');

  return {
    injection: mvi,
    sizeBytes,
    version: '1.0.0',
  };
}

/** Build the MVI markdown string from current project state. */
function buildMviMarkdown(state: {
  version: string;
  storageEngine: string;
  activeSessionName: string | null;
  focusTask: string | null;
  sessionScope: string | null;
}): string {
  const sessionLine = state.activeSessionName
    ? `| Session | \`${state.activeSessionName}\` (${state.sessionScope || 'unknown'}) |`
    : '| Session | none |';
  const focusLine = state.focusTask
    ? `| Focus | \`${state.focusTask}\` |`
    : '| Focus | none |';

  return `## CLEO Task Management (MVI)

> **Bootstrap**: Call \`orchestrate.bootstrap\` with \`speed=fast\` at session start.

| Key | Value |
|-----|-------|
| Version | \`${state.version}\` |
| Storage | \`${state.storageEngine}\` |
${sessionLine}
${focusLine}

### Essential Commands

| Command | Description |
|---------|-------------|
| \`ct find "query"\` | Fuzzy search tasks (minimal context) |
| \`ct show T1234\` | Full task details |
| \`ct add "Title" --desc "..."\` | Create task |
| \`ct done <id>\` | Complete task |
| \`ct start <id>\` | Start working on task |
| \`ct current\` | Show current task |
| \`ct next\` | Suggest next task |
| \`ct session list\` | List sessions |
| \`ct session start --scope epic:T### --auto-start --name "..."\` | Start session |
| \`ct session end --note "..."\` | End session |
| \`ct dash\` | Project overview |
| \`ct context\` | Context window usage |

### Session Protocol

1. **START**: \`ct session list\` then \`ct session resume <id>\` or \`ct session start --scope epic:T### --auto-start --name "Work"\`
2. **WORK**: \`ct current\` / \`ct next\` / \`ct complete <id>\` / \`ct start <id>\`
3. **END**: \`ct complete <id>\` then \`ct session end --note "Progress"\`

### Error Handling

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | \`E_NOT_FOUND\` | Use \`ct find\` or \`ct list\` to verify |
| 6 | \`E_VALIDATION\` | Check field lengths, escape \`$\` as \`\\$\` |
| 10 | \`E_PARENT_NOT_FOUND\` | Verify with \`ct exists <parent-id>\` |
| 11 | \`E_DEPTH_EXCEEDED\` | Exceeds configured hierarchy.maxDepth (default: 3) |
| 12 | \`E_SIBLING_LIMIT\` | Exceeds configured maxSiblings (default: unlimited) |

**After EVERY command**: Check exit code (\`0\` = success), check \`"success"\` in JSON output, execute \`error.fix\` if provided.

### Detailed Guidance

For full protocol details, load the **ct-cleo** skill: \`cleo_query({ domain: "skills", operation: "show", params: { name: "ct-cleo" }})\`
`;
}

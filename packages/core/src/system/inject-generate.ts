/**
 * MVI injection generation core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { focusSessionIdFromRead, readLiveFocus } from '../sessions/focus-state-store.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';

export interface InjectGenerateResult {
  injection: string;
  sizeBytes: number;
  version: string;
}

// SSoT-EXEMPT:engine-migration-T1571
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

  const acc = accessor ?? (await getTaskAccessor(projectRoot));
  const activeSessionMeta = await acc.getMetaValue<string>('activeSession');
  if (activeSessionMeta) {
    activeSessionName = activeSessionMeta;
  }

  // Load the CALLER's session from SQLite (ADR-006/ADR-020). T12501: the
  // read resolver (bound first), not the first active row — resolved once;
  // the focus key derives from the same resolution.
  let focusSessionId: string | null = null;
  try {
    const { resolveSessionForRead } = await import('../store/session-store.js');
    const read = await resolveSessionForRead(projectRoot);
    focusSessionId = focusSessionIdFromRead(read);
    const active = read.session;
    if (active && active.status === 'active') {
      activeSessionName = active.name || active.id;
      sessionScope = `${active.scope?.type}:${active.scope?.rootTaskId}`;
    }
  } catch {
    // fallback to meta-only data
  }

  // T12684: never generate an injection around a finished task. T12501: the
  // CALLER's focus key (THE focus-key rule) — a terminal-bound session reads
  // its own key, not the global one — and the ONLY focus source:
  // `taskWork.taskId` on the session row would bypass the done-task filter.
  focusTask = (await readLiveFocus(acc, focusSessionId)).currentTask;

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
  const focusLine = state.focusTask ? `| Focus | \`${state.focusTask}\` |` : '| Focus | none |';

  return `## CLEO Task Management (MVI)

> **Bootstrap**: Run \`cleo session status\` then \`cleo dash\` at session start.

| Key | Value |
|-----|-------|
| Version | \`${state.version}\` |
| Storage | \`${state.storageEngine}\` |
${sessionLine}
${focusLine}

### Essential Commands

| Command | Description |
|---------|-------------|
| \`cleo find "query"\` | Fuzzy search tasks (minimal context) |
| \`cleo show T1234\` | Full task details |
| \`cleo add "Title" -d "..."\` | Create task |
| \`cleo done <id>\` | Complete task |
| \`cleo start <id>\` | Start working on task |
| \`cleo current\` | Show current task |
| \`cleo next\` | Suggest next task |
| \`cleo session list\` | List sessions |
| \`cleo session start --scope epic:T### --auto-start --name "..."\` | Start session |
| \`cleo session end --note "..."\` | End session |
| \`cleo dash\` | Project overview |
| \`cleo context\` | Context window usage |

### Session Protocol

1. **START**: \`cleo session list\` then \`cleo session resume <id>\` or \`cleo session start --scope epic:T### --auto-start --name "Work"\`
2. **WORK**: \`cleo current\` / \`cleo next\` / \`cleo complete <id>\` / \`cleo start <id>\`
3. **END**: \`cleo complete <id>\` then \`cleo session end --note "Progress"\`

### Error Handling

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | \`E_NOT_FOUND\` | Use \`cleo find\` or \`cleo list\` to verify |
| 6 | \`E_VALIDATION\` | Check field lengths, escape \`$\` as \`\\$\` |
| 10 | \`E_PARENT_NOT_FOUND\` | Verify with \`cleo exists <parent-id>\` |
| 11 | \`E_DEPTH_EXCEEDED\` | Deeper than hierarchy.maxDepth, inclusive (default 3 = saga 0, epic 1, task 2, subtask 3) |
| 12 | \`E_SIBLING_LIMIT\` | Exceeds configured maxSiblings (default: unlimited) |

**After EVERY command**: Check exit code (\`0\` = success), check \`"success"\` in JSON output.

### Detailed Guidance

For full protocol details, load the **ct-cleo** skill.
`;
}

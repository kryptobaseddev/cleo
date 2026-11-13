/**
 * MVI injection generation core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { readInjectionSection } from '../injection.js';
import { focusSessionIdFromRead, readLiveFocus } from '../sessions/focus-state-store.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveSessionForRead } from '../store/session-store.js';

/** Generated MVI markdown with its byte size and format version. */
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
  let sessionUnbound = false;

  const acc = accessor ?? (await getTaskAccessor(projectRoot));
  const activeSessionMeta = await acc.getMetaValue<string>('activeSession');
  if (activeSessionMeta) {
    activeSessionName = activeSessionMeta;
  }

  // Load the CALLER's session from SQLite (ADR-006/ADR-020). T12500: the
  // caller's bound session; an unbound caller's injection names the newest
  // active row only with an explicit `unbound` label. T12501: resolved once;
  // the focus key derives from the same resolution, and the session row's
  // `taskWork` is never a focus source (it skips the done-task filter).
  let focusSessionId: string | null = null;
  try {
    const read = await resolveSessionForRead(projectRoot);
    focusSessionId = focusSessionIdFromRead(read);
    const active = read.session;
    if (active && active.status === 'active') {
      activeSessionName = active.name || active.id;
      sessionUnbound = read.unbound;
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
    sessionUnbound,
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
  sessionUnbound: boolean;
}): string {
  const errorHandling = readInjectionSection('error-handling').content;
  if (!errorHandling) {
    // @sync-invariant none:local-only Protocol templates are local package assets.
    throw new CleoError(ExitCode.FILE_ERROR, 'CLEO error-handling protocol section is missing', {
      fix: 'Reinstall CLEO to restore its bundled protocol templates, then run cleo upgrade.',
    });
  }

  // T12500: an unbound generator only saw the newest active row — say so.
  const unboundNote = state.sessionUnbound ? ' — unbound: newest active, may be another agent' : '';
  const sessionLine = state.activeSessionName
    ? `| Session | \`${state.activeSessionName}\` (${state.sessionScope || 'unknown'})${unboundNote} |`
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

${errorHandling.replace(/^##/gm, '###')}

### Detailed Guidance

For full protocol details, load the **ct-cleo** skill.
`;
}

/**
 * Context window monitoring core module.
 * @task T4535
 * @epic T4454
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function getCleoDir(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.cleo');
}

function getStateFile(session?: string, cwd?: string): string {
  const cleoDir = getCleoDir(cwd);

  if (session) {
    const sessionFile = join(cleoDir, 'context-states', `context-state-${session}.json`);
    if (existsSync(sessionFile)) return sessionFile;
  }

  // Check for current session binding
  const currentSessionFile = join(cleoDir, '.current-session');
  if (existsSync(currentSessionFile)) {
    const currentSession = readFileSync(currentSessionFile, 'utf-8').trim();
    if (currentSession) {
      const sessionFile = join(cleoDir, 'context-states', `context-state-${currentSession}.json`);
      if (existsSync(sessionFile)) return sessionFile;
    }
  }

  // Fall back to global state file
  return join(cleoDir, '.context-state.json');
}

/** Get context status. */
export async function getContextStatus(opts: {
  session?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const stateFile = getStateFile(opts.session, opts.cwd);

  if (!existsSync(stateFile)) {
    return {
      available: false,
      message: 'No context state file',
      hint: 'Ensure status line integration is configured',
    };
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const timestamp = state.timestamp;
  const staleMs = state.staleAfterMs ?? 5000;
  const percentage = state.contextWindow?.percentage ?? 0;
  const current = state.contextWindow?.currentTokens ?? 0;
  const max = state.contextWindow?.maxTokens ?? 0;
  let status = state.status ?? 'unknown';

  // Check staleness
  const fileTime = new Date(timestamp).getTime();
  const now = Date.now();
  if ((now - fileTime) > staleMs) {
    status = 'stale';
  }

  return {
    available: true,
    status,
    percentage,
    currentTokens: current,
    maxTokens: max,
    timestamp,
    stale: status === 'stale',
  };
}

/** Check context threshold (returns exit code info). */
export async function checkContextThreshold(opts: {
  session?: string;
  cwd?: string;
}): Promise<Record<string, unknown> & { exitCode?: number }> {
  const stateFile = getStateFile(opts.session, opts.cwd);

  if (!existsSync(stateFile)) {
    return { status: 'stale', exitCode: 54 };
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const timestamp = state.timestamp;
  const staleMs = state.staleAfterMs ?? 5000;
  let status = state.status ?? 'unknown';

  const fileTime = new Date(timestamp).getTime();
  if ((Date.now() - fileTime) > staleMs) {
    status = 'stale';
  }

  const exitCodeMap: Record<string, number> = {
    ok: 0,
    warning: 50,
    caution: 51,
    critical: 52,
    emergency: 53,
    stale: 54,
  };

  return {
    status,
    percentage: state.contextWindow?.percentage ?? 0,
    exitCode: exitCodeMap[status] ?? 54,
  };
}

/** List all context state files. */
export async function listContextSessions(
  cwd?: string,
): Promise<Record<string, unknown>> {
  const cleoDir = getCleoDir(cwd);
  const sessions: Record<string, unknown>[] = [];

  // Check canonical directory
  const statesDir = join(cleoDir, 'context-states');
  if (existsSync(statesDir)) {
    for (const file of readdirSync(statesDir)) {
      if (file.startsWith('context-state-') && file.endsWith('.json')) {
        const filePath = join(statesDir, file);
        try {
          const state = JSON.parse(readFileSync(filePath, 'utf-8'));
          sessions.push({
            file: basename(filePath),
            sessionId: state.sessionId ?? null,
            percentage: state.contextWindow?.percentage ?? 0,
            status: state.status ?? 'unknown',
            timestamp: state.timestamp,
          });
        } catch {
          // skip invalid files
        }
      }
    }
  }

  // Check singleton fallback
  const singletonFile = join(cleoDir, '.context-state.json');
  if (existsSync(singletonFile)) {
    try {
      const state = JSON.parse(readFileSync(singletonFile, 'utf-8'));
      sessions.push({
        file: '.context-state.json',
        sessionId: state.sessionId ?? 'global',
        percentage: state.contextWindow?.percentage ?? 0,
        status: state.status ?? 'unknown',
        timestamp: state.timestamp,
      });
    } catch {
      // skip
    }
  }

  return { sessions, count: sessions.length };
}

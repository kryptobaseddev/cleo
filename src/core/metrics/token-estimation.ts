/**
 * Token usage estimation and tracking.
 *
 * Estimates token consumption using heuristics (1 token ~ 4 chars).
 * Logs events to TOKEN_USAGE.jsonl for value-proof metrics.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { isoTimestamp } from './common.js';

/** Token event types. */
export type TokenEventType =
  | 'manifest_read'
  | 'manifest_query'
  | 'full_file_read'
  | 'file_read'
  | 'skill_inject'
  | 'protocol_inject'
  | 'prompt_build'
  | 'spawn_output'
  | 'spawn_complete'
  | 'session_start'
  | 'session_end';

/** A token usage event entry. */
export interface TokenEvent {
  timestamp: string;
  event_type: TokenEventType;
  estimated_tokens: number;
  source: string;
  task_id: string | null;
  session_id: string | null;
  context: Record<string, unknown>;
}

/** Session token tracking state. */
interface SessionState {
  sessionId: string;
  startTime: string;
  tokensByType: Record<string, number>;
}

let currentSession: SessionState | null = null;

function getTokenFilePath(cwd?: string): string {
  return join(getCleoDir(cwd), 'metrics', 'TOKEN_USAGE.jsonl');
}

function isTrackingEnabled(): boolean {
  return (process.env.CLEO_TRACK_TOKENS ?? '1') === '1';
}

/** Estimate token count from text. ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate token count from a file. */
export function estimateTokensFromFile(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const size = statSync(filePath).size;
  return Math.ceil(size / 4);
}

/** Log a token usage event to the JSONL file. */
export async function logTokenEvent(
  eventType: TokenEventType,
  tokens: number,
  source: string,
  taskId?: string,
  context?: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  if (!isTrackingEnabled()) return;

  const tokenFile = getTokenFilePath(cwd);
  await mkdir(dirname(tokenFile), { recursive: true });

  const entry: TokenEvent = {
    timestamp: isoTimestamp(),
    event_type: eventType,
    estimated_tokens: tokens,
    source,
    task_id: taskId ?? null,
    session_id: currentSession?.sessionId ?? null,
    context: context ?? {},
  };

  try {
    await appendFile(tokenFile, JSON.stringify(entry) + '\n');
  } catch {
    // Token tracking failures are non-fatal
  }

  // Update session totals
  if (currentSession) {
    const current = currentSession.tokensByType[eventType] ?? 0;
    currentSession.tokensByType[eventType] = current + tokens;
  }
}

/** Track a file read with token estimate. */
export async function trackFileRead(
  filePath: string,
  purpose: 'manifest' | 'full_file' | 'full' | 'skill' | 'protocol' | string,
  taskId?: string,
  cwd?: string,
): Promise<number> {
  if (!isTrackingEnabled()) return 0;

  const tokens = estimateTokensFromFile(filePath);
  const eventTypeMap: Record<string, TokenEventType> = {
    manifest: 'manifest_read',
    full_file: 'full_file_read',
    full: 'full_file_read',
    skill: 'skill_inject',
    protocol: 'protocol_inject',
  };
  const eventType = eventTypeMap[purpose] ?? ('file_read' as TokenEventType);

  await logTokenEvent(eventType, tokens, filePath, taskId, undefined, cwd);
  return tokens;
}

/** Track a manifest query (partial read). */
export async function trackManifestQuery(
  queryType: string,
  resultCount: number,
  taskId?: string,
  cwd?: string,
): Promise<number> {
  if (!isTrackingEnabled()) return 0;

  // Each manifest entry is ~200 tokens
  const tokens = resultCount * 200;

  await logTokenEvent(
    'manifest_query',
    tokens,
    `MANIFEST.jsonl:${queryType}`,
    taskId,
    { query_type: queryType, result_count: resultCount },
    cwd,
  );
  return tokens;
}

/** Track skill injection with tokens. */
export async function trackSkillInjection(
  skillName: string,
  tier: number,
  tokens: number,
  taskId?: string,
  cwd?: string,
): Promise<void> {
  if (!isTrackingEnabled()) return;

  await logTokenEvent(
    'skill_inject',
    tokens,
    `skills/${skillName}`,
    taskId,
    { skill: skillName, tier },
    cwd,
  );
}

/** Track final prompt size. */
export async function trackPromptBuild(
  prompt: string,
  taskId: string,
  skillsUsed: string,
  cwd?: string,
): Promise<number> {
  if (!isTrackingEnabled()) return 0;

  const tokens = estimateTokens(prompt);
  await logTokenEvent('prompt_build', tokens, 'spawn_prompt', taskId, { skills: skillsUsed }, cwd);
  return tokens;
}

/** Track subagent output tokens. */
export async function trackSpawnOutput(
  taskId: string,
  outputText: string,
  sessionId?: string,
  cwd?: string,
): Promise<number> {
  if (!isTrackingEnabled()) return 0;

  const tokens = estimateTokens(outputText);
  await logTokenEvent('spawn_output', tokens, 'subagent_response', taskId, { session_id: sessionId ?? '' }, cwd);
  return tokens;
}

/** Track complete spawn cycle (prompt + output). */
export async function trackSpawnComplete(
  taskId: string,
  promptTokens: number,
  outputTokens: number,
  sessionId?: string,
  cwd?: string,
): Promise<number> {
  if (!isTrackingEnabled()) return 0;

  const totalTokens = promptTokens + outputTokens;
  const baselineTokens = totalTokens * 10;
  const savedTokens = baselineTokens - totalTokens;
  const savingsPercent = baselineTokens > 0 ? Math.floor((savedTokens * 100) / baselineTokens) : 0;

  await logTokenEvent('spawn_complete', totalTokens, 'spawn_cycle', taskId, {
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    baseline_tokens: baselineTokens,
    saved_tokens: savedTokens,
    savings_percent: savingsPercent,
    session_id: sessionId ?? '',
  }, cwd);
  return totalTokens;
}

/** Start tracking tokens for a session. */
export async function startTokenSession(sessionId: string, cwd?: string): Promise<void> {
  currentSession = {
    sessionId,
    startTime: isoTimestamp(),
    tokensByType: {},
  };
  await logTokenEvent('session_start', 0, 'session', undefined, { session_id: sessionId }, cwd);
}

/** Token session summary shape. */
export interface TokenSessionSummary {
  session_id: string;
  start: string;
  end: string;
  tokens: {
    manifest_reads: number;
    full_file_reads: number;
    skill_injections: number;
    prompt_builds: number;
    total: number;
  };
  savings: {
    avoided_tokens: number;
    savings_percent: number;
  };
}

/** End token tracking session with summary. */
export async function endTokenSession(cwd?: string): Promise<TokenSessionSummary | null> {
  if (!currentSession) return null;

  const manifestTokens = currentSession.tokensByType['manifest_read'] ?? 0;
  const fullFileTokens = currentSession.tokensByType['full_file_read'] ?? 0;
  const skillTokens = currentSession.tokensByType['skill_inject'] ?? 0;
  const promptTokens = currentSession.tokensByType['prompt_build'] ?? 0;
  const total = manifestTokens + fullFileTokens + skillTokens + promptTokens;

  const avoidedTokens = manifestTokens * 9;
  const savingsPercent = total > 0 ? Math.floor((avoidedTokens * 100) / (total + avoidedTokens)) : 0;

  const summary: TokenSessionSummary = {
    session_id: currentSession.sessionId,
    start: currentSession.startTime,
    end: isoTimestamp(),
    tokens: {
      manifest_reads: manifestTokens,
      full_file_reads: fullFileTokens,
      skill_injections: skillTokens,
      prompt_builds: promptTokens,
      total,
    },
    savings: {
      avoided_tokens: avoidedTokens,
      savings_percent: savingsPercent,
    },
  };

  await logTokenEvent('session_end', total, 'session', undefined, summary as unknown as Record<string, unknown>, cwd);

  currentSession = null;
  return summary;
}

/** Get token usage summary for a time period. */
export function getTokenSummary(
  days: number = 7,
  cwd?: string,
): Record<string, unknown> {
  const tokenFile = getTokenFilePath(cwd);
  if (!existsSync(tokenFile)) {
    return { error: 'No token data', manifest_tokens: 0, full_file_tokens: 0, savings_percent: 0 };
  }

  const threshold = new Date();
  threshold.setDate(threshold.getDate() - days);
  const thresholdStr = threshold.toISOString();

  const entries = readFileSync(tokenFile, 'utf-8').trim().split('\n').filter(Boolean);

  let manifestTokens = 0;
  let fullFileTokens = 0;
  let skillTokens = 0;
  let promptTokensSum = 0;

  for (const line of entries) {
    try {
      const entry = JSON.parse(line) as TokenEvent;
      if (entry.timestamp < thresholdStr) continue;

      switch (entry.event_type) {
        case 'manifest_read':
        case 'manifest_query':
          manifestTokens += entry.estimated_tokens;
          break;
        case 'full_file_read':
          fullFileTokens += entry.estimated_tokens;
          break;
        case 'skill_inject':
          skillTokens += entry.estimated_tokens;
          break;
        case 'prompt_build':
          promptTokensSum += entry.estimated_tokens;
          break;
      }
    } catch {
      // Skip malformed entries
    }
  }

  const total = manifestTokens + fullFileTokens + skillTokens + promptTokensSum;
  const avoided = manifestTokens * 9;
  const savings = total > 0 ? Math.floor((avoided * 100) / (total + avoided)) : 0;

  return {
    period_days: days,
    tokens: {
      manifest_reads: manifestTokens,
      full_file_reads: fullFileTokens,
      skill_injections: skillTokens,
      prompt_builds: promptTokensSum,
      total,
    },
    savings: {
      avoided_tokens: avoided,
      savings_percent: savings,
      message: `Using manifest saves ~${savings}% context compared to full files`,
    },
  };
}

/** Compare manifest vs full file token usage strategies. */
export function compareManifestVsFull(manifestEntries: number): Record<string, unknown> {
  const manifestTokens = manifestEntries * 200;
  const fullFileTokens = manifestEntries * 2000;
  const savings = fullFileTokens - manifestTokens;
  const savingsPercent = fullFileTokens > 0 ? Math.floor((savings * 100) / fullFileTokens) : 0;

  let verdict: string;
  if (savingsPercent >= 80) verdict = 'Excellent';
  else if (savingsPercent >= 50) verdict = 'Good';
  else verdict = 'Moderate';

  return {
    manifest_entries_read: manifestEntries,
    manifest_tokens: manifestTokens,
    full_file_equivalent: fullFileTokens,
    tokens_saved: savings,
    savings_percent: savingsPercent,
    verdict,
  };
}

/** Get tracking status. */
export function getTrackingStatus(): { tracking_enabled: boolean; env_var: string } {
  return {
    tracking_enabled: isTrackingEnabled(),
    env_var: process.env.CLEO_TRACK_TOKENS ?? '1',
  };
}

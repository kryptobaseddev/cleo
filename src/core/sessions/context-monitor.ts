/**
 * Context monitor - reads Claude Code context window JSON and writes state.
 *
 * Used by the status line integration to track context window usage.
 * Receives JSON via stdin from Claude Code and writes state files.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCleoDir } from '../paths.js';
import { getCurrentSessionId, getContextStatePath, THRESHOLDS } from './context-alert.js';

/** Context window input from Claude Code. */
export interface ContextWindowInput {
  context_window: {
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** Context status derived from input. */
export type ContextStatus = 'ok' | 'warning' | 'caution' | 'critical' | 'emergency';

/** Determine status from percentage. */
export function getContextStatusFromPercentage(percentage: number): ContextStatus {
  if (percentage >= THRESHOLDS.EMERGENCY) return 'emergency';
  if (percentage >= THRESHOLDS.CRITICAL) return 'critical';
  if (percentage >= THRESHOLDS.CAUTION) return 'caution';
  if (percentage >= THRESHOLDS.WARNING) return 'warning';
  return 'ok';
}

/**
 * Process context window input and write state file.
 * Returns the status line string for display.
 */
export async function processContextInput(
  input: ContextWindowInput,
  cwd?: string,
): Promise<string> {
  const contextSize = input.context_window?.context_window_size ?? 200000;
  const usage = input.context_window?.current_usage;

  if (!usage) return '-- no data';

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const totalTokens = inputTokens + outputTokens + cacheCreate;
  const percentage = Math.floor((totalTokens * 100) / contextSize);
  const status = getContextStatusFromPercentage(percentage);

  // Write state file
  const cleoDir = getCleoDir(cwd);
  if (existsSync(cleoDir)) {
    const sessionId = getCurrentSessionId(cwd);
    const statePath = getContextStatePath(sessionId ?? undefined, cwd);

    const state = {
      $schema: 'https://cleo-dev.com/schemas/v1/context-state.schema.json',
      version: '1.0.0',
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      staleAfterMs: 5000,
      contextWindow: {
        maxTokens: contextSize,
        currentTokens: totalTokens,
        percentage,
        breakdown: {
          inputTokens,
          outputTokens,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
        },
      },
      thresholds: {
        warning: THRESHOLDS.WARNING,
        caution: THRESHOLDS.CAUTION,
        critical: THRESHOLDS.CRITICAL,
        emergency: THRESHOLDS.EMERGENCY,
      },
      status,
      cleoSessionId: sessionId ?? '',
    };

    try {
      await mkdir(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal
    }
  }

  return `${percentage}% | ${totalTokens}/${contextSize}`;
}

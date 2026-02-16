/**
 * Context window threshold crossing alerts.
 *
 * Detects when context usage crosses warning/caution/critical/emergency
 * thresholds and emits alerts. Supports suppression and per-command filtering.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
/** Synchronous config value reader (avoids async config pipeline for sync functions). */
function readConfigValueSync(path: string, defaultValue: unknown, cwd?: string): unknown {
  try {
    const configPath = join(getCleoDir(cwd), 'config.json');
    if (!existsSync(configPath)) return defaultValue;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const keys = path.split('.');
    let value: unknown = config;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Context alert thresholds (percentage of context window). */
export const THRESHOLDS = {
  WARNING: 70,
  CAUTION: 85,
  CRITICAL: 90,
  EMERGENCY: 95,
} as const;

/** Alert level names. */
export type AlertLevel = 'warning' | 'caution' | 'critical' | 'emergency';

/** Alert level ordering for comparison. */
const LEVEL_ORDER: AlertLevel[] = ['warning', 'caution', 'critical', 'emergency'];

/** Alert state persisted between checks. */
interface AlertState {
  lastAlertedLevel: number;
  thresholdLevel: AlertLevel;
  lastAlertedAt: string;
}

function getAlertStateFile(cwd?: string): string {
  return join(getCleoDir(cwd), '.context-alert-state.json');
}

/** Get the current session ID. */
export function getCurrentSessionId(cwd?: string): string | null {
  if (process.env.CLEO_SESSION) return process.env.CLEO_SESSION;

  const sessionFile = join(getCleoDir(cwd), '.current-session');
  if (existsSync(sessionFile)) {
    return readFileSync(sessionFile, 'utf-8').trim() || null;
  }
  return null;
}

/** Get context state file path for a session. */
export function getContextStatePath(sessionId?: string, cwd?: string): string {
  const cleoDir = getCleoDir(cwd);
  const sid = sessionId ?? getCurrentSessionId(cwd);

  if (sid) {
    const statesDir = join(cleoDir, 'context-states');
    const sessionFile = join(statesDir, `context-state-${sid}.json`);
    if (existsSync(sessionFile)) return sessionFile;
  }

  return join(cleoDir, '.context-state.json');
}

/** Read context state for a session. Returns null if stale or missing. */
export function readContextState(
  sessionId?: string,
  cwd?: string,
): Record<string, unknown> | null {
  const statePath = getContextStatePath(sessionId, cwd);
  if (!existsSync(statePath)) return null;

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const timestamp = state.timestamp as string;
    const staleAfterMs = (state.staleAfterMs as number) ?? 5000;

    if (timestamp) {
      const ageMs = Date.now() - new Date(timestamp).getTime();
      if (ageMs > staleAfterMs) return null;
    }

    return state;
  } catch {
    return null;
  }
}

/** Read the last alerted state. */
function readAlertState(cwd?: string): AlertState | null {
  const file = getAlertStateFile(cwd);
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as AlertState;
  } catch {
    return null;
  }
}

/** Update the last alerted state. */
function updateAlertState(percentage: number, level: AlertLevel, cwd?: string): void {
  const file = getAlertStateFile(cwd);
  const state: AlertState = {
    lastAlertedLevel: percentage,
    thresholdLevel: level,
    lastAlertedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileSync(file, JSON.stringify(state, null, 2));
}

/** Determine the threshold level for a given percentage. */
export function getThresholdLevel(percentage: number): AlertLevel | null {
  if (percentage >= THRESHOLDS.EMERGENCY) return 'emergency';
  if (percentage >= THRESHOLDS.CRITICAL) return 'critical';
  if (percentage >= THRESHOLDS.CAUTION) return 'caution';
  if (percentage >= THRESHOLDS.WARNING) return 'warning';
  return null;
}

/**
 * Determine if we should alert based on threshold crossing.
 * Returns the alert level if a new threshold was crossed, null otherwise.
 */
export function shouldAlert(
  currentPct: number,
  lastAlertedPct: number = 0,
  minThreshold: AlertLevel = 'warning',
): AlertLevel | null {
  const currentLevel = getThresholdLevel(currentPct);
  if (!currentLevel) return null;

  // Check if current level meets minimum threshold
  const currentIdx = LEVEL_ORDER.indexOf(currentLevel);
  const minIdx = LEVEL_ORDER.indexOf(minThreshold);
  if (currentIdx < minIdx) return null;

  // Determine last alerted level
  const lastLevel = getThresholdLevel(lastAlertedPct);
  if (currentLevel !== lastLevel) return currentLevel;

  return null;
}

/** Alert result from check_context_alert. */
export interface AlertCheckResult {
  alerted: boolean;
  level: AlertLevel | null;
  percentage: number;
  currentTokens: number;
  maxTokens: number;
  action: string | null;
}

/** Get recommended action for an alert level. */
export function getRecommendedAction(percentage: number): string | null {
  if (percentage >= THRESHOLDS.EMERGENCY) return 'IMMEDIATE: ct session end --note "..."';
  if (percentage >= THRESHOLDS.CRITICAL) return 'Recommended: ct session end --note "..."';
  if (percentage >= THRESHOLDS.CAUTION) return 'Consider: ct archive; ct session suspend';
  if (percentage >= THRESHOLDS.WARNING) return 'Monitor: Consider session cleanup soon';
  return null;
}

/**
 * Main function to check and determine if an alert should fire.
 * Non-blocking - always returns a result.
 */
export function checkContextAlert(
  currentCommand?: string,
  cwd?: string,
): AlertCheckResult {
  const noAlert: AlertCheckResult = {
    alerted: false,
    level: null,
    percentage: 0,
    currentTokens: 0,
    maxTokens: 0,
    action: null,
  };

  // Check if context alerts are enabled
  try {
    const enabled = readConfigValueSync('contextAlerts.enabled', true, cwd);
    if (!enabled) return noAlert;

    // Check trigger commands
    if (currentCommand) {
      const triggerCommands = readConfigValueSync('contextAlerts.triggerCommands', [], cwd) as string[];
      if (triggerCommands.length > 0 && !triggerCommands.includes(currentCommand)) {
        return noAlert;
      }
    }
  } catch {
    // Config not available, continue with defaults
  }

  // Check session
  const sessionId = getCurrentSessionId(cwd);
  if (!sessionId) return noAlert;

  // Read context state
  const contextState = readContextState(sessionId, cwd);
  if (!contextState) return noAlert;

  const cw = contextState.contextWindow as Record<string, number> | undefined;
  const currentPct = cw?.percentage ?? 0;
  const currentTokens = cw?.currentTokens ?? 0;
  const maxTokens = cw?.maxTokens ?? 200000;

  // Check suppress duration
  const alertState = readAlertState(cwd);
  const lastAlertedPct = alertState?.lastAlertedLevel ?? 0;

  try {
    const suppressDuration = readConfigValueSync('contextAlerts.suppressDuration', 0, cwd) as number;
    if (suppressDuration > 0 && alertState?.lastAlertedAt) {
      const ageSeconds = (Date.now() - new Date(alertState.lastAlertedAt).getTime()) / 1000;
      if (ageSeconds < suppressDuration) return noAlert;
    }
  } catch {
    // Config not available
  }

  // Check for threshold crossing
  const level = shouldAlert(currentPct, lastAlertedPct);
  if (!level) return noAlert;

  // Update state
  updateAlertState(currentPct, level, cwd);

  return {
    alerted: true,
    level,
    percentage: currentPct,
    currentTokens,
    maxTokens,
    action: getRecommendedAction(currentPct),
  };
}

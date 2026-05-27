/**
 * Terminal color and symbol utilities for human-readable CLI output.
 *
 * Respects NO_COLOR (https://no-color.org) and FORCE_COLOR env vars.
 * Falls back to plain ASCII when color is not supported.
 *
 * Status symbols are sourced from the registry (TASK_STATUS_SYMBOLS_UNICODE /
 * TASK_STATUS_SYMBOLS_ASCII) to keep icon definitions co-located with the
 * status values they describe.
 *
 * Originally lived under `packages/cleo/src/cli/renderers/colors.ts`.
 * Migrated to `@cleocode/core/render` per AGENTS.md Package-Boundary Check
 * (T10131 — B6) — rendering logic belongs in core, not the CLI thin shell.
 *
 * @task T4666
 * @task T10131
 * @epic T4663
 */
import {
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  type TaskStatus,
} from '@cleocode/contracts';

// Re-export the 3 ANSI primitives owned by B4's ansi.ts so callers have a
// single source for `BOLD`, `DIM`, `NC` alongside the extended color set.
import { BOLD, DIM, NC } from './ansi.js';

export { BOLD, DIM, NC };

/** Whether ANSI color escape codes should be used. */
const colorsEnabled: boolean = (() => {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
})();

/** Whether Unicode box-drawing and emoji are supported. */
const unicodeEnabled: boolean = (() => {
  const lang = process.env['LANG'] ?? '';
  if (lang === 'C' || lang === 'POSIX') return false;
  return lang.includes('UTF') || process.platform === 'darwin';
})();

// ---------------------------------------------------------------------------
// ANSI escape helpers
// ---------------------------------------------------------------------------

function ansi(code: string): string {
  return colorsEnabled ? code : '';
}

export const RED = ansi('\x1b[0;31m');
export const GREEN = ansi('\x1b[0;32m');
export const YELLOW = ansi('\x1b[1;33m');
export const BLUE = ansi('\x1b[0;34m');
export const MAGENTA = ansi('\x1b[0;35m');
export const CYAN = ansi('\x1b[0;36m');

// ---------------------------------------------------------------------------
// Status symbols and colors
// ---------------------------------------------------------------------------

/** Map task status to a display symbol. Falls back to '?' for unknown values. */
export function statusSymbol(status: string): string {
  const map = unicodeEnabled ? TASK_STATUS_SYMBOLS_UNICODE : TASK_STATUS_SYMBOLS_ASCII;
  return map[status as TaskStatus] ?? '?';
}

/** Map task status to a color escape. */
export function statusColor(status: string): string {
  switch (status as TaskStatus) {
    case 'pending':
      return CYAN;
    case 'active':
      return GREEN;
    case 'blocked':
      return RED;
    case 'done':
      return DIM;
    case 'cancelled':
      return DIM;
    case 'archived':
      return DIM;
    default:
      return '';
  }
}

/** Map task priority to a display symbol. */
export function prioritySymbol(priority: string): string {
  if (unicodeEnabled) {
    switch (priority) {
      case 'critical':
        return '🔴'; // red circle emoji
      case 'high':
        return '🟡'; // yellow circle emoji
      case 'medium':
        return '🔵'; // blue circle emoji
      case 'low':
        return '⚪'; // white circle emoji
      default:
        return '';
    }
  }
  switch (priority) {
    case 'critical':
      return '!';
    case 'high':
      return 'H';
    case 'medium':
      return 'M';
    case 'low':
      return 'L';
    default:
      return '';
  }
}

/** Map task priority to a color escape. */
export function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical':
      return RED;
    case 'high':
      return YELLOW;
    case 'medium':
      return BLUE;
    case 'low':
      return DIM;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export const BOX = unicodeEnabled
  ? {
      tl: '╭',
      tr: '╮',
      bl: '╰',
      br: '╯',
      h: '─',
      v: '│',
      ml: '├',
      mr: '┤',
    }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' };

/** Create a horizontal rule with box-drawing characters. */
export function hRule(width: number = 65): string {
  return BOX.h.repeat(width);
}

/** Format a date string as YYYY-MM-DD. */
export function shortDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  return isoDate.split('T')[0] ?? isoDate;
}

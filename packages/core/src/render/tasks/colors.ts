/**
 * Color, symbol, and box-drawing helpers used by the task-family renderers.
 *
 * Co-located with the tasks renderers rather than shared via
 * `packages/core/src/render/ansi.ts` (which is intentionally minimal) so that
 * the parallel B6 (system) / B7 (nexus) migrations can land independently
 * without cross-PR coupling. A follow-up cleanup may dedupe across families.
 *
 * @task T10133
 * @epic T10114
 */

import {
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  type TaskStatus,
} from '@cleocode/contracts';

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

function ansi(code: string): string {
  return colorsEnabled ? code : '';
}

export const BOLD = ansi('\x1b[1m');
export const DIM = ansi('\x1b[2m');
export const NC = ansi('\x1b[0m');
export const RED = ansi('\x1b[0;31m');
export const GREEN = ansi('\x1b[0;32m');
export const YELLOW = ansi('\x1b[1;33m');
export const BLUE = ansi('\x1b[0;34m');
export const CYAN = ansi('\x1b[0;36m');

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
        return '🔴';
      case 'high':
        return '🟡';
      case 'medium':
        return '🔵';
      case 'low':
        return '⚪';
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

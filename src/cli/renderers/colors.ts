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
 * @task T4666
 * @epic T4663
 */
import {
  TASK_STATUS_SYMBOLS_UNICODE,
  TASK_STATUS_SYMBOLS_ASCII,
  type TaskStatus,
} from '../../store/status-registry.js';

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

export const BOLD = ansi('\x1b[1m');
export const DIM = ansi('\x1b[2m');
export const NC = ansi('\x1b[0m');  // reset
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
    case 'pending':   return CYAN;
    case 'active':    return GREEN;
    case 'blocked':   return RED;
    case 'done':      return DIM;
    case 'cancelled': return DIM;
    case 'archived':  return DIM;
    default: return '';
  }
}

/** Map task priority to a display symbol. */
export function prioritySymbol(priority: string): string {
  if (unicodeEnabled) {
    switch (priority) {
      case 'critical': return '\uD83D\uDD34';  // red circle emoji
      case 'high': return '\uD83D\uDFE1';      // yellow circle emoji
      case 'medium': return '\uD83D\uDD35';    // blue circle emoji
      case 'low': return '\u26AA';              // white circle emoji
      default: return '';
    }
  }
  switch (priority) {
    case 'critical': return '!';
    case 'high': return 'H';
    case 'medium': return 'M';
    case 'low': return 'L';
    default: return '';
  }
}

/** Map task priority to a color escape. */
export function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return RED;
    case 'high': return YELLOW;
    case 'medium': return BLUE;
    case 'low': return DIM;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export const BOX = unicodeEnabled
  ? { tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F', h: '\u2500', v: '\u2502', ml: '\u251C', mr: '\u2524' }
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

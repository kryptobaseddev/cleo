/**
 * Typed icon enums for the human-render contract (ADR-077).
 *
 * Single source of truth for the visual language used across all renderers
 * (tree, table, list, badge). Each enum is emoji-first; `ascii()` returns the
 * NO_COLOR-safe fallback for non-UTF-8 terminals or `NO_COLOR=1` environments.
 *
 * @packageDocumentation
 */

/**
 * Status icons — agent-task lifecycle states.
 *
 * Emoji-first; `ascii()` returns a NO_COLOR-safe fallback.
 */
export enum StatusIcon {
  /** Task is queued and has not started. */
  PENDING = '⏳',
  /** Task is in progress. */
  ACTIVE = '🚧',
  /** Task completed successfully. */
  DONE = '✅',
  /** Task is blocked on a dependency or gate. */
  BLOCKED = '🚪',
  /** Task is archived and no longer actively tracked. */
  ARCHIVED = '🗄',
  /** Task was cancelled before completion. */
  CANCELLED = '✗',
}

/**
 * Task-kind icons — Saga / Epic / Task / Subtask plus ancillary kinds.
 */
export enum KindIcon {
  /** Saga — multi-release theme grouping ≥ 2 Epics. */
  SAGA = '🌲',
  /** Epic — one releasable slice. */
  EPIC = '📋',
  /** Task — one atomic PR-sized change. */
  TASK = '•',
  /** Subtask — one commit contributing to a Task's PR. */
  SUBTASK = '◦',
  /** Research task — investigation or audit. */
  RESEARCH = '📖',
  /** Bug task — defect tracking. */
  BUG = '🐛',
  /** Release task — shipping work. */
  RELEASE = '🚀',
}

/**
 * Badge icons — flags attached to tasks (empty, orphan, nested, etc).
 */
export enum BadgeIcon {
  /** Container has no children. */
  EMPTY = '🪦',
  /**
   * Task has no parent and is unreachable from a Saga or Epic.
   *
   * NOTE: ADR-077 §2 originally specified `'🚪'`, identical to `StatusIcon.BLOCKED`.
   * TypeScript string enums share a single runtime string so `ascii()` cannot
   * disambiguate. Resolved by switching to `'👻'` (abandoned/lonely semantics).
   * A follow-up ADR amendment lands in T10137 (B12).
   */
  ORPHAN = '👻',
  /** Task is nested deeper than the depth budget allows. */
  NESTED = '🔁',
  /** Caution — something needs human attention. */
  CAUTION = '⚠',
  /** Recently added — surfaced for visibility. */
  NEW = '★',
}

/**
 * Relation icons — edge semantics in tree views.
 */
export enum RelationIcon {
  /** Saga groups Epic via `task_relations.relation_type='groups'`. */
  GROUPS = '⊂',
  /** Parent edge — direct hierarchical parent. */
  PARENT = '⤴',
  /** Depends-on edge — A cannot start until B is done. */
  DEPENDS = '⇨',
  /** Blocks edge — A actively blocks B from progressing. */
  BLOCKS = '⊘',
}

/**
 * Union of every icon enum — useful as the parameter type for helpers that
 * accept any icon without caring which category it came from.
 */
export type AnyIcon = StatusIcon | KindIcon | BadgeIcon | RelationIcon;

/**
 * Maps an emoji icon to its NO_COLOR-safe ASCII equivalent.
 *
 * Used when stdout is not a UTF-8 TTY or `NO_COLOR=1` is set. Every enum
 * member has an explicit ASCII fallback — the exhaustive switch ensures the
 * TypeScript compiler flags any future icon added without an ASCII mapping.
 *
 * @param icon - Any icon from `StatusIcon`, `KindIcon`, `BadgeIcon`, or `RelationIcon`.
 * @returns The ASCII-only string to render in NO_COLOR contexts.
 */
export function ascii(icon: AnyIcon): string {
  switch (icon) {
    // Status
    case StatusIcon.PENDING:
      return '[ ]';
    case StatusIcon.ACTIVE:
      return '[~]';
    case StatusIcon.DONE:
      return '[x]';
    case StatusIcon.BLOCKED:
      return '[!]';
    case StatusIcon.ARCHIVED:
      return '[#]';
    case StatusIcon.CANCELLED:
      return '[-]';
    // Kind
    case KindIcon.SAGA:
      return 'SG';
    case KindIcon.EPIC:
      return 'E';
    case KindIcon.TASK:
      return '-';
    case KindIcon.SUBTASK:
      return '.';
    case KindIcon.RESEARCH:
      return 'R';
    case KindIcon.BUG:
      return 'B';
    case KindIcon.RELEASE:
      return '>';
    // Badge
    case BadgeIcon.EMPTY:
      return '(empty)';
    case BadgeIcon.ORPHAN:
      return '(orphan)';
    case BadgeIcon.NESTED:
      return '(nested)';
    case BadgeIcon.CAUTION:
      return '(!)';
    case BadgeIcon.NEW:
      return '(new)';
    // Relation
    case RelationIcon.GROUPS:
      return 'in';
    case RelationIcon.PARENT:
      return '^';
    case RelationIcon.DEPENDS:
      return '->';
    case RelationIcon.BLOCKS:
      return '!>';
  }
}

/**
 * Options for {@link pickIcon}.
 */
export interface PickIconOptions {
  /**
   * Force ASCII fallback. When omitted, falls back to `NO_COLOR=1` or
   * `TERM=dumb` in `process.env`.
   */
  noColor?: boolean;
}

/**
 * Returns the icon to render given the current environment.
 *
 * Honors `NO_COLOR=1` and `TERM=dumb` for ASCII fallback when `opts.noColor`
 * is not provided explicitly.
 *
 * @param icon - The icon to render.
 * @param opts - Optional override for NO_COLOR detection.
 * @returns The emoji icon, or its ASCII equivalent if NO_COLOR mode is active.
 */
export function pickIcon<I extends AnyIcon>(icon: I, opts?: PickIconOptions): string {
  const noColor =
    opts?.noColor ?? (process.env['NO_COLOR'] === '1' || process.env['TERM'] === 'dumb');
  return noColor ? ascii(icon) : icon;
}

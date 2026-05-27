/**
 * Static badge rendering — single-icon glyphs with ASCII fallback.
 *
 * @remarks
 * Part of the Human Render Contract (Epic T10114, ADR-077). Every CLI status,
 * kind, badge, or relation glyph that surfaces in `--human` mode flows through
 * one of these two helpers. The {@link AnimateContext} gate guarantees JSON /
 * quiet / non-TTY / NO_COLOR outputs emit nothing, mirroring the silence
 * contract enforced by {@link createSpinnerHandle}.
 *
 * @epic T10114
 * @task T10128
 * @subtask T10145
 */

import {
  ascii,
  type BadgeIcon,
  type KindIcon,
  type RelationIcon,
  StatusIcon,
} from '@cleocode/contracts/render/icon.js';
import type { AnimateContext } from '../animate-context.js';

/**
 * Common options for badge rendering.
 *
 * @remarks
 * `ascii` is an explicit override. When omitted the helper falls back to
 * `ctx.inputs.noColor` so callers can simply thread the context through.
 */
export interface RenderBadgeOptions {
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
  /**
   * When `true`, force the ASCII fallback regardless of the context's
   * `noColor` signal. When `false`, force the emoji form. When omitted,
   * defer to `ctx.inputs.noColor`.
   */
  readonly ascii?: boolean;
}

/** Lifecycle status names accepted by {@link renderStatusBadge}. */
export type StatusBadgeName =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'archived';

/**
 * Render a single icon as its emoji form or ASCII fallback.
 *
 * @param icon - Any member of {@link StatusIcon}, {@link KindIcon},
 *   {@link BadgeIcon}, or {@link RelationIcon}.
 * @param opts - Render gate + optional ASCII override.
 * @returns The emoji or ASCII glyph. Empty string when `opts.ctx.enabled` is `false`.
 *
 * @example
 * ```ts
 * renderBadge(StatusIcon.DONE, { ctx: enabledCtx });          // '✅'
 * renderBadge(StatusIcon.DONE, { ctx: enabledCtx, ascii: true }); // '[x]'
 * renderBadge(StatusIcon.DONE, { ctx: disabledCtx });          // ''
 * ```
 */
export function renderBadge(
  icon: StatusIcon | KindIcon | BadgeIcon | RelationIcon,
  opts: RenderBadgeOptions,
): string {
  if (!opts.ctx.enabled) return '';
  const useAscii = opts.ascii ?? opts.ctx.inputs.noColor;
  return useAscii ? ascii(icon) : icon;
}

/** Internal mapping — lifecycle status name → canonical {@link StatusIcon}. */
const STATUS_NAME_TO_ICON: Readonly<Record<StatusBadgeName, StatusIcon>> = {
  pending: StatusIcon.PENDING,
  in_progress: StatusIcon.ACTIVE,
  done: StatusIcon.DONE,
  blocked: StatusIcon.BLOCKED,
  cancelled: StatusIcon.CANCELLED,
  archived: StatusIcon.ARCHIVED,
};

/**
 * Render a lifecycle status string as a badge glyph.
 *
 * @param status - Canonical task status name (`'pending'`, `'in_progress'`, …).
 * @param opts - Render gate + optional ASCII override.
 * @returns The emoji or ASCII glyph for the status. Empty string when
 *   `opts.ctx.enabled` is `false`.
 *
 * @example
 * ```ts
 * renderStatusBadge('done', { ctx });          // '✅'
 * renderStatusBadge('pending', { ctx: ascii }); // '[ ]'
 * ```
 */
export function renderStatusBadge(status: StatusBadgeName, opts: RenderBadgeOptions): string {
  return renderBadge(STATUS_NAME_TO_ICON[status], opts);
}

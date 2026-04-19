/**
 * CLEO Studio — shared UI primitive prop unions.
 *
 * These types are intentionally small and UI-specific. Anything with a
 * domain meaning (task status, priority, pipeline stage) MUST come from
 * `@cleocode/contracts` instead; this file is the escape hatch for
 * pure presentational variants only.
 *
 * @task T990
 * @wave 0
 */

/**
 * Semantic tone — maps to the `--success / --warning / --danger / --info
 * / --neutral / --accent` palette in `tokens.css`.
 *
 * Consumed by {@link Badge}, {@link Chip}, and any primitive that needs
 * a semantic colour swap.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

/**
 * Component size — three-tier scale. Maps to padding + font-size pairs
 * inside each primitive's scoped CSS.
 */
export type Size = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Button-style variant — governs background / border / text colour.
 * `subtle` is the low-emphasis sibling of `ghost` for toolbar use.
 */
export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

/**
 * Popover / Drawer / Tooltip placement relative to its anchor.
 */
export type Placement = 'top' | 'bottom' | 'left' | 'right';

/**
 * Card padding density. Maps to the spacing scale:
 *   compact → var(--space-2) (8px)
 *   cozy    → var(--space-4) (16px)  DEFAULT
 *   comfy   → var(--space-6) (24px)
 */
export type CardDensity = 'compact' | 'cozy' | 'comfy';

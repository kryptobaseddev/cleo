/**
 * CleoOS TUI design system theme — shared ANSI color constants.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/tui-theme.ts`
 *
 * Maps the design tokens from `docs/design/CLEO-PI-AGENT-TUI-DESIGN.md`
 * and `docs/design/QUICK-REFERENCE.md` to ANSI 256-color escape sequences.
 *
 * All Pi extensions that render TUI elements MUST import from this module
 * rather than defining ad-hoc ANSI codes inline. This ensures visual
 * consistency across the CleoOS Hearth surface.
 *
 * ANSI 256-color mapping rationale:
 *   Terminal environments do not support arbitrary hex colors. The 256-color
 *   palette provides the closest available approximation. Each constant
 *   documents the target hex value from the design spec and the chosen
 *   ANSI 256-color code that best approximates it.
 *
 * @packageDocumentation
 */

// ============================================================================
// ANSI primitives
// ============================================================================

/** ANSI escape code prefix. */
const ESC = "\x1b[";

/** ANSI reset sequence — clears all styling. */
export const RESET = `${ESC}0m`;

// ============================================================================
// Raw ANSI 256-color codes (design token → closest 256-color match)
// ============================================================================

/**
 * Design token `bg-primary` (#0a0a0f) — main background.
 * ANSI 256-color 232 (darkest gray, #080808).
 */
export const CODE_BG_PRIMARY = 232;

/**
 * Design token `bg-secondary` (#13131f) — panels, elevated surfaces.
 * ANSI 256-color 233 (#121212).
 */
export const CODE_BG_SECONDARY = 233;

/**
 * Design token `bg-tertiary` (#1a1a2e) — inputs, cards, subtle highlights.
 * ANSI 256-color 234 (#1c1c1c).
 */
export const CODE_BG_TERTIARY = 234;

/**
 * Design token `accent-primary` (#a855f7) — Pi AI purple accent.
 * ANSI 256-color 135 (#af5fff).
 */
export const CODE_ACCENT_PRIMARY = 135;

/**
 * Design token `accent-secondary` (#ec4899) — pink accent.
 * ANSI 256-color 205 (#ff5faf).
 */
export const CODE_ACCENT_SECONDARY = 205;

/**
 * Design token `accent-success` (#22c55e) — success / active states.
 * ANSI 256-color 35 (#00af5f).
 */
export const CODE_ACCENT_SUCCESS = 35;

/**
 * Design token `accent-warning` (#f59e0b) — warning states.
 * ANSI 256-color 214 (#ffaf00).
 */
export const CODE_ACCENT_WARNING = 214;

/**
 * Design token `accent-error` (#ef4444) — error states.
 * ANSI 256-color 196 (#ff0000).
 */
export const CODE_ACCENT_ERROR = 196;

/**
 * Design token `text-primary` (#f8fafc) — primary headings text.
 * ANSI 256-color 255 (#eeeeee).
 */
export const CODE_TEXT_PRIMARY = 255;

/**
 * Design token `text-secondary` (#94a3b8) — body / muted text.
 * ANSI 256-color 245 (#8a8a8a).
 */
export const CODE_TEXT_SECONDARY = 245;

/**
 * Design token `text-tertiary` (#64748b) — disabled / very muted text.
 * ANSI 256-color 243 (#767676).
 */
export const CODE_TEXT_TERTIARY = 243;

/**
 * Design token `border-subtle` (#2a2a3e) — dividers, borders.
 * ANSI 256-color 236 (#303030).
 */
export const CODE_BORDER_SUBTLE = 236;

/**
 * Design token `border-focus` (#4a4a5e) — focus rings.
 * ANSI 256-color 240 (#585858).
 */
export const CODE_BORDER_FOCUS = 240;

/**
 * Blue accent for worker tier badges (not in the design palette but used
 * consistently in the Circle of Ten worker display).
 * ANSI 256-color 75 (#5fafff).
 */
export const CODE_TIER_WORKER = 75;

// ============================================================================
// Convenience styling functions
// ============================================================================

/**
 * Wrap text in ANSI 256-color foreground.
 *
 * @param text - The text to colorize.
 * @param code - ANSI 256-color code (0-255).
 * @returns The text wrapped in ANSI color escape sequences.
 */
export function fg256(text: string, code: number): string {
	return `${ESC}38;5;${code}m${text}${RESET}`;
}

/**
 * Apply `accent-primary` (purple, #a855f7) foreground to text.
 *
 * Used for: Pi AI branding, active tab indicators, focus borders,
 * Circle of Ten header, banner chrome.
 *
 * @param text - The text to style.
 * @returns Purple ANSI text.
 */
export function accentPrimary(text: string): string {
	return fg256(text, CODE_ACCENT_PRIMARY);
}

/**
 * Apply `accent-secondary` (pink, #ec4899) foreground to text.
 *
 * Used for: secondary emphasis, user message borders, gradient endpoints.
 *
 * @param text - The text to style.
 * @returns Pink ANSI text.
 */
export function accentSecondary(text: string): string {
	return fg256(text, CODE_ACCENT_SECONDARY);
}

/**
 * Apply `accent-success` (green, #22c55e) foreground to text.
 *
 * Used for: active status dots, success badges, healthy system states,
 * orchestrator tier prefix.
 *
 * @param text - The text to style.
 * @returns Green ANSI text.
 */
export function accentSuccess(text: string): string {
	return fg256(text, CODE_ACCENT_SUCCESS);
}

/**
 * Apply `accent-warning` (amber, #f59e0b) foreground to text.
 *
 * Used for: paused status, warning badges, lead tier prefix,
 * modified file indicators.
 *
 * @param text - The text to style.
 * @returns Amber/yellow ANSI text.
 */
export function accentWarning(text: string): string {
	return fg256(text, CODE_ACCENT_WARNING);
}

/**
 * Apply `accent-error` (red, #ef4444) foreground to text.
 *
 * Used for: error status, failed states, deleted file indicators,
 * validation failures.
 *
 * @param text - The text to style.
 * @returns Red ANSI text.
 */
export function accentError(text: string): string {
	return fg256(text, CODE_ACCENT_ERROR);
}

/**
 * Apply `text-secondary` (gray, #94a3b8) foreground to text.
 *
 * Used for: body text, timestamps, metadata, dim separators.
 *
 * @param text - The text to dim.
 * @returns Dim gray ANSI text.
 */
export function textSecondary(text: string): string {
	return fg256(text, CODE_TEXT_SECONDARY);
}

/**
 * Apply `text-tertiary` (dark gray, #64748b) foreground to text.
 *
 * Used for: disabled text, placeholders, line numbers.
 *
 * @param text - The text to style.
 * @returns Dark gray ANSI text.
 */
export function textTertiary(text: string): string {
	return fg256(text, CODE_TEXT_TERTIARY);
}

/**
 * Apply worker tier blue accent foreground to text.
 *
 * Used for: worker agent tier prefix `[W]` in the Circle of Ten display.
 *
 * @param text - The text to style.
 * @returns Blue ANSI text.
 */
export function tierWorker(text: string): string {
	return fg256(text, CODE_TIER_WORKER);
}

/**
 * Apply `border-subtle` (#2a2a3e) foreground to text.
 *
 * Used for: separator lines, box-drawing border characters.
 *
 * @param text - The text to style.
 * @returns Subtle border-colored ANSI text.
 */
export function borderSubtle(text: string): string {
	return fg256(text, CODE_BORDER_SUBTLE);
}

/**
 * Apply ANSI bold to text.
 *
 * Used for: headings, agent names, active labels, H2/H3 elements.
 *
 * @param text - The text to bold.
 * @returns Bold ANSI text.
 */
export function bold(text: string): string {
	return `${ESC}1m${text}${RESET}`;
}

/**
 * Apply ANSI italic to text.
 *
 * Used for: thought process text, AI reasoning display.
 *
 * @param text - The text to italicize.
 * @returns Italic ANSI text.
 */
export function italic(text: string): string {
	return `${ESC}3m${text}${RESET}`;
}

// ============================================================================
// Box-drawing constants (Forge aesthetic)
// ============================================================================

/** Double-line horizontal bar character. */
export const BOX_HORIZONTAL = "\u2550";

/** Double-line vertical bar character. */
export const BOX_VERTICAL = "\u2551";

/** Double-line top-left corner. */
export const BOX_TOP_LEFT = "\u2554";

/** Double-line top-right corner. */
export const BOX_TOP_RIGHT = "\u2557";

/** Double-line bottom-left corner. */
export const BOX_BOTTOM_LEFT = "\u255A";

/** Double-line bottom-right corner. */
export const BOX_BOTTOM_RIGHT = "\u255D";

/** Double-line left T-junction. */
export const BOX_LEFT_T = "\u2560";

/** Double-line right T-junction. */
export const BOX_RIGHT_T = "\u2563";

/** Single-line horizontal bar character (for lighter separators). */
export const LINE_HORIZONTAL = "\u2500";

/** Single-line vertical bar character (for lighter separators). */
export const LINE_VERTICAL = "\u2502";

// ============================================================================
// Status indicator characters
// ============================================================================

/** Filled circle — active / online status. */
export const DOT_FILLED = "\u25CF";

/** Hollow circle — inactive / offline status. */
export const DOT_HOLLOW = "\u25CB";

/** Hammer and pick — CleoOS forge icon. */
export const ICON_FORGE = "\u2692";

/** Diamond — team indicator. */
export const ICON_DIAMOND = "\u25C6";

/** Triangle up — tier/priority indicator. */
export const ICON_TRIANGLE = "\u25B2";

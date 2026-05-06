/**
 * AnimateContext — render-gate for terminal animations.
 *
 * @remarks
 * Every animation primitive in this package (spinners, progress bars, sparks)
 * routes its output through an {@link AnimateContext}. When the context is
 * "silent" — JSON mode, --quiet, non-TTY pipes, or NO_COLOR — the primitive
 * returns no-op handles so callers do not have to branch on output mode.
 *
 * This mirrors the LAFS protocol invariant from `@cleocode/lafs`: JSON output
 * is the default, human-readable rendering requires explicit opt-in. By
 * keeping the gate logic in one place we guarantee that every animation
 * surface obeys the same rules:
 *
 *   - `format === 'human'`         — animations enabled
 *   - `format === 'json'`          — animations disabled (machine output)
 *   - `quiet === true`             — animations disabled (script-friendly)
 *   - `isTTY === false`            — animations disabled (piped/redirected)
 *   - `noColor === true`           — animations disabled (NO_COLOR env)
 *
 * The context is intentionally pure data — no I/O, no timers — so it can be
 * constructed once at command entry and threaded through long-running ops.
 */

/**
 * Minimal subset of the LAFS `FlagResolution` shape that AnimateContext needs.
 *
 * @remarks
 * Declared structurally rather than imported from `@cleocode/lafs` to keep
 * `@cleocode/animations` zero-dep. Anything that produces a `{ format, quiet }`
 * pair — including `resolveOutputFormat()` from LAFS — satisfies this contract.
 */
export interface FlagResolutionLike {
  /** Resolved output format. */
  readonly format: 'json' | 'human';
  /** When true, suppress non-essential output. */
  readonly quiet: boolean;
}

/**
 * Inputs to {@link createAnimateContext}.
 *
 * @remarks
 * `flagResolution` is the load-bearing input — pass the value returned by
 * `resolveOutputFormat()` from `@cleocode/lafs`. The other fields default to
 * inspecting the current Node.js process environment when omitted, which is
 * the right call for nearly every CLI use case.
 */
export interface AnimateContextInput {
  /** Resolved LAFS flags governing output format and quietness. */
  readonly flagResolution: FlagResolutionLike;
  /**
   * Whether stdout is attached to a TTY. Defaults to `process.stdout.isTTY`.
   * Pass `false` explicitly when rendering to a buffer or redirected stream.
   */
  readonly isTTY?: boolean;
  /**
   * Whether the `NO_COLOR` standard is in effect (https://no-color.org).
   * Defaults to `process.env.NO_COLOR != null`. Pass `false` to override.
   */
  readonly noColor?: boolean;
}

/**
 * Resolved render-gate context — consult `enabled` before rendering anything.
 *
 * @remarks
 * `reason` carries diagnostic provenance (which gate disabled rendering) so
 * verbose-mode callers can surface why animations are silent without
 * re-implementing the gate logic.
 */
export interface AnimateContext {
  /** Whether animation rendering is permitted. */
  readonly enabled: boolean;
  /** When `enabled === false`, the rule that disabled rendering. */
  readonly reason: 'enabled' | 'format-json' | 'quiet' | 'no-tty' | 'no-color';
  /** Echo of the inputs used to derive this context — useful for diagnostics. */
  readonly inputs: {
    readonly format: 'json' | 'human';
    readonly quiet: boolean;
    readonly isTTY: boolean;
    readonly noColor: boolean;
  };
}

/**
 * Construct an {@link AnimateContext} from LAFS flags + environment signals.
 *
 * @param input - LAFS flag resolution plus optional TTY / NO_COLOR overrides
 * @returns The resolved context with `enabled` flag and diagnostic `reason`
 *
 * @remarks
 * Precedence (first match disables): `format !== 'human'` →
 * `quiet === true` → `isTTY === false` → `noColor === true`. All four checks
 * fire independently; rendering is enabled only when every gate passes.
 *
 * @example
 * ```ts
 * import { resolveOutputFormat } from '@cleocode/lafs';
 * import { createAnimateContext, createSpinnerHandle } from '@cleocode/animations';
 *
 * const flagResolution = resolveOutputFormat({ humanFlag: true });
 * const context = createAnimateContext({ flagResolution });
 * const spinner = createSpinnerHandle(context, 'looming', 'Weaving tasks…');
 * spinner.start();
 * await doWork();
 * spinner.stop('Done.');
 * ```
 */
export function createAnimateContext(input: AnimateContextInput): AnimateContext {
  const format = input.flagResolution.format;
  const quiet = input.flagResolution.quiet;
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);
  const noColor = input.noColor ?? process.env.NO_COLOR != null;

  const inputs = { format, quiet, isTTY, noColor } as const;

  if (format !== 'human') {
    return { enabled: false, reason: 'format-json', inputs };
  }
  if (quiet) {
    return { enabled: false, reason: 'quiet', inputs };
  }
  if (!isTTY) {
    return { enabled: false, reason: 'no-tty', inputs };
  }
  if (noColor) {
    return { enabled: false, reason: 'no-color', inputs };
  }

  return { enabled: true, reason: 'enabled', inputs };
}

/**
 * A silent context — guarantees every primitive returns a no-op handle.
 *
 * @remarks
 * Useful for tests and for libraries that want to opt out of animations
 * without constructing a full LAFS flag resolution.
 */
export const SILENT_CONTEXT: AnimateContext = Object.freeze({
  enabled: false,
  reason: 'format-json',
  inputs: Object.freeze({
    format: 'json',
    quiet: false,
    isTTY: false,
    noColor: false,
  }),
});

/**
 * Local render types — not shared via `@cleocode/contracts`.
 *
 * Caller-facing options for {@link ./render-envelope.ts | renderEnvelopeForHuman}
 * plus the `Renderer<T>` function shape used by the registry. These types live
 * in core (not contracts) because they describe presenter behaviour rather
 * than wire-format payloads — the contracts package stays pure-data.
 *
 * @epic T10114
 * @task T10130
 */

import type { RenderableEnvelope } from '@cleocode/contracts';

/**
 * Per-call render options. Mirrors the format axes already used by the CLI
 * but lives in core so non-CLI callers (tests, programmatic consumers) can
 * pass them too.
 */
export interface RenderOptions {
  /** Output format. `'human'` (default) returns a formatted string; `'json'` suppresses output. */
  readonly format?: 'human' | 'json';
  /** When `true`, suppress ANSI color escapes in the output. */
  readonly noColor?: boolean;
  /** Terminal width hint in columns. Defaults to 80 when not provided. */
  readonly width?: number;
  /** When `true`, presenters MAY emit extended detail. */
  readonly verbose?: boolean;
  /**
   * When `true`, presenters MUST emit the most compact representation —
   * typically one line per item with no chrome, headers, or descriptions.
   * Mirrors the `--quiet` CLI flag the legacy `(data, quiet)` renderers
   * accepted as their second argument.
   *
   * @task T10133
   */
  readonly quiet?: boolean;
}

/**
 * A renderer accepts a typed envelope plus per-call options and returns the
 * string to write to stdout. Returning `''` suppresses output for that call.
 *
 * @typeParam T — caller-defined envelope payload shape.
 */
export type Renderer<T = unknown> = (
  envelope: RenderableEnvelope<T>,
  opts: RenderOptions,
) => string;

/**
 * Registry key — `${command}:${kind}` uniquely addresses a renderer slot.
 *
 * `command` is the CLEO command that produced the envelope (e.g.
 * `'tasks.list'`); `kind` is the discriminator on `RenderableEnvelope<T>`.
 */
export type RegistryKey = `${string}:${RenderableEnvelope<unknown>['kind']}`;

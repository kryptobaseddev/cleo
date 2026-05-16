/**
 * CLEO LLM native hot-path bindings.
 *
 * Provides Rust-accelerated implementations of the think-scrubber and
 * rate-limit-guard, with automatic JS fallback when the native binary is
 * absent.
 *
 * Enable the Rust path with `CLEO_USE_RUST=1`. Default is JS (no behavior
 * change, no binary required).
 *
 * @module llm/rust
 * @task T9318
 * @epic T9261
 */

/**
 * Scrub all reasoning blocks from a complete (non-streaming) string.
 *
 * Routes to the Rust implementation when `CLEO_USE_RUST=1` and the native
 * binary is present; otherwise delegates to the pure-JS fallback.
 *
 * @param input - Complete response text, potentially containing `<think>` blocks.
 * @returns Text with all reasoning blocks stripped.
 */
export declare function thinkScrub(input: string): string;

/**
 * Stateful streaming reasoning-block scrubber.
 *
 * Holds buffer across `feed()` calls so partial open/close tags spanning a
 * chunk boundary do not leak inner content to the consumer.
 *
 * Routes to Rust (`ThinkScrubber`) when `CLEO_USE_RUST=1` and native binary
 * is present; otherwise wraps pure-JS `StreamingThinkScrubber`.
 *
 * @example
 * ```ts
 * const s = new ThinkScrubber();
 * for (const chunk of stream) {
 *   const visible = s.feed(chunk);
 *   if (visible) emit(visible);
 * }
 * const tail = s.flush();
 * if (tail) emit(tail);
 * ```
 */
export declare class ThinkScrubber {
  constructor();
  /**
   * Feed one delta chunk. Returns the visible portion with reasoning blocks stripped.
   *
   * May return an empty string when the delta is entirely reasoning content or
   * is held back pending resolution of a partial tag at the boundary.
   */
  feed(chunk: string): string;
  /** Flush any remaining buffered text. Call at end-of-stream. */
  flush(): string;
  /** Reset all internal state. Call at the start of every new turn. */
  reset(): void;
}

/**
 * In-process token-bucket rate-limit guard.
 *
 * Tokens refill continuously at `refillRatePerSecond` tokens per second up to
 * `capacity`. Complementary to the cross-session file-based guard in
 * `rate-limit-guard.ts`.
 *
 * Routes to Rust (`RateLimitGuard`) when `CLEO_USE_RUST=1` and native binary
 * is present; otherwise uses a pure-JS token-bucket implementation.
 *
 * @example
 * ```ts
 * const guard = new RateLimitGuard(100, 10); // 100 cap, 10 tok/s
 * if (guard.acquire(1)) {
 *   // proceed with request
 * } else {
 *   // rate-limited — back off
 * }
 * ```
 */
export declare class RateLimitGuard {
  /**
   * @param capacity - Maximum token bucket size.
   * @param refillRatePerSecond - Tokens added per second (continuous refill).
   */
  constructor(capacity: number, refillRatePerSecond: number);
  /**
   * Try to acquire `tokens` from the bucket.
   * Returns `true` if the tokens were available and consumed.
   */
  acquire(tokens: number): boolean;
  /** Return the number of currently available tokens (after refill). */
  peekAvailable(): number;
  /** Return the bucket capacity. */
  capacity(): number;
  /** Return the refill rate in tokens per second. */
  refillRatePerSecond(): number;
  /** Reset the bucket to full capacity. */
  reset(): void;
  /**
   * Return milliseconds until `tokens` are available, or `0` if already available.
   */
  msUntilAvailable(tokens: number): number;
}

/** `true` when the native binary was successfully loaded. */
export declare const nativeLoaded: boolean;

/**
 * Anthropic prompt-caching strategies.
 *
 * Ported from Hermes agent/prompt_caching.py. Provides two injection
 * strategies that place `cache_control` breakpoints on Anthropic
 * Messages.create kwargs to reduce input-token costs on multi-turn
 * conversations:
 *
 * - `system_and_3`: mark every system block + last 3 user-message ends
 *   at the 5-minute TTL tier.
 * - `prefix_and_2`: mark the first system block at the 1-hour TTL tier
 *   (stable prefix) + last 2 user-message ends at the 5-minute TTL tier
 *   (rolling window).
 * - `none`: no-op — pass kwargs through unchanged.
 *
 * All functions are pure (mutate the input object — callers own the
 * lifecycle) and carry no class state.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 * @task T9269
 * @epic T9261
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Anthropic cache breakpoint TTL options.
 *
 * The Anthropic API accepts string duration values:
 * - `'5m'` = 5-minute rolling window (default ephemeral tier).
 * - `'1h'` = 1-hour stable prefix (long-cache tier).
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export type CacheTtl = '5m' | '1h';

/**
 * The three supported prompt-caching injection strategies.
 *
 * - `system_and_3`: system block(s) + last 3 user messages, all at 5-minute TTL.
 * - `prefix_and_2`: first system block at 1-hour TTL + last 2 user messages at 5-minute TTL.
 * - `none`: no cache breakpoints injected.
 */
export type PromptCachingStrategy = 'system_and_3' | 'prefix_and_2' | 'none';

/**
 * Cache control marker as Anthropic accepts on content blocks and system blocks.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export interface CacheControlMarker {
  /** Must be `'ephemeral'` per the Anthropic API. */
  type: 'ephemeral';
  /**
   * Optional TTL duration string.
   * `'5m'` = 5-minute tier (default when omitted).
   * `'1h'` = 1-hour tier (long-cache stable prefix).
   */
  ttl?: CacheTtl;
}

/**
 * Minimal shape of an Anthropic system block — must carry at least
 * `type` and optionally `text` and `cache_control`.
 */
export interface AnthropicSystemBlock {
  type: string;
  text?: string;
  cache_control?: CacheControlMarker;
}

/**
 * Minimal shape of an Anthropic message — role + content (string or block array).
 * The `content` field is widened to `Array<Record<string, unknown>>` after
 * string→block normalisation inside the injector.
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/**
 * Minimal kwargs shape accepted by `injectCacheBreakpoints`.
 *
 * Represents a partial Anthropic Messages.create parameters object that
 * contains at least `messages` and optionally a `system` block array.
 */
export interface AnthropicKwargs {
  system?: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a `CacheControlMarker` for the given TTL.
 * The `ttl` field is omitted when it equals `'5m'` to keep the payload minimal
 * (`'5m'` is Anthropic's implicit default for the ephemeral tier).
 */
function buildMarker(ttl: CacheTtl): CacheControlMarker {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral', ttl: '5m' };
}

/**
 * Attach a `cache_control` marker to the last block of a message's content.
 *
 * If `content` is a plain string it is first converted to a single-element
 * block array (`[{ type: 'text', text: content }]`) so the marker can be
 * attached. Mutates `msg.content` in-place.
 */
function attachMarkerToLastBlock(msg: AnthropicMessage, marker: CacheControlMarker): void {
  // Normalise string content → block array
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content }];
  }

  const blocks = msg.content as Array<Record<string, unknown>>;
  const last = blocks[blocks.length - 1];
  if (last !== undefined) {
    last['cache_control'] = marker;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject Anthropic cache breakpoints into a Messages.create kwargs object
 * according to the chosen strategy.
 *
 * Mutates `kwargs` in-place — call this immediately before passing the object
 * to the Anthropic SDK so no copies need to be made on the hot path.
 *
 * Strategy details:
 * - `system_and_3`: every system block + the last 3 user messages receive
 *   `{ type: 'ephemeral', ttl: '5m' }`.
 * - `prefix_and_2`: the **first** system block receives
 *   `{ type: 'ephemeral', ttl: '1h' }` (stable long-cache prefix); the last
 *   2 user messages receive `{ type: 'ephemeral', ttl: '5m' }` (rolling
 *   window).
 * - `none`: kwargs returned unchanged.
 *
 * @param kwargs - Anthropic Messages.create kwargs to mutate.
 * @param strategy - Which caching strategy to apply.
 * @returns The same `kwargs` reference (mutated).
 *
 * @task T9269
 */
export function injectCacheBreakpoints<T extends AnthropicKwargs>(
  kwargs: T,
  strategy: PromptCachingStrategy,
): T {
  if (strategy === 'none') return kwargs;

  if (strategy === 'system_and_3') {
    const shortMarker = buildMarker('5m');

    // Mark every system block at the 5-minute TTL
    if (Array.isArray(kwargs.system)) {
      for (const block of kwargs.system) {
        block.cache_control = shortMarker;
      }
    }

    // Mark the last 3 user-message ends at the 5-minute TTL
    let userCount = 0;
    for (let i = kwargs.messages.length - 1; i >= 0; i--) {
      const msg = kwargs.messages[i];
      if (msg === undefined || msg.role !== 'user') continue;
      attachMarkerToLastBlock(msg, shortMarker);
      userCount++;
      if (userCount >= 3) break;
    }

    return kwargs;
  }

  if (strategy === 'prefix_and_2') {
    const longMarker = buildMarker('1h');
    const shortMarker = buildMarker('5m');

    // Mark ONLY the first system block with the 1-hour TTL (stable prefix)
    if (Array.isArray(kwargs.system) && kwargs.system.length > 0) {
      const firstBlock = kwargs.system[0];
      if (firstBlock !== undefined) {
        firstBlock.cache_control = longMarker;
      }
    }

    // Mark the last 2 user-message ends at the 5-minute TTL (rolling window)
    let userCount = 0;
    for (let i = kwargs.messages.length - 1; i >= 0; i--) {
      const msg = kwargs.messages[i];
      if (msg === undefined || msg.role !== 'user') continue;
      attachMarkerToLastBlock(msg, shortMarker);
      userCount++;
      if (userCount >= 2) break;
    }

    return kwargs;
  }

  return kwargs;
}

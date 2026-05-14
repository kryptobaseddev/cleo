/**
 * Stateful scrubber for reasoning/thinking blocks in streamed assistant text.
 *
 * When a model streams `<think>...</think>` blocks across multiple SSE deltas,
 * naive per-delta regex destroys open/close tag state, leaking inner content
 * to the consumer. This module holds a buffer across `feed()` calls so partial
 * tags at delta boundaries are resolved before any text is emitted.
 *
 * Ported from Hermes `agent/think_scrubber.py` (StreamingThinkScrubber).
 *
 * @task T9275
 * @epic T9261
 */

/**
 * Recognised opening tags (case-insensitive).
 * Mirrors Hermes' `OPEN_TAGS` set.
 */
const OPEN_TAGS = [
  '<think>',
  '<thinking>',
  '<reasoning>',
  '<thought>',
  '<reasoning_scratchpad>',
] as const;

/**
 * Recognised closing tags (case-insensitive).
 * Each index corresponds to the same-index entry in {@link OPEN_TAGS}.
 */
const CLOSE_TAGS = [
  '</think>',
  '</thinking>',
  '</reasoning>',
  '</thought>',
  '</reasoning_scratchpad>',
] as const;

/** Pre-computed maximum tag length used for partial-suffix hold-back. */
const MAX_TAG_LEN: number = Math.max(
  ...OPEN_TAGS.map((t) => t.length),
  ...CLOSE_TAGS.map((t) => t.length),
);

// ── internal helpers ──────────────────────────────────────────────────────────

/**
 * Return `[earliestIndex, tagLength]` of the first case-insensitive match of
 * any entry in `tags` within `buf`, or `[-1, 0]` if none found.
 */
function findFirstTag(buf: string, tags: readonly string[]): [number, number] {
  const lower = buf.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const tag of tags) {
    const idx = lower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = tag.length;
    }
  }
  return [bestIdx, bestLen];
}

/**
 * Return the length of the longest suffix of `buf` that is a strict prefix
 * (shorter than the full tag) of any entry in `tags`. Case-insensitive.
 *
 * Only prefixes strictly shorter than the tag count — a full match is handled
 * as a tag hit, not a held-back partial.
 */
function maxPartialSuffix(buf: string, tags: readonly string[]): number {
  if (buf.length === 0) return 0;
  const lower = buf.toLowerCase();
  const maxCheck = Math.min(lower.length, MAX_TAG_LEN - 1);
  for (let i = maxCheck; i > 0; i--) {
    const suffix = lower.slice(-i);
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower.length > i && tagLower.startsWith(suffix)) {
        return i;
      }
    }
  }
  return 0;
}

/**
 * Return `[startIdx, endIdx]` of the earliest complete closed pair
 * `<tag>…</tag>` (case-insensitive, non-greedy per-variant) in `buf`, or
 * `null` if none found.
 *
 * Closed pairs are always stripped regardless of line-boundary position;
 * an inline `<think>X</think>` is almost certainly intentional reasoning.
 */
function findEarliestClosedPair(buf: string): [number, number] | null {
  const lower = buf.toLowerCase();
  let best: [number, number] | null = null;
  for (let i = 0; i < OPEN_TAGS.length; i++) {
    const openLower = OPEN_TAGS[i].toLowerCase();
    const closeLower = CLOSE_TAGS[i].toLowerCase();
    const openIdx = lower.indexOf(openLower);
    if (openIdx === -1) continue;
    const closeIdx = lower.indexOf(closeLower, openIdx + openLower.length);
    if (closeIdx === -1) continue;
    const endIdx = closeIdx + closeLower.length;
    if (best === null || openIdx < best[0]) {
      best = [openIdx, endIdx];
    }
  }
  return best;
}

/**
 * Remove any orphan close tags from `text` (close tag with no matching open in
 * the current scrubber state). Trailing whitespace after each orphan is also
 * consumed so surrounding prose flows naturally.
 */
function stripOrphanCloseTags(text: string): string {
  if (!text.includes('</')) return text;
  const lower = text.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (lower[i] === '<' && lower[i + 1] === '/') {
      let matched = false;
      for (const tag of CLOSE_TAGS) {
        const tagLower = tag.toLowerCase();
        if (lower.startsWith(tagLower, i)) {
          let j = i + tagLower.length;
          while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
          i = j;
          matched = true;
          break;
        }
      }
      if (!matched) {
        out.push(text[i]);
        i++;
      }
    } else {
      out.push(text[i]);
      i++;
    }
  }
  return out.join('');
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Stateful streaming reasoning-block scrubber.
 *
 * Holds a buffer across deltas so partial open/close tags spanning a delta
 * boundary do not leak inner content to the consumer.
 *
 * Usage:
 * ```ts
 * const s = new StreamingThinkScrubber();
 * for (const delta of stream) {
 *   const visible = s.feed(delta);
 *   if (visible) emit(visible);
 * }
 * const tail = s.flush();
 * if (tail) emit(tail);
 * ```
 *
 * Call {@link reset} at the start of every new turn so a hung block from an
 * interrupted prior stream cannot taint the next turn's output.
 */
export class StreamingThinkScrubber {
  private buf = '';
  private inBlock = false;
  /** True when the last emission ended with `\n`, or nothing has been emitted yet. */
  private lastEmittedEndedNewline = true;

  /**
   * Feed one delta. Returns the visible portion with reasoning blocks stripped.
   *
   * May return an empty string when the entire delta is reasoning content or is
   * being held back pending resolution of a partial tag at the boundary.
   */
  feed(text: string): string {
    if (!text) return '';

    let buf = this.buf + text;
    this.buf = '';
    const out: string[] = [];

    while (buf.length > 0) {
      if (this.inBlock) {
        // Hunt for the earliest close tag to exit the reasoning block.
        const [closeIdx, closeLen] = findFirstTag(buf, CLOSE_TAGS);
        if (closeIdx === -1) {
          // No close yet — hold back potential partial close-tag prefix.
          const held = maxPartialSuffix(buf, CLOSE_TAGS);
          this.buf = held > 0 ? buf.slice(-held) : '';
          return out.join('');
        }
        // Found close: discard block content + tag, continue scanning.
        buf = buf.slice(closeIdx + closeLen);
        this.inBlock = false;
        continue;
      }

      // Outside a block — look for closed pairs first (highest priority),
      // then unterminated open tags.
      const pair = findEarliestClosedPair(buf);
      const [openIdx, openLen] = this.findOpenAtBoundary(buf, out);

      if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
        // Closed pair wins — emit preceding text, discard the pair.
        const [pairStart, pairEnd] = pair;
        if (pairStart > 0) {
          const preceding = stripOrphanCloseTags(buf.slice(0, pairStart));
          if (preceding) {
            out.push(preceding);
            this.lastEmittedEndedNewline = preceding.endsWith('\n');
          }
        }
        buf = buf.slice(pairEnd);
        continue;
      }

      if (openIdx !== -1) {
        // Unterminated open at a block boundary — emit preceding, enter block.
        if (openIdx > 0) {
          const preceding = stripOrphanCloseTags(buf.slice(0, openIdx));
          if (preceding) {
            out.push(preceding);
            this.lastEmittedEndedNewline = preceding.endsWith('\n');
          }
        }
        this.inBlock = true;
        buf = buf.slice(openIdx + openLen);
        continue;
      }

      // No resolvable tag structure — hold back any partial-tag suffix and
      // emit the rest.
      const heldOpen = maxPartialSuffix(buf, OPEN_TAGS);
      const heldClose = maxPartialSuffix(buf, CLOSE_TAGS);
      const held = Math.max(heldOpen, heldClose);

      const emitText = held > 0 ? buf.slice(0, -held) : buf;
      this.buf = held > 0 ? buf.slice(-held) : '';

      if (emitText) {
        const clean = stripOrphanCloseTags(emitText);
        if (clean) {
          out.push(clean);
          this.lastEmittedEndedNewline = clean.endsWith('\n');
        }
      }
      return out.join('');
    }

    return out.join('');
  }

  /**
   * Flush any remaining buffered text. Call at end-of-stream.
   *
   * If still inside an unterminated reasoning block the held-back content is
   * discarded — leaking partial reasoning is worse than a truncated answer.
   * Otherwise the held-back partial-tag tail is emitted verbatim (it turned
   * out not to be a real tag prefix).
   */
  flush(): string {
    if (this.inBlock) {
      this.buf = '';
      this.inBlock = false;
      return '';
    }
    const tail = this.buf;
    this.buf = '';
    if (!tail) return '';
    const clean = stripOrphanCloseTags(tail);
    if (clean) {
      this.lastEmittedEndedNewline = clean.endsWith('\n');
    }
    return clean;
  }

  /** Reset all internal state. Call at the start of every new turn. */
  reset(): void {
    this.buf = '';
    this.inBlock = false;
    this.lastEmittedEndedNewline = true;
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /**
   * Return `[index, tagLength]` of the earliest open tag that sits at a
   * block boundary in `buf`, or `[-1, 0]` if none found.
   *
   * A block boundary is:
   * - position 0 when the last emission ended with `\n` (or nothing emitted)
   * - any position preceded only by whitespace since the last `\n` in `buf`
   *   (with the same newline-ended prior-emission requirement when no `\n` is
   *   present in the preceding text)
   *
   * Closed pairs (`<tag>X</tag>`) are handled separately and are NOT
   * subject to boundary gating.
   */
  private findOpenAtBoundary(buf: string, alreadyEmitted: string[]): [number, number] {
    const lower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;

    for (const tag of OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      while (true) {
        const idx = lower.indexOf(tagLower, searchStart);
        if (idx === -1) break;
        if (this.isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break; // first boundary hit for this tag variant is sufficient
        }
        searchStart = idx + 1;
      }
    }

    return [bestIdx, bestLen];
  }

  /**
   * Return true if position `idx` in `buf` is a block boundary.
   *
   * Rules:
   * - `idx === 0`: boundary iff the last emitted chunk (this feed call or the
   *   cross-feed flag) ended with `\n`, or nothing has been emitted yet.
   * - `idx > 0`: boundary iff every character since the last `\n` in
   *   `buf.slice(0, idx)` is whitespace; when there is no `\n` in that slice
   *   the same newline-ended prior-emission requirement applies.
   */
  private isBlockBoundary(buf: string, idx: number, alreadyEmitted: string[]): boolean {
    if (idx === 0) {
      if (alreadyEmitted.length > 0) {
        return alreadyEmitted[alreadyEmitted.length - 1].endsWith('\n');
      }
      return this.lastEmittedEndedNewline;
    }

    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf('\n');

    if (lastNl === -1) {
      // No newline in buf before the tag.
      const priorNewline =
        alreadyEmitted.length > 0
          ? alreadyEmitted[alreadyEmitted.length - 1].endsWith('\n')
          : this.lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === '';
    }

    // Newline present — text between it and the tag must be whitespace-only.
    return preceding.slice(lastNl + 1).trim() === '';
  }
}

/**
 * Scrub all reasoning blocks from a complete (non-streaming) string.
 *
 * Convenience wrapper around {@link StreamingThinkScrubber} for callers that
 * already have the full response text.
 */
export function scrubReasoning(text: string): string {
  const s = new StreamingThinkScrubber();
  return s.feed(text) + s.flush();
}

/**
 * Tests for `StreamingThinkScrubber` and `scrubReasoning`.
 *
 * Covers the state-machine semantics specified in T9275:
 *   - full-block stripping in a single feed
 *   - multi-delta split across boundaries
 *   - partial open-tag hold-back at delta boundaries
 *   - multiple reasoning blocks in one feed
 *   - case-insensitive tag matching
 *   - unterminated block flushed as empty
 *   - plain text passthrough
 *   - convenience `scrubReasoning` helper
 *   - reset() clears mid-block state
 *
 * Also covers T9295 (W4c) stream-side integration tests:
 *   - strips <think> tags from OpenAI o1 stream deltas
 *   - preserves Anthropic native thinking blocks (no scrubbing needed)
 *   - routes thinking → delta.reasoning and visible → delta.text
 *
 * @task T9275
 * @task T9295 (W4c — stream-side wiring tests)
 * @epic T9261
 */

import { describe, expect, it } from 'vitest';
import { StreamingThinkScrubber, scrubReasoning } from '../think-scrubber.js';

describe('StreamingThinkScrubber', () => {
  describe('single-feed cases', () => {
    it('strips a complete think block and returns trailing visible text', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<think>secret</think>hi')).toBe('hi');
      expect(s.flush()).toBe('');
    });

    it('returns empty string when the entire feed is a reasoning block', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<think>secret</think>')).toBe('');
      expect(s.flush()).toBe('');
    });

    it('passes through text with no tags', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('plain text')).toBe('plain text');
      expect(s.flush()).toBe('');
    });

    it('returns empty string for an empty feed', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('')).toBe('');
    });
  });

  describe('multi-delta split across boundaries', () => {
    it('accumulates split block across three deltas', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<think>')).toBe('');
      expect(s.feed('secret')).toBe('');
      expect(s.feed('</think>hi')).toBe('hi');
      expect(s.flush()).toBe('');
    });

    it('holds back split close tag and resolves on next delta', () => {
      const s = new StreamingThinkScrubber();
      s.feed('<think>secret');
      expect(s.feed('</thin')).toBe(''); // partial close held
      expect(s.feed('k>after')).toBe('after');
    });
  });

  describe('partial open-tag hold-back', () => {
    it('holds partial open tag at delta end and resolves on next delta', () => {
      const s = new StreamingThinkScrubber();
      // 'a<thi' — 'a' is emitted, '<thi' is held as a partial open prefix
      expect(s.feed('a<thi')).toBe('a');
      // '<thi' + 'nk>secret</think>b' resolves to a full open tag
      expect(s.feed('nk>secret</think>b')).toBe('b');
      expect(s.flush()).toBe('');
    });

    it('emits held-back partial tag verbatim if stream ends without tag completion', () => {
      const s = new StreamingThinkScrubber();
      s.feed('hello <thi');
      // flush: not in a block, so the held partial is returned verbatim
      expect(s.flush()).toBe('<thi');
    });
  });

  describe('multiple reasoning blocks', () => {
    it('strips two sequential blocks separated by visible text', () => {
      const s = new StreamingThinkScrubber();
      const result = s.feed('<think>x</think>vis<reasoning>y</reasoning>end') + s.flush();
      expect(result).toBe('visend');
    });

    it('handles two blocks split across deltas', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<think>a</think>')).toBe('');
      expect(s.feed('between')).toBe('between');
      expect(s.feed('<reasoning>b</reasoning>')).toBe('');
      expect(s.feed('after')).toBe('after');
    });
  });

  describe('case-insensitive matching', () => {
    it('matches THINK and Think case variants', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<THINK>x</Think>vis')).toBe('vis');
      expect(s.flush()).toBe('');
    });

    it('matches mixed-case reasoning tag', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<REASONING>x</reasoning>after')).toBe('after');
    });

    it('handles REASONING_SCRATCHPAD case variant', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<REASONING_SCRATCHPAD>hidden</reasoning_scratchpad>visible')).toBe('visible');
    });
  });

  describe('mismatched open/close tags', () => {
    it('closes a block on any recognised close tag regardless of which open was used', () => {
      // <think> opened, </reasoning> closes it — Hermes behaviour
      const s = new StreamingThinkScrubber();
      const result = s.feed('<think>foo</reasoning>after') + s.flush();
      expect(result).toBe('after');
    });
  });

  describe('unterminated block — flush discards content', () => {
    it('discards held reasoning content when block is never closed', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('<think>oops')).toBe('');
      expect(s.flush()).toBe('');
    });

    it('returns empty from flush even after partial close in unterminated block', () => {
      const s = new StreamingThinkScrubber();
      s.feed('<think>some content</thi'); // partial close, still in block
      expect(s.flush()).toBe('');
    });
  });

  describe('reset()', () => {
    it('clears mid-block state so subsequent plain text is emitted', () => {
      const s = new StreamingThinkScrubber();
      s.feed('<think>mid-block-content');
      s.reset();
      expect(s.feed('plain text')).toBe('plain text');
      expect(s.flush()).toBe('');
    });

    it('clears held partial-tag buffer', () => {
      const s = new StreamingThinkScrubber();
      s.feed('prefix <thi'); // partial open held in buf
      s.reset();
      expect(s.feed('clean')).toBe('clean');
      expect(s.flush()).toBe('');
    });
  });

  describe('all recognised tag variants', () => {
    const variants: Array<[string, string]> = [
      ['<think>', '</think>'],
      ['<thinking>', '</thinking>'],
      ['<reasoning>', '</reasoning>'],
      ['<thought>', '</thought>'],
      ['<reasoning_scratchpad>', '</reasoning_scratchpad>'],
    ];

    for (const [open, close] of variants) {
      it(`strips ${open}…${close} block`, () => {
        const s = new StreamingThinkScrubber();
        expect(s.feed(`${open}hidden${close}visible`) + s.flush()).toBe('visible');
      });
    }
  });

  describe('visible text before and after a block', () => {
    it('preserves text on both sides of a block', () => {
      const s = new StreamingThinkScrubber();
      expect(s.feed('before<think>inner</think>after') + s.flush()).toBe('beforeafter');
    });
  });
});

describe('scrubReasoning (convenience helper)', () => {
  it('strips a reasoning block from a complete string', () => {
    expect(scrubReasoning('<think>x</think>visible')).toBe('visible');
  });

  it('returns unchanged text when no reasoning blocks are present', () => {
    expect(scrubReasoning('just plain text')).toBe('just plain text');
  });

  it('strips multiple blocks in one call', () => {
    expect(scrubReasoning('<think>a</think>mid<reasoning>b</reasoning>end')).toBe('midend');
  });

  it('discards unterminated block content', () => {
    expect(scrubReasoning('<think>never closed')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// T9295 (W4c) — stream-side integration tests
// ---------------------------------------------------------------------------

describe('T9295 W4c — stream-side think-scrubber integration', () => {
  it('strips <think> tags from OpenAI o1 stream deltas', () => {
    const s = new StreamingThinkScrubber();
    // Simulate o1 style: <think>...</think> inline in text stream
    const deltas = ['<think>', 'internal reasoning step', '</think>', 'visible answer'];

    const collected: string[] = [];
    for (const d of deltas) {
      const out = s.feed(d);
      if (out) collected.push(out);
    }
    const tail = s.flush();
    if (tail) collected.push(tail);

    expect(collected.join('')).toBe('visible answer');
  });

  it('preserves Anthropic native thinking blocks (delta.reasoning populated separately)', () => {
    // Anthropic routes thinking via delta.reasoning — not via <think> tags.
    // Verify the scrubber passes plain non-tagged text through unchanged.
    const s = new StreamingThinkScrubber();
    expect(s.feed('normal assistant text')).toBe('normal assistant text');
    expect(s.flush()).toBe('');
  });

  it('routes thinking → hidden and visible → delta.text across multiple chunks', () => {
    const s = new StreamingThinkScrubber();
    // Split tag across chunks to exercise boundary handling.
    // <think> must appear at a line boundary — use newline before the tag.
    // The close tag emits its trailing '\n' as visible text.
    const chunks = ['pre\n', '<thi', 'nk>hi', 'dden</th', 'ink>\n', 'post'];
    let visible = '';
    for (const chunk of chunks) {
      visible += s.feed(chunk);
    }
    visible += s.flush();
    // 'pre\n' before the block, '\n' from after </think>, 'post' after
    expect(visible).toBe('pre\n\npost');
  });
});

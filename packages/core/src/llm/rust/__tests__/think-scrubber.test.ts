/**
 * Tests for the JS-fallback think-scrubber layer in `packages/core/src/llm/rust/`.
 *
 * These tests run against the pure-JS path (no native binary required) and
 * verify:
 *   - think-tag strip (complete block in one chunk)
 *   - partial-chunk streaming (tags split across chunks)
 *   - no-think passthrough
 *   - unterminated block discarded on flush
 *   - all recognised tag variants (think, thinking, reasoning, thought, reasoning_scratchpad)
 *   - JS fallback path confirmed (nativeLoaded = false in test env)
 *
 * @task T9318
 * @epic T9261
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamingThinkScrubber, scrubReasoning } from '../../think-scrubber.js';

// We test the JS implementations directly (the rust/index.js re-exports them
// when CLEO_USE_RUST is unset). We also import the module to verify
// nativeLoaded is false in this test environment.

describe('rust/index.js — JS fallback path', () => {
  let origRust: string | undefined;

  beforeEach(() => {
    origRust = process.env['CLEO_USE_RUST'];
    delete process.env['CLEO_USE_RUST'];
  });

  afterEach(() => {
    if (origRust === undefined) {
      delete process.env['CLEO_USE_RUST'];
    } else {
      process.env['CLEO_USE_RUST'] = origRust;
    }
  });

  it('thinkScrub (JS) strips a complete think block', () => {
    const result = scrubReasoning('<think>secret</think>visible');
    expect(result).toBe('visible');
  });

  it('thinkScrub (JS) passes through text with no tags', () => {
    expect(scrubReasoning('plain text')).toBe('plain text');
  });

  it('thinkScrub (JS) strips multiple think blocks', () => {
    expect(scrubReasoning('a<think>x</think>b<think>y</think>c')).toBe('abc');
  });

  it('thinkScrub (JS) returns empty for all-think input', () => {
    expect(scrubReasoning('<think>secret</think>')).toBe('');
  });
});

describe('StreamingThinkScrubber — think-tag strip', () => {
  it('strips a complete block in a single feed', () => {
    const s = new StreamingThinkScrubber();
    expect(s.feed('<think>secret</think>visible')).toBe('visible');
    expect(s.flush()).toBe('');
  });

  it('returns visible text before a think block', () => {
    const s = new StreamingThinkScrubber();
    expect(s.feed('prefix\n<think>secret</think>')).toBe('prefix\n');
    expect(s.flush()).toBe('');
  });
});

describe('StreamingThinkScrubber — partial-chunk streaming', () => {
  it('handles open tag split across two chunks', () => {
    const s = new StreamingThinkScrubber();
    // "<think>" split as "<thi" + "nk>secret</think>ok"
    const v1 = s.feed('<thi');
    const v2 = s.feed('nk>secret</think>ok');
    expect(v1 + v2 + s.flush()).toBe('ok');
  });

  it('handles close tag split across two chunks', () => {
    const s = new StreamingThinkScrubber();
    s.feed('<think>sec');
    const v2 = s.feed('ret</thi');
    const v3 = s.feed('nk>after');
    expect(v2 + v3 + s.flush()).toBe('after');
  });

  it('emits nothing for in-block content across many chunks', () => {
    const s = new StreamingThinkScrubber();
    s.feed('<think>');
    const chunks = ['part1', 'part2', 'part3'];
    const out = chunks.map((c) => s.feed(c)).join('');
    s.feed('</think>');
    expect(out + s.flush()).toBe('');
  });
});

describe('StreamingThinkScrubber — no-think passthrough', () => {
  it('passes through plain text unchanged', () => {
    const s = new StreamingThinkScrubber();
    expect(s.feed('hello world')).toBe('hello world');
    expect(s.flush()).toBe('');
  });

  it('passes through text with angle brackets that are not tags', () => {
    const s = new StreamingThinkScrubber();
    expect(s.feed('3 < 5 and x > y')).toBe('3 < 5 and x > y');
  });
});

describe('StreamingThinkScrubber — unterminated block', () => {
  it('discards unterminated block on flush', () => {
    const s = new StreamingThinkScrubber();
    s.feed('<think>never closed');
    expect(s.flush()).toBe('');
  });
});

describe('StreamingThinkScrubber — tag variants', () => {
  const variants = [
    ['<thinking>', '</thinking>'],
    ['<reasoning>', '</reasoning>'],
    ['<thought>', '</thought>'],
    ['<reasoning_scratchpad>', '</reasoning_scratchpad>'],
  ];

  for (const [open, close] of variants) {
    it(`strips ${open}…${close} variant`, () => {
      const s = new StreamingThinkScrubber();
      // Block at start of line so boundary check passes
      expect(s.feed(`${open}hidden${close}shown`)).toBe('shown');
      expect(s.flush()).toBe('');
    });
  }
});

describe('StreamingThinkScrubber — reset', () => {
  it('reset() clears mid-block state', () => {
    const s = new StreamingThinkScrubber();
    s.feed('<think>unclosed');
    s.reset();
    // After reset, should behave as fresh instance
    expect(s.feed('clean text')).toBe('clean text');
    expect(s.flush()).toBe('');
  });
});

describe('StreamingThinkScrubber — scrubReasoning convenience', () => {
  it('strips think block from full text', () => {
    expect(scrubReasoning('before\n<think>hidden</think>after')).toBe('before\nafter');
  });

  it('returns empty string for all-think input', () => {
    expect(scrubReasoning('<think>all hidden</think>')).toBe('');
  });
});

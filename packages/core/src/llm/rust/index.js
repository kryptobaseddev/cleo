// JS fallback loader for @cleocode/llm-native.
// Tries to load the platform-specific napi binary; falls back to pure-JS
// implementations when the binary is absent (dev environments, CI, Pi targets
// without a prebuilt binary).
//
// Set CLEO_USE_RUST=1 to force the native path (throws if binary missing).

'use strict';

const { join } = require('node:path');

function platformTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64-gnu' : 'linux-x64-gnu';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'win32-arm64-msvc' : 'win32-x64-msvc';
  }
  return `${process.platform}-${process.arch}`;
}

// ── Attempt native load ──────────────────────────────────────────────────────

/** @type {import('./index.d.ts') | null} */
let native = null;

try {
  native = require(join(__dirname, `cleo-llm-native.${platformTriple()}.node`));
} catch (_loadErr) {
  if (process.env.CLEO_USE_RUST === '1') {
    throw new Error(
      `CLEO_USE_RUST=1 but native binary not found for ${platformTriple()}. ` +
        'Build with: cargo build -p cleo-llm-native',
    );
  }
  // Silently fall through to JS fallback.
}

// ── JS fallback implementations ──────────────────────────────────────────────
// Loaded lazily so that environments with the native binary never pay the cost.

let JsStreamingThinkScrubber = null;
let jsScrubReasoning = null;

function loadJsThinkScrubber() {
  if (JsStreamingThinkScrubber !== null) return;
  // Dynamic require so bundlers can exclude this path when native is present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require('../think-scrubber.js');
  JsStreamingThinkScrubber = m.StreamingThinkScrubber;
  jsScrubReasoning = m.scrubReasoning;
}

// ── Exported think-scrubber ──────────────────────────────────────────────────

/**
 * Scrub all reasoning blocks from a complete (non-streaming) string.
 *
 * Routes to the Rust implementation when `CLEO_USE_RUST=1` and the native
 * binary is present; otherwise delegates to the pure-JS fallback.
 *
 * @param {string} input
 * @returns {string}
 */
function thinkScrub(input) {
  if (native !== null && process.env.CLEO_USE_RUST === '1') {
    return native.thinkScrub(input);
  }
  loadJsThinkScrubber();
  return jsScrubReasoning(input);
}

/**
 * Stateful streaming think-scrubber.
 *
 * When `CLEO_USE_RUST=1` and the native binary is present this is the Rust
 * `ThinkScrubber` napi class; otherwise it wraps the pure-JS
 * `StreamingThinkScrubber`.
 */
class ThinkScrubber {
  constructor() {
    if (native !== null && process.env.CLEO_USE_RUST === '1') {
      this._impl = new native.ThinkScrubber();
      this._isNative = true;
    } else {
      loadJsThinkScrubber();
      this._impl = new JsStreamingThinkScrubber();
      this._isNative = false;
    }
  }

  /** @param {string} chunk @returns {string} */
  feed(chunk) {
    return this._impl.feed(chunk);
  }

  /** @returns {string} */
  flush() {
    return this._impl.flush();
  }

  reset() {
    this._impl.reset();
  }
}

// ── Exported rate-limit guard ────────────────────────────────────────────────

/**
 * In-process token-bucket rate-limit guard.
 *
 * When `CLEO_USE_RUST=1` and the native binary is present this wraps the Rust
 * `RateLimitGuard` napi class; otherwise provides a pure-JS token-bucket
 * implementation with an identical interface.
 */
class RateLimitGuard {
  /**
   * @param {number} capacity - Maximum token bucket size.
   * @param {number} refillRatePerSecond - Tokens added per second.
   */
  constructor(capacity, refillRatePerSecond) {
    if (native !== null && process.env.CLEO_USE_RUST === '1') {
      this._impl = new native.RateLimitGuard(capacity, refillRatePerSecond);
      this._isNative = true;
    } else {
      this._impl = new JsRateLimitGuard(capacity, refillRatePerSecond);
      this._isNative = false;
    }
  }

  /** @param {number} tokens @returns {boolean} */
  acquire(tokens) {
    return this._impl.acquire(tokens);
  }

  /** @returns {number} */
  peekAvailable() {
    return this._impl.peekAvailable();
  }

  /** @returns {number} */
  capacity() {
    return this._impl.capacity();
  }

  /** @returns {number} */
  refillRatePerSecond() {
    return this._impl.refillRatePerSecond();
  }

  reset() {
    return this._impl.reset();
  }

  /** @param {number} tokens @returns {number} */
  msUntilAvailable(tokens) {
    return this._impl.msUntilAvailable(tokens);
  }
}

// Pure-JS token-bucket (fallback when native binary is absent).
class JsRateLimitGuard {
  constructor(capacity, refillRatePerSecond) {
    this._capacity = capacity;
    this._refillRate = refillRatePerSecond / 1000; // tokens per ms
    this._available = capacity;
    this._lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this._lastRefill;
    if (elapsed > 0) {
      this._available = Math.min(
        this._capacity,
        this._available + elapsed * this._refillRate,
      );
      this._lastRefill = now;
    }
  }

  acquire(tokens) {
    this._refill();
    if (this._available >= tokens) {
      this._available -= tokens;
      return true;
    }
    return false;
  }

  peekAvailable() {
    this._refill();
    return this._available;
  }

  capacity() {
    return this._capacity;
  }

  refillRatePerSecond() {
    return this._refillRate * 1000;
  }

  reset() {
    this._available = this._capacity;
    this._lastRefill = Date.now();
  }

  msUntilAvailable(tokens) {
    this._refill();
    if (this._available >= tokens) return 0;
    const deficit = tokens - this._available;
    if (this._refillRate <= 0) return Infinity;
    return deficit / this._refillRate;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  thinkScrub,
  ThinkScrubber,
  RateLimitGuard,
  /** True when the native binary was successfully loaded. */
  nativeLoaded: native !== null,
};

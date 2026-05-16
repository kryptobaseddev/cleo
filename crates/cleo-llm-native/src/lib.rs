#![allow(unsafe_code)] // napi-rs FFI macros generate unsafe blocks internally
//! napi-rs bindings for CLEO LLM hot-path operations.
//!
//! Provides two opt-in Rust accelerators for the CLEO LLM pipeline:
//!
//! - **Think-scrubber** (`think_scrub`, `ThinkScrubber`): strips
//!   `<think>…</think>` (and sibling) reasoning blocks from streaming LLM
//!   output using a state-machine that correctly handles tags split across
//!   chunk boundaries.
//!
//! - **Rate-limit guard** (`RateLimitGuard`): an in-process token-bucket that
//!   enforces per-provider request rate limits without file I/O.  Complementary
//!   to the cross-session file-based guard in `rate-limit-guard.ts`.
//!
//! Both are gated behind `process.env.CLEO_USE_RUST=1` in the JS layer.
//! The JS fallback exports the same surface so callers are never broken when
//! the native binary is absent.

use napi_derive::napi;

// ─────────────────────────────────────────────────────────────────────────────
// Think-scrubber
// ─────────────────────────────────────────────────────────────────────────────

/// Recognised opening tags, lowercase.
const OPEN_TAGS: &[&str] = &[
    "<think>",
    "<thinking>",
    "<reasoning>",
    "<thought>",
    "<reasoning_scratchpad>",
];

/// Recognised closing tags, lowercase. Index-matched to `OPEN_TAGS`.
const CLOSE_TAGS: &[&str] = &[
    "</think>",
    "</thinking>",
    "</reasoning>",
    "</thought>",
    "</reasoning_scratchpad>",
];

/// Pre-computed maximum tag length (for partial-suffix hold-back).
fn max_tag_len() -> usize {
    OPEN_TAGS
        .iter()
        .chain(CLOSE_TAGS.iter())
        .map(|t| t.len())
        .max()
        .unwrap_or(0)
}

/// Return `(index, len)` of the first case-insensitive match of any tag in
/// `tags` within `buf`, or `(usize::MAX, 0)` if none found.
fn find_first_tag(buf: &str, tags: &[&str]) -> (usize, usize) {
    let lower = buf.to_lowercase();
    let mut best_idx = usize::MAX;
    let mut best_len = 0usize;
    for &tag in tags {
        if let Some(idx) = lower.find(tag) {
            if idx < best_idx {
                best_idx = idx;
                best_len = tag.len();
            }
        }
    }
    (best_idx, best_len)
}

/// Return the length of the longest suffix of `buf` that is a strict prefix
/// (shorter than the full tag) of any entry in `tags`. Case-insensitive.
fn max_partial_suffix(buf: &str, tags: &[&str]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    let lower = buf.to_lowercase();
    let max_check = lower.len().min(max_tag_len().saturating_sub(1));
    for i in (1..=max_check).rev() {
        let suffix = &lower[lower.len() - i..];
        for &tag in tags {
            if tag.len() > i && tag.starts_with(suffix) {
                return i;
            }
        }
    }
    0
}

/// Return `(start, end)` of the earliest complete closed pair in `buf`, or
/// `None` if none found. Case-insensitive.
fn find_earliest_closed_pair(buf: &str) -> Option<(usize, usize)> {
    let lower = buf.to_lowercase();
    let mut best: Option<(usize, usize)> = None;
    for i in 0..OPEN_TAGS.len() {
        let open = OPEN_TAGS[i];
        let close = CLOSE_TAGS[i];
        let Some(open_idx) = lower.find(open) else {
            continue;
        };
        let search_from = open_idx + open.len();
        let Some(close_rel) = lower[search_from..].find(close) else {
            continue;
        };
        let close_idx = search_from + close_rel;
        let end_idx = close_idx + close.len();
        match best {
            None => best = Some((open_idx, end_idx)),
            Some((b, _)) if open_idx < b => best = Some((open_idx, end_idx)),
            _ => {}
        }
    }
    best
}

/// Remove orphan close tags (close with no matching open) from `text`.
fn strip_orphan_close_tags(text: &str) -> String {
    if !text.contains("</") {
        return text.to_string();
    }
    let lower = text.to_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < text.len() {
        if lower.as_bytes().get(i) == Some(&b'<') && lower.as_bytes().get(i + 1) == Some(&b'/') {
            let mut matched = false;
            for &tag in CLOSE_TAGS {
                if lower[i..].starts_with(tag) {
                    let mut j = i + tag.len();
                    while j < text.len() && matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r') {
                        j += 1;
                    }
                    i = j;
                    matched = true;
                    break;
                }
            }
            if !matched {
                if let Some(ch) = text[i..].chars().next() {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        } else if let Some(ch) = text[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

/// Check whether `idx` in `buf` is a block boundary given the last-emitted
/// state. Mirrors the JS `isBlockBoundary` logic.
fn is_block_boundary(
    buf: &str,
    idx: usize,
    last_emitted_ended_newline: bool,
    already_emitted: &[String],
) -> bool {
    if idx == 0 {
        if let Some(last) = already_emitted.last() {
            return last.ends_with('\n');
        }
        return last_emitted_ended_newline;
    }
    let preceding = &buf[..idx];
    let lower_pre = preceding.to_lowercase();
    match lower_pre.rfind('\n') {
        None => {
            let prior_newline = already_emitted
                .last()
                .map(|s| s.ends_with('\n'))
                .unwrap_or(last_emitted_ended_newline);
            prior_newline && preceding.trim().is_empty()
        }
        Some(nl_pos) => preceding[nl_pos + 1..].trim().is_empty(),
    }
}

/// Find the earliest open tag at a block boundary. Returns `(idx, len)` or
/// `(usize::MAX, 0)`.
fn find_open_at_boundary(
    buf: &str,
    last_emitted_ended_newline: bool,
    already_emitted: &[String],
) -> (usize, usize) {
    let lower = buf.to_lowercase();
    let mut best_idx = usize::MAX;
    let mut best_len = 0usize;
    for &tag in OPEN_TAGS {
        let mut search_start = 0usize;
        while let Some(rel) = lower[search_start..].find(tag) {
            let idx = search_start + rel;
            if is_block_boundary(buf, idx, last_emitted_ended_newline, already_emitted) {
                if idx < best_idx {
                    best_idx = idx;
                    best_len = tag.len();
                }
                break;
            }
            search_start = idx + 1;
        }
    }
    (best_idx, best_len)
}

/// Stateful streaming reasoning-block scrubber (Rust implementation).
///
/// Mirrors `StreamingThinkScrubber` from `packages/core/src/llm/think-scrubber.ts`.
/// Holds a buffer across `feed()` calls so partial tags at delta boundaries do
/// not leak reasoning content to the consumer.
///
/// # Example (JS)
///
/// ```js
/// const s = new ThinkScrubber();
/// for (const chunk of stream) {
///   const visible = s.feed(chunk);
///   if (visible) emit(visible);
/// }
/// const tail = s.flush();
/// if (tail) emit(tail);
/// ```
#[napi]
pub struct ThinkScrubber {
    buf: String,
    in_block: bool,
    last_emitted_ended_newline: bool,
}

impl Default for ThinkScrubber {
    fn default() -> Self {
        ThinkScrubber {
            buf: String::new(),
            in_block: false,
            last_emitted_ended_newline: true,
        }
    }
}

#[napi]
impl ThinkScrubber {
    /// Create a new `ThinkScrubber`.
    #[napi(constructor)]
    pub fn new() -> Self {
        ThinkScrubber::default()
    }

    /// Feed one delta chunk. Returns the visible portion with reasoning blocks stripped.
    ///
    /// May return an empty string when the entire delta is reasoning content or is
    /// held back pending resolution of a partial tag at the chunk boundary.
    ///
    /// # Panics
    ///
    /// Does not panic under normal operation. Slice indices are always derived
    /// from tag search results that are guaranteed to fall on valid UTF-8
    /// character boundaries.
    #[napi]
    pub fn feed(&mut self, text: String) -> String {
        if text.is_empty() {
            return String::new();
        }

        let mut buf = std::mem::take(&mut self.buf) + &text;
        let mut out: Vec<String> = Vec::new();

        loop {
            if buf.is_empty() {
                break;
            }

            if self.in_block {
                let (close_idx, close_len) = find_first_tag(&buf, CLOSE_TAGS);
                if close_idx == usize::MAX {
                    let held = max_partial_suffix(&buf, CLOSE_TAGS);
                    self.buf = if held > 0 {
                        buf[buf.len() - held..].to_string()
                    } else {
                        String::new()
                    };
                    return out.join("");
                }
                buf = buf[close_idx + close_len..].to_string();
                self.in_block = false;
                continue;
            }

            let pair = find_earliest_closed_pair(&buf);
            let (open_idx, open_len) =
                find_open_at_boundary(&buf, self.last_emitted_ended_newline, &out);

            if let Some((pair_start, pair_end)) = pair {
                if open_idx == usize::MAX || pair_start <= open_idx {
                    if pair_start > 0 {
                        let preceding = strip_orphan_close_tags(&buf[..pair_start]);
                        if !preceding.is_empty() {
                            self.last_emitted_ended_newline = preceding.ends_with('\n');
                            out.push(preceding);
                        }
                    }
                    buf = buf[pair_end..].to_string();
                    continue;
                }
            }

            if open_idx != usize::MAX {
                if open_idx > 0 {
                    let preceding = strip_orphan_close_tags(&buf[..open_idx]);
                    if !preceding.is_empty() {
                        self.last_emitted_ended_newline = preceding.ends_with('\n');
                        out.push(preceding);
                    }
                }
                self.in_block = true;
                buf = buf[open_idx + open_len..].to_string();
                continue;
            }

            // No resolvable tag — hold back partial-tag suffix and emit rest.
            let held_open = max_partial_suffix(&buf, OPEN_TAGS);
            let held_close = max_partial_suffix(&buf, CLOSE_TAGS);
            let held = held_open.max(held_close);

            let emit_text = if held > 0 {
                buf[..buf.len() - held].to_string()
            } else {
                buf.clone()
            };
            self.buf = if held > 0 {
                buf[buf.len() - held..].to_string()
            } else {
                String::new()
            };

            if !emit_text.is_empty() {
                let clean = strip_orphan_close_tags(&emit_text);
                if !clean.is_empty() {
                    self.last_emitted_ended_newline = clean.ends_with('\n');
                    out.push(clean);
                }
            }
            return out.join("");
        }

        out.join("")
    }

    /// Flush any remaining buffered text. Call at end-of-stream.
    ///
    /// If still inside an unterminated reasoning block, the held-back content is
    /// discarded. Otherwise the partial-tag tail is emitted verbatim.
    #[napi]
    pub fn flush(&mut self) -> String {
        if self.in_block {
            self.buf.clear();
            self.in_block = false;
            return String::new();
        }
        let tail = std::mem::take(&mut self.buf);
        if tail.is_empty() {
            return String::new();
        }
        let clean = strip_orphan_close_tags(&tail);
        if !clean.is_empty() {
            self.last_emitted_ended_newline = clean.ends_with('\n');
        }
        clean
    }

    /// Reset all internal state. Call at the start of every new turn.
    #[napi]
    pub fn reset(&mut self) {
        self.buf.clear();
        self.in_block = false;
        self.last_emitted_ended_newline = true;
    }
}

/// Scrub all reasoning blocks from a complete (non-streaming) string.
///
/// Convenience wrapper around `ThinkScrubber` for callers that already have
/// the full response text.
///
/// # Arguments
///
/// * `input` - Complete response text, potentially containing reasoning blocks.
#[napi]
pub fn think_scrub(input: String) -> String {
    let mut s = ThinkScrubber::new();
    let part = s.feed(input);
    let tail = s.flush();
    if tail.is_empty() { part } else { part + &tail }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit guard (in-process token bucket)
// ─────────────────────────────────────────────────────────────────────────────

/// In-process token-bucket rate-limit guard.
///
/// Provides a fast, synchronous rate-limit check complementary to the
/// cross-session file-based guard in `rate-limit-guard.ts`. Useful for
/// per-request pre-flight checks inside a single process.
///
/// Tokens refill continuously at `refill_rate` tokens per second up to
/// `capacity`. Each `acquire(tokens)` call checks availability and, if
/// sufficient, consumes the tokens atomically.
///
/// # Example (JS)
///
/// ```js
/// const guard = new RateLimitGuard(100, 10); // 100 cap, 10 tok/s
/// if (guard.acquire(1)) {
///   // proceed with request
/// } else {
///   // rate-limited — back off
/// }
/// ```
#[napi]
pub struct RateLimitGuard {
    capacity: f64,
    refill_rate: f64, // tokens per millisecond
    available: f64,
    last_refill_ms: f64,
}

#[napi]
impl RateLimitGuard {
    /// Create a new `RateLimitGuard`.
    ///
    /// # Arguments
    ///
    /// * `capacity` - Maximum token bucket size.
    /// * `refill_rate_per_second` - Tokens added per second (continuous refill).
    #[napi(constructor)]
    pub fn new(capacity: f64, refill_rate_per_second: f64) -> Self {
        let now_ms = now_ms();
        RateLimitGuard {
            capacity,
            refill_rate: refill_rate_per_second / 1000.0,
            available: capacity,
            last_refill_ms: now_ms,
        }
    }

    /// Refill the bucket based on elapsed time since last refill.
    fn refill(&mut self) {
        let now = now_ms();
        let elapsed = now - self.last_refill_ms;
        if elapsed > 0.0 {
            self.available = (self.available + elapsed * self.refill_rate).min(self.capacity);
            self.last_refill_ms = now;
        }
    }

    /// Try to acquire `tokens` from the bucket. Returns `true` if the tokens
    /// were available and consumed; `false` if the bucket is insufficient.
    ///
    /// # Arguments
    ///
    /// * `tokens` - Number of tokens to consume.
    #[napi]
    pub fn acquire(&mut self, tokens: f64) -> bool {
        self.refill();
        if self.available >= tokens {
            self.available -= tokens;
            true
        } else {
            false
        }
    }

    /// Return the number of currently available tokens (after refill).
    #[napi]
    pub fn peek_available(&mut self) -> f64 {
        self.refill();
        self.available
    }

    /// Return the bucket capacity.
    #[napi]
    pub fn capacity(&self) -> f64 {
        self.capacity
    }

    /// Return the refill rate in tokens per second.
    #[napi]
    pub fn refill_rate_per_second(&self) -> f64 {
        self.refill_rate * 1000.0
    }

    /// Reset the bucket to full capacity.
    #[napi]
    pub fn reset(&mut self) {
        self.available = self.capacity;
        self.last_refill_ms = now_ms();
    }

    /// Return milliseconds until `tokens` are available, or `0` if already
    /// available.
    ///
    /// # Arguments
    ///
    /// * `tokens` - Number of tokens needed.
    #[napi]
    pub fn ms_until_available(&mut self, tokens: f64) -> f64 {
        self.refill();
        if self.available >= tokens {
            return 0.0;
        }
        let deficit = tokens - self.available;
        if self.refill_rate <= 0.0 {
            return f64::MAX;
        }
        deficit / self.refill_rate
    }
}

/// Current time in milliseconds since epoch (using `std::time::SystemTime`).
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

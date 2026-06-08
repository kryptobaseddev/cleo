/**
 * Web + browser agent-tool I/O contracts (T1742 · epic T11456 · SG-TOOLS).
 *
 * The shared, types-only I/O shapes for the `web` toolset surfaced through the
 * `AgentToolRegistry` (`packages/core/src/tools/agent-registry.ts`), on top of
 * the terminal/file/search/git families ({@link ./agent-tools.js}):
 *
 *   - **web_search** — pluggable, backend-agnostic web search
 *     ({@link WebSearchInput} / {@link WebSearchResult}). NO hard paid-API dep:
 *     a backend is resolved at call time and the tool degrades gracefully to an
 *     `unavailable` result when none is configured.
 *   - **web_extract** — fetch a URL and convert its HTML body to markdown
 *     ({@link WebExtractInput} / {@link WebExtractResult}).
 *   - **browser_*** — Playwright-driven browser automation
 *     ({@link BrowserNavigateInput} … {@link BrowserVisionResult}). Playwright is
 *     an OPTIONAL, lazily-loaded dependency — these tools' `available()` predicate
 *     returns `false` (with an install hint) when it is absent.
 *
 * The web tools compose over the `net` side-effect surface; the browser tools
 * over a Playwright-managed `shell`-class process. Like every agent tool, their
 * executables perform side effects through the injected `GuardedToolSurface` (or,
 * for the AI call in {@link BrowserVisionResult}, through the E9
 * `resolveLLMForSystem` chokepoint) — never a raw provider/network bypass.
 * Types-only — no runtime logic (Gate 10 `contracts-purity`).
 *
 * @epic T11456
 * @task T1742
 * @see ./agent-tools.js — the terminal/file/search/git family I/O shapes
 */

// ---------------------------------------------------------------------------
// web_search — pluggable, backend-agnostic
// ---------------------------------------------------------------------------

/**
 * Identifier of a {@link WebSearchInput} backend.
 *
 * - `duckduckgo` — DuckDuckGo's keyless HTML endpoint (no API key required).
 * - `searxng` — a self-hosted / public SearXNG JSON instance (URL via config/env).
 * - `auto` — try each configured backend in priority order, first success wins.
 *
 * NONE require a paid API key; the set is open by design so a deployment can
 * register its own backend. The string union here is the canonical builtin set.
 */
export type WebSearchBackendId = 'duckduckgo' | 'searxng' | 'auto';

/** Input for the `web_search` tool. */
export interface WebSearchInput {
  /** Free-text search query. */
  readonly query: string;
  /** Maximum number of results to return. Defaults to 10. */
  readonly maxResults?: number;
  /**
   * Preferred backend. Defaults to `auto` — the first configured/reachable
   * backend answers. An explicit id pins a single backend.
   */
  readonly backend?: WebSearchBackendId;
}

/** A single web-search hit. */
export interface WebSearchHit {
  /** Result title. */
  readonly title: string;
  /** Absolute result URL. */
  readonly url: string;
  /** Snippet / description (may be empty). */
  readonly snippet: string;
}

/** Result of `web_search`. */
export interface WebSearchResult {
  /** The originating query (echoed for traceability). */
  readonly query: string;
  /** Hits in backend-ranked order (empty when none / unavailable). */
  readonly results: readonly WebSearchHit[];
  /** The backend that actually answered, or `null` when none was available. */
  readonly backend: WebSearchBackendId | null;
  /**
   * `true` when NO backend could answer (none configured, network egress
   * denied, or every backend failed). Callers MUST treat this as a soft
   * "no search capability" signal — it is NOT an error.
   */
  readonly unavailable: boolean;
  /** Human-readable reason when {@link WebSearchResult.unavailable} is `true`. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// web_extract — URL → markdown
// ---------------------------------------------------------------------------

/** Input for the `web_extract` tool. */
export interface WebExtractInput {
  /** Absolute URL to fetch and convert. */
  readonly url: string;
  /** Hard timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number;
  /**
   * Cap on the markdown length (characters). Output beyond this is truncated
   * and {@link WebExtractResult.truncated} set. Defaults to 100000.
   */
  readonly maxChars?: number;
}

/** Result of `web_extract`. */
export interface WebExtractResult {
  /** The fetched URL. */
  readonly url: string;
  /** HTTP status code of the fetch. */
  readonly status: number;
  /** Document `<title>`, when present. */
  readonly title: string;
  /** The page body converted to markdown. */
  readonly markdown: string;
  /** Whether {@link WebExtractInput.maxChars} truncated the markdown. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// browser_* — Playwright-driven automation
// ---------------------------------------------------------------------------

/** Input for `browser_navigate`. */
export interface BrowserNavigateInput {
  /** Absolute URL to navigate the browser to. */
  readonly url: string;
  /**
   * When to consider navigation complete. Defaults to `load`.
   * Mirrors Playwright's `waitUntil` states.
   */
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Per-navigation timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number;
}

/** Result common to navigation / interaction browser tools. */
export interface BrowserPageState {
  /** The page's current URL after the operation. */
  readonly url: string;
  /** The page's `document.title` after the operation. */
  readonly title: string;
}

/** Input for `browser_click`. */
export interface BrowserClickInput {
  /** A CSS / Playwright selector for the element to click. */
  readonly selector: string;
  /** Per-action timeout in milliseconds. Defaults to 15000. */
  readonly timeoutMs?: number;
}

/** Input for `browser_type`. */
export interface BrowserTypeInput {
  /** A CSS / Playwright selector for the input element. */
  readonly selector: string;
  /** The text to type into the element. */
  readonly text: string;
  /** Clear the field before typing. Defaults to `true`. */
  readonly clear?: boolean;
  /** Per-action timeout in milliseconds. Defaults to 15000. */
  readonly timeoutMs?: number;
}

/** Input for `browser_press` (a single key / chord). */
export interface BrowserPressInput {
  /**
   * The key (or `Modifier+Key` chord) to press, in Playwright key syntax
   * (e.g. `Enter`, `Tab`, `Control+A`, `ArrowDown`).
   */
  readonly key: string;
  /** Optional selector to focus before pressing. */
  readonly selector?: string;
  /** Per-action timeout in milliseconds. Defaults to 15000. */
  readonly timeoutMs?: number;
}

/** Result of a `browser_click` / `browser_type` / `browser_press` action. */
export interface BrowserActionResult extends BrowserPageState {
  /** The action that was performed. */
  readonly action: 'click' | 'type' | 'press';
}

/** A single node in the {@link BrowserSnapshotResult} accessibility tree. */
export interface AccessibilityNode {
  /** ARIA role (e.g. `button`, `link`, `textbox`). */
  readonly role: string;
  /** Accessible name, when present. */
  readonly name?: string;
  /** Current value (form controls). */
  readonly value?: string;
  /** Child nodes (depth-first). */
  readonly children?: readonly AccessibilityNode[];
}

/** Result of `browser_snapshot` — the page accessibility tree. */
export interface BrowserSnapshotResult extends BrowserPageState {
  /** The root of the accessibility tree, or `null` when none is available. */
  readonly tree: AccessibilityNode | null;
}

/** Scroll direction for `browser_scroll`. */
export type BrowserScrollDirection = 'up' | 'down';

/** Input for `browser_scroll`. */
export interface BrowserScrollInput {
  /** Direction to scroll. */
  readonly direction: BrowserScrollDirection;
  /**
   * Pixels to scroll by. Defaults to roughly one viewport height (800px).
   */
  readonly amountPx?: number;
}

/** Result of `browser_scroll`. */
export interface BrowserScrollResult extends BrowserPageState {
  /** The direction that was scrolled. */
  readonly direction: BrowserScrollDirection;
  /** The vertical scroll position (pixels from top) after scrolling. */
  readonly scrollY: number;
}

/** Input for `browser_vision` (screenshot + AI analysis). */
export interface BrowserVisionInput {
  /**
   * The question / instruction the vision model should answer about the current
   * page screenshot (e.g. "What is the primary call-to-action on this page?").
   */
  readonly prompt: string;
  /** Capture the full scrollable page rather than just the viewport. Defaults to `false`. */
  readonly fullPage?: boolean;
}

/** Result of `browser_vision`. */
export interface BrowserVisionResult extends BrowserPageState {
  /**
   * The vision model's textual analysis of the screenshot, or `null` when no
   * LLM credential was reachable (graceful degradation — NOT an error).
   */
  readonly analysis: string | null;
  /** The model id that produced {@link BrowserVisionResult.analysis}, when available. */
  readonly model?: string;
  /**
   * `true` when the AI call was skipped because no LLM credential resolved
   * through the E9 chokepoint. The screenshot was still captured.
   */
  readonly aiUnavailable: boolean;
}

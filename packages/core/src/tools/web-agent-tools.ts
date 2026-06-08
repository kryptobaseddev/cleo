/**
 * Web + browser agent-tool FAMILY — registration (T1742 · epic T11456 · SG-TOOLS).
 *
 * Registers the `web` toolset into the {@link ./agent-registry.js |
 * AgentToolRegistry}, on top of the terminal/file/search/git families
 * ({@link ./agent-tool-families.js}):
 *
 *   - **AC1** `web_search` — pluggable, backend-agnostic search
 *     ({@link ./web-search-backends.js}); graceful `unavailable` result when no
 *     backend can answer. NO hard paid-API dependency.
 *   - **AC2** `web_extract` — fetch a URL + convert HTML to markdown.
 *   - **AC3** `browser_navigate` — Playwright (lazily, optionally loaded).
 *   - **AC4** `browser_click` / `browser_type` / `browser_press`.
 *   - **AC5** `browser_snapshot` — accessibility tree.
 *   - **AC6** `browser_vision` — screenshot + AI analysis routed THROUGH the E9
 *     `resolveLLMForSystem` chokepoint + sealed-credential handle (never a raw
 *     provider call).
 *   - **AC7** `browser_scroll` up / down.
 *   - **AC8** all registered; the browser tools' `available()` returns `false`
 *     (with an install hint) when Playwright is absent.
 *
 * Browser tools share ONE lazily-launched {@link BrowserSession} per registration
 * (a closure cell), so the optional Playwright load happens at most once per run.
 * The web tools' network egress flows through an injectable {@link HttpFetch}; the
 * vision AI call flows through the single E9 chokepoint — neither bypasses the
 * resolver / credential layer. Import-time side-effect-free (NO top-level
 * playwright import).
 *
 * @epic T11456
 * @task T1742
 * @see ./browser-driver.js — the optional-Playwright lazy-load backend
 * @see ./web-search-backends.js — the pluggable search backends + HTML→markdown
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import type {
  BrowserVisionResult,
  WebSearchBackendId,
  WebSearchInput,
  WebSearchResult,
} from '@cleocode/contracts/tools/web-tools';
import { z } from 'zod';
import { getLogger } from '../logger.js';
import type { AgentToolRegistry, AvailabilityCheck } from './agent-registry.js';
import { BrowserSession, PLAYWRIGHT_INSTALL_HINT } from './browser-driver.js';
import {
  defaultHttpFetch,
  fetchAndExtract,
  type HttpFetch,
  resolveSearchBackends,
  runSearch,
} from './web-search-backends.js';

const log = getLogger('tool-web-agent');

/**
 * Available only when outbound network egress is permitted. When the context
 * does not declare egress (`networkEgressAllowed === undefined`) the tool is
 * permitted — the registry default is permissive; a context that explicitly sets
 * `false` hides it (AC5/availability).
 */
const networkAvailable: AvailabilityCheck = (ctx) => ctx.networkEgressAllowed !== false;

/**
 * Available only when the optional Playwright capability is present in the
 * context. The browser tools are ALWAYS registered (AC8), but report unavailable
 * — surfacing {@link PLAYWRIGHT_INSTALL_HINT} in their description — until a
 * context advertises `capabilities.playwright === true`. The registration helper
 * probes Playwright once and stamps that flag, so an absent optional dep simply
 * leaves the browser tools hidden rather than crashing.
 */
const playwrightAvailable: AvailabilityCheck = (ctx) =>
  ctx.capabilities?.playwright === true && ctx.networkEgressAllowed !== false;

/**
 * Options for {@link registerWebAgentTools} — all injectable so tests run with
 * NO real network and NO real browser launch (AC9).
 */
export interface WebAgentToolOptions {
  /** Injected HTTP fetch (defaults to the platform `fetch`). */
  readonly http?: HttpFetch;
  /** Injected browser session (defaults to a real lazy-Playwright session). */
  readonly browser?: BrowserSession;
  /**
   * SearXNG instance URL for the `searxng` backend. When omitted, the SearXNG
   * backend reports unconfigured and only DuckDuckGo answers — preserving the
   * "graceful when unconfigured" contract (AC1). Read from `SEARXNG_URL` env when
   * not supplied.
   */
  readonly searxngUrl?: string;
  /**
   * Project root threaded into the E9 `resolveLLMForSystem` chokepoint for
   * `browser_vision` (defaults to the resolver's own `process.cwd()` fallback).
   */
  readonly projectRoot?: string;
}

/**
 * Run the `browser_vision` AI analysis: capture a screenshot, then resolve an
 * LLM through the SINGLE E9 chokepoint (`resolveLLMForSystem`) and send the
 * screenshot as a multimodal user turn. The plaintext credential is materialized
 * from the sealed handle ONLY at the wire (inside `ModelRunner.build`), never
 * surfaced up the stack — and there is NO raw provider/transport construction
 * here (Gate-13). Returns `aiUnavailable: true` (with the screenshot still
 * captured) when no credential resolves — graceful degradation, not an error.
 *
 * @param browser - The shared browser session.
 * @param prompt - The analysis instruction.
 * @param fullPage - Capture the full page rather than the viewport.
 * @param projectRoot - Project root for the resolver.
 * @returns The {@link BrowserVisionResult}.
 */
async function runBrowserVision(
  browser: BrowserSession,
  prompt: string,
  fullPage: boolean,
  projectRoot: string | undefined,
): Promise<BrowserVisionResult> {
  const shot = await browser.screenshot(fullPage);
  const base = { url: shot.url, title: shot.title };

  // E9 resolution chokepoint — the ONLY route to an LLM credential. Never throws.
  const { resolveLLMForSystem } = await import('../llm/system-resolver.js');
  const resolved = await resolveLLMForSystem('task-executor', {
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  });
  if (!resolved.sealedCredential) {
    // No credential reachable — return the screenshot-only result (graceful).
    return { ...base, analysis: null, aiUnavailable: true };
  }

  try {
    // Build the wire surfaces via the single SSoT ModelRunner (Gate-13: no raw
    // transport / provider construction at this call-site). The descriptor's
    // token is materialized from the sealed handle inside ModelRunner only.
    const { ModelRunner } = await import('../llm/model-runner.js');
    const apiKey = (await resolved.sealedCredential.fetch()).value;
    const built = await ModelRunner.build({
      provider: resolved.provider,
      model: resolved.model,
      credential: resolved.credential
        ? {
            provider: resolved.credential.provider,
            apiKey,
            source: resolved.credential.source,
            authType: resolved.credential.authType,
          }
        : null,
      source: resolved.source,
      ...(resolved.credentialLabel !== undefined
        ? { credentialLabel: resolved.credentialLabel }
        : {}),
      apiMode: resolved.apiMode,
      baseUrl: resolved.baseUrl,
      authType: resolved.authType,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    });

    // A single multimodal user turn: the instruction text + the screenshot as a
    // native image block (transports that cannot do images degrade per imageMode).
    const messages: TransportMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: { type: 'base64', data: shot.base64Png, mediaType: 'image/png' },
          },
        ],
      },
    ];
    const response = await built.session.send(messages);
    return {
      ...base,
      analysis: response.content,
      model: resolved.model,
      aiUnavailable: false,
    };
  } catch (err) {
    log.warn({ err }, 'browser_vision: AI analysis failed — returning screenshot-only result');
    return { ...base, analysis: null, model: resolved.model, aiUnavailable: true };
  }
}

/**
 * Register the web + browser agent-tool family into `registry`. Pure
 * registration — no network, no browser launch, no scan; side effects happen
 * later through the injected {@link HttpFetch} / {@link BrowserSession}.
 *
 * The browser tools are registered with a `playwright`-gated availability
 * predicate (AC8): present in the registry but hidden by `available()` until a
 * context advertises the optional Playwright capability.
 *
 * @param registry - The registry to populate.
 * @param options - Injectable backends (HTTP fetch, browser session, searxng URL).
 */
export function registerWebAgentTools(
  registry: AgentToolRegistry,
  options: WebAgentToolOptions = {},
): void {
  const http: HttpFetch = options.http ?? defaultHttpFetch;
  // ONE browser session shared by every browser tool in this registration — the
  // optional Playwright load happens at most once. Constructing it is free (no
  // import until the first navigation).
  const browser = options.browser ?? new BrowserSession();
  const searxngUrl = options.searxngUrl ?? process.env.SEARXNG_URL;
  const projectRoot = options.projectRoot;

  // --- AC1: web_search (pluggable backends, graceful when unconfigured) ----
  registry.register({
    name: 'web_search',
    class: 'net',
    description:
      'Search the web via a pluggable backend (DuckDuckGo / SearXNG — no API key required). ' +
      'Returns ranked results, or an `unavailable` result when no backend can answer.',
    toolset: 'web',
    stateless: true,
    available: networkAvailable,
    parameters: z.object({
      query: z.string().describe('Free-text search query.'),
      maxResults: z.number().int().positive().optional().describe('Max results (default 10).'),
      backend: z
        .enum(['duckduckgo', 'searxng', 'auto'])
        .optional()
        .describe("Preferred backend: 'duckduckgo', 'searxng', or 'auto' (default)."),
    }),
    execute: async (rawArgs): Promise<WebSearchResult> => {
      const backend: WebSearchBackendId | undefined =
        rawArgs.backend === 'duckduckgo' ||
        rawArgs.backend === 'searxng' ||
        rawArgs.backend === 'auto'
          ? rawArgs.backend
          : undefined;
      const input: WebSearchInput = {
        query: String(rawArgs.query),
        maxResults: typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : undefined,
        backend,
      };
      const backends = resolveSearchBackends(input, searxngUrl);
      if (backends.length === 0) {
        return {
          query: input.query,
          results: [],
          backend: null,
          unavailable: true,
          reason: 'no configured web-search backend',
        };
      }
      const outcome = await runSearch(input, backends, http);
      if (outcome === null) {
        return {
          query: input.query,
          results: [],
          backend: null,
          unavailable: true,
          reason: 'every web-search backend failed',
        };
      }
      return {
        query: input.query,
        results: outcome.results,
        backend: outcome.backend,
        unavailable: false,
      };
    },
  });

  // --- AC2: web_extract (URL → markdown) ----------------------------------
  registry.register({
    name: 'web_extract',
    class: 'net',
    description: 'Fetch a URL and convert its HTML content to markdown.',
    toolset: 'web',
    stateless: true,
    available: networkAvailable,
    parameters: z.object({
      url: z.string().describe('Absolute URL to fetch and convert.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Fetch timeout in ms (default 30000).'),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on markdown length in characters (default 100000).'),
    }),
    execute: async (rawArgs) => {
      const url = String(rawArgs.url);
      return fetchAndExtract(url, http, {
        timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
        maxChars: typeof rawArgs.maxChars === 'number' ? rawArgs.maxChars : undefined,
      });
    },
  });

  // --- AC3: browser_navigate ----------------------------------------------
  registry.register({
    name: 'browser_navigate',
    class: 'shell',
    description: `Navigate a headless browser to a URL (Playwright). ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      url: z.string().describe('Absolute URL to navigate to.'),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle'])
        .optional()
        .describe("When navigation is complete (default 'load')."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Navigation timeout in ms (default 30000).'),
    }),
    execute: async (rawArgs) =>
      browser.navigate({
        url: String(rawArgs.url),
        waitUntil:
          rawArgs.waitUntil === 'load' ||
          rawArgs.waitUntil === 'domcontentloaded' ||
          rawArgs.waitUntil === 'networkidle'
            ? rawArgs.waitUntil
            : undefined,
        timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      }),
  });

  // --- AC4: browser_click / browser_type / browser_press ------------------
  registry.register({
    name: 'browser_click',
    class: 'shell',
    description: `Click an element by selector in the browser. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      selector: z.string().describe('CSS / Playwright selector for the element to click.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Action timeout in ms (default 15000).'),
    }),
    execute: async (rawArgs) => {
      const state = await browser.click(
        String(rawArgs.selector),
        typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      );
      return { ...state, action: 'click' as const };
    },
  });

  registry.register({
    name: 'browser_type',
    class: 'shell',
    description: `Type text into an input element by selector. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      selector: z.string().describe('CSS / Playwright selector for the input element.'),
      text: z.string().describe('Text to type into the element.'),
      clear: z.boolean().optional().describe('Clear the field before typing (default true).'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Action timeout in ms (default 15000).'),
    }),
    execute: async (rawArgs) => {
      const state = await browser.type(
        String(rawArgs.selector),
        String(rawArgs.text),
        typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      );
      return { ...state, action: 'type' as const };
    },
  });

  registry.register({
    name: 'browser_press',
    class: 'shell',
    description: `Press a key or chord (e.g. Enter, Control+A) in the browser. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      key: z.string().describe('Key or chord in Playwright syntax (e.g. Enter, Control+A).'),
      selector: z.string().optional().describe('Optional selector to focus before pressing.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Focus timeout in ms (default 15000).'),
    }),
    execute: async (rawArgs) => {
      const state = await browser.press(
        String(rawArgs.key),
        rawArgs.selector === undefined ? undefined : String(rawArgs.selector),
        typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      );
      return { ...state, action: 'press' as const };
    },
  });

  // --- AC5: browser_snapshot (accessibility tree) -------------------------
  registry.register({
    name: 'browser_snapshot',
    class: 'shell',
    description: `Capture the page's accessibility tree. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({}),
    execute: async () => browser.snapshot(),
  });

  // --- AC7: browser_scroll (up / down) ------------------------------------
  registry.register({
    name: 'browser_scroll',
    class: 'shell',
    description: `Scroll the page up or down. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      direction: z.enum(['up', 'down']).describe('Scroll direction.'),
      amountPx: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Pixels to scroll (default ~one viewport).'),
    }),
    execute: async (rawArgs) => {
      const direction = rawArgs.direction === 'up' ? 'up' : 'down';
      const state = await browser.scroll(
        direction,
        typeof rawArgs.amountPx === 'number' ? rawArgs.amountPx : undefined,
      );
      return { ...state, direction };
    },
  });

  // --- AC6: browser_vision (screenshot + AI analysis via the E9 chokepoint) -
  registry.register({
    name: 'browser_vision',
    class: 'shell',
    description:
      'Screenshot the current page and analyse it with a vision model. ' +
      `The AI call routes through the resolveLLMForSystem chokepoint. ${PLAYWRIGHT_INSTALL_HINT}`,
    toolset: 'web',
    stateless: false,
    available: playwrightAvailable,
    parameters: z.object({
      prompt: z.string().describe('Question / instruction for the vision model about the page.'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page (default false).'),
    }),
    execute: async (rawArgs) =>
      runBrowserVision(browser, String(rawArgs.prompt), rawArgs.fullPage === true, projectRoot),
  });
}

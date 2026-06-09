/**
 * Pluggable `web_search` backends + HTML→markdown extraction (T1742 · epic
 * T11456 · SG-TOOLS).
 *
 * The `web` toolset's network backend. TWO concerns live here, both built over
 * an INJECTABLE {@link HttpFetch} so unit tests mock the network and CI never
 * makes a real request (AC9):
 *
 *   - **web_search backends** — a {@link WebSearchBackend} interface with two
 *     keyless builtin implementations ({@link duckDuckGoBackend},
 *     {@link searxngBackend}). NO hard paid-API dependency: backends are resolved
 *     at call time and the tool degrades gracefully to an `unavailable` result
 *     when none answer (AC1). New backends register by satisfying the interface —
 *     the search tool is backend-agnostic.
 *   - **web_extract** — {@link htmlToMarkdown}, a dependency-free HTML→markdown
 *     converter (AC2), plus {@link extractTitle}.
 *
 * The pure helpers (parsers, the markdown converter) are exported for direct unit
 * testing. Import-time side-effect-free.
 *
 * @epic T11456
 * @task T1742
 */

import type {
  WebExtractResult,
  WebSearchBackendId,
  WebSearchHit,
  WebSearchInput,
} from '@cleocode/contracts/tools/web-tools';
import { getLogger } from '../logger.js';

const log = getLogger('tool-web-search');

/**
 * A minimal HTTP-fetch surface the web tools depend on by INJECTION. Structurally
 * a subset of the global `fetch`, declared here so the executables can be driven
 * by a mock in tests (no real network in CI · AC9) and so a future routing of
 * web egress through a guarded `net` primitive is a one-line swap.
 */
export type HttpFetch = (
  url: string,
  init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
  readonly headers: { get(name: string): string | null };
}>;

/** The default {@link HttpFetch} — the platform global `fetch`. */
export const defaultHttpFetch: HttpFetch = (url, init) =>
  fetch(url, init) as unknown as ReturnType<HttpFetch>;

// ===========================================================================
// web_search backends
// ===========================================================================

/**
 * One pluggable web-search backend. A backend resolves a query into ranked
 * {@link WebSearchHit}s, or throws (the resolver moves on to the next backend).
 * `isConfigured()` lets a backend that needs a URL/instance opt OUT of the `auto`
 * rotation when it has nothing to talk to — keeping the "graceful when
 * unconfigured" contract (AC1) without a network round-trip.
 */
export interface WebSearchBackend {
  /** Canonical backend id. */
  readonly id: WebSearchBackendId;
  /** Whether this backend has everything it needs to run (e.g. an instance URL). */
  isConfigured(): boolean;
  /**
   * Run the search.
   *
   * @param query - The search query.
   * @param maxResults - Cap on returned hits.
   * @param http - The injected fetch surface.
   * @returns Ranked hits.
   */
  search(query: string, maxResults: number, http: HttpFetch): Promise<WebSearchHit[]>;
}

/** Decode the most common HTML entities found in result titles/snippets. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Strip HTML tags from a fragment and collapse whitespace. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse DuckDuckGo's keyless HTML endpoint (`html.duckduckgo.com/html/`) into
 * structured hits. Pure helper (AC9) — exported for direct unit testing against
 * a captured fixture, so no network is needed.
 *
 * @param html - The DuckDuckGo HTML response body.
 * @param maxResults - Cap on returned hits.
 * @returns Parsed hits.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // Each result anchor: <a ... class="result__a" href="URL">TITLE</a>
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Optional snippet: <a ... class="result__snippet" ...>SNIPPET</a>
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  let i = 0;
  for (
    let m = anchorRe.exec(html);
    m !== null && hits.length < maxResults;
    m = anchorRe.exec(html)
  ) {
    const rawHref = decodeEntities(m[1] ?? '');
    // DDG wraps targets as `/l/?uddg=<encoded-url>` — unwrap when present.
    const uddg = /[?&]uddg=([^&]+)/.exec(rawHref);
    const url = uddg ? decodeURIComponent(uddg[1] ?? '') : rawHref;
    const title = stripTags(m[2] ?? '');
    if (title === '' || url === '') {
      i++;
      continue;
    }
    hits.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  return hits;
}

/**
 * The DuckDuckGo backend — keyless HTML endpoint, always "configured" (no
 * instance URL needed). The canonical no-API-key default (AC1).
 */
export const duckDuckGoBackend: WebSearchBackend = {
  id: 'duckduckgo',
  isConfigured: () => true,
  async search(query, maxResults, http) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await http(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CleoBot/1.0)' },
    });
    if (res.status >= 400) {
      throw new Error(`duckduckgo: HTTP ${res.status}`);
    }
    return parseDuckDuckGoHtml(await res.text(), maxResults);
  },
};

/**
 * Parse a SearXNG JSON response (`{ results: [{ title, url, content }] }`) into
 * hits. Pure helper (AC9).
 *
 * @param json - The parsed SearXNG JSON body.
 * @param maxResults - Cap on returned hits.
 * @returns Parsed hits.
 */
export function parseSearxngJson(json: unknown, maxResults: number): WebSearchHit[] {
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: WebSearchHit[] = [];
  for (const r of results) {
    if (hits.length >= maxResults) break;
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title : '';
    const url = typeof rec.url === 'string' ? rec.url : '';
    if (title === '' || url === '') continue;
    hits.push({ title, url, snippet: typeof rec.content === 'string' ? rec.content : '' });
  }
  return hits;
}

/**
 * Build a SearXNG backend bound to an instance URL (from `SEARXNG_URL` env or
 * config). When no instance URL is supplied it reports `isConfigured() === false`
 * so the `auto` resolver skips it — preserving the "graceful when unconfigured"
 * contract (AC1) with no paid dependency.
 *
 * @param instanceUrl - The SearXNG instance base URL (or `undefined`/empty).
 * @returns A {@link WebSearchBackend}.
 */
export function makeSearxngBackend(instanceUrl: string | undefined): WebSearchBackend {
  const base = (instanceUrl ?? '').replace(/\/+$/, '');
  return {
    id: 'searxng',
    isConfigured: () => base !== '',
    async search(query, maxResults, http) {
      if (base === '') throw new Error('searxng: no instance URL configured');
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await http(url, { headers: { Accept: 'application/json' } });
      if (res.status >= 400) {
        throw new Error(`searxng: HTTP ${res.status}`);
      }
      const json: unknown = JSON.parse(await res.text());
      return parseSearxngJson(json, maxResults);
    },
  };
}

/**
 * Resolve the candidate backends for a {@link WebSearchInput}, in priority
 * order. A SearXNG instance (when configured) ranks before DuckDuckGo; an
 * explicit `input.backend` pins a single backend. The DuckDuckGo backend is
 * always present (keyless), so the list is never empty — but a pinned backend
 * that is not configured yields an empty list, which the executable surfaces as
 * `unavailable` (AC1).
 *
 * @param input - The search input.
 * @param searxngUrl - Optional SearXNG instance URL (config/env).
 * @returns The ordered candidate backends.
 */
export function resolveSearchBackends(
  input: WebSearchInput,
  searxngUrl: string | undefined,
): WebSearchBackend[] {
  const searxng = makeSearxngBackend(searxngUrl);
  const all: WebSearchBackend[] = [searxng, duckDuckGoBackend];
  const pinned = input.backend;
  if (pinned !== undefined && pinned !== 'auto') {
    return all.filter((b) => b.id === pinned && b.isConfigured());
  }
  return all.filter((b) => b.isConfigured());
}

// ===========================================================================
// web_extract — HTML → markdown
// ===========================================================================

/** Extract the document `<title>` text, or `''` when absent. Pure (AC9). */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1] ?? '') : '';
}

/**
 * Convert an HTML document to markdown. Dependency-free (AC2) — a focused,
 * deterministic transform of the structural tags an agent cares about
 * (headings, links, lists, code, emphasis, paragraphs); `<script>`/`<style>`
 * and remaining tags are dropped. NOT a full HTML5 parser — a pragmatic
 * readability-style extraction that keeps `core` free of a heavy DOM dependency.
 *
 * Pure function of its input (no I/O), so it is unit-testable in isolation (AC9).
 *
 * @param html - The HTML document / fragment.
 * @returns A markdown rendering of the body content.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;
  // 1) Drop non-content elements entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  // 2) Headings → #..######.
  for (let level = 1; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    s = s.replace(re, (_m, inner: string) => `\n\n${'#'.repeat(level)} ${stripTags(inner)}\n\n`);
  }
  // 3) Links → [text](href). The `(?=[\s>])` after the tag name ensures `<a `
  //    matches but `<article>` / `<aside>` do not (tag-boundary guard).
  s = s.replace(
    /<a(?=[\s>])[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = stripTags(inner);
      const url = decodeEntities(href);
      return text === '' ? '' : `[${text}](${url})`;
    },
  );
  // 4) Inline emphasis / code. Each opening tag is boundary-guarded so a longer
  //    element (e.g. `<body>` for `<b>`) is never mistaken for the short tag.
  s = s.replace(
    /<(?:strong|b)(?=[\s>])[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    (_m, i: string) => `**${stripTags(i)}**`,
  );
  s = s.replace(
    /<(?:em|i)(?=[\s>])[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
    (_m, i: string) => `*${stripTags(i)}*`,
  );
  s = s.replace(
    /<code(?=[\s>])[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, i: string) => `\`${stripTags(i)}\``,
  );
  // 5) Pre blocks → fenced code.
  s = s.replace(
    /<pre(?=[\s>])[^>]*>([\s\S]*?)<\/pre>/gi,
    (_m, i: string) => `\n\n\`\`\`\n${stripTags(i)}\n\`\`\`\n\n`,
  );
  // 6) List items → `- `; close lists with a blank line.
  s = s.replace(/<li(?=[\s>])[^>]*>([\s\S]*?)<\/li>/gi, (_m, i: string) => `\n- ${stripTags(i)}`);
  s = s.replace(/<\/(?:ul|ol)>/gi, '\n\n');
  // 7) Block separators → blank line.
  s = s.replace(/<\/(?:p|div|section|article|tr|table|blockquote)>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // 8) Drop every remaining tag, decode entities, normalise whitespace.
  s = stripTagsPreservingNewlines(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Like {@link stripTags} but keeps newline structure for block-level markdown. */
function stripTagsPreservingNewlines(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/[ \t]{2,}/g, ' ');
}

/**
 * Fetch a URL and convert its HTML body to markdown. The single executable body
 * for the `web_extract` tool — uses the INJECTED {@link HttpFetch} so CI mocks
 * the network (AC9).
 *
 * @param url - The URL to fetch.
 * @param http - The injected fetch surface.
 * @param opts - Timeout + markdown length cap.
 * @returns The {@link WebExtractResult}.
 */
export async function fetchAndExtract(
  url: string,
  http: HttpFetch,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<WebExtractResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await http(url, { signal: controller.signal });
    const body = await res.text();
    const title = extractTitle(body);
    const full = htmlToMarkdown(body);
    const maxChars = opts.maxChars ?? 100000;
    const truncated = full.length > maxChars;
    return {
      url,
      status: res.status,
      title,
      markdown: truncated ? full.slice(0, maxChars) : full,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a {@link WebSearchInput} against the resolved backends, first-success-wins.
 * Returns the hits + the answering backend id, or `null` when no backend could
 * answer (every candidate failed or the list was empty) — the executable maps
 * `null` onto a graceful `unavailable` result (AC1).
 *
 * @param input - The search input.
 * @param backends - The ordered candidate backends (from {@link resolveSearchBackends}).
 * @param http - The injected fetch surface.
 * @returns The hits + backend, or `null` when none answered.
 */
export async function runSearch(
  input: WebSearchInput,
  backends: readonly WebSearchBackend[],
  http: HttpFetch,
): Promise<{ results: WebSearchHit[]; backend: WebSearchBackendId } | null> {
  const maxResults = input.maxResults ?? 10;
  for (const backend of backends) {
    try {
      const results = await backend.search(input.query, maxResults, http);
      return { results, backend: backend.id };
    } catch (err) {
      log.debug({ backend: backend.id, err }, 'web_search backend failed — trying next');
    }
  }
  return null;
}

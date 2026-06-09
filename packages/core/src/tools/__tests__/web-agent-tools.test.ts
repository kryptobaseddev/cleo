/**
 * Tests for the web + browser agent-tool family (T1742 · epic T11456).
 *
 * Covers the 9 acceptance criteria with FULLY-MOCKED backends (AC9) — no real
 * network, no real browser launch, no real LLM credential:
 *   AC1 web_search pluggable backends + graceful-when-unconfigured ·
 *   AC2 web_extract HTML→markdown · AC3 browser_navigate (mocked Playwright) ·
 *   AC4 browser_click/type/press · AC5 browser_snapshot (a11y tree) ·
 *   AC6 browser_vision (covered in web-browser-vision.test.ts — resolver mocked) ·
 *   AC7 browser_scroll up/down · AC8 all registered + browser availability gating ·
 *   AC9 (this file) — mocked Playwright module + mocked HTTP fetch.
 *
 * The pure helpers (HTML→markdown, the search-backend parsers) are tested
 * directly; the executables are driven through an injected mock {@link HttpFetch}
 * and an injected {@link BrowserSession} backed by a FAKE Playwright loader, so no
 * subprocess / network / browser is ever touched.
 *
 * @task T1742
 * @epic T11456
 */

import { describe, expect, it } from 'vitest';
import { AgentToolRegistry } from '../agent-registry.js';
import { BrowserSession } from '../browser-driver.js';
import { registerBuiltinAgentTools } from '../builtin-agent-tools.js';
import { registerWebAgentTools } from '../web-agent-tools.js';
import {
  extractTitle,
  type HttpFetch,
  htmlToMarkdown,
  makeSearxngBackend,
  parseDuckDuckGoHtml,
  parseSearxngJson,
  resolveSearchBackends,
} from '../web-search-backends.js';

// ===========================================================================
// Test doubles
// ===========================================================================

/** A mock {@link HttpFetch} that maps a URL substring → canned response body. */
function mockHttp(routes: Array<{ match: string; status?: number; body: string }>): {
  http: HttpFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const http: HttpFetch = async (url) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) throw new Error(`mockHttp: no route for ${url}`);
    return {
      status: route.status ?? 200,
      async text() {
        return route.body;
      },
      headers: { get: () => null },
    };
  };
  return { http, calls };
}

/** Build a fake Playwright module recording every page action it performs. */
function fakePlaywright(): {
  loader: () => Promise<unknown>;
  actions: string[];
  setUrl: (u: string) => void;
} {
  const actions: string[] = [];
  let currentUrl = 'about:blank';
  const page = {
    async goto(url: string): Promise<unknown> {
      actions.push(`goto:${url}`);
      currentUrl = url;
      return undefined;
    },
    url: () => currentUrl,
    async title(): Promise<string> {
      return 'Mock Page';
    },
    locator(selector: string) {
      return {
        async click(): Promise<void> {
          actions.push(`click:${selector}`);
        },
        async fill(value: string): Promise<void> {
          actions.push(`fill:${selector}:${value}`);
        },
        async focus(): Promise<void> {
          actions.push(`focus:${selector}`);
        },
      };
    },
    keyboard: {
      async press(key: string): Promise<void> {
        actions.push(`press:${key}`);
      },
    },
    accessibility: {
      async snapshot() {
        actions.push('snapshot');
        return { role: 'WebArea', name: 'Mock Page', children: [{ role: 'button', name: 'Go' }] };
      },
    },
    async screenshot(): Promise<Buffer> {
      actions.push('screenshot');
      return Buffer.from('PNGDATA');
    },
    async evaluate<T>(_fn: string): Promise<T> {
      actions.push('evaluate');
      return 800 as unknown as T;
    },
  };
  const browser = {
    async newPage() {
      actions.push('newPage');
      return page;
    },
    async close(): Promise<void> {
      actions.push('close');
    },
  };
  const chromium = {
    async launch() {
      actions.push('launch');
      return browser;
    },
  };
  return {
    loader: async () => ({ chromium }),
    actions,
    setUrl: (u: string) => {
      currentUrl = u;
    },
  };
}

/** A registry with the web+browser family registered over injected mocks. */
async function registryWith(
  options: Parameters<typeof registerWebAgentTools>[1],
): Promise<AgentToolRegistry> {
  const r = new AgentToolRegistry();
  registerWebAgentTools(r, options);
  await r.init({ skipBuiltins: true });
  return r;
}

// ===========================================================================
// Pure helpers — HTML → markdown (AC2)
// ===========================================================================

describe('htmlToMarkdown (AC2)', () => {
  it('converts headings, links, lists, emphasis', () => {
    const html =
      '<html><head><title>T</title><style>x{}</style></head><body>' +
      '<h1>Title</h1><p>Hello <strong>world</strong> and <a href="https://x.io">link</a>.</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<script>evil()</script></body></html>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('# Title');
    expect(md).toContain('**world**');
    expect(md).toContain('[link](https://x.io)');
    expect(md).toContain('- one');
    expect(md).toContain('- two');
    // script/style stripped
    expect(md).not.toContain('evil');
    expect(md).not.toContain('x{}');
  });

  it('renders fenced code from <pre>', () => {
    const md = htmlToMarkdown('<body><pre>const x = 1;</pre></body>');
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  it('extracts the document title', () => {
    expect(extractTitle('<html><head><title>My Page</title></head></html>')).toBe('My Page');
    expect(extractTitle('<html></html>')).toBe('');
  });
});

// ===========================================================================
// Pure helpers — search backends (AC1)
// ===========================================================================

describe('search-backend parsers (AC1)', () => {
  it('parses DuckDuckGo HTML results (unwrapping /l/?uddg= targets)', () => {
    const target = encodeURIComponent('https://example.com/page');
    const html =
      `<a class="result__a" href="/l/?uddg=${target}">Example Title</a>` +
      '<a class="result__snippet" href="#">A snippet here</a>';
    const hits = parseDuckDuckGoHtml(html, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: 'Example Title',
      url: 'https://example.com/page',
      snippet: 'A snippet here',
    });
  });

  it('parses SearXNG JSON results', () => {
    const json = {
      results: [
        { title: 'A', url: 'https://a.io', content: 'about a' },
        { title: 'B', url: 'https://b.io' },
      ],
    };
    const hits = parseSearxngJson(json, 10);
    expect(hits).toEqual([
      { title: 'A', url: 'https://a.io', snippet: 'about a' },
      { title: 'B', url: 'https://b.io', snippet: '' },
    ]);
  });

  it('searxng backend reports unconfigured when no instance URL', () => {
    expect(makeSearxngBackend(undefined).isConfigured()).toBe(false);
    expect(makeSearxngBackend('').isConfigured()).toBe(false);
    expect(makeSearxngBackend('https://searx.local').isConfigured()).toBe(true);
  });

  it('resolves only DuckDuckGo in auto mode when searxng is unconfigured', () => {
    const backends = resolveSearchBackends({ query: 'q' }, undefined);
    expect(backends.map((b) => b.id)).toEqual(['duckduckgo']);
  });

  it('a pinned but unconfigured backend resolves to an empty list (→ unavailable)', () => {
    const backends = resolveSearchBackends({ query: 'q', backend: 'searxng' }, undefined);
    expect(backends).toHaveLength(0);
  });
});

// ===========================================================================
// web_search executable (AC1)
// ===========================================================================

describe('web_search executable (AC1)', () => {
  it('returns ranked DuckDuckGo results via the injected fetch', async () => {
    const target = encodeURIComponent('https://result.io');
    const body = `<a class="result__a" href="/l/?uddg=${target}">Result</a>`;
    const { http, calls } = mockHttp([{ match: 'duckduckgo', body }]);
    const r = await registryWith({ http });
    const exec = r.getExecutable('web_search');
    if (exec === undefined) throw new Error('web_search missing');
    const out = (await exec({ query: 'hello' }, undefined as never)) as {
      results: unknown[];
      backend: string;
      unavailable: boolean;
    };
    expect(out.unavailable).toBe(false);
    expect(out.backend).toBe('duckduckgo');
    expect(out.results).toEqual([{ title: 'Result', url: 'https://result.io', snippet: '' }]);
    expect(calls[0]).toContain('html.duckduckgo.com');
  });

  it('degrades gracefully to unavailable when a pinned backend is unconfigured', async () => {
    const { http } = mockHttp([]);
    const r = await registryWith({ http });
    const exec = r.getExecutable('web_search');
    if (exec === undefined) throw new Error('web_search missing');
    const out = (await exec({ query: 'q', backend: 'searxng' }, undefined as never)) as {
      unavailable: boolean;
      results: unknown[];
      reason?: string;
    };
    expect(out.unavailable).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.reason).toBeDefined();
  });

  it('degrades to unavailable when every backend fails (no real network)', async () => {
    const http: HttpFetch = async () => {
      throw new Error('network down');
    };
    const r = await registryWith({ http });
    const exec = r.getExecutable('web_search');
    if (exec === undefined) throw new Error('web_search missing');
    const out = (await exec({ query: 'q' }, undefined as never)) as { unavailable: boolean };
    expect(out.unavailable).toBe(true);
  });

  it('uses SearXNG first when an instance URL is configured', async () => {
    const json = JSON.stringify({ results: [{ title: 'S', url: 'https://s.io', content: 'c' }] });
    const { http, calls } = mockHttp([{ match: 'searx.local', body: json }]);
    const r = await registryWith({ http, searxngUrl: 'https://searx.local' });
    const exec = r.getExecutable('web_search');
    if (exec === undefined) throw new Error('web_search missing');
    const out = (await exec({ query: 'q' }, undefined as never)) as {
      backend: string;
      results: Array<{ title: string }>;
    };
    expect(out.backend).toBe('searxng');
    expect(out.results[0]?.title).toBe('S');
    expect(calls[0]).toContain('searx.local');
  });
});

// ===========================================================================
// web_extract executable (AC2)
// ===========================================================================

describe('web_extract executable (AC2)', () => {
  it('fetches a URL and returns markdown via the injected fetch', async () => {
    const html =
      '<html><head><title>Doc</title></head><body><h1>Heading</h1><p>Body.</p></body></html>';
    const { http } = mockHttp([{ match: 'example.com', body: html }]);
    const r = await registryWith({ http });
    const exec = r.getExecutable('web_extract');
    if (exec === undefined) throw new Error('web_extract missing');
    const out = (await exec({ url: 'https://example.com/doc' }, undefined as never)) as {
      title: string;
      markdown: string;
      status: number;
      truncated: boolean;
    };
    expect(out.status).toBe(200);
    expect(out.title).toBe('Doc');
    expect(out.markdown).toContain('# Heading');
    expect(out.markdown).toContain('Body.');
    expect(out.truncated).toBe(false);
  });

  it('truncates markdown beyond maxChars', async () => {
    const html = `<body><p>${'x'.repeat(500)}</p></body>`;
    const { http } = mockHttp([{ match: 'big', body: html }]);
    const r = await registryWith({ http });
    const exec = r.getExecutable('web_extract');
    if (exec === undefined) throw new Error('web_extract missing');
    const out = (await exec({ url: 'https://big.io', maxChars: 50 }, undefined as never)) as {
      markdown: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.markdown.length).toBe(50);
  });
});

// ===========================================================================
// browser_* executables over a MOCKED Playwright (AC3/AC4/AC5/AC7) — AC9
// ===========================================================================

describe('browser tools over a mocked Playwright (AC3/AC4/AC5/AC7)', () => {
  async function browserRegistry(): Promise<{
    r: AgentToolRegistry;
    actions: string[];
  }> {
    const fake = fakePlaywright();
    const session = new BrowserSession(fake.loader as never);
    const r = await registryWith({ browser: session });
    return { r, actions: fake.actions };
  }

  it('browser_navigate launches the browser lazily and navigates (AC3)', async () => {
    const { r, actions } = await browserRegistry();
    const exec = r.getExecutable('browser_navigate');
    if (exec === undefined) throw new Error('browser_navigate missing');
    const out = (await exec({ url: 'https://site.io' }, undefined as never)) as {
      url: string;
      title: string;
    };
    expect(out.url).toBe('https://site.io');
    expect(out.title).toBe('Mock Page');
    // Lazy launch happened on first navigation.
    expect(actions).toContain('launch');
    expect(actions).toContain('goto:https://site.io');
  });

  it('browser_click / browser_type / browser_press perform actions (AC4)', async () => {
    const { r, actions } = await browserRegistry();
    const click = r.getExecutable('browser_click');
    const type = r.getExecutable('browser_type');
    const press = r.getExecutable('browser_press');
    if (click === undefined || type === undefined || press === undefined) {
      throw new Error('browser action tools missing');
    }
    const clicked = (await click({ selector: '#go' }, undefined as never)) as { action: string };
    const typed = (await type({ selector: '#q', text: 'hi' }, undefined as never)) as {
      action: string;
    };
    const pressed = (await press({ key: 'Enter', selector: '#q' }, undefined as never)) as {
      action: string;
    };
    expect(clicked.action).toBe('click');
    expect(typed.action).toBe('type');
    expect(pressed.action).toBe('press');
    expect(actions).toContain('click:#go');
    expect(actions).toContain('fill:#q:hi');
    expect(actions).toContain('focus:#q');
    expect(actions).toContain('press:Enter');
  });

  it('browser_snapshot returns the accessibility tree (AC5)', async () => {
    const { r, actions } = await browserRegistry();
    const exec = r.getExecutable('browser_snapshot');
    if (exec === undefined) throw new Error('browser_snapshot missing');
    const out = (await exec({}, undefined as never)) as {
      tree: { role: string; children?: unknown[] } | null;
    };
    expect(actions).toContain('snapshot');
    expect(out.tree?.role).toBe('WebArea');
    expect(out.tree?.children).toHaveLength(1);
  });

  it('browser_scroll scrolls up and down (AC7)', async () => {
    const { r, actions } = await browserRegistry();
    const exec = r.getExecutable('browser_scroll');
    if (exec === undefined) throw new Error('browser_scroll missing');
    const down = (await exec({ direction: 'down' }, undefined as never)) as {
      direction: string;
      scrollY: number;
    };
    const up = (await exec({ direction: 'up', amountPx: 200 }, undefined as never)) as {
      direction: string;
    };
    expect(down.direction).toBe('down');
    expect(down.scrollY).toBe(800);
    expect(up.direction).toBe('up');
    expect(actions.filter((a) => a === 'evaluate')).toHaveLength(2);
  });
});

// ===========================================================================
// Registration + availability gating (AC8)
// ===========================================================================

describe('web + browser tools — registration & availability (AC8)', () => {
  it('registers every web + browser tool, all surfaced via toOpenAITools', async () => {
    const r = new AgentToolRegistry();
    registerBuiltinAgentTools(r);
    await r.init({ skipBuiltins: true });
    for (const name of [
      'web_search',
      'web_extract',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_snapshot',
      'browser_scroll',
      'browser_vision',
    ]) {
      expect(r.get(name), `${name} should be registered`).toBeDefined();
    }
    const openai = r.toOpenAITools();
    expect(openai.find((t) => t.name === 'web_search')?.inputSchema).toMatchObject({
      type: 'object',
    });
    expect(openai.find((t) => t.name === 'browser_vision')).toBeDefined();
  });

  it('browser tools are hidden when playwright capability is absent (AC8)', async () => {
    const r = new AgentToolRegistry();
    registerBuiltinAgentTools(r);
    await r.init({ skipBuiltins: true });
    // No playwright capability advertised → browser tools unavailable.
    const names = r.available({}).map((t) => t.name);
    expect(names).not.toContain('browser_navigate');
    expect(names).not.toContain('browser_vision');
    // web tools (net) are still available (no playwright needed).
    expect(names).toContain('web_search');
    expect(names).toContain('web_extract');
  });

  it('browser tools become available when the playwright capability is present (AC8)', async () => {
    const r = new AgentToolRegistry();
    registerBuiltinAgentTools(r);
    await r.init({ skipBuiltins: true });
    const names = r.available({ capabilities: { playwright: true } }).map((t) => t.name);
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_vision');
  });

  it('web tools are hidden when network egress is denied', async () => {
    const r = new AgentToolRegistry();
    registerBuiltinAgentTools(r);
    await r.init({ skipBuiltins: true });
    const names = r.available({ networkEgressAllowed: false }).map((t) => t.name);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('browser_navigate');
  });

  it('browser tool descriptions carry the playwright install hint (AC8)', async () => {
    const r = new AgentToolRegistry();
    registerBuiltinAgentTools(r);
    await r.init({ skipBuiltins: true });
    expect(r.get('browser_navigate')?.description).toContain('playwright');
  });
});

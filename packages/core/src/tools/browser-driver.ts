/**
 * Playwright browser driver — the OPTIONAL, lazily-loaded automation backend
 * (T1742 · epic T11456 · SG-TOOLS).
 *
 * The `browser_*` tools' execution backend. Playwright is an OPTIONAL dependency
 * (publish-surface discipline · D11136): it is NEVER a hard dependency of
 * `@cleocode/core`. Like `node-pty` (see {@link ./pty.js}), it is deliberately
 * NOT declared in `core`'s `dependencies` / `optionalDependencies` and is loaded
 * ONLY via a dynamic `import()` whose specifier is held in a variable — so
 * neither the bundler nor TS treats the missing package as a hard,
 * statically-resolved dependency, the published `@cleocode/core` carries no
 * Playwright weight, and `core` builds + tests pass with Playwright NOT installed.
 * An environment that wants the browser tools opts in by installing `playwright`
 * itself (`pnpm add playwright && pnpm exec playwright install chromium`).
 *
 * Import-time side-effect-free: NO top-level `playwright` import; the browser is
 * launched lazily on the first navigation through a {@link BrowserSession}. When
 * Playwright is absent, {@link isPlaywrightAvailable} resolves `false` and the
 * browser tools' availability predicate hides them with an install hint —
 * nothing throws at import.
 *
 * @epic T11456
 * @task T1742
 * @see ./pty.js — the analogous optional-native-dep (node-pty) lazy-load pattern
 */

import type {
  AccessibilityNode,
  BrowserNavigateInput,
  BrowserPageState,
} from '@cleocode/contracts/tools/web-tools';
import { getLogger } from '../logger.js';

const log = getLogger('tool-browser');

/**
 * The npm install hint surfaced to the model when a browser tool is unavailable
 * because Playwright is not installed. Playwright is an OPTIONAL dep — the
 * browser tools are registered regardless, but report unavailable until this
 * runs (AC8).
 */
export const PLAYWRIGHT_INSTALL_HINT =
  'Browser tools require the optional "playwright" package. Install it with ' +
  '`pnpm add playwright && pnpm exec playwright install chromium`, then retry.';

// ---------------------------------------------------------------------------
// Minimal structural shapes of the Playwright surface we consume.
//
// Declared LOCALLY so this file carries NO type dependency on the optional
// package — the dynamic import is shape-checked against these, not against
// `@types/playwright`. Only the members the browser tools actually use are
// modelled; everything is `readonly` and narrow.
// ---------------------------------------------------------------------------

/** A keyboard handle (`page.keyboard`). */
interface PwKeyboard {
  press(key: string): Promise<void>;
}

/** A located element handle (`page.locator(...)`). */
interface PwLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  focus(options?: { timeout?: number }): Promise<void>;
}

/** The accessibility snapshot surface (`page.accessibility`). */
interface PwAccessibility {
  snapshot(): Promise<AccessibilityNode | null>;
}

/** A Playwright `Page`. */
interface PwPage {
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): PwLocator;
  readonly keyboard: PwKeyboard;
  readonly accessibility: PwAccessibility;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer | Uint8Array>;
  evaluate<T>(fn: string): Promise<T>;
}

/** A Playwright `Browser`. */
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

/** The `chromium` browser-type launcher. */
interface PwBrowserType {
  launch(options?: { headless?: boolean }): Promise<PwBrowser>;
}

/** The minimal shape of the `playwright` module we depend on. */
interface PlaywrightModule {
  readonly chromium: PwBrowserType;
}

/**
 * Attempt to lazily load `playwright`. Returns `null` when the optional dep is
 * not installed or fails to load (any reason), so callers can report the browser
 * tools as unavailable rather than crashing.
 *
 * The import specifier is held in a variable so bundlers / TS do not treat the
 * missing optional dep as a hard, statically-resolved dependency (same technique
 * as {@link ./pty.js}'s `node-pty` load).
 *
 * @returns The loaded module shape, or `null` when unavailable.
 */
async function loadPlaywright(): Promise<PlaywrightModule | null> {
  const specifier = 'playwright';
  try {
    const mod: unknown = await import(specifier);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as { chromium?: unknown }).chromium === 'object'
    ) {
      return candidate as PlaywrightModule;
    }
    return null;
  } catch (err) {
    log.debug({ err }, 'playwright not loadable — browser tools unavailable');
    return null;
  }
}

/**
 * Whether the optional `playwright` package can be loaded in this process.
 *
 * Used by the browser tools' {@link import('./agent-registry.js').AvailabilityCheck}
 * (via the registry's `capabilities` flag) so they are hidden — with
 * {@link PLAYWRIGHT_INSTALL_HINT} — when Playwright is absent (AC8). The result is
 * cached after the first probe so availability checks stay cheap.
 *
 * @returns `true` when `playwright` is importable, else `false`.
 */
let cachedAvailable: boolean | undefined;
export async function isPlaywrightAvailable(): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  cachedAvailable = (await loadPlaywright()) !== null;
  return cachedAvailable;
}

/**
 * Reset the cached Playwright-availability probe.
 *
 * EXPORTED FOR TESTS ONLY — lets a unit test toggle the mocked availability of
 * the optional dep between cases without a fresh module graph.
 *
 * @internal
 */
export function __resetPlaywrightAvailabilityCache(): void {
  cachedAvailable = undefined;
}

// ---------------------------------------------------------------------------
// BrowserSession — a single lazily-launched browser + page
// ---------------------------------------------------------------------------

/**
 * The injectable factory the {@link BrowserSession} uses to obtain a Playwright
 * module. Defaults to the real lazy {@link loadPlaywright}; unit tests inject a
 * fake so NO real browser is ever launched (AC9).
 */
export type PlaywrightLoader = () => Promise<PlaywrightModule | null>;

/**
 * A single browser session: lazily launches a headless Chromium on the first
 * navigation, then reuses the same page for subsequent interactions. Holds no
 * Playwright reference until {@link BrowserSession.navigate} is first called, so
 * constructing one is free and import-time side-effect-free.
 *
 * The browser tools share ONE session per registry run (created by the browser
 * tool family at registration). All Playwright access funnels through here so
 * the lazy-load + teardown live in one place.
 */
export class BrowserSession {
  #browser: PwBrowser | null = null;
  #page: PwPage | null = null;
  readonly #load: PlaywrightLoader;

  /**
   * @param load - Optional Playwright loader (defaults to the real lazy import).
   *   Tests pass a fake that returns a mock module — no real browser launches.
   */
  constructor(load: PlaywrightLoader = loadPlaywright) {
    this.#load = load;
  }

  /**
   * Ensure a page exists, launching the browser on first use. Throws a typed
   * error when Playwright is unavailable so the tool executable can surface the
   * install hint (the tool's `available()` predicate normally hides it first).
   *
   * @returns The active page.
   */
  async #ensurePage(): Promise<PwPage> {
    if (this.#page !== null) return this.#page;
    const pw = await this.#load();
    if (pw === null) {
      throw new Error(`E_BROWSER_UNAVAILABLE: ${PLAYWRIGHT_INSTALL_HINT}`);
    }
    this.#browser = await pw.chromium.launch({ headless: true });
    this.#page = await this.#browser.newPage();
    return this.#page;
  }

  /** The current page state (url + title). */
  async #state(page: PwPage): Promise<BrowserPageState> {
    return { url: page.url(), title: await page.title() };
  }

  /**
   * Navigate to a URL (launching the browser on first call).
   *
   * @param input - {@link BrowserNavigateInput}.
   * @returns The page state after navigation.
   */
  async navigate(input: BrowserNavigateInput): Promise<BrowserPageState> {
    const page = await this.#ensurePage();
    await page.goto(input.url, {
      waitUntil: input.waitUntil ?? 'load',
      timeout: input.timeoutMs ?? 30000,
    });
    return this.#state(page);
  }

  /**
   * Click the element matching `selector`.
   *
   * @param selector - CSS / Playwright selector.
   * @param timeoutMs - Per-action timeout.
   * @returns The page state after the click.
   */
  async click(selector: string, timeoutMs = 15000): Promise<BrowserPageState> {
    const page = await this.#ensurePage();
    await page.locator(selector).click({ timeout: timeoutMs });
    return this.#state(page);
  }

  /**
   * Type `text` into the element matching `selector`.
   *
   * @param selector - CSS / Playwright selector.
   * @param text - Text to enter (`fill` replaces the field's content).
   * @param timeoutMs - Per-action timeout.
   * @returns The page state after typing.
   */
  async type(selector: string, text: string, timeoutMs = 15000): Promise<BrowserPageState> {
    const page = await this.#ensurePage();
    await page.locator(selector).fill(text, { timeout: timeoutMs });
    return this.#state(page);
  }

  /**
   * Press a key / chord, optionally focusing `selector` first.
   *
   * @param key - Playwright key syntax (e.g. `Enter`, `Control+A`).
   * @param selector - Optional element to focus before pressing.
   * @param timeoutMs - Per-action timeout (for the focus step).
   * @returns The page state after the keypress.
   */
  async press(key: string, selector?: string, timeoutMs = 15000): Promise<BrowserPageState> {
    const page = await this.#ensurePage();
    if (selector !== undefined) {
      await page.locator(selector).focus({ timeout: timeoutMs });
    }
    await page.keyboard.press(key);
    return this.#state(page);
  }

  /**
   * Capture the page's accessibility tree.
   *
   * @returns The page state plus the accessibility tree root (or `null`).
   */
  async snapshot(): Promise<BrowserPageState & { tree: AccessibilityNode | null }> {
    const page = await this.#ensurePage();
    const tree = await page.accessibility.snapshot();
    return { ...(await this.#state(page)), tree };
  }

  /**
   * Scroll the page vertically by `amountPx` in `direction` and report the new
   * scroll offset.
   *
   * @param direction - `up` or `down`.
   * @param amountPx - Pixels to scroll (defaults to ~one viewport).
   * @returns The page state plus the post-scroll `scrollY`.
   */
  async scroll(
    direction: 'up' | 'down',
    amountPx = 800,
  ): Promise<BrowserPageState & { scrollY: number }> {
    const page = await this.#ensurePage();
    const delta = direction === 'down' ? amountPx : -amountPx;
    // `evaluate(string)` so this file never imports playwright's function-arg
    // serialization types; the page runs the scroll + returns the new offset.
    const scrollY = await page.evaluate<number>(
      `(() => { window.scrollBy(0, ${delta}); return window.scrollY; })()`,
    );
    return { ...(await this.#state(page)), scrollY };
  }

  /**
   * Capture a screenshot of the current page as base64-encoded PNG bytes.
   *
   * @param fullPage - Capture the full scrollable page when `true`.
   * @returns The page state plus the base64 PNG and the page state.
   */
  async screenshot(fullPage = false): Promise<BrowserPageState & { base64Png: string }> {
    const page = await this.#ensurePage();
    const buf = await page.screenshot({ fullPage });
    const base64Png = Buffer.from(buf).toString('base64');
    return { ...(await this.#state(page)), base64Png };
  }

  /** Close the browser and release the page (idempotent). */
  async close(): Promise<void> {
    if (this.#browser !== null) {
      try {
        await this.#browser.close();
      } catch (err) {
        log.debug({ err }, 'browser close failed (ignored)');
      }
    }
    this.#browser = null;
    this.#page = null;
  }
}

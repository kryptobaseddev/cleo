/**
 * `@earendil-works/pi-tui` — the OPTIONAL, lazily-loaded terminal-UI renderer
 * powering the `cleo tui` cockpit (T11932 · T11933 · T11934 · epic T11916).
 *
 * `pi-tui` is a differential-rendering TUI library (the `TUI` render loop +
 * `Text`/`Box`/`Container` components + `ProcessTerminal`). It is an OPTIONAL
 * dependency — NEVER a hard dependency of `@cleocode/cleo`. Exactly like
 * `@earendil-works/gondolin` (see
 * {@link import('@cleocode/core/internal')} `loadGondolin`) and `playwright`
 * (see `packages/core/src/tools/browser-driver.ts`), it is deliberately NOT
 * declared in `cleo`'s `dependencies` / `optionalDependencies` and is loaded
 * ONLY via a dynamic `import()` whose specifier is held in a variable — so
 * neither the bundler nor TS treats the missing package as a hard,
 * statically-resolved dependency, the published `@cleocode/cleo` carries no
 * pi-tui weight, and `cleo` builds + non-TUI tests pass with pi-tui NOT
 * installed.
 *
 * An environment that wants the cockpit opts in by installing the package
 * itself (`pnpm add @earendil-works/pi-tui`). Until then {@link loadPiTui}
 * resolves `null` and {@link isPiTuiAvailable} resolves `false`, and the
 * `cleo tui` command degrades gracefully — it prints {@link PI_TUI_INSTALL_HINT}
 * and exits 0 rather than crashing.
 *
 * Import-time side-effect-free: NO top-level `@earendil-works/pi-tui` import; the
 * renderer is loaded lazily on the first `cleo tui` invocation. When pi-tui is
 * absent nothing throws at import.
 *
 * The structural shapes of the consumed pi-tui surface are declared LOCALLY in
 * this file (`Terminal`, `ProcessTerminalCtor`, `Component`, `TuiComponentCtor`,
 * `TuiInstance`, `TuiCtor`, `TextCtor`); there is NO `import type` from the
 * optional package, so the type-check passes with the package uninstalled.
 *
 * @task T11932 — optional-dep loader (mirror of gondolin-loader)
 * @epic T11916
 * @see packages/core/src/llm/pi/gondolin-loader.ts — the analogous optional-dep lazy-load pattern
 * @see packages/core/src/tools/browser-driver.ts — the Playwright optional-dep lazy-load pattern
 */

/**
 * The npm install hint surfaced to the operator when the cockpit renderer is
 * unavailable because `@earendil-works/pi-tui` is not installed. pi-tui is an
 * OPTIONAL dep — `cleo tui` degrades to a plain-text fallback regardless, but
 * the rich differential-rendered board stays UNAVAILABLE until this is
 * satisfied.
 */
export const PI_TUI_INSTALL_HINT =
  'The `cleo tui` cockpit requires the optional "@earendil-works/pi-tui" package. ' +
  'Install it with `pnpm add @earendil-works/pi-tui` (or `npm i -g @earendil-works/pi-tui`) ' +
  'to enable the rich differential-rendered terminal board.';

// ---------------------------------------------------------------------------
// Minimal structural shapes of the pi-tui surface we consume.
//
// Declared LOCALLY so this file carries NO type dependency on the optional
// package — the dynamic import is shape-checked against these, not against the
// package's own `.d.ts`. Only the members the cockpit shell + Kanban view
// actually use are modelled. There is NO `import type` from
// `@earendil-works/pi-tui` anywhere in `cleo`.
// ---------------------------------------------------------------------------

/**
 * The minimal `Terminal` surface a {@link TuiInstance} drives. Mirrors pi-tui's
 * `terminal.d.ts` `Terminal` interface (only the members consumed here).
 */
export interface Terminal {
  /** Current terminal width in columns. */
  readonly columns: number;
  /** Current terminal height in rows. */
  readonly rows: number;
}

/** The `ProcessTerminal` constructor surface (a concrete {@link Terminal}). */
export interface ProcessTerminalCtor {
  new (): Terminal;
}

/**
 * A renderable component (pi-tui `Component`). `render(width)` returns one
 * string per terminal line; the cockpit's view components implement this so
 * they can be added as children of the {@link TuiInstance}.
 */
export interface Component {
  /** Render the component to lines for the given viewport width. */
  render(width: number): string[];
  /** Optional handler for keyboard input when the component has focus. */
  handleInput?(data: string): void;
  /** Invalidate any cached rendering state. */
  invalidate(): void;
}

/**
 * A running pi-tui render loop (`TUI`). The cockpit owns exactly one: it adds
 * view components as children, drives input listeners, and stops it on exit.
 */
export interface TuiInstance {
  /** Append a component to the render tree. */
  addChild(component: Component): void;
  /** Remove all children (used when swapping the home frame). */
  clear(): void;
  /** Begin the differential render loop (raw mode, alt screen). */
  start(): void;
  /** Tear down the loop and restore the terminal (idempotent). */
  stop(): void;
  /** Request a (debounced) re-render of the tree. */
  requestRender(force?: boolean): void;
  /**
   * Register a global input listener. Returns a disposer that unregisters it.
   * The listener returns `{ consume: true }` to swallow the key.
   */
  addInputListener(
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
}

/** The `TUI` constructor surface (`new TUI(terminal)`). */
export interface TuiCtor {
  new (terminal: Terminal, showHardwareCursor?: boolean): TuiInstance;
}

/** The `Text` component constructor surface (`new Text(text)`). */
export interface TextCtor {
  new (
    text?: string,
    paddingX?: number,
    paddingY?: number,
    customBgFn?: (text: string) => string,
  ): Component;
}

/**
 * The minimal shape of the `@earendil-works/pi-tui` module the cockpit depends
 * on. Only the exports the shell + Kanban renderer consume are modelled.
 */
export interface PiTuiModule {
  /** The differential-render loop class. */
  readonly TUI: TuiCtor;
  /** The concrete `process.stdin`/`stdout`-backed terminal. */
  readonly ProcessTerminal: ProcessTerminalCtor;
  /** The multi-line text component. */
  readonly Text: TextCtor;
}

// ---------------------------------------------------------------------------
// Injectable seam — overridable ONLY by the unit tests so a mocked import() can
// deterministically simulate "package absent" and "package present" WITHOUT
// touching the module graph or requiring pi-tui to be installed. In production
// this resolves to the real dynamic import.
// ---------------------------------------------------------------------------

/** The npm specifier — held in a VARIABLE so it is never statically resolved. */
const PI_TUI_SPECIFIER = '@earendil-works/pi-tui';

/** A pluggable dynamic-importer (test seam). Defaults to the real `import()`. */
type DynamicImporter = (specifier: string) => Promise<unknown>;

/**
 * The real dynamic importer. The specifier is passed as an argument (held in a
 * variable at the call site) so the bundler / TS never treats the optional
 * package as a hard dependency.
 */
const realImporter: DynamicImporter = (specifier) => import(specifier);

/** The active importer (swapped only by {@link __setPiTuiTestHooks}). */
let importer: DynamicImporter = realImporter;

/**
 * Structurally validate a dynamically-imported candidate against the three
 * pi-tui exports the cockpit consumes. Returns the typed module on a match,
 * else `null` — so a shape-incompatible package version reports unavailable
 * rather than crashing later at render time.
 *
 * @param candidate - The dynamically-imported module (or its `default`).
 * @returns The shape-checked module, or `null` when the surface is incompatible.
 */
function shapeCheck(candidate: unknown): PiTuiModule | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  const mod = candidate as {
    TUI?: unknown;
    ProcessTerminal?: unknown;
    Text?: unknown;
  };
  const tuiOk = typeof mod.TUI === 'function';
  const terminalOk = typeof mod.ProcessTerminal === 'function';
  const textOk = typeof mod.Text === 'function';
  if (tuiOk && terminalOk && textOk) {
    return candidate as PiTuiModule;
  }
  return null;
}

/**
 * Attempt to lazily load `@earendil-works/pi-tui`. Returns `null` when the
 * optional dep is not installed, fails to load, OR does not expose the expected
 * `TUI` / `ProcessTerminal` / `Text` surface — so callers can degrade to the
 * plain-text fallback rather than crashing. NEVER throws.
 *
 * The import specifier is held in a variable (passed to the {@link importer}
 * seam) so bundlers / TS do not treat the missing optional dep as a hard,
 * statically-resolved dependency (same technique as the gondolin + Playwright
 * loaders).
 *
 * @returns The shape-checked module, or `null` when unavailable.
 */
export async function loadPiTui(): Promise<PiTuiModule | null> {
  try {
    const mod: unknown = await importer(PI_TUI_SPECIFIER);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    return shapeCheck(candidate);
  } catch {
    // Optional dep absent or unloadable — the cockpit degrades to plain text.
    return null;
  }
}

/**
 * Whether the pi-tui renderer can run in this process — i.e. the optional
 * `@earendil-works/pi-tui` package loads and exposes the expected surface.
 *
 * Returns `false` (NEVER throws) when the package is absent so the `cleo tui`
 * command can print {@link PI_TUI_INSTALL_HINT} and exit cleanly. The result is
 * cached after the first probe so repeated checks stay cheap;
 * {@link __resetPiTuiAvailabilityCache} clears it (tests only).
 *
 * @returns `true` only when the package is present and shape-compatible.
 */
let cachedAvailable: boolean | undefined;
export async function isPiTuiAvailable(): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  cachedAvailable = (await loadPiTui()) !== null;
  return cachedAvailable;
}

/**
 * Reset the cached pi-tui-availability probe.
 *
 * EXPORTED FOR TESTS ONLY — lets a unit test toggle the mocked availability of
 * the optional dep between cases without a fresh module graph.
 *
 * @internal
 */
export function __resetPiTuiAvailabilityCache(): void {
  cachedAvailable = undefined;
}

/**
 * Override the dynamic-importer and reset the availability cache.
 *
 * EXPORTED FOR TESTS ONLY — lets a unit test simulate "package absent" (importer
 * rejects), "package present" (importer resolves a mock module), and
 * "shape-incompatible package" deterministically, WITHOUT touching the module
 * graph or installing pi-tui. Call with no arguments to restore the real
 * importer.
 *
 * @param hooks - Partial override for the importer.
 * @internal
 */
export function __setPiTuiTestHooks(hooks?: { importer?: DynamicImporter }): void {
  importer = hooks?.importer ?? realImporter;
  cachedAvailable = undefined;
}

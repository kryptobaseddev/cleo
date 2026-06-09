/**
 * The `cleo tui` cockpit runtime — boots a keyboard-first terminal client over
 * the gateway SDK and renders the Kanban HOME view (T11933 · T11934 · epic
 * T11916).
 *
 * ## Data access — gateway SDK ONLY (T11933 · AC2)
 *
 * Every byte of data the cockpit shows comes through the M5 generated gateway
 * SDK client ({@link createCleoClient} from `@cleocode/core/gateway-client`,
 * T11920) pointed at the running daemon's `/v1` listener
 * (`cleo daemon serve`, default `http://127.0.0.1:7777`). There is NO direct
 * `@cleocode/core` DOMAIN import here — the cockpit is a pure SDK consumer, so
 * secrets never cross the boundary (sealed-handle resolution stays server-side).
 *
 * ## Graceful degradation (T11933 · AC1)
 *
 *  - **pi-tui absent** → print the board as plain text + the install hint, exit
 *    0. NEVER crash.
 *  - **daemon unreachable** → print a clean "start `cleo daemon serve`" message,
 *    exit 0.
 *  - **pi-tui present + daemon reachable** → boot the rich differential-rendered
 *    board with a keyboard-navigation skeleton.
 *
 * The pi-tui render glue is confined to this module; the board MODEL + plain-text
 * body live in the pure {@link import('./kanban-board.js')} module.
 *
 * @task T11933
 * @task T11934
 * @epic T11916
 */

import { createCleoClient } from '@cleocode/core/gateway-client';
import {
  isPiTuiAvailable,
  loadPiTui,
  PI_TUI_INSTALL_HINT,
  type PiTuiModule,
  type TuiInstance,
} from '../pi-tui-loader.js';
import {
  buildKanbanBoard,
  type KanbanBoard,
  renderKanbanBoardText,
  type TuiTaskRow,
} from './kanban-board.js';

/** The default loopback gateway base URL (`cleo daemon serve` listener). */
export const DEFAULT_TUI_BASE_URL = 'http://127.0.0.1:7777';

/** Options for {@link runCockpit}. */
export interface CockpitOptions {
  /** Gateway base URL. Defaults to {@link DEFAULT_TUI_BASE_URL}. */
  readonly baseUrl?: string;
  /**
   * When `true`, perform the data fetch + render once and return WITHOUT
   * entering the interactive pi-tui loop (used by `--once` / non-TTY runs so the
   * command is testable and CI-safe). Defaults to `false`.
   */
  readonly once?: boolean;
}

/** A line-emitting sink (defaults to stdout) — injectable for tests. */
export type LineSink = (line: string) => void;

/** Outcome of a cockpit boot, surfaced to the command for exit-code mapping. */
export interface CockpitResult {
  /**
   * What happened:
   *  - `'rendered'`       — board rendered (interactive or `--once`).
   *  - `'degraded-pi'`    — pi-tui absent; plain-text fallback rendered.
   *  - `'daemon-down'`    — daemon unreachable; install/start message shown.
   */
  readonly outcome: 'rendered' | 'degraded-pi' | 'daemon-down';
  /** The base URL the cockpit targeted. */
  readonly baseUrl: string;
  /** Whether the rich pi-tui renderer was used. */
  readonly piTui: boolean;
}

/**
 * Fetch the task rows for the home board through the gateway SDK. Returns the
 * raw rows on success, or `null` when the daemon is unreachable (so the caller
 * can print the "start the daemon" message and exit cleanly).
 *
 * @param baseUrl - Gateway base URL.
 * @returns Task rows, or `null` when the gateway is unreachable.
 */
async function fetchTaskRows(baseUrl: string): Promise<TuiTaskRow[] | null> {
  const client = createCleoClient({ baseUrl });
  try {
    const res = (await client.tasks.list({ body: { limit: 500 } })) as {
      data?: { data?: { tasks?: unknown } };
      response?: unknown;
    };
    // The hey-api client does NOT throw by default. A failed CONNECTION yields a
    // result with NO `response` object (the request never reached an HTTP
    // server) — that is the unambiguous "daemon not serving" signal, distinct
    // from a reachable daemon that simply returned zero rows.
    if (res.response == null) return null;
    // The SDK returns a LAFS envelope: { success, data: { tasks: [...] }, meta }.
    const tasks = res.data?.data?.tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks as TuiTaskRow[];
  } catch {
    // Defensive: a thrown transport error (e.g. DNS) is also "not serving".
    return null;
  }
}

/**
 * A pi-tui {@link import('../pi-tui-loader.js').Component} that renders the
 * Kanban board's plain-text body and reports which lane currently has keyboard
 * focus. The render output is the SAME body the fallback prints, so the two
 * paths can never diverge.
 */
class KanbanBoardComponent {
  /** Index of the lane that currently holds keyboard focus. */
  private focusedLane = 0;

  constructor(private board: KanbanBoard) {}

  /** Replace the board model (e.g. after a refresh) and reset cached render. */
  setBoard(board: KanbanBoard): void {
    this.board = board;
    if (this.focusedLane >= board.columns.length) this.focusedLane = 0;
  }

  /** Move keyboard focus one lane right (wraps). */
  focusNextLane(): void {
    const n = this.board.columns.length || 1;
    this.focusedLane = (this.focusedLane + 1) % n;
  }

  /** Move keyboard focus one lane left (wraps). */
  focusPrevLane(): void {
    const n = this.board.columns.length || 1;
    this.focusedLane = (this.focusedLane - 1 + n) % n;
  }

  /** The id of the currently-focused lane (for the status bar / tests). */
  focusedLaneId(): string {
    return this.board.columns[this.focusedLane]?.lane ?? '';
  }

  /** No cached state to clear — render is pure over the current board. */
  invalidate(): void {}

  /** Render the board body plus a focus indicator + key legend. */
  render(_width: number): string[] {
    const lines = renderKanbanBoardText(this.board);
    const focused = this.board.columns[this.focusedLane];
    lines.push(
      `Focus: ${focused?.label ?? '—'}   ` +
        `[←/→ or h/l] move lane   [Tab] cycle   [r] refresh   [q] quit`,
    );
    // TODO(T11935): dispatch via orchestrate.spawn — Enter on a focused card in
    // the Ready lane will transition + spawn a worker. Read-only home view for now.
    return lines;
  }
}

/**
 * Run the interactive pi-tui board loop until the user quits (`q`/Ctrl-C).
 * Resolves once the loop is torn down.
 *
 * @param piTui - The loaded pi-tui module.
 * @param component - The board component to render.
 * @param refresh - Re-fetch + rebuild the board (bound to the `r` key).
 */
function runInteractiveLoop(
  piTui: PiTuiModule,
  component: KanbanBoardComponent,
  refresh: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const terminal = new piTui.ProcessTerminal();
    const tui: TuiInstance = new piTui.TUI(terminal);
    tui.addChild(component);

    const dispose = tui.addInputListener((data: string) => {
      // Minimal keyboard-navigation skeleton (arrow keys + vim h/l + Tab).
      if (data === 'q' || data === '' /* Ctrl-C */) {
        dispose();
        tui.stop();
        resolve();
        return { consume: true };
      }
      if (data === '[C' || data === 'l' || data === '\t') {
        component.focusNextLane();
        tui.requestRender();
        return { consume: true };
      }
      if (data === '[D' || data === 'h') {
        component.focusPrevLane();
        tui.requestRender();
        return { consume: true };
      }
      if (data === 'r') {
        void refresh().then(() => tui.requestRender(true));
        return { consume: true };
      }
      return undefined;
    });

    tui.start();
    tui.requestRender(true);
  });
}

/**
 * Boot the `cleo tui` cockpit. Pure orchestration over the loader, the gateway
 * SDK, and the board model — it NEVER throws for the expected degradation paths
 * (pi-tui absent, daemon down); both render a clean message and resolve.
 *
 * @param options - {@link CockpitOptions}.
 * @param sink - Where plain-text lines go (defaults to stdout). Injectable for tests.
 * @returns A {@link CockpitResult} describing what happened (for exit mapping).
 */
export async function runCockpit(
  options: CockpitOptions = {},
  sink: LineSink = (line) => process.stdout.write(`${line}\n`), // stdout-write-allowed: interactive TUI / plain-text board + degrade render (T11933) // stdout-discipline-allowed: interactive TUI / plain-text board + degrade render (T11933)
): Promise<CockpitResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_TUI_BASE_URL;

  // 1. Fetch home data through the SDK. null ⇒ daemon unreachable.
  const rows = await fetchTaskRows(baseUrl);
  if (rows === null) {
    sink('CLEO cockpit: the daemon gateway is not reachable.');
    sink(`  Tried: ${baseUrl}/v1`);
    sink('  Start it with:  cleo daemon serve');
    sink('  (override the target with:  cleo tui --base-url <url>)');
    return { outcome: 'daemon-down', baseUrl, piTui: false };
  }

  const board = buildKanbanBoard(rows);

  // 2. pi-tui absent OR non-interactive (--once / no TTY) ⇒ plain-text render.
  const piTuiOk = await isPiTuiAvailable();
  const interactive = options.once !== true && process.stdout.isTTY === true;

  if (!piTuiOk || !interactive) {
    for (const line of renderKanbanBoardText(board)) sink(line);
    if (!piTuiOk) {
      sink('');
      sink(PI_TUI_INSTALL_HINT);
      return { outcome: 'degraded-pi', baseUrl, piTui: false };
    }
    return { outcome: 'rendered', baseUrl, piTui: false };
  }

  // 3. Rich interactive board.
  const piTui = await loadPiTui();
  if (piTui === null) {
    // Race/edge: availability said yes but load failed — degrade safely.
    for (const line of renderKanbanBoardText(board)) sink(line);
    sink('');
    sink(PI_TUI_INSTALL_HINT);
    return { outcome: 'degraded-pi', baseUrl, piTui: false };
  }

  const component = new KanbanBoardComponent(board);
  const refresh = async (): Promise<void> => {
    const fresh = await fetchTaskRows(baseUrl);
    if (fresh !== null) component.setBoard(buildKanbanBoard(fresh));
  };
  await runInteractiveLoop(piTui, component, refresh);
  return { outcome: 'rendered', baseUrl, piTui: true };
}

/** Exported for unit tests — the focusable board component. */
export { KanbanBoardComponent };

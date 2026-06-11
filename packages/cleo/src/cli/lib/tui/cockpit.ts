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
 * ## Graceful degradation (T11933 · AC1 / T11980)
 *
 *  - **pi-tui absent** → print the board as plain text + the install hint, exit
 *    0. NEVER crash.
 *  - **daemon unreachable + autoStart true (default)** → spawn `cleo daemon serve`
 *    as a detached background child (T11980 batteries-included surface), wait
 *    up to {@link GATEWAY_WAIT_TIMEOUT_MS} ms, then proceed or degrade.
 *  - **daemon unreachable + autoStart false** → print a clean
 *    "start `cleo daemon serve`" hint and exit 0 (legacy behaviour preserved).
 *  - **pi-tui present + daemon reachable** → boot the rich differential-rendered
 *    board with a keyboard-navigation skeleton.
 *
 * The pi-tui render glue is confined to this module; the board MODEL + plain-text
 * body live in the pure {@link import('./kanban-board.js')} module.
 *
 * @task T11933
 * @task T11934
 * @task T11980
 * @epic T11916
 */

import { createCleoClient } from '@cleocode/core/gateway-client';
import { type SpawnGatewayOptions, spawnGatewayIfDown } from '../gateway-auto-start.js';
import {
  isPiTuiAvailable,
  loadPiTui,
  PI_TUI_INSTALL_HINT,
  type PiTuiModule,
  type TuiInstance,
} from '../pi-tui-loader.js';
import {
  buildConductorLane,
  clampTier,
  dispatchWorker,
  renderConductorLane,
  type SpawnTier,
} from './dispatch.js';
import {
  buildKanbanBoard,
  type KanbanBoard,
  type KanbanCard,
  type KanbanLaneColumn,
  renderKanbanBoardText,
  type TuiTaskRow,
} from './kanban-board.js';
import { type SseSubscription, subscribeOrchestrateEvents } from './sse-client.js';
import {
  applyWorkerStreamFrame,
  emptyWorkerStreamView,
  renderWorkerStreamPanel,
  type WorkerStreamView,
} from './worker-stream.js';

/** The default loopback gateway base URL (`cleo daemon serve` listener). */
export const DEFAULT_TUI_BASE_URL = 'http://127.0.0.1:7777';

/**
 * The dispatch function the cockpit calls to spawn a worker. Defaults to the
 * real {@link dispatchWorker} (SDK → gateway); overridable by unit tests so the
 * dispatch action is exercisable without a daemon. Mirrors the
 * {@link import('./dispatch.js').dispatchWorker} signature.
 */
export type DispatchFn = typeof dispatchWorker;

/**
 * The SSE subscribe function the cockpit calls to tail a Running card's worker
 * stream. Defaults to the real {@link subscribeOrchestrateEvents}; overridable
 * by unit tests so the stream wiring is exercisable without a socket.
 */
export type SubscribeFn = typeof subscribeOrchestrateEvents;

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
  /**
   * Override the worker-dispatch function (test seam). Defaults to the real
   * SDK-backed {@link dispatchWorker}.
   */
  readonly dispatch?: DispatchFn;
  /**
   * Override the SSE subscribe function (test seam). Defaults to the real
   * {@link subscribeOrchestrateEvents}.
   */
  readonly subscribe?: SubscribeFn;
  /**
   * When `true` (default), attempt to auto-start the gateway via
   * {@link spawnGatewayIfDown} when it is not reachable. Set to `false` to
   * disable auto-start and fall back to the static "start the daemon" hint.
   *
   * Callers MUST check `daemon.autoStart` in the project config before passing
   * `true` here (see {@link shouldAutoStartGateway} in gateway-auto-start.ts).
   *
   * @default true
   */
  readonly autoStart?: boolean;
  /**
   * Override gateway spawn options (test seam for {@link spawnGatewayIfDown}).
   * Only used when `autoStart` is `true`.
   */
  readonly spawnOpts?: SpawnGatewayOptions;
}

/** A line-emitting sink (defaults to stdout) — injectable for tests. */
export type LineSink = (line: string) => void;

/** Outcome of a cockpit boot, surfaced to the command for exit-code mapping. */
export interface CockpitResult {
  /**
   * What happened:
   *  - `'rendered'`       — board rendered (interactive or `--once`).
   *  - `'degraded-pi'`    — pi-tui absent; plain-text fallback rendered.
   *  - `'daemon-down'`    — daemon unreachable (auto-start disabled or timed out).
   */
  readonly outcome: 'rendered' | 'degraded-pi' | 'daemon-down';
  /** The base URL the cockpit targeted. */
  readonly baseUrl: string;
  /** Whether the rich pi-tui renderer was used. */
  readonly piTui: boolean;
  /** Whether the gateway was auto-started by this invocation (T11980). */
  readonly gatewayAutoStarted?: boolean;
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

/** Lanes a card may be DISPATCHED from (`d`/Enter spawns a worker). */
const DISPATCHABLE_LANES: ReadonlySet<string> = new Set(['backlog', 'ready']);

/**
 * A pi-tui {@link import('../pi-tui-loader.js').Component} that renders the
 * Kanban board's plain-text body, tracks lane AND card keyboard focus, owns the
 * confirm-gated dispatch action (T11935), and renders the live worker stream
 * panel for a focused Running card (T11936).
 *
 * The board-body render is the SAME body the fallback prints (so the two paths
 * can never diverge); the focus indicator, status line, conductor lane, and
 * worker panel are appended below it. ALL dispatch + SSE go through injected
 * functions ({@link DispatchFn} / {@link SubscribeFn}) — the component never
 * imports a core domain or shells out (T11935 · AC3).
 */
class KanbanBoardComponent {
  /** Index of the lane that currently holds keyboard focus. */
  private focusedLane = 0;
  /** Index of the focused card WITHIN the focused lane. */
  private focusedCard = 0;
  /** Two-step confirm latch — set on the first dispatch key, cleared on action/move. */
  private confirming = false;
  /** Spawn tier for the next dispatch (cycled with `t`). */
  private tier: SpawnTier = 1;
  /** A transient single-line status message (dispatch result / hint). */
  private status = '';
  /** The folded worker-stream view for the focused Running card, or null. */
  private workerView: WorkerStreamView | null = null;
  /** The task id the worker panel is currently bound to. */
  private workerTaskId: string | null = null;
  /** The live SSE subscription for the worker panel, or null. */
  private workerSub: SseSubscription | null = null;

  constructor(
    private board: KanbanBoard,
    private readonly deps: {
      readonly baseUrl: string;
      readonly dispatch: DispatchFn;
      readonly subscribe: SubscribeFn;
      /** Ask the loop to re-render (set by the loop after construction). */
      requestRender?: () => void;
      /** Ask the loop to re-fetch + rebuild the board (set by the loop). */
      refresh?: () => Promise<void>;
    },
  ) {}

  /** Wire the render/refresh callbacks the loop owns. */
  bind(requestRender: () => void, refresh: () => Promise<void>): void {
    this.deps.requestRender = requestRender;
    this.deps.refresh = refresh;
  }

  /** Replace the board model (e.g. after a refresh) and clamp focus. */
  setBoard(board: KanbanBoard): void {
    this.board = board;
    if (this.focusedLane >= board.columns.length) this.focusedLane = 0;
    this.clampCardFocus();
    // If the focused card moved off the Running lane, drop the worker stream.
    this.reconcileWorkerPanel();
  }

  /** The currently-focused lane column, or undefined. */
  private currentLane(): KanbanLaneColumn | undefined {
    return this.board.columns[this.focusedLane];
  }

  /** The currently-focused card, or undefined. */
  focusedCardModel(): KanbanCard | undefined {
    return this.currentLane()?.cards[this.focusedCard];
  }

  /** Keep {@link focusedCard} within the focused lane's card range. */
  private clampCardFocus(): void {
    const count = this.currentLane()?.cards.length ?? 0;
    if (count === 0) {
      this.focusedCard = 0;
      return;
    }
    if (this.focusedCard >= count) this.focusedCard = count - 1;
    if (this.focusedCard < 0) this.focusedCard = 0;
  }

  /** Move keyboard focus one lane right (wraps), resetting card focus. */
  focusNextLane(): void {
    const n = this.board.columns.length || 1;
    this.focusedLane = (this.focusedLane + 1) % n;
    this.focusedCard = 0;
    this.confirming = false;
    this.clampCardFocus();
    this.reconcileWorkerPanel();
  }

  /** Move keyboard focus one lane left (wraps), resetting card focus. */
  focusPrevLane(): void {
    const n = this.board.columns.length || 1;
    this.focusedLane = (this.focusedLane - 1 + n) % n;
    this.focusedCard = 0;
    this.confirming = false;
    this.clampCardFocus();
    this.reconcileWorkerPanel();
  }

  /** Move card focus down within the lane (wraps). */
  focusNextCard(): void {
    const count = this.currentLane()?.cards.length ?? 0;
    if (count === 0) return;
    this.focusedCard = (this.focusedCard + 1) % count;
    this.confirming = false;
    this.reconcileWorkerPanel();
  }

  /** Move card focus up within the lane (wraps). */
  focusPrevCard(): void {
    const count = this.currentLane()?.cards.length ?? 0;
    if (count === 0) return;
    this.focusedCard = (this.focusedCard - 1 + count) % count;
    this.confirming = false;
    this.reconcileWorkerPanel();
  }

  /** The id of the currently-focused lane (for the status bar / tests). */
  focusedLaneId(): string {
    return this.currentLane()?.lane ?? '';
  }

  /** Cycle the spawn tier 1 → 2 → 0 → 1 (for the next dispatch). */
  cycleTier(): void {
    this.tier = clampTier((this.tier + 1) % 3);
  }

  /** The current spawn tier (for tests / status). */
  currentTier(): SpawnTier {
    return this.tier;
  }

  /** The current transient status line (for tests). */
  statusLine(): string {
    return this.status;
  }

  /** Whether the component is awaiting a dispatch confirm (for tests). */
  isConfirming(): boolean {
    return this.confirming;
  }

  /**
   * Handle the dispatch key (`d` / Enter) on the focused card.
   *
   * Two-step confirm — spawning is real + expensive. The first press latches
   * `confirming` and shows the confirm prompt; the second press performs the
   * spawn via the injected dispatch fn (SDK → gateway), surfaces the result
   * inline, and (on success) re-fetches so the worker lands in the Running lane.
   * NEVER throws — a failed dispatch sets the status line, never crashes.
   */
  async requestDispatch(): Promise<void> {
    const lane = this.focusedLaneId();
    const card = this.focusedCardModel();
    if (card === undefined) {
      this.status = 'No card focused to dispatch.';
      this.deps.requestRender?.();
      return;
    }
    if (!DISPATCHABLE_LANES.has(lane)) {
      this.status = `Dispatch is only available on Backlog/Ready cards (focused: ${lane}).`;
      this.confirming = false;
      this.deps.requestRender?.();
      return;
    }
    if (!this.confirming) {
      this.confirming = true;
      this.status = `Spawn a real worker for ${card.id} (tier ${this.tier})? Press [d] again to confirm, [Esc] to cancel.`;
      this.deps.requestRender?.();
      return;
    }

    // Second press — perform the spawn.
    this.confirming = false;
    this.status = `Dispatching ${card.id} (tier ${this.tier})…`;
    this.deps.requestRender?.();

    const result = await this.deps.dispatch(this.deps.baseUrl, card.id, this.tier);
    if (result.ok) {
      this.status = `Dispatched ${result.taskId} → Running (tier ${result.tier}).`;
      // Re-fetch so the spawned worker surfaces in the Running lane.
      await this.deps.refresh?.();
    } else {
      this.status = `Dispatch failed for ${result.taskId}: ${result.code} — ${result.message}`;
    }
    this.deps.requestRender?.();
  }

  /** Clear the confirm latch (Esc) without dispatching. */
  cancelConfirm(): void {
    if (this.confirming) {
      this.confirming = false;
      this.status = 'Dispatch cancelled.';
      this.deps.requestRender?.();
    }
  }

  /**
   * Bind / rebind the live worker stream to the focused card when (and only
   * when) it is a Running card, tearing down any prior subscription. Idempotent
   * for the same task — re-focusing the same Running card does not churn the
   * socket.
   */
  private reconcileWorkerPanel(): void {
    const lane = this.focusedLaneId();
    const card = this.focusedCardModel();
    const targetId = lane === 'running' && card !== undefined ? card.id : null;

    if (targetId === this.workerTaskId) return; // No change — keep the stream.

    // Detach the previous stream first (clean unsubscribe on blur).
    this.teardownWorkerPanel();

    if (targetId === null) return; // Focused card is not a Running worker.

    this.workerTaskId = targetId;
    this.workerView = emptyWorkerStreamView();
    this.workerSub = this.deps.subscribe(
      { baseUrl: this.deps.baseUrl, taskId: targetId },
      {
        onFrame: (frame) => {
          // Drop late frames for a card we've since blurred away from.
          if (this.workerTaskId !== targetId || this.workerView === null) return;
          this.workerView = applyWorkerStreamFrame(this.workerView, frame);
          this.deps.requestRender?.();
        },
        onError: (reason) => {
          if (this.workerTaskId !== targetId) return;
          this.status = `Worker stream for ${targetId} unavailable: ${reason}`;
          this.deps.requestRender?.();
        },
      },
    );
  }

  /** Tear down the active worker subscription + panel state (leak-free). */
  teardownWorkerPanel(): void {
    if (this.workerSub !== null) {
      this.workerSub.unsubscribe();
      this.workerSub = null;
    }
    this.workerView = null;
    this.workerTaskId = null;
  }

  /** No cached state to clear — render is pure over the current board. */
  invalidate(): void {}

  /** Render the board body plus the focus indicator, dispatch affordances,
   * conductor lane, status line, and (on a Running card) the worker panel. */
  render(_width: number): string[] {
    const lines = renderKanbanBoardText(this.board);
    const lane = this.currentLane();
    const card = this.focusedCardModel();

    // Focus indicator — lane + the specific focused card.
    const focusCard = card !== undefined ? `${card.id}` : '—';
    lines.push(`Focus: ${lane?.label ?? '—'} › ${focusCard}   (tier ${this.tier})`);

    // Conductor role lane for a dispatchable focused card.
    if (card !== undefined && DISPATCHABLE_LANES.has(lane?.lane ?? '')) {
      lines.push(renderConductorLane(buildConductorLane(card.id, card.assignee)));
    }

    // Live worker stream panel for a focused Running card (T11936).
    if (this.workerView !== null && this.workerTaskId !== null) {
      for (const l of renderWorkerStreamPanel(this.workerTaskId, this.workerView)) {
        lines.push(l);
      }
    }

    // Transient status line (dispatch result / confirm prompt / hint).
    if (this.status.length > 0) lines.push(this.status);

    lines.push(
      '[←/→ h/l] lane   [↑/↓ j/k] card   [Tab] cycle lane   [d/Enter] dispatch   ' +
        '[t] tier   [Esc] cancel   [r] refresh   [q] quit',
    );
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

    // Wire the component's render + refresh callbacks. Async dispatch results,
    // SSE frames, and the post-dispatch re-fetch all drive a re-render through
    // these, so the component never references the loop directly.
    component.bind(
      () => tui.requestRender(),
      async () => {
        await refresh();
        tui.requestRender(true);
      },
    );

    const dispose = tui.addInputListener((data: string) => {
      // Quit — tear the worker stream down first so no socket leaks.
      if (data === 'q' || data === '' /* Ctrl-C */) {
        component.teardownWorkerPanel();
        dispose();
        tui.stop();
        resolve();
        return { consume: true };
      }
      // Lane navigation (arrow keys + vim h/l + Tab).
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
      // Card navigation within the focused lane (arrow keys + vim j/k).
      if (data === '[B' || data === 'j') {
        component.focusNextCard();
        tui.requestRender();
        return { consume: true };
      }
      if (data === '[A' || data === 'k') {
        component.focusPrevCard();
        tui.requestRender();
        return { consume: true };
      }
      // Dispatch (confirm-gated) — `d` or Enter (CR/LF). requestDispatch drives
      // its own re-renders via the bound callback (it awaits the async SDK spawn).
      if (data === 'd' || data === '\r' || data === '\n') {
        void component.requestDispatch();
        return { consume: true };
      }
      // Cycle the spawn tier for the next dispatch.
      if (data === 't') {
        component.cycleTier();
        tui.requestRender();
        return { consume: true };
      }
      // Cancel a pending dispatch confirm (Esc).
      if (data === '') {
        component.cancelConfirm();
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
 * When `options.autoStart` is `true` (default) and the gateway is unreachable,
 * this function first attempts to spawn the gateway on-demand via
 * {@link spawnGatewayIfDown} before falling back to the "start it yourself"
 * hint. NEVER activates a systemd service unit.
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
  // Dispatch + SSE go through these (test-overridable; default to the real
  // SDK-backed implementations — NO core domain import, NO CLI shell-out).
  const dispatch: DispatchFn = options.dispatch ?? dispatchWorker;
  const subscribe: SubscribeFn = options.subscribe ?? subscribeOrchestrateEvents;

  // Derive port/host from baseUrl for the auto-start probe.
  let gatewayAutoStarted = false;
  const autoStart = options.autoStart !== false; // default true

  // 1. Fetch home data through the SDK. null ⇒ daemon unreachable.
  let rows = await fetchTaskRows(baseUrl);

  if (rows === null && autoStart) {
    // Auto-start path (T11980): spawn `cleo daemon serve` as a detached child
    // and wait for it to accept connections. NEVER touches the systemd service.
    let port: number | undefined;
    let host: string | undefined;
    try {
      const u = new URL(baseUrl);
      const parsed = Number.parseInt(u.port, 10);
      port = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      host = u.hostname || undefined;
    } catch {
      // URL parse failure — use gateway-auto-start defaults.
    }
    const spawnResult = await spawnGatewayIfDown({
      ...(options.spawnOpts ?? {}),
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
    });
    if (spawnResult.reachable) {
      gatewayAutoStarted = spawnResult.spawned;
      // Re-fetch now that the gateway is up.
      rows = await fetchTaskRows(baseUrl);
    }
  }

  if (rows === null) {
    sink('CLEO cockpit: the daemon gateway is not reachable.');
    sink(`  Tried: ${baseUrl}/v1`);
    sink('  Start it with:  cleo daemon serve');
    sink('  (override the target with:  cleo tui --base-url <url>)');
    return { outcome: 'daemon-down', baseUrl, piTui: false, gatewayAutoStarted };
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
      return { outcome: 'degraded-pi', baseUrl, piTui: false, gatewayAutoStarted };
    }
    return { outcome: 'rendered', baseUrl, piTui: false, gatewayAutoStarted };
  }

  // 3. Rich interactive board.
  const piTui = await loadPiTui();
  if (piTui === null) {
    // Race/edge: availability said yes but load failed — degrade safely.
    for (const line of renderKanbanBoardText(board)) sink(line);
    sink('');
    sink(PI_TUI_INSTALL_HINT);
    return { outcome: 'degraded-pi', baseUrl, piTui: false, gatewayAutoStarted };
  }

  const component = new KanbanBoardComponent(board, { baseUrl, dispatch, subscribe });
  const refresh = async (): Promise<void> => {
    const fresh = await fetchTaskRows(baseUrl);
    if (fresh !== null) component.setBoard(buildKanbanBoard(fresh));
  };
  await runInteractiveLoop(piTui, component, refresh);
  return { outcome: 'rendered', baseUrl, piTui: true, gatewayAutoStarted };
}

/** Exported for unit tests — the focusable board component. */
export { KanbanBoardComponent };

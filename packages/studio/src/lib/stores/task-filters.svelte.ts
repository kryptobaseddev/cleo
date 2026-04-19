/**
 * Shared Task Explorer filter store (W0B of T949 · T951).
 *
 * Single source of truth for the `/tasks` Task Explorer filter state. Every
 * filter mutation is round-tripped through the URL search-string so any view
 * of Studio can share a filter configuration via a link. All pages under
 * `/tasks/*` (dashboard + 3 Explorer tabs) consume this module.
 *
 * ## Design
 *
 * - **Reactivity**: Svelte 5 `$state` rune drives reactive updates in
 *   consumer components. The file uses the `.svelte.ts` suffix so the Svelte
 *   compiler rewrites runes into reactive primitives.
 * - **URL contract** (see `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §8):
 *
 *   | Field       | Query param                   | Encoding           |
 *   | ----------- | ----------------------------- | ------------------ |
 *   | `query`     | `?q=`                         | string             |
 *   | `status`    | `?status=pending,active,done` | CSV                |
 *   | `priority`  | `?priority=high,medium`       | CSV                |
 *   | `labels`    | `?labels=a,b,c`               | CSV                |
 *   | `epic`      | `?epic=T123`                  | single value       |
 *   | `selected`  | `?selected=T123`              | single value       |
 *   | `cancelled` | `?cancelled=1` (present=true) | presence-boolean   |
 *   | `view`      | `?view=hierarchy\|graph\|kanban` | enum (default `hierarchy`) |
 *
 * - **Legacy deprecation**: `?deferred=1` is still read as
 *   `cancelled=true` and emits a one-time `console.warn` until T958 renames
 *   the param cluster officially.
 * - **Debouncing**: `setQuery` writes to history are debounced (~150 ms) to
 *   avoid spamming the session history with every keystroke.
 * - **Deterministic ordering**: all CSV params are serialized in a stable
 *   sort order so round-tripping state → URL → state is idempotent.
 *
 * ## Usage
 *
 * ```ts
 * // In a +page.svelte inside /tasks/*
 * import { page } from '$app/stores';
 * import { createTaskFilters } from '$lib/stores/task-filters.svelte';
 *
 * const filters = createTaskFilters($page.url);
 * // Reactive reads:
 * filters.state.query;
 * filters.state.status;
 * // Mutations (auto-sync to URL):
 * filters.setQuery('T123');
 * filters.toggleStatus('pending');
 * filters.setView('graph');
 * ```
 *
 * @epic T949
 * @task T951
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
import { TASK_STATUSES } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Valid Task Explorer tab identifiers.
 *
 * - `hierarchy` — collapsible tree across epics.
 * - `graph` — d3-force dependency graph.
 * - `kanban` — status-axis kanban (distinct from `/tasks/pipeline`).
 */
export type TaskView = 'hierarchy' | 'graph' | 'kanban';

/**
 * All Task Explorer filter fields in a plain shape suitable for snapshotting,
 * serializing, and diffing.
 */
export interface TaskFilterState {
  /** Free-text search query (`?q=`). Case-insensitive title substring. */
  query: string;
  /** Multi-select status chips (`?status=a,b,c`). */
  status: TaskStatus[];
  /** Multi-select priority chips (`?priority=a,b,c`). */
  priority: TaskPriority[];
  /** Multi-select label filter (`?labels=a,b,c`). */
  labels: string[];
  /** Epic drill-down (`?epic=T123`). `null` = no epic scope. */
  epic: string | null;
  /** Currently-selected task id driving the drawer (`?selected=T123`). */
  selected: string | null;
  /**
   * Include cancelled epics (`?cancelled=1`). Also reads legacy `?deferred=1`
   * as `true` until T958 completes the rename.
   */
  cancelled: boolean;
  /** Active Explorer tab (`?view=hierarchy|graph|kanban`). Default `hierarchy`. */
  view: TaskView;
}

/**
 * Handle returned by {@link createTaskFilters}. Exposes reactive state plus
 * typed setters; every setter round-trips the mutation to `window.location`
 * via `history.replaceState`.
 */
export interface TaskFilters {
  /**
   * Reactive snapshot of the current filter state. Svelte 5 components that
   * access fields on `state` are automatically subscribed to updates.
   *
   * The returned object is {@link TaskFilterState}; it is frozen from the
   * consumer's perspective — use the setter methods to mutate.
   */
  readonly state: TaskFilterState;
  /**
   * Replace the free-text search query. URL writes are debounced (~150 ms)
   * to avoid history-spam while the user types.
   *
   * @param q - The new query string (empty to clear).
   */
  setQuery(q: string): void;
  /**
   * Toggle a {@link TaskStatus} in the multi-select chip row.
   *
   * @param s - The status to toggle on/off.
   */
  toggleStatus(s: TaskStatus): void;
  /**
   * Toggle a {@link TaskPriority} in the multi-select chip row.
   *
   * @param p - The priority to toggle on/off.
   */
  togglePriority(p: TaskPriority): void;
  /**
   * Toggle a label in the multi-select dropdown.
   *
   * @param l - The label name to toggle on/off.
   */
  toggleLabel(l: string): void;
  /**
   * Set the epic drill-down. Pass `null` to clear.
   *
   * @param id - Epic task id, or `null` to show all epics.
   */
  setEpic(id: string | null): void;
  /**
   * Set the currently-selected task id for the detail drawer. Pass `null` to
   * close the drawer.
   *
   * @param id - Task id, or `null` to close the drawer.
   */
  setSelected(id: string | null): void;
  /**
   * Set the `cancelled` toggle (include cancelled epics).
   *
   * @param v - `true` to include, `false` to hide.
   */
  setCancelled(v: boolean): void;
  /**
   * Switch the active Explorer tab.
   *
   * @param v - The tab to activate.
   */
  setView(v: TaskView): void;
  /**
   * Reset every filter to its default empty state and clear the URL params.
   * `view` returns to `'hierarchy'`; everything else empties.
   */
  clear(): void;
  /**
   * Tear down any registered listeners (e.g. the popstate handler). Consumer
   * components SHOULD call this from an `$effect` cleanup function when the
   * page unmounts.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default view when `?view=` is missing or invalid. */
const DEFAULT_VIEW: TaskView = 'hierarchy';

/** Valid {@link TaskView} values — used for parsing incoming URL params. */
const VALID_VIEWS: ReadonlySet<TaskView> = new Set(['hierarchy', 'graph', 'kanban']);

/** Valid {@link TaskPriority} values — used for parsing incoming URL params. */
const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set(['critical', 'high', 'medium', 'low']);

/** Debounce window for `setQuery` URL writes (ms). */
const QUERY_DEBOUNCE_MS = 150;

/**
 * One-time guard so we only warn about legacy `?deferred=1` once per runtime,
 * regardless of how many filter instances read it.
 */
let deferredWarningEmitted = false;

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated URL parameter into an array of validated string
 * values. Unknown or empty tokens are dropped silently.
 *
 * @param raw - The raw query-string value (e.g. `"pending,active"`) or `null`.
 * @param validate - Predicate narrowing a string to a typed enum member.
 * @returns The parsed, de-duplicated array in source order.
 */
function parseCsv<T extends string>(raw: string | null, validate: (v: string) => v is T): T[] {
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (validate(t) && !seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

/** Type-guard for {@link TaskStatus}. */
function isTaskStatus(v: string): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v);
}

/** Type-guard for {@link TaskPriority}. */
function isTaskPriority(v: string): v is TaskPriority {
  return VALID_PRIORITIES.has(v as TaskPriority);
}

/** Type-guard for {@link TaskView}. */
function isTaskView(v: string): v is TaskView {
  return VALID_VIEWS.has(v as TaskView);
}

/** Pass-through validator for free-form label names (non-empty tokens). */
function isNonEmptyLabel(v: string): v is string {
  return v.length > 0;
}

/**
 * Read a {@link TaskFilterState} from a {@link URL}.
 *
 * Honours the legacy `?deferred=1` alias for `?cancelled=1` and emits a
 * one-time `console.warn` the first time the alias is encountered.
 *
 * @param url - The URL to parse.
 * @returns A fresh {@link TaskFilterState}.
 */
function readFromUrl(url: URL): TaskFilterState {
  const p = url.searchParams;

  const cancelledFlag = p.get('cancelled') === '1';
  const deferredFlag = p.get('deferred') === '1';
  if (deferredFlag && !deferredWarningEmitted) {
    deferredWarningEmitted = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[task-filters] ?deferred=1 is deprecated; use ?cancelled=1. ' +
        'Alias removal tracked by T958.',
    );
  }

  const viewRaw = p.get('view');
  const view: TaskView = viewRaw && isTaskView(viewRaw) ? viewRaw : DEFAULT_VIEW;

  return {
    query: p.get('q') ?? '',
    status: parseCsv(p.get('status'), isTaskStatus),
    priority: parseCsv(p.get('priority'), isTaskPriority),
    labels: parseCsv(p.get('labels'), isNonEmptyLabel),
    epic: p.get('epic'),
    selected: p.get('selected'),
    cancelled: cancelledFlag || deferredFlag,
    view,
  };
}

/**
 * Apply a {@link TaskFilterState} onto a fresh {@link URL} and return it.
 *
 * - Empty values, empty arrays, default view, and `cancelled:false` all
 *   result in the corresponding param being deleted (minimal URL).
 * - CSV arrays are serialized in source order — callers should ensure
 *   stable ordering if they want idempotent round-trips (setters do).
 *
 * @param base - The URL to clone and mutate (typically `window.location`).
 * @param state - The filter state to serialize.
 * @returns A new {@link URL} instance with only the relevant params set.
 */
function writeToUrl(base: URL, state: TaskFilterState): URL {
  const next = new URL(base.toString());
  const p = next.searchParams;

  // Remove any legacy/deprecated alias so we do not emit both forms.
  p.delete('deferred');

  setOrDelete(p, 'q', state.query || null);
  setOrDelete(p, 'status', state.status.length ? state.status.join(',') : null);
  setOrDelete(p, 'priority', state.priority.length ? state.priority.join(',') : null);
  setOrDelete(p, 'labels', state.labels.length ? state.labels.join(',') : null);
  setOrDelete(p, 'epic', state.epic);
  setOrDelete(p, 'selected', state.selected);
  setOrDelete(p, 'cancelled', state.cancelled ? '1' : null);
  setOrDelete(p, 'view', state.view === DEFAULT_VIEW ? null : state.view);

  return next;
}

/** Write `value` to `params[key]` if non-null/non-empty, otherwise delete. */
function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value === null || value === '') {
    params.delete(key);
  } else {
    params.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Task Explorer filter store bound to a URL.
 *
 * The initial state is parsed from `url`. Subsequent mutations both update
 * the reactive state and write the new query string to `window.history` via
 * `replaceState`. On `popstate` (browser back/forward), state is re-read from
 * `window.location` so filters stay in sync with navigation.
 *
 * Server-side / test environments without `window` skip the browser-specific
 * hookup but remain fully reactive in memory.
 *
 * @param url - The initial URL whose query string seeds the state.
 * @returns A {@link TaskFilters} handle exposing reactive state plus setters.
 *
 * @example
 * ```ts
 * const filters = createTaskFilters($page.url);
 * filters.setQuery('pomodoro');
 * filters.toggleStatus('active');
 * // URL is now /tasks?q=pomodoro&status=active
 * ```
 */
export function createTaskFilters(url: URL): TaskFilters {
  const state = $state<TaskFilterState>(readFromUrl(url));

  let queryDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let popstateHandler: (() => void) | null = null;

  /**
   * Write the current state to `window.history`. Called after every mutation
   * (debounced for `setQuery`).
   */
  function syncUrl(): void {
    if (typeof window === 'undefined') return;
    const next = writeToUrl(new URL(window.location.href), state);
    // Only write if something actually changed, to avoid spurious entries.
    if (next.search !== window.location.search) {
      window.history.replaceState(window.history.state, '', next.toString());
    }
  }

  /** Schedule or coalesce a debounced `syncUrl` call for query updates. */
  function scheduleQuerySync(): void {
    if (typeof window === 'undefined') return;
    if (queryDebounceTimer !== null) {
      clearTimeout(queryDebounceTimer);
    }
    queryDebounceTimer = setTimeout(() => {
      queryDebounceTimer = null;
      syncUrl();
    }, QUERY_DEBOUNCE_MS);
  }

  /** Re-read state from `window.location` (popstate handler). */
  function readFromWindow(): void {
    if (typeof window === 'undefined') return;
    const fresh = readFromUrl(new URL(window.location.href));
    state.query = fresh.query;
    state.status = fresh.status;
    state.priority = fresh.priority;
    state.labels = fresh.labels;
    state.epic = fresh.epic;
    state.selected = fresh.selected;
    state.cancelled = fresh.cancelled;
    state.view = fresh.view;
  }

  if (typeof window !== 'undefined') {
    popstateHandler = readFromWindow;
    window.addEventListener('popstate', popstateHandler);
  }

  /** Toggle membership of `value` in `arr` (mutates in place; stable order). */
  function toggleIn<T>(arr: T[], value: T): T[] {
    const idx = arr.indexOf(value);
    if (idx === -1) return [...arr, value];
    return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
  }

  return {
    get state(): TaskFilterState {
      return state;
    },

    setQuery(q: string): void {
      state.query = q;
      scheduleQuerySync();
    },

    toggleStatus(s: TaskStatus): void {
      state.status = toggleIn(state.status, s);
      syncUrl();
    },

    togglePriority(p: TaskPriority): void {
      state.priority = toggleIn(state.priority, p);
      syncUrl();
    },

    toggleLabel(l: string): void {
      state.labels = toggleIn(state.labels, l);
      syncUrl();
    },

    setEpic(id: string | null): void {
      state.epic = id;
      syncUrl();
    },

    setSelected(id: string | null): void {
      state.selected = id;
      syncUrl();
    },

    setCancelled(v: boolean): void {
      state.cancelled = v;
      syncUrl();
    },

    setView(v: TaskView): void {
      state.view = v;
      syncUrl();
    },

    clear(): void {
      state.query = '';
      state.status = [];
      state.priority = [];
      state.labels = [];
      state.epic = null;
      state.selected = null;
      state.cancelled = false;
      state.view = DEFAULT_VIEW;
      // Flush any pending debounced query write before clearing the URL.
      if (queryDebounceTimer !== null) {
        clearTimeout(queryDebounceTimer);
        queryDebounceTimer = null;
      }
      syncUrl();
    },

    dispose(): void {
      if (queryDebounceTimer !== null) {
        clearTimeout(queryDebounceTimer);
        queryDebounceTimer = null;
      }
      if (popstateHandler !== null && typeof window !== 'undefined') {
        window.removeEventListener('popstate', popstateHandler);
        popstateHandler = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/**
 * @internal
 * Reset the one-time `?deferred=1` warning guard. Intended ONLY for tests
 * that need to verify the warning fires exactly once.
 */
export function __resetDeferredWarningGuardForTests(): void {
  deferredWarningEmitted = false;
}

/**
 * @internal
 * Pure helper re-exported for tests that round-trip state ↔ URL without
 * spinning up a full filter instance.
 */
export const __internals = {
  readFromUrl,
  writeToUrl,
};

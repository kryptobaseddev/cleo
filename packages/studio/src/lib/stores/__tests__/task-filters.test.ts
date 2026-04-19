/**
 * Tests for the shared Task Explorer filter store (T951).
 *
 * Covers:
 * 1. Initial parse from URL
 * 2. Every setter mutation
 * 3. Toggle semantics (add/remove)
 * 4. URL write after mutation (history.replaceState)
 * 5. Clear resets state + URL
 * 6. Legacy `?deferred=1` alias + one-time console warning
 * 7. Round-trip: state → URL → state idempotency
 * 8. Dispose tear-down
 *
 * @task T951
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __internals,
  __resetDeferredWarningGuardForTests,
  createTaskFilters,
  type TaskFilterState,
} from '../task-filters.svelte.js';

// ---------------------------------------------------------------------------
// Minimal window / history mock (vitest runs in node env, no DOM)
// ---------------------------------------------------------------------------

interface MockWindow {
  location: { href: string; search: string };
  history: {
    state: unknown;
    replaceState: ReturnType<typeof vi.fn>;
  };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

/**
 * Install a mock `window` on the global scope with a mutable URL. Returns
 * helpers so tests can inspect history calls and fire popstate events.
 */
function installMockWindow(initialHref: string): {
  win: MockWindow;
  setHref(href: string): void;
  firePopstate(): void;
  restore(): void;
} {
  let href = initialHref;
  const listeners: Array<() => void> = [];

  const win: MockWindow = {
    location: {
      get href() {
        return href;
      },
      get search() {
        return new URL(href).search;
      },
    } as { href: string; search: string },
    history: {
      state: null,
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        href = new URL(url, href).toString();
      }),
    },
    addEventListener: vi.fn((evt: string, cb: () => void) => {
      if (evt === 'popstate') listeners.push(cb);
    }),
    removeEventListener: vi.fn((evt: string, cb: () => void) => {
      if (evt !== 'popstate') return;
      const idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
  };

  // @ts-expect-error — assigning a partial window mock onto globalThis for test isolation
  globalThis.window = win;

  return {
    win,
    setHref(next: string): void {
      href = next;
    },
    firePopstate(): void {
      for (const cb of listeners) cb();
    },
    restore(): void {
      // @ts-expect-error — cleaning up the partial window assignment
      globalThis.window = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let env: ReturnType<typeof installMockWindow>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetDeferredWarningGuardForTests();
  env = installMockWindow('https://studio.cleo.dev/tasks');
});

afterEach(() => {
  vi.useRealTimers();
  env.restore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTaskFilters', () => {
  describe('initial parse', () => {
    it('seeds empty state from a bare URL', () => {
      const f = createTaskFilters(new URL('https://studio.cleo.dev/tasks'));
      expect(f.state).toEqual<TaskFilterState>({
        query: '',
        status: [],
        priority: [],
        labels: [],
        epic: null,
        selected: null,
        cancelled: false,
        view: 'hierarchy',
      });
    });

    it('parses every param from a fully-populated URL', () => {
      const url = new URL(
        'https://studio.cleo.dev/tasks' +
          '?q=pomodoro' +
          '&status=pending,active' +
          '&priority=high,medium' +
          '&labels=ui,backend' +
          '&epic=T949' +
          '&selected=T951' +
          '&cancelled=1' +
          '&view=graph',
      );
      const f = createTaskFilters(url);
      expect(f.state).toEqual<TaskFilterState>({
        query: 'pomodoro',
        status: ['pending', 'active'],
        priority: ['high', 'medium'],
        labels: ['ui', 'backend'],
        epic: 'T949',
        selected: 'T951',
        cancelled: true,
        view: 'graph',
      });
    });

    it('drops unknown status / priority / view tokens defensively', () => {
      const url = new URL(
        'https://studio.cleo.dev/tasks?status=pending,bogus&priority=high,nope&view=sideways',
      );
      const f = createTaskFilters(url);
      expect(f.state.status).toEqual(['pending']);
      expect(f.state.priority).toEqual(['high']);
      expect(f.state.view).toBe('hierarchy');
    });
  });

  describe('setters + URL writes', () => {
    it('setQuery updates state immediately and writes URL after debounce', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      f.setQuery('T123');
      expect(f.state.query).toBe('T123');
      // Immediate: URL has NOT been written yet.
      expect(env.win.history.replaceState).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(env.win.history.replaceState).toHaveBeenCalledTimes(1);
      const [, , wrote] = env.win.history.replaceState.mock.calls[0];
      expect(new URL(wrote).searchParams.get('q')).toBe('T123');
    });

    it('rapid setQuery calls coalesce into one URL write', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      f.setQuery('a');
      f.setQuery('ab');
      f.setQuery('abc');
      vi.advanceTimersByTime(150);
      expect(env.win.history.replaceState).toHaveBeenCalledTimes(1);
      const [, , wrote] = env.win.history.replaceState.mock.calls[0];
      expect(new URL(wrote).searchParams.get('q')).toBe('abc');
      // State reflects the latest keystroke synchronously.
      expect(f.state.query).toBe('abc');
    });

    it('toggleStatus adds then removes on repeat', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      f.toggleStatus('pending');
      expect(f.state.status).toEqual(['pending']);
      expect(env.win.history.replaceState).toHaveBeenCalledTimes(1);
      f.toggleStatus('active');
      expect(f.state.status).toEqual(['pending', 'active']);
      f.toggleStatus('pending');
      expect(f.state.status).toEqual(['active']);
      const lastCall =
        env.win.history.replaceState.mock.calls[env.win.history.replaceState.mock.calls.length - 1];
      expect(new URL(lastCall[2]).searchParams.get('status')).toBe('active');
    });

    it('togglePriority, toggleLabel, setEpic, setSelected, setCancelled, setView all sync URL', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      f.togglePriority('high');
      f.toggleLabel('ui');
      f.setEpic('T949');
      f.setSelected('T951');
      f.setCancelled(true);
      f.setView('graph');

      // Each non-debounced setter triggers exactly one synchronous URL write.
      expect(env.win.history.replaceState).toHaveBeenCalledTimes(6);

      const finalCall = env.win.history.replaceState.mock.calls[5];
      const finalUrl = new URL(finalCall[2]);
      expect(finalUrl.searchParams.get('priority')).toBe('high');
      expect(finalUrl.searchParams.get('labels')).toBe('ui');
      expect(finalUrl.searchParams.get('epic')).toBe('T949');
      expect(finalUrl.searchParams.get('selected')).toBe('T951');
      expect(finalUrl.searchParams.get('cancelled')).toBe('1');
      expect(finalUrl.searchParams.get('view')).toBe('graph');
    });

    it('setView="hierarchy" clears the ?view param (default elides)', () => {
      // Synchronize the mock browser location with the seed URL so the
      // syncUrl() diff ("did the search string change?") fires correctly.
      env.setHref('https://studio.cleo.dev/tasks?view=graph');
      const f = createTaskFilters(new URL(env.win.location.href));
      expect(f.state.view).toBe('graph');
      f.setView('hierarchy');
      expect(f.state.view).toBe('hierarchy');
      const lastCall =
        env.win.history.replaceState.mock.calls[env.win.history.replaceState.mock.calls.length - 1];
      expect(new URL(lastCall[2]).searchParams.has('view')).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets every field and clears URL params', () => {
      const url = new URL(
        'https://studio.cleo.dev/tasks?q=x&status=active&priority=high&labels=a&epic=T1&selected=T2&cancelled=1&view=graph',
      );
      // Update mock location so syncUrl reads from the populated URL first.
      env.setHref(url.toString());
      const f = createTaskFilters(url);
      expect(f.state.query).toBe('x');
      f.clear();
      expect(f.state).toEqual<TaskFilterState>({
        query: '',
        status: [],
        priority: [],
        labels: [],
        epic: null,
        selected: null,
        cancelled: false,
        view: 'hierarchy',
      });
      const lastCall =
        env.win.history.replaceState.mock.calls[env.win.history.replaceState.mock.calls.length - 1];
      const cleared = new URL(lastCall[2]);
      for (const key of [
        'q',
        'status',
        'priority',
        'labels',
        'epic',
        'selected',
        'cancelled',
        'view',
      ]) {
        expect(cleared.searchParams.has(key)).toBe(false);
      }
    });
  });

  describe('legacy ?deferred=1 alias', () => {
    it('reads as cancelled:true and warns exactly once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = createTaskFilters(new URL('https://studio.cleo.dev/tasks?deferred=1'));
      expect(a.state.cancelled).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      // Second instance also sees the legacy param but warning only fires once.
      const b = createTaskFilters(new URL('https://studio.cleo.dev/tasks?deferred=1'));
      expect(b.state.cancelled).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('strips ?deferred=1 when writing so the URL canonicalises to ?cancelled=1', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      env.setHref('https://studio.cleo.dev/tasks?deferred=1');
      const f = createTaskFilters(new URL(env.win.location.href));
      expect(f.state.cancelled).toBe(true);
      // Trigger a sync by toggling something benign.
      f.setView('graph');
      const lastCall =
        env.win.history.replaceState.mock.calls[env.win.history.replaceState.mock.calls.length - 1];
      const next = new URL(lastCall[2]);
      expect(next.searchParams.has('deferred')).toBe(false);
      expect(next.searchParams.get('cancelled')).toBe('1');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('round-trip idempotency', () => {
    it('state -> URL -> state yields equivalent state for every field', () => {
      const seed: TaskFilterState = {
        query: 'hello world',
        status: ['active', 'done'],
        priority: ['critical', 'medium'],
        labels: ['alpha', 'beta'],
        epic: 'T900',
        selected: 'T901',
        cancelled: true,
        view: 'kanban',
      };
      const base = new URL('https://studio.cleo.dev/tasks');
      const serialized = __internals.writeToUrl(base, seed);
      const parsed = __internals.readFromUrl(serialized);
      expect(parsed).toEqual(seed);
    });

    it('empty state -> URL -> state is stable (no leftover params)', () => {
      const empty: TaskFilterState = {
        query: '',
        status: [],
        priority: [],
        labels: [],
        epic: null,
        selected: null,
        cancelled: false,
        view: 'hierarchy',
      };
      const base = new URL('https://studio.cleo.dev/tasks?leftover=remove_me');
      const serialized = __internals.writeToUrl(base, empty);
      const parsed = __internals.readFromUrl(serialized);
      expect(parsed).toEqual(empty);
      // Unrelated params are untouched; filter params are absent.
      expect(serialized.searchParams.has('q')).toBe(false);
      expect(serialized.searchParams.has('status')).toBe(false);
      expect(serialized.searchParams.has('view')).toBe(false);
      expect(serialized.searchParams.get('leftover')).toBe('remove_me');
    });
  });

  describe('dispose', () => {
    it('removes the popstate listener and clears pending debounce', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      expect(env.win.addEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
      f.setQuery('x');
      // Debounce still pending when we dispose.
      f.dispose();
      vi.advanceTimersByTime(200);
      expect(env.win.history.replaceState).not.toHaveBeenCalled();
      expect(env.win.removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
    });

    it('re-reads state on popstate', () => {
      const f = createTaskFilters(new URL(env.win.location.href));
      expect(f.state.view).toBe('hierarchy');
      // Simulate browser back/forward navigating to a different filter state.
      env.setHref('https://studio.cleo.dev/tasks?view=graph&epic=T900&status=active');
      env.firePopstate();
      expect(f.state.view).toBe('graph');
      expect(f.state.epic).toBe('T900');
      expect(f.state.status).toEqual(['active']);
      f.dispose();
    });
  });
});

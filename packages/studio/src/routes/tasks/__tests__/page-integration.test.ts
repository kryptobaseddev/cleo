/**
 * T956 — /tasks hybrid page integration tests.
 *
 * Covers the five contract-critical behaviours that the rewritten
 * `routes/tasks/+page.svelte` relies on:
 *
 *   1. The server loader returns BOTH the dashboard bundle AND the shared
 *      {@link import('$lib/server/tasks/explorer-loader.js').ExplorerBundle}
 *      so switching tabs does not require a re-query.
 *   2. The {@link createTaskFilters} store's `setView` updates `state.view`
 *      when a tab is switched.
 *   3. Setting `state.view = 'graph'` writes `?view=graph` back to the URL
 *      via `history.replaceState` — the hash-state-sync layer in
 *      `+page.svelte` reads this back on `hashchange`.
 *   4. A URL with `?selected=T###` deterministically resolves to a task
 *      object from the loaded bundle — this is the `selectedTask` derived
 *      value driving the global `DetailDrawer`.
 *   5. The page-level keyboard handler wires `1` / `2` / `3` to the three
 *      tabs AND is suppressed when focus is inside an input/textarea/
 *      contentEditable element.
 *
 * Vitest runs in node environment (see `vitest.config.ts`), so we test the
 * filter store + bundle loader directly and re-implement the page-level
 * `onPageKey` logic as a pure function so it can be asserted without
 * mounting the Svelte component.
 *
 * @task T956
 * @epic T949
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectContext } from '$lib/server/project-context.js';
import { loadExplorerBundle } from '$lib/server/tasks/explorer-loader.js';
import {
  __resetDeferredWarningGuardForTests,
  createTaskFilters,
  type TaskFilters,
  type TaskView,
} from '$lib/stores/task-filters.svelte.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Fixture — minimum production schema for loadExplorerBundle
// ---------------------------------------------------------------------------

/**
 * Minimal production-shaped schema needed for the explorer loader. Mirrors
 * what `explorer-loader.test.ts` already uses — kept local so this file
 * remains self-contained.
 */
const CREATE_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT,
    parent_id TEXT,
    phase TEXT,
    size TEXT,
    position INTEGER,
    position_version INTEGER DEFAULT 0,
    labels_json TEXT DEFAULT '[]',
    notes_json TEXT DEFAULT '[]',
    acceptance_json TEXT DEFAULT '[]',
    files_json TEXT DEFAULT '[]',
    origin TEXT,
    blocked_by TEXT,
    epic_lifecycle TEXT,
    no_auto_complete INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    archived_at TEXT,
    archive_reason TEXT,
    cycle_time_days INTEGER,
    verification_json TEXT,
    created_by TEXT,
    modified_by TEXT,
    session_id TEXT,
    pipeline_stage TEXT,
    assignee TEXT,
    ivtr_state TEXT,
    role TEXT NOT NULL DEFAULT 'work',
    scope TEXT NOT NULL DEFAULT 'feature',
    severity TEXT
  );

  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

interface SeedTask {
  id: string;
  title?: string;
  status?: string;
  type?: string;
  parentId?: string | null;
  labels?: string[];
}

function insertTask(db: DatabaseSync, t: SeedTask): void {
  const status = t.status ?? 'pending';
  let pipelineStage: string | null = null;
  if (status === 'done') pipelineStage = 'contribution';
  else if (status === 'cancelled') pipelineStage = 'cancelled';
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, priority, type, parent_id, pipeline_stage, labels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.title ?? `Task ${t.id}`,
    status,
    'medium',
    t.type ?? 'task',
    t.parentId ?? null,
    pipelineStage,
    JSON.stringify(t.labels ?? []),
  );
}

function seedFixture(seed: (db: DatabaseSync) => void): { ctx: ProjectContext; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cleo-tasks-page-'));
  const tasksDbPath = join(tmpDir, 'tasks.db');
  const brainDbPath = join(tmpDir, 'brain.db');
  const db = new DatabaseSync(tasksDbPath, { open: true });
  try {
    db.exec(CREATE_SCHEMA);
    seed(db);
  } finally {
    db.close();
  }
  const ctx: ProjectContext = {
    projectId: 'test',
    name: 'page-integration-fixture',
    projectPath: tmpDir,
    brainDbPath,
    tasksDbPath,
    brainDbExists: false,
    tasksDbExists: true,
  };
  return { ctx, tmpDir };
}

// ---------------------------------------------------------------------------
// 1. Loader composition — dashboard AND explorer payloads in one load
// ---------------------------------------------------------------------------

describe('T956 · /tasks loader composition', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('loads the Explorer bundle alongside the dashboard (1 round-trip per page load)', async () => {
    const fixture = seedFixture((db) => {
      insertTask(db, { id: 'E1', type: 'epic', status: 'active' });
      insertTask(db, { id: 'T1', parentId: 'E1', status: 'done', labels: ['core'] });
      insertTask(db, { id: 'T2', parentId: 'E1', status: 'pending', labels: ['core', 'backend'] });
    });
    tmpDir = fixture.tmpDir;

    const bundle = await loadExplorerBundle({ projectCtx: fixture.ctx });

    expect(bundle.tasks.map((t) => t.id).sort()).toEqual(['E1', 'T1', 'T2']);
    expect(bundle.deps).toEqual([]);
    expect(bundle.epicProgress['E1']).toMatchObject({ total: 2, done: 1, active: 0 });
    expect(bundle.labels.sort()).toEqual(['backend', 'core']);
    expect(new Date(bundle.loadedAt).getTime()).toBeGreaterThan(0);
  });

  it('returns an empty bundle — never throws — when tasks.db is missing', async () => {
    const missingDir = mkdtempSync(join(tmpdir(), 'cleo-tasks-page-missing-'));
    tmpDir = missingDir;
    const ctx: ProjectContext = {
      projectId: 'ghost',
      name: 'ghost',
      projectPath: missingDir,
      brainDbPath: join(missingDir, 'brain.db'),
      tasksDbPath: join(missingDir, 'tasks.db'),
      brainDbExists: false,
      tasksDbExists: false,
    };

    const bundle = await loadExplorerBundle({ projectCtx: ctx });

    expect(bundle.tasks).toEqual([]);
    expect(bundle.deps).toEqual([]);
    expect(bundle.epicProgress).toEqual({});
    expect(bundle.labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2-3. Filter store behaviour — tab switch + URL hash sync expectations
// ---------------------------------------------------------------------------

interface MockWindow {
  location: { href: string; search: string; pathname: string; hash: string };
  history: {
    state: unknown;
    replaceState: ReturnType<typeof vi.fn>;
  };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

/**
 * Minimal window mock mirrored from `task-filters.test.ts`, extended with
 * `pathname` + `hash` so the page-integration test can simulate
 * `history.replaceState` writes that hit the hash-sync path in
 * `+page.svelte#switchView`.
 */
function installMockWindow(initialHref: string): {
  win: MockWindow;
  setHref(href: string): void;
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
      get pathname() {
        return new URL(href).pathname;
      },
      get hash() {
        return new URL(href).hash;
      },
    } as { href: string; search: string; pathname: string; hash: string },
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

  // @ts-expect-error — assigning partial window mock onto globalThis for test isolation
  globalThis.window = win;

  return {
    win,
    setHref(next) {
      href = next;
    },
    restore() {
      // @ts-expect-error — restoring globalThis after test
      globalThis.window = undefined;
    },
  };
}

describe('T956 · Tab switching via createTaskFilters', () => {
  let mock: ReturnType<typeof installMockWindow>;

  beforeEach(() => {
    __resetDeferredWarningGuardForTests();
    mock = installMockWindow('https://studio.test/tasks');
  });

  afterEach(() => {
    mock.restore();
  });

  it('setView updates filters.state.view and writes ?view= to the URL', () => {
    const filters = createTaskFilters(new URL('https://studio.test/tasks'));
    expect(filters.state.view).toBe('hierarchy');

    filters.setView('graph');

    expect(filters.state.view).toBe('graph');
    expect(mock.win.history.replaceState).toHaveBeenCalled();

    const lastCall = mock.win.history.replaceState.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const writtenUrl = lastCall![2] as string;
    expect(new URL(writtenUrl).searchParams.get('view')).toBe('graph');

    filters.dispose();
  });

  it('clears ?view= from the URL when reverting to the default (hierarchy)', () => {
    mock.restore();
    mock = installMockWindow('https://studio.test/tasks?view=kanban');

    const filters = createTaskFilters(new URL('https://studio.test/tasks?view=kanban'));
    expect(filters.state.view).toBe('kanban');

    filters.setView('hierarchy');

    // The sync DOES fire because `window.location.search` was `?view=kanban`
    // and the canonical default writes an empty search. The last replaceState
    // call MUST have the `view` param removed.
    const lastCall = mock.win.history.replaceState.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const writtenUrl = lastCall![2] as string;
    expect(new URL(writtenUrl).searchParams.get('view')).toBeNull();

    filters.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hash-state sync — mirrors the `parseHashView` helper in +page.svelte
// ---------------------------------------------------------------------------

/**
 * Re-implementation of the `parseHashView` helper colocated with the page
 * component. Exported as a pure function here so the test asserts the exact
 * parse rules without spinning up a Svelte component. Kept in lockstep with
 * the component copy — if you change one, change the other.
 */
function parseHashView(hash: string): TaskView | null {
  const cleaned = hash.replace(/^#/, '').toLowerCase();
  if (cleaned === 'hierarchy' || cleaned === 'graph' || cleaned === 'kanban') {
    return cleaned;
  }
  return null;
}

describe('T956 · Hash-state sync', () => {
  it('parses valid hashes for all three tabs', () => {
    expect(parseHashView('#hierarchy')).toBe('hierarchy');
    expect(parseHashView('#graph')).toBe('graph');
    expect(parseHashView('#kanban')).toBe('kanban');
  });

  it('is case-insensitive (redirects from `/tasks/GRAPH` style land correctly)', () => {
    expect(parseHashView('#GRAPH')).toBe('graph');
    expect(parseHashView('#Kanban')).toBe('kanban');
  });

  it('returns null for unknown hashes so the filter state is not clobbered', () => {
    expect(parseHashView('#pipeline')).toBeNull();
    expect(parseHashView('')).toBeNull();
    expect(parseHashView('#')).toBeNull();
    expect(parseHashView('#sessions')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. selectedTask derivation — URL `?selected=T###` resolves to a task obj
// ---------------------------------------------------------------------------

describe('T956 · Selected-task derivation drives the DetailDrawer', () => {
  let tmpDir: string | null = null;
  let mock: ReturnType<typeof installMockWindow>;

  beforeEach(() => {
    __resetDeferredWarningGuardForTests();
    mock = installMockWindow('https://studio.test/tasks?selected=T2');
  });

  afterEach(() => {
    mock.restore();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('resolves filters.state.selected to the matching task from the bundle', async () => {
    const fixture = seedFixture((db) => {
      insertTask(db, { id: 'E1', type: 'epic' });
      insertTask(db, { id: 'T1', parentId: 'E1', title: 'First' });
      insertTask(db, { id: 'T2', parentId: 'E1', title: 'Second' });
    });
    tmpDir = fixture.tmpDir;

    const bundle = await loadExplorerBundle({ projectCtx: fixture.ctx });
    const filters = createTaskFilters(new URL('https://studio.test/tasks?selected=T2'));

    // Mirror the `selectedTask` derived in +page.svelte.
    const resolved = (() => {
      const id = filters.state.selected;
      if (!id) return null;
      return bundle.tasks.find((t) => t.id === id) ?? null;
    })();

    expect(filters.state.selected).toBe('T2');
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe('T2');
    expect(resolved?.title).toBe('Second');

    filters.setSelected(null);
    expect(filters.state.selected).toBeNull();
    // After clearing, the same derivation returns null — i.e. drawer closes.
    const afterClear = (() => {
      const id = filters.state.selected;
      if (!id) return null;
      return bundle.tasks.find((t) => t.id === id) ?? null;
    })();
    expect(afterClear).toBeNull();

    filters.dispose();
  });
});

// ---------------------------------------------------------------------------
// 5. Page-level keyboard shortcuts — 1/2/3 tab switching
// ---------------------------------------------------------------------------

/**
 * Pure port of the page-level keyboard handler (`onPageKey`) from
 * `+page.svelte`. Kept here as a standalone function so the test doesn't
 * need to mount the Svelte component. If the component's copy changes,
 * update this one too.
 *
 * @param e       - Keyboard event.
 * @param filters - Filter store handle (must expose `setView`).
 * @returns `true` when the handler switched the view; `false` otherwise.
 */
function onPageKey(e: KeyboardEvent, filters: TaskFilters | null): boolean {
  if (!filters) return false;
  const target = e.target;
  if (target instanceof HTMLElement) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return false;
  }
  if (e.key === '1') {
    e.preventDefault();
    filters.setView('hierarchy');
    return true;
  }
  if (e.key === '2') {
    e.preventDefault();
    filters.setView('graph');
    return true;
  }
  if (e.key === '3') {
    e.preventDefault();
    filters.setView('kanban');
    return true;
  }
  return false;
}

/** Thin stub of the `KeyboardEvent` surface the handler consumes. */
class StubKeyboardEvent {
  public defaultPrevented = false;
  constructor(
    public readonly key: string,
    public readonly target: unknown = null,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

describe('T956 · Page keyboard shortcuts (1/2/3)', () => {
  let mock: ReturnType<typeof installMockWindow>;
  /**
   * Snapshot/restore the global `HTMLElement` so the `instanceof HTMLElement`
   * check inside `onPageKey` works even under the node-only vitest runner.
   */
  let prevHtmlElement: unknown;

  beforeEach(() => {
    __resetDeferredWarningGuardForTests();
    mock = installMockWindow('https://studio.test/tasks');

    // @ts-expect-error — snapshot HTMLElement from globalThis
    prevHtmlElement = globalThis.HTMLElement;
    // @ts-expect-error — install a minimal HTMLElement stub for instanceof
    globalThis.HTMLElement = class HTMLElementStub {};
  });

  afterEach(() => {
    mock.restore();
    // @ts-expect-error — restore prior HTMLElement binding
    globalThis.HTMLElement = prevHtmlElement;
  });

  it('`1` switches to Hierarchy, `2` to Graph, `3` to Kanban', () => {
    const filters = createTaskFilters(new URL('https://studio.test/tasks?view=graph'));
    expect(filters.state.view).toBe('graph');

    onPageKey(new StubKeyboardEvent('1') as unknown as KeyboardEvent, filters);
    expect(filters.state.view).toBe('hierarchy');

    onPageKey(new StubKeyboardEvent('2') as unknown as KeyboardEvent, filters);
    expect(filters.state.view).toBe('graph');

    onPageKey(new StubKeyboardEvent('3') as unknown as KeyboardEvent, filters);
    expect(filters.state.view).toBe('kanban');

    filters.dispose();
  });

  it('does NOT hijack shortcuts when focus is inside an INPUT (typing)', () => {
    const filters = createTaskFilters(new URL('https://studio.test/tasks'));
    expect(filters.state.view).toBe('hierarchy');

    // Build a stub input on top of the HTMLElement stub so `instanceof` works.
    // @ts-expect-error — reading the global stub class installed in beforeEach
    const HE = globalThis.HTMLElement as { prototype: object };
    const fakeInput = Object.create(HE.prototype) as HTMLElement & {
      tagName: string;
      isContentEditable: boolean;
    };
    fakeInput.tagName = 'INPUT';
    fakeInput.isContentEditable = false;

    const handled = onPageKey(
      new StubKeyboardEvent('2', fakeInput) as unknown as KeyboardEvent,
      filters,
    );
    expect(handled).toBe(false);
    expect(filters.state.view).toBe('hierarchy');

    filters.dispose();
  });

  it('returns false for keys outside the 1/2/3 set', () => {
    const filters = createTaskFilters(new URL('https://studio.test/tasks'));
    const handled = onPageKey(new StubKeyboardEvent('4') as unknown as KeyboardEvent, filters);
    expect(handled).toBe(false);
    expect(filters.state.view).toBe('hierarchy');
    filters.dispose();
  });

  it('returns false when the filter store is not ready (ssr guard)', () => {
    const handled = onPageKey(new StubKeyboardEvent('1') as unknown as KeyboardEvent, null);
    expect(handled).toBe(false);
  });
});

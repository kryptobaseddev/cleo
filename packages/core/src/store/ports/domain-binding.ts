/**
 * Path-keyed domain binding registry — the single owner of every per-domain
 * Drizzle wrapper in the CLEO runtime.
 *
 * ## Why this module exists (E6-L13 · T12037)
 *
 * Before this leaf, each store facade (`sqlite.ts`, `memory-sqlite.ts`,
 * `conduit-sqlite.ts`, `nexus-sqlite.ts`, `skills-db.ts`) owned its OWN
 * process-global singleton quartet:
 *
 * ```ts
 * let _db: NodeSQLiteDatabase | null = null;
 * let _nativeDb: DatabaseSync | null = null;
 * let _dbPath: string | null = null;
 * let _initPromise: Promise<NodeSQLiteDatabase> | null = null;
 * ```
 *
 * Five independent caches over ONE shared `DatabaseSync` produced a documented
 * class of defects:
 *
 * - **Last-project-wins** — `_dbPath` held a single project. Touching project B
 *   reset the singleton, so an interleaved project-A query re-opened and
 *   re-migrated on every alternation (thrash, not just slowness).
 * - **Cross-domain staleness** — the tasks singleton could reference a
 *   `DatabaseSync` that the brain domain had already closed (T12019/T12020),
 *   surfacing as `database is not open` or, worse, a silently-nulled
 *   `sourceSessionId`.
 * - **Band-aid retry loops** — both `getDb` and `getBrainDb` grew bounded
 *   re-acquisition loops (T12035) purely to paper over the above.
 *
 * This module replaces all five with ONE registry keyed by
 * `${scope}::${canonical dbPath}::${domain}`, layered on the
 * {@link CleoRuntime} store registry (T12036). A binding is valid only while
 * the {@link ProjectStore} / {@link GlobalStore} instance it was established
 * against is still the one the runtime hands out AND its native handle is
 * open. Any eviction — a `close()`, a `_resetDualScopeDbCache`, an external
 * teardown — yields a fresh store object, which invalidates every binding
 * derived from it by identity comparison. No liveness polling, no retry loop,
 * no "last opened project".
 *
 * ## What a domain owns after this leaf
 *
 * A domain owns its `establish` function — the schema reconciliation it must
 * run against a native handle (legacy Drizzle wrapping, `runMigrations`,
 * vec0 extension loading, seed rows). It no longer owns caching, path
 * resolution, single-flight, or liveness. Those are this module's job.
 *
 * @packageDocumentation
 * @task T12037 (E6-L13)
 * @epic T11249 (E6)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { worktreeScope } from '../../project-scope.js';
import {
  type CleoRuntime,
  createCleoRuntime,
  type GlobalStore,
  type ProjectStore,
  resolveDualScopeDbPath,
  withStoreSchemaOwnership,
} from '../dual-scope-db.js';

/**
 * The process-wide {@link CleoRuntime} instance backing every domain port.
 *
 * A single runtime is correct here: the runtime registry is itself path-keyed,
 * so one instance serves every project the process touches. It is lazily
 * constructed so importing this module has no side effects (a hard constraint
 * — the Gate-13 chokepoint audit rejects import-time DB work).
 */
let _runtime: CleoRuntime | null = null;

/**
 * Get (or lazily create) the process-wide {@link CleoRuntime}.
 *
 * @returns The shared runtime store registry.
 */
export function getCleoRuntime(): CleoRuntime {
  if (!_runtime) {
    _runtime = createCleoRuntime();
  }
  return _runtime;
}

/**
 * Tear down the process-wide runtime: close every registry entry and drop
 * every domain binding. The next {@link getCleoRuntime} call builds a fresh
 * registry.
 *
 * Used by full-teardown paths (`closeAllDatabases`) and by tests that need a
 * pristine process state between cases.
 */
export function resetCleoRuntime(): void {
  releaseAllDomainBindings();
  if (_runtime) {
    try {
      _runtime.closeAll();
    } catch {
      // Best-effort teardown — the registry is discarded either way.
    }
    _runtime = null;
  }
}

/**
 * A domain's live binding to one store.
 *
 * @typeParam TDb - The domain's Drizzle handle type (its legacy schema shape).
 */
export interface DomainBinding<TDb, TStore extends ProjectStore | GlobalStore> {
  /** The store this binding was established against. */
  readonly store: TStore;
  /** The native `DatabaseSync` extracted from {@link store}. */
  readonly native: DatabaseSync;
  /** The domain-typed Drizzle handle produced by the domain's `establish`. */
  readonly db: TDb;
}

/** Internal registry row — type-erased so one map serves every domain. */
interface BindingRow {
  store: ProjectStore | GlobalStore;
  native: DatabaseSync;
  db: unknown;
}

/**
 * Established bindings, keyed `${scope}::${canonical dbPath}::${domain}`.
 * Type-erased; {@link bindProjectDomain} re-applies the caller's type at the
 * boundary, which is sound because the key includes the domain id and each
 * domain passes exactly one `establish` shape.
 */
const _bindings = new Map<string, BindingRow>();

/**
 * In-flight `establish` calls, same keying as {@link _bindings}. Concurrent
 * binders for one key share a single establishment (single-flight).
 */
const _inflight = new Map<string, Promise<BindingRow>>();

/** Membership in one awaited establishment chain; never a handle or grant cache. */
interface DomainEstablishmentScope {
  readonly parent?: DomainEstablishmentScope;
  readonly key: string;
  active: boolean;
}

/** Detect recursive self-establishment before it can wait on its own single flight. */
const domainEstablishment = new AsyncLocalStorage<DomainEstablishmentScope>();

/**
 * Build the composite registry key for a domain binding.
 *
 * @param scope - The dual-scope discriminator.
 * @param dbPath - Canonical (already `path.resolve`d) database path.
 * @param domain - Stable domain id (e.g. `'tasks'`, `'brain'`).
 */
function bindingKey(scope: 'project' | 'global', dbPath: string, domain: string): string {
  return `${scope}::${dbPath}::${domain}`;
}

/**
 * Extract the underlying `DatabaseSync` from a store's Drizzle handle.
 *
 * Drizzle's `node:sqlite` driver exposes the native connection as `$client`.
 * This is the ONLY place that reach-through happens — domains receive the
 * already-extracted handle.
 *
 * @param store - The runtime store to unwrap.
 * @returns The live native connection.
 * @throws If the Drizzle handle exposes no `$client`.
 */
function nativeOf(store: ProjectStore | GlobalStore): DatabaseSync {
  const native = (store.db as { $client?: DatabaseSync }).$client;
  if (!native) {
    throw new Error(
      `T12037: CleoRuntime store for ${store.scope}::${store.dbPath} exposed no $client — ` +
        'cannot bind a domain schema to it.',
    );
  }
  return native;
}

/**
 * Reuse the cached binding for `key` if it is still valid.
 *
 * A binding is valid iff it was established against the SAME store instance
 * the runtime just returned (identity, not path — a reopened store is a new
 * object) and that store's native connection is still open.
 *
 * @param key - Composite registry key.
 * @param store - The store the runtime returned for this open.
 * @returns The still-valid row, or `undefined` if it must be re-established.
 */
function reuseValid(key: string, store: ProjectStore | GlobalStore): BindingRow | undefined {
  const row = _bindings.get(key);
  if (!row) return undefined;
  if (row.store !== store || !store.isOpen || !row.native.isOpen) {
    _bindings.delete(key);
    return undefined;
  }
  return row;
}

/**
 * Establish (or reuse) `domain`'s binding against a store, single-flighted.
 *
 * @param key - Composite registry key.
 * @param store - The store to bind against.
 * @param establish - Domain schema reconciliation.
 */
async function bindAgainst<TDb>(
  key: string,
  store: ProjectStore | GlobalStore,
  establish: (native: DatabaseSync, store: never) => TDb | Promise<TDb>,
): Promise<BindingRow> {
  const execution = worktreeScope.getStore()?.execution;
  execution?.assertActive();
  const cached = reuseValid(key, store);
  if (cached) return cached;
  const parent = domainEstablishment.getStore();
  for (let frame = parent; frame; frame = frame.parent) {
    if (frame.active && frame.key === key) {
      throw new Error(
        `Recursive domain establishment cannot await its own incomplete binding: ${key}`,
      );
    }
  }

  const pending = _inflight.get(key);
  if (pending) {
    const row = await pending;
    execution?.assertActive();
    // The in-flight establishment may have raced an eviction; re-validate.
    if (row.store === store && row.native.isOpen) return row;
    return bindAgainst(key, store, establish);
  }

  const native = nativeOf(store);
  const flight = (async (): Promise<BindingRow> => {
    const row = await withStoreSchemaOwnership(store, native, async () => {
      const membership: DomainEstablishmentScope = { parent, key, active: true };
      try {
        const db = await domainEstablishment.run(membership, () =>
          establish(native, store as never),
        );
        return { store, native, db };
      } finally {
        membership.active = false;
      }
    });
    // Ownership and file-generation checks complete before publishing the binding.
    // A deliberate callback close releases its independent lease handle first;
    // bindLive can then reacquire without waiting on its own stranded claim.
    if (store.isOpen && native.isOpen) {
      _bindings.set(key, row);
    }
    return row;
  })();

  _inflight.set(key, flight);
  try {
    return await flight;
  } finally {
    if (_inflight.get(key) === flight) {
      _inflight.delete(key);
    }
  }
}

/**
 * Maximum consecutive attempts to obtain a binding over a LIVE connection.
 *
 * The shared consolidated `DatabaseSync` can be closed in the microtask gap
 * between the runtime resolving a store and `establish` finishing against it
 * (another domain's `closeDb()`, a `_resetDualScopeDbCache`, a fire-and-forget
 * brain write crossing a test boundary). One reacquisition is enough: closing
 * the dead store evicts it from BOTH the runtime registry and the dual-scope
 * chokepoint cache, so the retry necessarily opens a fresh connection.
 *
 * Before this module each facade carried its own copy of this loop
 * (T12020 · T12035). It lives here now — one implementation, every domain.
 */
const MAX_LIVENESS_ATTEMPTS = 2;

/**
 * Obtain a binding whose connection is guaranteed live, with bounded
 * reacquisition.
 *
 * @param scope - Dual-scope discriminator, for the eviction filter.
 * @param key - Composite registry key.
 * @param dbPath - Canonical database path, for the eviction filter.
 * @param openStore - Opens (or reuses) the store for this key.
 * @param establish - Domain schema reconciliation.
 * @returns A row whose `native` was open at publication.
 * @throws When every attempt yielded a dead connection.
 */
async function bindLive<TDb>(
  scope: 'project' | 'global',
  key: string,
  dbPath: string,
  openStore: () => Promise<ProjectStore | GlobalStore>,
  establish: (native: DatabaseSync, store: never) => TDb | Promise<TDb>,
): Promise<BindingRow> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_LIVENESS_ATTEMPTS; attempt += 1) {
    let store: ProjectStore | GlobalStore;
    try {
      store = await openStore();
    } catch (err) {
      // The runtime's OWN bounded reacquisition can exhaust when a sibling
      // keeps closing the shared handle across a microtask boundary (a
      // fire-and-forget brain write crossing a test teardown is the usual
      // culprit). That is transient, not terminal: drop our bindings for the
      // path so the chokepoint cache is not holding a corpse, and take one
      // more pass. A genuinely broken open fails again and rethrows.
      lastError = err;
      releaseDomainBindings({ scope, dbPath });
      if (attempt + 1 >= MAX_LIVENESS_ATTEMPTS) throw err;
      continue;
    }

    try {
      const row = await bindAgainst(key, store, establish);
      if (row.store.isOpen && row.native.isOpen) return row;
    } catch (err) {
      // A connection closed mid-`establish` surfaces as "database is not
      // open" from the migration/DDL path. Retry once against a fresh
      // handle; a genuine schema error will fail again and rethrow below.
      lastError = err;
      if (store.isOpen) throw err;
    }

    // Dead handle. Closing the store evicts the runtime entry AND the
    // chokepoint cache entry, so the next attempt opens a fresh connection.
    releaseDomainBindings({ scope, dbPath });
    try {
      store.close();
    } catch {
      // Already closed — the eviction is what matters.
    }
  }

  if (lastError !== undefined) throw lastError;
  throw new Error(
    `T12037: could not bind ${key} over a live connection after ` +
      `${MAX_LIVENESS_ATTEMPTS} attempts — the consolidated handle was closed each time.`,
  );
}

/**
 * Bind a project-scope domain schema to the {@link ProjectStore} for `cwd`.
 *
 * This is the replacement for every `getXxxDb(cwd)` project-domain facade.
 * The returned binding carries the store itself, so callers that need a
 * cross-domain transaction hold an explicit handle rather than reaching for a
 * process global.
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param domain - Stable domain id; part of the registry key.
 * @param cwd - Project working directory. Resolved to the canonical
 *   `cleo.db` path and forwarded as `exodusCwd` so a port open arms the
 *   exodus-on-open auto-migration exactly like the facade it replaces.
 * @param establish - Reconcile the domain's schema against the native handle
 *   and return the domain-typed Drizzle instance. Called once per
 *   (path, domain, store instance); MUST be idempotent because a store
 *   eviction re-runs it.
 * @returns The live {@link DomainBinding}.
 */
export async function bindProjectDomain<TDb>(
  domain: string,
  cwd: string | undefined,
  establish: (native: DatabaseSync, store: ProjectStore) => TDb | Promise<TDb>,
): Promise<DomainBinding<TDb, ProjectStore>> {
  const dbPath = resolve(resolveDualScopeDbPath('project', cwd));
  const row = await bindLive(
    'project',
    bindingKey('project', dbPath, domain),
    dbPath,
    () => getCleoRuntime().openProject(dbPath, { exodusCwd: cwd }),
    establish,
  );
  return row as DomainBinding<TDb, ProjectStore>;
}

/**
 * Bind a project-scope domain schema to an EXPLICIT database path.
 *
 * Used by domains whose legacy lifecycle API accepted an on-disk path (test
 * fixtures, snapshot inspection). Never arms exodus-on-open — an explicit
 * path must not auto-migrate a legacy fleet into a fixture.
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param domain - Stable domain id.
 * @param dbPath - Absolute path to a consolidated `cleo.db`.
 * @param establish - See {@link bindProjectDomain}.
 */
export async function bindProjectDomainAtPath<TDb>(
  domain: string,
  dbPath: string,
  establish: (native: DatabaseSync, store: ProjectStore) => TDb | Promise<TDb>,
): Promise<DomainBinding<TDb, ProjectStore>> {
  const normalized = resolve(dbPath);
  const row = await bindLive(
    'project',
    bindingKey('project', normalized, domain),
    normalized,
    () => getCleoRuntime().openProject(normalized),
    establish,
  );
  return row as DomainBinding<TDb, ProjectStore>;
}

/**
 * Bind a global-scope domain schema to the {@link GlobalStore}.
 *
 * This is the replacement for every `getXxxDb()` global-domain facade
 * (nexus, skills, agents, telemetry).
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param domain - Stable domain id; part of the registry key.
 * @param establish - See {@link bindProjectDomain}.
 * @param cwd - Optional cwd forwarded as `exodusCwd` for the global scope's
 *   own legacy-fleet auto-migration.
 */
export async function bindGlobalDomain<TDb>(
  domain: string,
  establish: (native: DatabaseSync, store: GlobalStore) => TDb | Promise<TDb>,
  cwd?: string,
): Promise<DomainBinding<TDb, GlobalStore>> {
  const dbPath = resolve(resolveDualScopeDbPath('global'));
  const row = await bindLive(
    'global',
    bindingKey('global', dbPath, domain),
    dbPath,
    () => getCleoRuntime().openGlobal({ exodusCwd: cwd }),
    establish,
  );
  return row as DomainBinding<TDb, GlobalStore>;
}

/**
 * Bind a global-scope domain schema to an EXPLICIT database path.
 *
 * The path-aware sibling of {@link bindGlobalDomain}, for domains whose
 * lifecycle API accepts an on-disk path — notably the skills registry's
 * test-sandbox `{ path }` override. Never arms exodus-on-open.
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param domain - Stable domain id.
 * @param dbPath - Absolute path to a global-scope `cleo.db`.
 * @param establish - See {@link bindProjectDomain}.
 */
export async function bindGlobalDomainAtPath<TDb>(
  domain: string,
  dbPath: string,
  establish: (native: DatabaseSync, store: GlobalStore) => TDb | Promise<TDb>,
): Promise<DomainBinding<TDb, GlobalStore>> {
  const normalized = resolve(dbPath);
  const row = await bindLive(
    'global',
    bindingKey('global', normalized, domain),
    normalized,
    () => getCleoRuntime().openGlobalAt(normalized),
    establish,
  );
  return row as DomainBinding<TDb, GlobalStore>;
}

/**
 * Synchronously read an ALREADY-established binding at an EXPLICIT path.
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param scope - Dual-scope discriminator.
 * @param dbPath - Absolute database path.
 * @param domain - Stable domain id.
 */
export function peekDomainAtPath<TDb>(
  scope: 'project' | 'global',
  dbPath: string,
  domain: string,
): DomainBinding<TDb, ProjectStore | GlobalStore> | null {
  const row = _bindings.get(bindingKey(scope, resolve(dbPath), domain));
  if (!row?.native.isOpen) return null;
  return row as DomainBinding<TDb, ProjectStore | GlobalStore>;
}

/**
 * Drop cached bindings.
 *
 * Dropping a binding does NOT close any connection — the runtime registry and
 * the dual-scope chokepoint own connection lifecycle. This only forces the
 * next bind to re-run the domain's `establish`.
 *
 * @param filter - Restrict the drop. Omit any field to match all values of it.
 *   `{ scope: 'project' }` drops every project-domain binding;
 *   `{ domain: 'brain' }` drops the brain binding for every project.
 */
export function releaseDomainBindings(filter?: {
  scope?: 'project' | 'global';
  dbPath?: string;
  domain?: string;
}): void {
  if (!filter) {
    _bindings.clear();
    return;
  }
  const wantPath = filter.dbPath === undefined ? undefined : resolve(filter.dbPath);
  for (const key of [..._bindings.keys()]) {
    const sep = key.indexOf('::');
    const lastSep = key.lastIndexOf('::');
    const scope = key.slice(0, sep);
    const dbPath = key.slice(sep + 2, lastSep);
    const domain = key.slice(lastSep + 2);
    if (filter.scope !== undefined && scope !== filter.scope) continue;
    if (wantPath !== undefined && dbPath !== wantPath) continue;
    if (filter.domain !== undefined && domain !== filter.domain) continue;
    _bindings.delete(key);
  }
}

/**
 * Drop every cached binding in every scope. Equivalent to
 * `releaseDomainBindings()` with no filter; named for call-site clarity in
 * teardown paths.
 */
export function releaseAllDomainBindings(): void {
  _bindings.clear();
}

/**
 * Snapshot of currently-established binding keys.
 *
 * Read-only diagnostic surface for `cleo health` / architecture tests that
 * assert a process holds exactly one binding per (path, domain).
 */
export function boundDomainKeys(): ReadonlySet<string> {
  return new Set(_bindings.keys());
}

/**
 * Synchronously look up the native `DatabaseSync` of an ALREADY-established
 * project-domain binding.
 *
 * This exists solely to keep the legacy synchronous native getters
 * (`getNativeDb`, `getNativeTasksDb`, `getBrainNativeDb`) working while their
 * call sites migrate to the async binding. Unlike the module-global they
 * replace, this lookup is **path-keyed** — passing the caller's `cwd` returns
 * that project's handle rather than "whichever project was opened last".
 *
 * Returns `null` when nothing is bound yet or the connection has since
 * closed; callers must have awaited the domain's async binder first.
 *
 * @param domain - Stable domain id.
 * @param cwd - Project working directory; resolved to the canonical path.
 * @returns The live native connection, or `null`.
 *
 * @deprecated Read `.native` from the {@link DomainBinding} instead. Removed
 *   when the last synchronous native getter is retired (T12040 · E6-L16).
 */
export function boundProjectNative(domain: string, cwd?: string): DatabaseSync | null {
  return peekProjectDomain(domain, cwd)?.native ?? null;
}

/**
 * Synchronously read an ALREADY-established project-domain binding without
 * opening anything.
 *
 * Returns `null` when the domain is unbound for that project or its
 * connection has closed. Unlike {@link bindProjectDomain} this never triggers
 * an open, so it is safe on synchronous code paths (accessor predicates,
 * health probes) that must not force a migration.
 *
 * @typeParam TDb - The domain's Drizzle handle type, as passed to
 *   {@link bindProjectDomain}. Unchecked at runtime — the caller is
 *   responsible for using the same type it bound with.
 * @param domain - Stable domain id.
 * @param cwd - Project working directory.
 */
export function peekProjectDomain<TDb>(
  domain: string,
  cwd?: string,
): DomainBinding<TDb, ProjectStore> | null {
  const dbPath = resolve(resolveDualScopeDbPath('project', cwd));
  const row = _bindings.get(bindingKey('project', dbPath, domain));
  if (row?.native.isOpen) return row as DomainBinding<TDb, ProjectStore>;

  // An EXPLICIT `cwd` is a precise request: if that project is not bound, say
  // so. Never silently answer with a different project's connection — that is
  // the cross-project hazard this cutover exists to remove.
  if (cwd !== undefined) return null;

  // No `cwd` means "the project". Ambient resolution can still miss when the
  // caller bound an EXPLICIT project root that differs from the ambient one
  // (a test fixture, a tool operating on another checkout). Fall back ONLY
  // when the answer is unambiguous — exactly one project bound for this
  // domain. With two or more we return null, forcing the caller to pass a
  // `cwd`, which is precisely the situation where it must.
  const suffix = `::${domain}`;
  let sole: BindingRow | undefined;
  for (const [key, candidate] of _bindings) {
    if (!key.startsWith('project::') || !key.endsWith(suffix)) continue;
    if (!candidate.native.isOpen) continue;
    if (sole) return null; // ambiguous — the caller must disambiguate
    sole = candidate;
  }
  return (sole as DomainBinding<TDb, ProjectStore> | undefined) ?? null;
}

/**
 * Synchronous sibling of {@link peekProjectDomain} for the global scope.
 *
 * @typeParam TDb - The domain's Drizzle handle type.
 * @param domain - Stable domain id.
 */
export function peekGlobalDomain<TDb>(domain: string): DomainBinding<TDb, GlobalStore> | null {
  const dbPath = resolve(resolveDualScopeDbPath('global'));
  const row = _bindings.get(bindingKey('global', dbPath, domain));
  if (!row || !row.native.isOpen) return null;
  return row as DomainBinding<TDb, GlobalStore>;
}

/**
 * Synchronous sibling of {@link boundProjectNative} for the global scope.
 *
 * @param domain - Stable domain id.
 * @returns The live native connection, or `null`.
 *
 * @deprecated See {@link boundProjectNative}.
 */
export function boundGlobalNative(domain: string): DatabaseSync | null {
  return peekGlobalDomain(domain)?.native ?? null;
}

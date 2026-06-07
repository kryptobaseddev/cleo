/**
 * **session_manifest mirror writers** — best-effort GLOBAL-scope mirror of the
 * per-project `tasks_sessions` rows (EP-SESSION-MANIFEST · epic T11638 · task T11639).
 *
 * ## What this module does
 *
 * The authoritative session row lives per-project in `tasks_sessions` (PROJECT
 * scope `cleo.db`). These writers copy a compact projection of that row into the
 * `session_manifest` table in the GLOBAL-scope `cleo.db` so the fleet has a single,
 * machine-wide index of every session across every project — without ATTACHing N
 * per-project DB files. The manifest is a MIRROR, never the source of truth.
 *
 * ## Three invariants (the ACs of T11639)
 *
 * 1. **Shared handle, never closed (AC3).** All writes go through the singleton
 *    GLOBAL `cleo.db` handle returned by {@link openDualScopeDb}('global'). We NEVER
 *    call `.close()` on it — closing the cached handle would pull the rug from under
 *    every other global-scope reader/writer in the process.
 * 2. **Best-effort — never throw into the caller (AC3).** Every public writer here
 *    swallows ALL errors (log at debug + continue). A failure to mirror MUST NOT
 *    fail the underlying `cleo session start|end` / handoff op. The mirror is an
 *    observability convenience, not a correctness dependency.
 * 3. **MIRROR, never authoritative (AC4).** {@link reconcileSessionManifestOnStart}
 *    re-reads the AUTHORITATIVE project row and OVERWRITES the manifest row, so a
 *    stale or partially-written manifest entry can never drift into being treated as
 *    truth. Consumers needing exact session state read `tasks_sessions`.
 *
 * ## Identity (`project_id`)
 *
 * The mirror reuses the CANONICAL `nexus_project_registry.project_id` (12-hex) for
 * the owning project — resolved via the nexus identity helper — never a freshly
 * minted id. Nullable: a session started outside any resolvable registered project
 * still mirrors with `project_id` NULL.
 *
 * ## Writer lease (operating rule 5)
 *
 * Global-scope writes acquire the writer lease ({@link withWriterLease}) for
 * `(scope='global', lane='tasks')`, pinned to the global `cleo.db` path, so they
 * serialize with the cold-open and every other chokepoint write — healing T5158.
 *
 * @module
 * @task T11639
 * @epic T11638
 * @saga T11242
 * @see ../store/schema/cleo-global/session-manifest.ts — the table decl
 * @see ./index.ts — startSession/endSession call sites
 */

import type { Session } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import {
  type CleoGlobalDb,
  type DualScopeDbHandle,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../store/dual-scope-db.js';
import { sessionManifest } from '../store/schema/cleo-global/session-manifest.js';
import { withWriterLease } from '../store/writer-lease.js';

/**
 * Lazily-memoized module logger.
 *
 * Constructed on first use, never at import time: a top-level `getLogger(...)`
 * executes the logger factory during module init, which — when this module is
 * pulled into a test's mocked import graph — can reach a `vi.mock('../logger.js')`
 * factory before its module-scoped spy `const` is initialized, throwing a TDZ
 * `ReferenceError`. Deferring keeps import-time side-effect-free (operating rule 4),
 * matching the pattern in `writer-lease.ts` / `dual-scope-db.ts`.
 *
 * @task T11639
 */
let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('session-manifest-mirror');
  return _log;
}

/**
 * Ensure the GLOBAL `session_manifest` table exists and return the SHARED global
 * `cleo.db` handle (AC1).
 *
 * This is the named "ensure" entry point referenced by EP-SESSION-MANIFEST. It
 * opens (or re-uses) the singleton GLOBAL-scope handle via {@link openDualScopeDb},
 * whose migrate step runs the `session_manifest` migration idempotently — so the
 * table is guaranteed present after this resolves. The returned handle is the SHARED
 * singleton: callers MUST NOT close it.
 *
 * @returns The shared GLOBAL-scope {@link DualScopeDbHandle} (table ensured).
 * @task T11639
 */
export async function ensureGlobalSignaldockDb(): Promise<DualScopeDbHandle<'global'>> {
  // openDualScopeDb('global') runs the consolidated GLOBAL migrations (which now
  // include the session_manifest CREATE) under the cold-open lease, then caches +
  // returns the singleton handle. Idempotent — a re-call returns the same handle.
  return openDualScopeDb('global');
}

/**
 * Build the `session_manifest` mirror row from an authoritative {@link Session}
 * plus its resolved owning-project metadata.
 *
 * Pure projection — no I/O. `mirroredAt` is set to write time here so the row
 * records WHEN the mirror was last refreshed (independent of session activity).
 */
function toManifestRow(
  session: Session,
  projectId: string | null,
  projectPath: string | null,
): typeof sessionManifest.$inferInsert {
  return {
    sessionId: session.id,
    projectId,
    parentSessionId: session.parentSessionId ?? null,
    name: session.name ?? null,
    status: session.status ?? null,
    projectPath,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    mirroredAt: new Date().toISOString(),
  };
}

/**
 * Resolve the CANONICAL `nexus_project_registry.project_id` (12-hex) for a project
 * root, best-effort. Returns `null` when the project is not resolvable (e.g. not a
 * git repo / no canonical id) — the manifest row then carries a NULL `project_id`.
 *
 * Lazy `import()` of the nexus identity helper keeps this module's import graph
 * light and avoids a cycle (the nexus layer transitively imports the store).
 */
async function resolveCanonicalProjectId(projectRoot: string): Promise<string | null> {
  try {
    const { canonicalProjectId } = await import('../nexus/identity.js');
    const result = await canonicalProjectId(projectRoot);
    return result.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write (upsert) a single `session_manifest` mirror row through the GLOBAL handle,
 * under the writer lease. The PRIVATE core shared by the public best-effort writers.
 *
 * Throws on failure — the PUBLIC wrappers ({@link mirrorSessionToManifest} /
 * {@link reconcileSessionManifestOnStart}) are responsible for swallowing.
 */
async function upsertManifestRow(
  handle: DualScopeDbHandle<'global'>,
  row: typeof sessionManifest.$inferInsert,
): Promise<void> {
  const db: CleoGlobalDb = handle.db;
  // Operating rule 5: gate the GLOBAL-scope write through the writer lease, pinned
  // to the global cleo.db path so the lease row lands in THIS file.
  await withWriterLease(
    'global',
    'tasks',
    async () => {
      await db
        .insert(sessionManifest)
        .values(row)
        .onConflictDoUpdate({
          target: sessionManifest.sessionId,
          // Overwrite every mirrored column on conflict — the manifest is a pure
          // projection, so the latest write fully replaces the prior projection.
          set: {
            projectId: row.projectId,
            parentSessionId: row.parentSessionId,
            name: row.name,
            status: row.status,
            projectPath: row.projectPath,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            mirroredAt: row.mirroredAt,
          },
        })
        .run();
    },
    { dbPath: handle.dbPath },
  );
}

/**
 * Best-effort mirror of a session into the GLOBAL `session_manifest` (AC3).
 *
 * Call on session start / end / handoff. Resolves the owning project's canonical
 * `project_id`, ensures the table + shared handle, and upserts the mirror row. ANY
 * failure (DB unopenable, write error, identity-resolution failure) is logged at
 * debug and SWALLOWED — this NEVER throws into the caller, so a mirror failure
 * cannot fail the underlying session op.
 *
 * @param projectRoot - Absolute path to the project whose session is being mirrored
 *   (used to resolve the canonical `project_id` and `project_path`).
 * @param session - The authoritative {@link Session} (post-mutation) to mirror.
 * @task T11639
 */
export async function mirrorSessionToManifest(
  projectRoot: string,
  session: Session,
): Promise<void> {
  try {
    const handle = await ensureGlobalSignaldockDb();
    const projectId = await resolveCanonicalProjectId(projectRoot);
    const row = toManifestRow(session, projectId, projectRoot);
    await upsertManifestRow(handle, row);
  } catch (err) {
    // Best-effort: a mirror failure MUST NOT fail the session op (AC3).
    log().debug(
      { sessionId: session.id, err: err instanceof Error ? err.message : err },
      'session_manifest mirror write failed (non-fatal); session op unaffected',
    );
  }
}

/**
 * Reconcile-on-start: re-read the AUTHORITATIVE project session row and OVERWRITE
 * its manifest mirror so the manifest can never drift into authority (AC4).
 *
 * Called at session start (after the project row is persisted). It reads the
 * canonical `tasks_sessions` row back from the PROJECT scope and re-projects it into
 * the GLOBAL manifest — guaranteeing the mirror reflects the source of truth even if
 * a prior mirror write was partial, stale, or raced. Best-effort: ANY failure is
 * logged at debug and swallowed.
 *
 * @param projectRoot - Absolute path to the owning project.
 * @param sessionId - The session whose manifest row is reconciled.
 * @task T11639
 */
export async function reconcileSessionManifestOnStart(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  try {
    // Re-read the AUTHORITATIVE project row (source of truth) — never trust the
    // manifest as input. Lazy import breaks the store→sessions cycle.
    const { getSession } = await import('../store/session-store.js');
    const authoritative = await getSession(sessionId, projectRoot);
    if (!authoritative) {
      // No project row → nothing authoritative to mirror. Leave the manifest as-is.
      return;
    }
    const handle = await ensureGlobalSignaldockDb();
    const projectId = await resolveCanonicalProjectId(projectRoot);
    const row = toManifestRow(authoritative, projectId, projectRoot);
    await upsertManifestRow(handle, row);
  } catch (err) {
    log().debug(
      { sessionId, err: err instanceof Error ? err.message : err },
      'session_manifest reconcile-on-start failed (non-fatal); session op unaffected',
    );
  }
}

/**
 * Read a single `session_manifest` mirror row through the SHARED global handle.
 *
 * Primarily a test / introspection convenience — production consumers needing exact
 * session state MUST read the authoritative `tasks_sessions`, not this mirror.
 *
 * @param sessionId - The session id to look up in the manifest.
 * @returns The mirror row, or `null` when absent.
 * @task T11639
 */
export async function readSessionManifestRow(
  sessionId: string,
): Promise<typeof sessionManifest.$inferSelect | null> {
  const handle = await ensureGlobalSignaldockDb();
  const rows = await handle.db
    .select()
    .from(sessionManifest)
    .where(eq(sessionManifest.sessionId, sessionId))
    .all();
  return rows[0] ?? null;
}

/**
 * Resolve the absolute on-disk path of the GLOBAL `cleo.db` (the manifest's home).
 * Thin re-export of the scope→path resolver for callers that want the path without
 * opening the handle.
 *
 * @returns The GLOBAL-scope `cleo.db` absolute path.
 * @task T11639
 */
export function resolveGlobalManifestDbPath(): string {
  return resolveDualScopeDbPath('global');
}

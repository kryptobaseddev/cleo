import { b as getSignaldockDbPath, c as getNexusDbPath, d as dbExists } from './cleo-home-BSckk0xW.js';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

//#region src/lib/server/db/connections.ts
/**
* Per-request SQLite connection helpers for CLEO Studio.
*
* Uses node:sqlite (Node.js built-in).
*
* Global databases (nexus.db, signaldock.db) are shared across all projects
* and continue to use module-level caches — they have a single path per
* machine and never change between requests.
*
* Per-project databases (brain.db, tasks.db, conduit.db) are resolved from
* the active {@link ProjectContext} supplied by the SvelteKit `event.locals`
* injected in `hooks.server.ts`. No cross-request caching is performed for
* these: opening SQLite with `node:sqlite` is sub-millisecond and caching
* across different ProjectContexts is precisely the bug this module was
* rewritten to fix.
*/
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
/** Cached nexus.db connection — global, path is machine-scoped. */
var nexusDb = null;
/** Cached signaldock.db connection — global, path is machine-scoped. */
var signaldockDb = null;
/**
* Returns a read-only connection to the global nexus.db.
* Returns null when the file does not exist on disk.
*/
function getNexusDb() {
	if (nexusDb) return nexusDb;
	const path = getNexusDbPath();
	if (!dbExists(path)) return null;
	nexusDb = new DatabaseSync(path, { open: true });
	return nexusDb;
}
/**
* Returns a read-only connection to the global signaldock.db.
* Returns null when the file does not exist on disk.
*/
function getSignaldockDb() {
	if (signaldockDb) return signaldockDb;
	const path = getSignaldockDbPath();
	if (!dbExists(path)) return null;
	signaldockDb = new DatabaseSync(path, { open: true });
	return signaldockDb;
}
/**
* Opens a connection to brain.db for the given project context.
*
* Each call opens a fresh DatabaseSync against the path stored in `ctx`.
* No per-request caching is performed; this is intentional to ensure project
* switching takes effect immediately without stale state.
*
* Returns null when brain.db does not exist for the project.
*
* @param ctx - The active project context from `event.locals.projectCtx`.
*/
function getBrainDb(ctx) {
	const path = ctx.brainDbPath;
	if (!existsSync(path)) return null;
	return new DatabaseSync(path, { open: true });
}
/**
* Opens a connection to tasks.db for the given project context.
*
* Each call opens a fresh DatabaseSync against the path stored in `ctx`.
* Returns null when tasks.db does not exist for the project.
*
* @param ctx - The active project context from `event.locals.projectCtx`.
*/
function getTasksDb(ctx) {
	const path = ctx.tasksDbPath;
	if (!existsSync(path)) return null;
	return new DatabaseSync(path, { open: true });
}
/**
* Opens a connection to conduit.db for the given project context.
*
* conduit.db lives alongside brain.db in the project's `.cleo/` directory.
* Its path is derived from the brain.db path since `ProjectContext` does not
* carry a dedicated conduitDbPath field.
*
* Returns null when conduit.db does not exist for the project.
*
* @param ctx - The active project context from `event.locals.projectCtx`.
*/
function getConduitDb(ctx) {
	const path = join(dirname(ctx.brainDbPath), "conduit.db");
	if (!existsSync(path)) return null;
	return new DatabaseSync(path, { open: true });
}
/**
* Returns existence and path information for all five CLEO databases.
*
* Per-project paths are resolved from the supplied `ctx`; global paths are
* resolved from the machine-scoped helpers in cleo-home.ts.
*
* @param ctx - The active project context from `event.locals.projectCtx`.
*/
function getDbStatus(ctx) {
	const conduitPath = join(dirname(ctx.brainDbPath), "conduit.db");
	return {
		nexus: dbExists(getNexusDbPath()),
		brain: existsSync(ctx.brainDbPath),
		tasks: existsSync(ctx.tasksDbPath),
		conduit: existsSync(conduitPath),
		signaldock: dbExists(getSignaldockDbPath()),
		nexusPath: getNexusDbPath(),
		brainPath: ctx.brainDbPath,
		tasksPath: ctx.tasksDbPath,
		conduitPath,
		signaldockPath: getSignaldockDbPath()
	};
}

export { getBrainDb as a, getTasksDb as b, getDbStatus as c, getConduitDb as d, getSignaldockDb as e, getNexusDb as g };
//# sourceMappingURL=connections-C-btvhSI.js.map

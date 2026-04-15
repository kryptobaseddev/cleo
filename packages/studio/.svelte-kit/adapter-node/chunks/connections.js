import { a as getTasksDbPath, i as getNexusDbPath, n as getBrainDbPath, t as dbExists } from "./cleo-home.js";
import { createRequire } from "node:module";
//#region src/lib/server/db/connections.ts
/**
* Read-only SQLite connection helpers for CLEO Studio.
*
* Uses node:sqlite (Node.js built-in) with read-only mode.
* All three CLEO databases (nexus, brain, tasks) are accessed here.
* Connections are opened lazily and cached per process lifetime.
*/
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
/** Cached read-only connection instances. */
var nexusDb = null;
var brainDb = null;
var tasksDb = null;
/**
* Returns a cached read-only connection to nexus.db.
* Returns null if nexus.db does not exist.
*/
function getNexusDb() {
	if (nexusDb) return nexusDb;
	const path = getNexusDbPath();
	if (!dbExists(path)) return null;
	nexusDb = new DatabaseSync(path, { open: true });
	return nexusDb;
}
/**
* Returns a cached read-only connection to brain.db.
* Returns null if brain.db does not exist.
*/
function getBrainDb() {
	if (brainDb) return brainDb;
	const path = getBrainDbPath();
	if (!dbExists(path)) return null;
	brainDb = new DatabaseSync(path, { open: true });
	return brainDb;
}
/**
* Returns a cached read-only connection to tasks.db.
* Returns null if tasks.db does not exist.
*/
function getTasksDb() {
	if (tasksDb) return tasksDb;
	const path = getTasksDbPath();
	if (!dbExists(path)) return null;
	tasksDb = new DatabaseSync(path, { open: true });
	return tasksDb;
}
/**
* Returns availability status for all three databases.
*/
function getDbStatus() {
	return {
		nexus: dbExists(getNexusDbPath()),
		brain: dbExists(getBrainDbPath()),
		tasks: dbExists(getTasksDbPath()),
		nexusPath: getNexusDbPath(),
		brainPath: getBrainDbPath(),
		tasksPath: getTasksDbPath()
	};
}
//#endregion
export { getTasksDb as i, getDbStatus as n, getNexusDb as r, getBrainDb as t };

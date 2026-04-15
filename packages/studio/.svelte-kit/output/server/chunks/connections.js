import { a as getNexusDbPath, i as getConduitDbPath, n as getBrainDbPath, o as getSignaldockDbPath, s as getTasksDbPath, t as dbExists } from "./cleo-home.js";
import { createRequire } from "node:module";
//#region src/lib/server/db/connections.ts
/**
* Read-only SQLite connection helpers for CLEO Studio.
*
* Uses node:sqlite (Node.js built-in) with read-only mode.
* All five CLEO databases (nexus, brain, tasks, conduit, signaldock) are accessed here.
* Connections are opened lazily and cached per process lifetime.
*/
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
/** Cached read-only connection instances. */
var nexusDb = null;
var brainDb = null;
var tasksDb = null;
var conduitDb = null;
var signaldockDb = null;
function getNexusDb() {
	if (nexusDb) return nexusDb;
	const path = getNexusDbPath();
	if (!dbExists(path)) return null;
	nexusDb = new DatabaseSync(path, { open: true });
	return nexusDb;
}
function getBrainDb() {
	if (brainDb) return brainDb;
	const path = getBrainDbPath();
	if (!dbExists(path)) return null;
	brainDb = new DatabaseSync(path, { open: true });
	return brainDb;
}
function getTasksDb() {
	if (tasksDb) return tasksDb;
	const path = getTasksDbPath();
	if (!dbExists(path)) return null;
	tasksDb = new DatabaseSync(path, { open: true });
	return tasksDb;
}
function getConduitDb() {
	if (conduitDb) return conduitDb;
	const path = getConduitDbPath();
	if (!dbExists(path)) return null;
	conduitDb = new DatabaseSync(path, { open: true });
	return conduitDb;
}
function getSignaldockDb() {
	if (signaldockDb) return signaldockDb;
	const path = getSignaldockDbPath();
	if (!dbExists(path)) return null;
	signaldockDb = new DatabaseSync(path, { open: true });
	return signaldockDb;
}
function getDbStatus() {
	return {
		nexus: dbExists(getNexusDbPath()),
		brain: dbExists(getBrainDbPath()),
		tasks: dbExists(getTasksDbPath()),
		conduit: dbExists(getConduitDbPath()),
		signaldock: dbExists(getSignaldockDbPath()),
		nexusPath: getNexusDbPath(),
		brainPath: getBrainDbPath(),
		tasksPath: getTasksDbPath(),
		conduitPath: getConduitDbPath(),
		signaldockPath: getSignaldockDbPath()
	};
}
//#endregion
export { getSignaldockDb as a, getNexusDb as i, getConduitDb as n, getTasksDb as o, getDbStatus as r, getBrainDb as t };

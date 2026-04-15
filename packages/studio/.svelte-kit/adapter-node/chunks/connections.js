import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/lib/server/cleo-home.ts
/**
* Resolves CLEO home and project data paths for the studio server.
*
* Resolution order:
*   1. CLEO_HOME env var — explicit override
*   2. XDG_DATA_HOME / platform default (~/.local/share/cleo on Linux)
*
* Project data (tasks.db, brain.db) is resolved from:
*   1. CLEO_ROOT env var (project root)
*   2. process.cwd()/.cleo/
*/
/**
* Returns the global CLEO home directory.
* Linux: ~/.local/share/cleo
* macOS: ~/Library/Application Support/cleo
* Windows: %LOCALAPPDATA%\cleo
*/
function getCleoHome() {
	if (process.env["CLEO_HOME"]) return process.env["CLEO_HOME"];
	const platform = process.platform;
	const home = homedir();
	if (platform === "darwin") return join(home, "Library", "Application Support", "cleo");
	if (platform === "win32") return join(process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "cleo");
	return join(process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "cleo");
}
/**
* Returns the CLEO project data directory (.cleo/).
* Uses CLEO_ROOT env var or falls back to process.cwd().
*/
function getCleoProjectDir() {
	return join(process.env["CLEO_ROOT"] ?? process.cwd(), ".cleo");
}
/**
* Returns the absolute path to nexus.db (global).
* nexus.db lives in the CLEO home directory.
*/
function getNexusDbPath() {
	return join(getCleoHome(), "nexus.db");
}
/**
* Returns the absolute path to brain.db (project-local).
*/
function getBrainDbPath() {
	return join(getCleoProjectDir(), "brain.db");
}
/**
* Returns the absolute path to tasks.db (project-local).
*/
function getTasksDbPath() {
	return join(getCleoProjectDir(), "tasks.db");
}
/**
* Checks if a database file exists at the given path.
*/
function dbExists(dbPath) {
	return existsSync(dbPath);
}
//#endregion
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

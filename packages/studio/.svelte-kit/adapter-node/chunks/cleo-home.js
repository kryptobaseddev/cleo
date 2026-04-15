import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
function getCleoHome() {
	if (process.env["CLEO_HOME"]) return process.env["CLEO_HOME"];
	const platform = process.platform;
	const home = homedir();
	if (platform === "darwin") return join(home, "Library", "Application Support", "cleo");
	if (platform === "win32") return join(process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "cleo");
	return join(process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "cleo");
}
function getCleoProjectDir() {
	return join(process.env["CLEO_ROOT"] ?? process.cwd(), ".cleo");
}
function getNexusDbPath() {
	return join(getCleoHome(), "nexus.db");
}
function getSignaldockDbPath() {
	return join(getCleoHome(), "signaldock.db");
}
function dbExists(dbPath) {
	return existsSync(dbPath);
}
//#endregion
export { getSignaldockDbPath as a, getNexusDbPath as i, getCleoHome as n, getCleoProjectDir as r, dbExists as t };

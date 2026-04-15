import { r as getCleoHome } from "./cleo-home.js";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
//#region src/lib/server/project-context.ts
/**
* Project context resolution for CLEO Studio.
*
* The active project is stored as a cookie (`cleo_project_id`).
* When a project is selected, the studio resolves the project's
* brain.db and tasks.db paths from the global nexus.db registry,
* injecting them into database connections for the page load.
*
* nexus.db is always global (single instance); brain.db and tasks.db
* are per-project.
*
* @task T622
*/
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
/** Cookie name used to persist the active project selection. */
var PROJECT_COOKIE = "cleo_project_id";
/** How long the project context cookie lives (7 days). */
var COOKIE_MAX_AGE = 3600 * 24 * 7;
/**
* Read the active project ID from the request cookie.
* Returns null if no project is selected.
*/
function getActiveProjectId(cookies) {
	return cookies.get("cleo_project_id") ?? null;
}
/**
* Set the active project context cookie.
*/
function setActiveProjectId(cookies, projectId) {
	cookies.set(PROJECT_COOKIE, projectId, {
		path: "/",
		maxAge: COOKIE_MAX_AGE,
		httpOnly: false,
		sameSite: "lax"
	});
}
/**
* Clear the active project context cookie.
*/
function clearActiveProjectId(cookies) {
	cookies.delete(PROJECT_COOKIE, { path: "/" });
}
/**
* List all registered projects from nexus.db.
* Returns an empty array if nexus.db is unavailable.
*/
function listRegisteredProjects() {
	try {
		const nexusPath = join(getCleoHome(), "nexus.db");
		if (!existsSync(nexusPath)) return [];
		const db = new DatabaseSync(nexusPath, { open: true });
		try {
			return db.prepare(`SELECT
            project_id,
            name,
            project_path,
            brain_db_path,
            tasks_db_path,
            last_indexed,
            task_count,
            stats_json,
            last_seen,
            health_status
          FROM project_registry
          ORDER BY last_seen DESC`).all().map((row) => {
				let nodeCount = 0;
				let relationCount = 0;
				let fileCount = 0;
				try {
					const stats = JSON.parse(row.stats_json ?? "{}");
					nodeCount = stats.nodeCount ?? 0;
					relationCount = stats.relationCount ?? 0;
					fileCount = stats.fileCount ?? 0;
				} catch {}
				return {
					projectId: row.project_id,
					name: row.name,
					projectPath: row.project_path,
					brainDbPath: row.brain_db_path ?? null,
					tasksDbPath: row.tasks_db_path ?? null,
					lastIndexed: row.last_indexed ?? null,
					taskCount: row.task_count ?? 0,
					nodeCount,
					relationCount,
					fileCount,
					lastSeen: row.last_seen,
					healthStatus: row.health_status
				};
			});
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}
//#endregion
export { setActiveProjectId as i, getActiveProjectId as n, listRegisteredProjects as r, clearActiveProjectId as t };

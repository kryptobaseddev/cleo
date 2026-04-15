import { n as getCleoHome } from "../../../../chunks/cleo-home.js";
import { n as getActiveProjectId, r as listRegisteredProjects } from "../../../../chunks/project-context.js";
import { createRequire } from "node:module";
import { json } from "@sveltejs/kit";
import { existsSync } from "node:fs";
import { join } from "node:path";
//#region src/routes/api/search/+server.ts
/**
* Cross-project symbol search API endpoint.
*
* GET /api/search?q=<term>&scope=all|current
*
* Searches nexus_nodes across all registered projects (scope=all) or
* just the current/active project (scope=current).
*
* Query params:
*   q      - search term (required, min 2 chars)
*   scope  - "all" (default) or "current"
*   limit  - max results per project (default 20, max 100)
*
* Returns a LAFS-compliant JSON envelope.
*
* @task T622
*/
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
var GET = ({ url, cookies }) => {
	const startTime = Date.now();
	const q = url.searchParams.get("q") ?? "";
	const scope = url.searchParams.get("scope") ?? "all";
	const limitParam = parseInt(url.searchParams.get("limit") ?? "20", 10);
	const limit = Math.min(Math.max(1, limitParam), 100);
	if (q.length < 2) return json({
		success: false,
		error: {
			code: "E_INVALID_INPUT",
			message: "q must be at least 2 characters"
		},
		meta: {
			operation: "api.search",
			duration_ms: Date.now() - startTime,
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		}
	}, { status: 400 });
	try {
		const nexusPath = join(getCleoHome(), "nexus.db");
		if (!existsSync(nexusPath)) return json({
			success: true,
			data: {
				query: q,
				scope,
				results: [],
				totalHits: 0
			},
			meta: {
				operation: "api.search",
				duration_ms: Date.now() - startTime,
				timestamp: (/* @__PURE__ */ new Date()).toISOString()
			}
		});
		let projectFilter = null;
		if (scope === "current") {
			const activeId = getActiveProjectId(cookies);
			if (activeId) projectFilter = [activeId];
		}
		const allProjects = listRegisteredProjects();
		const projectNameById = new Map(allProjects.map((p) => [p.projectId, p.name]));
		const db = new DatabaseSync(nexusPath, { open: true });
		const hits = [];
		try {
			const term = `%${q.toLowerCase()}%`;
			if (projectFilter) for (const projectId of projectFilter) {
				const rows = db.prepare(`SELECT id, project_id, name, kind, file_path, start_line, language, doc_summary, is_exported
               FROM nexus_nodes
               WHERE project_id = ?
                 AND lower(name) LIKE ?
                 AND kind NOT IN ('community', 'process', 'file', 'folder')
               ORDER BY
                 CASE kind
                   WHEN 'function' THEN 0 WHEN 'method' THEN 1 WHEN 'class' THEN 2
                   WHEN 'interface' THEN 3 WHEN 'type_alias' THEN 4 ELSE 5
                 END, name
               LIMIT ?`).all(projectId, term, limit);
				for (const row of rows) {
					if (!row.name) continue;
					hits.push({
						projectId: row.project_id,
						projectName: projectNameById.get(row.project_id) ?? row.project_id,
						nodeId: row.id,
						name: row.name,
						kind: row.kind,
						filePath: row.file_path ?? null,
						startLine: row.start_line ?? null,
						language: row.language ?? null,
						docSummary: row.doc_summary ?? null,
						isExported: row.is_exported === 1
					});
				}
			}
			else {
				const rows = db.prepare(`SELECT id, project_id, name, kind, file_path, start_line, language, doc_summary, is_exported
             FROM nexus_nodes
             WHERE lower(name) LIKE ?
               AND kind NOT IN ('community', 'process', 'file', 'folder')
             ORDER BY
               CASE kind
                 WHEN 'function' THEN 0 WHEN 'method' THEN 1 WHEN 'class' THEN 2
                 WHEN 'interface' THEN 3 WHEN 'type_alias' THEN 4 ELSE 5
               END, name
             LIMIT ?`).all(term, limit * Math.max(allProjects.length, 1));
				for (const row of rows) {
					if (!row.name) continue;
					hits.push({
						projectId: row.project_id,
						projectName: projectNameById.get(row.project_id) ?? row.project_id,
						nodeId: row.id,
						name: row.name,
						kind: row.kind,
						filePath: row.file_path ?? null,
						startLine: row.start_line ?? null,
						language: row.language ?? null,
						docSummary: row.doc_summary ?? null,
						isExported: row.is_exported === 1
					});
				}
			}
		} finally {
			db.close();
		}
		return json({
			success: true,
			data: {
				query: q,
				scope,
				results: hits,
				totalHits: hits.length
			},
			meta: {
				operation: "api.search",
				duration_ms: Date.now() - startTime,
				timestamp: (/* @__PURE__ */ new Date()).toISOString()
			}
		});
	} catch (err) {
		return json({
			success: false,
			error: {
				code: "E_SEARCH_FAILED",
				message: err instanceof Error ? err.message : String(err)
			},
			meta: {
				operation: "api.search",
				duration_ms: Date.now() - startTime,
				timestamp: (/* @__PURE__ */ new Date()).toISOString()
			}
		}, { status: 500 });
	}
};
//#endregion
export { GET };

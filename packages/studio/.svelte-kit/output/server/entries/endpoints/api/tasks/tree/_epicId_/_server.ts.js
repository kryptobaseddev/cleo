import { o as getTasksDb } from "../../../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/tasks/tree/[epicId]/+server.ts
/**
* GET /api/tasks/tree/[epicId] — full epic hierarchy (epic → tasks → subtasks).
*
* Returns nested tree up to 3 levels deep.
*/
function buildTree(parentId, allRows, depth) {
	if (depth > 3) return [];
	return allRows.filter((r) => r.parent_id === parentId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)).map((r) => ({
		id: r.id,
		title: r.title,
		status: r.status,
		priority: r.priority,
		type: r.type,
		pipeline_stage: r.pipeline_stage,
		size: r.size,
		verification_json: r.verification_json,
		acceptance_json: r.acceptance_json,
		created_at: r.created_at,
		completed_at: r.completed_at,
		children: buildTree(r.id, allRows, depth + 1)
	}));
}
var GET = ({ params }) => {
	const db = getTasksDb();
	if (!db) return json({ error: "tasks.db unavailable" }, { status: 503 });
	const { epicId } = params;
	try {
		const epic = db.prepare(`SELECT id, title, status, priority, type, pipeline_stage, size,
                verification_json, acceptance_json, created_at, completed_at, parent_id, position
         FROM tasks WHERE id = ?`).get(epicId);
		if (!epic) return json({ error: "not found" }, { status: 404 });
		const allDescendants = db.prepare(`WITH RECURSIVE descendants(id, title, status, priority, type, parent_id,
                pipeline_stage, size, verification_json, acceptance_json,
                created_at, completed_at, position) AS (
          SELECT id, title, status, priority, type, parent_id,
                 pipeline_stage, size, verification_json, acceptance_json,
                 created_at, completed_at, position
          FROM tasks WHERE parent_id = ?
          UNION ALL
          SELECT t.id, t.title, t.status, t.priority, t.type, t.parent_id,
                 t.pipeline_stage, t.size, t.verification_json, t.acceptance_json,
                 t.created_at, t.completed_at, t.position
          FROM tasks t
          INNER JOIN descendants d ON t.parent_id = d.id
          LIMIT 500
        )
        SELECT * FROM descendants`).all(epicId);
		const children = buildTree(epicId, allDescendants, 1);
		const all = [epic, ...allDescendants];
		const stats = {
			total: all.length,
			done: all.filter((t) => t.status === "done").length,
			active: all.filter((t) => t.status === "active").length,
			pending: all.filter((t) => t.status === "pending").length,
			archived: all.filter((t) => t.status === "archived").length
		};
		return json({
			epic: {
				...epic,
				children
			},
			stats
		});
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};
//#endregion
export { GET };

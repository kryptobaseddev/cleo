import { o as getTasksDb } from "../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/tasks/+server.ts
/**
* GET /api/tasks — list tasks with optional filters.
*
* Query params:
*   status  — pending | active | done | archived (comma-separated)
*   priority — critical | high | medium | low (comma-separated)
*   type    — epic | task | subtask (comma-separated)
*   limit   — max rows (default 200)
*/
var GET = ({ locals, url }) => {
	const db = getTasksDb(locals.projectCtx);
	if (!db) return json({ error: "tasks.db unavailable" }, { status: 503 });
	const statusParam = url.searchParams.get("status");
	const priorityParam = url.searchParams.get("priority");
	const typeParam = url.searchParams.get("type");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 1e3);
	const conditions = [];
	const params = [];
	if (statusParam) {
		const values = statusParam.split(",").map((s) => s.trim());
		conditions.push(`status IN (${values.map(() => "?").join(",")})`);
		params.push(...values);
	}
	if (priorityParam) {
		const values = priorityParam.split(",").map((s) => s.trim());
		conditions.push(`priority IN (${values.map(() => "?").join(",")})`);
		params.push(...values);
	}
	if (typeParam) {
		const values = typeParam.split(",").map((s) => s.trim());
		conditions.push(`type IN (${values.map(() => "?").join(",")})`);
		params.push(...values);
	}
	const sql = `
    SELECT id, title, description, status, priority, type, parent_id,
           pipeline_stage, size, created_at, updated_at, completed_at,
           verification_json, acceptance_json
    FROM tasks
    ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC
    LIMIT ?
  `;
	params.push(limit);
	try {
		const rows = db.prepare(sql).all(...params);
		return json({
			tasks: rows,
			total: rows.length
		});
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};
//#endregion
export { GET };

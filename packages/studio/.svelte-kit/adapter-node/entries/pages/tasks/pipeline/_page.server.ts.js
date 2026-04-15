import { o as getTasksDb } from "../../../../chunks/connections.js";
//#region src/routes/tasks/pipeline/+page.server.ts
/**
* Pipeline page server load — tasks grouped by pipeline_stage for kanban.
*/
/** Ordered canonical pipeline stages. */
var PIPELINE_STAGES = [
	"research",
	"specification",
	"decomposition",
	"design",
	"implementation",
	"testing",
	"validation",
	"review",
	"release",
	"done"
];
var load = () => {
	const db = getTasksDb();
	if (!db) return { columns: [] };
	try {
		const rows = db.prepare(`SELECT id, title, status, priority, type, parent_id, size,
                pipeline_stage, verification_json
         FROM tasks
         WHERE status != 'archived'
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC`).all();
		const buckets = {};
		for (const stage of [...PIPELINE_STAGES, "unassigned"]) buckets[stage] = [];
		for (const row of rows) {
			const target = buckets[row.pipeline_stage ?? "unassigned"] ?? buckets["unassigned"];
			const { pipeline_stage: _, ...rest } = row;
			target.push(rest);
		}
		const columns = [...PIPELINE_STAGES].map((s) => ({
			id: s,
			label: s.charAt(0).toUpperCase() + s.slice(1),
			count: buckets[s].length,
			tasks: buckets[s]
		}));
		if (buckets["unassigned"].length > 0) columns.push({
			id: "unassigned",
			label: "Unassigned",
			count: buckets["unassigned"].length,
			tasks: buckets["unassigned"]
		});
		return { columns };
	} catch {
		return { columns: [] };
	}
};
//#endregion
export { load };

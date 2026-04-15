import { b as getTasksDb } from './connections-BR9V-1fV.js';
import { json } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/tasks/pipeline/+server.ts
/**
* GET /api/tasks/pipeline — tasks grouped by pipeline_stage.
*
* Returns a map of stage → tasks[], plus counts per stage.
* Only non-archived tasks are included.
*/
/** Ordered list of all pipeline stages. */
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
var GET = () => {
	const db = getTasksDb();
	if (!db) return json({ error: "tasks.db unavailable" }, { status: 503 });
	try {
		const rows = db.prepare(`SELECT id, title, status, priority, type, parent_id,
                pipeline_stage, size, verification_json, acceptance_json,
                created_at, updated_at, completed_at
         FROM tasks
         WHERE status != 'archived'
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC`).all();
		const columns = {};
		for (const stage of [...PIPELINE_STAGES, "unassigned"]) columns[stage] = [];
		for (const row of rows) {
			const stage = row.pipeline_stage ?? "unassigned";
			if (columns[stage]) columns[stage].push(row);
			else columns["unassigned"].push(row);
		}
		const stages = PIPELINE_STAGES.map((s) => ({
			id: s,
			label: s.charAt(0).toUpperCase() + s.slice(1),
			count: columns[s].length,
			tasks: columns[s]
		}));
		if (columns["unassigned"].length > 0) stages.push({
			id: "unassigned",
			label: "Unassigned",
			count: columns["unassigned"].length,
			tasks: columns["unassigned"]
		});
		return json({ stages });
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};

export { GET };
//# sourceMappingURL=_server.ts-BfMWVnjA.js.map

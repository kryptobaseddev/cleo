import { b as getTasksDb } from './connections-BR9V-1fV.js';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

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

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 15;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-3F4R47BX.js')).default;
const server_id = "src/routes/tasks/pipeline/+page.server.ts";
const imports = ["_app/immutable/nodes/15.BjVh6XXk.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/15.DD-MRcTL.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=15-CRNW9TLf.js.map

import { b as getTasksDb } from './connections-C-btvhSI.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/tasks/+page.server.ts
/**
* Tasks dashboard server load — status/priority/type counts, epic progress, recent activity.
*/
var load = ({ locals }) => {
	const db = getTasksDb(locals.projectCtx);
	if (!db) return {
		stats: null,
		recentTasks: [],
		epicProgress: []
	};
	try {
		const countByStatus = db.prepare("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status").all();
		const countByPriority = db.prepare(`SELECT priority, COUNT(*) as cnt FROM tasks WHERE status != 'archived' GROUP BY priority`).all();
		const countByType = db.prepare(`SELECT type, COUNT(*) as cnt FROM tasks WHERE status != 'archived' GROUP BY type`).all();
		const statusMap = Object.fromEntries(countByStatus.map((r) => [r.status, r.cnt]));
		const priorityMap = Object.fromEntries(countByPriority.map((r) => [r.priority, r.cnt]));
		const typeMap = Object.fromEntries(countByType.map((r) => [r.type, r.cnt]));
		return {
			stats: {
				total: Object.values(statusMap).reduce((a, b) => a + b, 0),
				pending: statusMap["pending"] ?? 0,
				active: statusMap["active"] ?? 0,
				done: statusMap["done"] ?? 0,
				archived: statusMap["archived"] ?? 0,
				critical: priorityMap["critical"] ?? 0,
				high: priorityMap["high"] ?? 0,
				medium: priorityMap["medium"] ?? 0,
				low: priorityMap["low"] ?? 0,
				epics: typeMap["epic"] ?? 0,
				tasks: typeMap["task"] ?? 0,
				subtasks: typeMap["subtask"] ?? 0
			},
			recentTasks: db.prepare(`SELECT id, title, status, priority, type, pipeline_stage, updated_at
         FROM tasks
         WHERE status IN ('active', 'pending', 'done')
         ORDER BY updated_at DESC
         LIMIT 20`).all(),
			epicProgress: db.prepare(`SELECT id, title FROM tasks WHERE type = 'epic' AND status != 'archived' LIMIT 20`).all().map((epic) => {
				const children = db.prepare(`WITH RECURSIVE desc(id, status) AS (
            SELECT id, status FROM tasks WHERE parent_id = ?
            UNION ALL
            SELECT t.id, t.status FROM tasks t INNER JOIN desc d ON t.parent_id = d.id
            LIMIT 500
          )
          SELECT status, COUNT(*) as cnt FROM desc GROUP BY status`).all(epic.id);
				const childMap = Object.fromEntries(children.map((r) => [r.status, r.cnt]));
				const total = Object.values(childMap).reduce((a, b) => a + b, 0);
				return {
					id: epic.id,
					title: epic.title,
					total,
					done: childMap["done"] ?? 0,
					active: childMap["active"] ?? 0,
					pending: childMap["pending"] ?? 0
				};
			})
		};
	} catch {
		return {
			stats: null,
			recentTasks: [],
			epicProgress: []
		};
	}
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 13;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-Buhpx1l6.js')).default;
const server_id = "src/routes/tasks/+page.server.ts";
const imports = ["_app/immutable/nodes/13.BIGa0Fd0.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/13.D-mF5Pzk.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=13-C55_QYTu.js.map

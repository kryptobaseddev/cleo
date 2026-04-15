import { b as getTasksDb } from './connections-BR9V-1fV.js';
import { error } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/tasks/tree/[epicId]/+page.server.ts
/**
* Epic tree page server load — collapsible epic→subtask hierarchy.
*/
function buildTree(parentId, allRows, depth) {
	if (depth > 4) return [];
	return allRows.filter((r) => r.parent_id === parentId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)).map((r) => ({
		id: r.id,
		title: r.title,
		status: r.status,
		priority: r.priority,
		type: r.type,
		pipeline_stage: r.pipeline_stage,
		size: r.size,
		verification_json: r.verification_json,
		created_at: r.created_at,
		completed_at: r.completed_at,
		children: buildTree(r.id, allRows, depth + 1)
	}));
}
var load = ({ params }) => {
	const db = getTasksDb();
	if (!db) error(503, "tasks.db unavailable");
	const { epicId } = params;
	const epic = db.prepare(`SELECT id, title, status, priority, type, pipeline_stage, size,
              verification_json, created_at, completed_at, parent_id, position
       FROM tasks WHERE id = ?`).get(epicId);
	if (!epic) error(404, `Task ${epicId} not found`);
	const allDescendants = db.prepare(`WITH RECURSIVE desc(id, title, status, priority, type, parent_id,
              pipeline_stage, size, verification_json,
              created_at, completed_at, position) AS (
        SELECT id, title, status, priority, type, parent_id,
               pipeline_stage, size, verification_json,
               created_at, completed_at, position
        FROM tasks WHERE parent_id = ?
        UNION ALL
        SELECT t.id, t.title, t.status, t.priority, t.type, t.parent_id,
               t.pipeline_stage, t.size, t.verification_json,
               t.created_at, t.completed_at, t.position
        FROM tasks t
        INNER JOIN desc d ON t.parent_id = d.id
        LIMIT 500
      )
      SELECT * FROM desc`).all(epicId);
	const children = buildTree(epicId, allDescendants, 1);
	const all = [epic, ...allDescendants];
	const stats = {
		total: all.length,
		done: all.filter((t) => t.status === "done").length,
		active: all.filter((t) => t.status === "active").length,
		pending: all.filter((t) => t.status === "pending").length,
		archived: all.filter((t) => t.status === "archived").length
	};
	return {
		epic: {
			id: epic.id,
			title: epic.title,
			status: epic.status,
			priority: epic.priority,
			type: epic.type,
			pipeline_stage: epic.pipeline_stage,
			size: epic.size,
			verification_json: epic.verification_json,
			created_at: epic.created_at,
			completed_at: epic.completed_at,
			children
		},
		stats
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 17;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-DDeZYLQ6.js')).default;
const server_id = "src/routes/tasks/tree/[epicId]/+page.server.ts";
const imports = ["_app/immutable/nodes/17.B3HvQ5GV.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/17.DYClIb_H.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=17-Dqrzkmc_.js.map

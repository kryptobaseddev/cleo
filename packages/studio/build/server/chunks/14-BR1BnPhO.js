import { b as getTasksDb } from './connections-C-btvhSI.js';
import { error } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/tasks/[id]/+page.server.ts
/**
* Task detail page server load — single task, subtasks, verification, acceptance.
*/
var load = ({ locals, params }) => {
	const db = getTasksDb(locals.projectCtx);
	if (!db) error(503, "tasks.db unavailable");
	const { id } = params;
	const row = db.prepare(`SELECT id, title, description, status, priority, type, parent_id,
              pipeline_stage, size, phase, labels_json, acceptance_json,
              verification_json, created_at, updated_at, completed_at,
              assignee, session_id
       FROM tasks WHERE id = ?`).get(id);
	if (!row) error(404, `Task ${id} not found`);
	let verification = null;
	try {
		if (row.verification_json) verification = JSON.parse(row.verification_json);
	} catch {}
	let acceptance = [];
	try {
		if (row.acceptance_json) acceptance = JSON.parse(row.acceptance_json);
	} catch {}
	let labels = [];
	try {
		if (row.labels_json) labels = JSON.parse(row.labels_json);
	} catch {}
	const task = {
		id: row.id,
		title: row.title,
		description: row.description,
		status: row.status,
		priority: row.priority,
		type: row.type,
		parent_id: row.parent_id,
		pipeline_stage: row.pipeline_stage,
		size: row.size,
		phase: row.phase,
		created_at: row.created_at,
		updated_at: row.updated_at,
		completed_at: row.completed_at,
		assignee: row.assignee,
		session_id: row.session_id,
		verification,
		acceptance,
		labels
	};
	const subtasks = db.prepare(`SELECT id, title, status, priority, type, pipeline_stage, size,
              verification_json, acceptance_json, created_at, completed_at
       FROM tasks WHERE parent_id = ?
       ORDER BY position ASC, created_at ASC`).all(id);
	let parent = null;
	if (row.parent_id) parent = db.prepare("SELECT id, title, type FROM tasks WHERE id = ?").get(row.parent_id) ?? null;
	return {
		task,
		subtasks,
		parent
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 14;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-CwWh1Fam.js')).default;
const server_id = "src/routes/tasks/[id]/+page.server.ts";
const imports = ["_app/immutable/nodes/14.B3LXKwyY.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/14.DKwxyo93.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=14-BR1BnPhO.js.map

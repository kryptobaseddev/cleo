import { b as getTasksDb } from './connections-C-btvhSI.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/tasks/sessions/+page.server.ts
/**
* Sessions page server load — session history with task completions timeline.
*/
var load = ({ locals }) => {
	const db = getTasksDb(locals.projectCtx);
	if (!db) return { sessions: [] };
	try {
		return { sessions: db.prepare(`SELECT id, name, status, agent, started_at, ended_at,
                tasks_completed_json, tasks_created_json
         FROM sessions
         ORDER BY started_at DESC
         LIMIT 100`).all().map((s) => {
			let completedIds = [];
			try {
				completedIds = s.tasks_completed_json ? JSON.parse(s.tasks_completed_json) : [];
			} catch {
				completedIds = [];
			}
			let createdCount = 0;
			try {
				const created = s.tasks_created_json ? JSON.parse(s.tasks_created_json) : [];
				createdCount = Array.isArray(created) ? created.length : 0;
			} catch {
				createdCount = 0;
			}
			const completedTasks = [];
			for (const tid of completedIds.slice(0, 20)) {
				const t = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(tid);
				if (t) completedTasks.push(t);
			}
			const durationMs = s.started_at && s.ended_at ? new Date(s.ended_at).getTime() - new Date(s.started_at).getTime() : null;
			return {
				id: s.id,
				name: s.name,
				status: s.status,
				agent: s.agent,
				startedAt: s.started_at,
				endedAt: s.ended_at,
				durationMs,
				completedCount: completedIds.length,
				createdCount,
				completedTasks
			};
		}) };
	} catch {
		return { sessions: [] };
	}
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 16;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-z-kpl9zt.js')).default;
const server_id = "src/routes/tasks/sessions/+page.server.ts";
const imports = ["_app/immutable/nodes/16.BYYIT3m-.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/16.DWzk8nj5.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=16-DoMS_X2b.js.map

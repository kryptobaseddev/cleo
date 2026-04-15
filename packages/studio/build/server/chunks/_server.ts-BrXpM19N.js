import { b as getTasksDb } from './connections-C-btvhSI.js';
import { json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/tasks/sessions/+server.ts
/**
* GET /api/tasks/sessions — session history with task completions.
*
* Query params:
*   limit — max sessions (default 50)
*/
var GET = ({ locals, url }) => {
	const db = getTasksDb(locals.projectCtx);
	if (!db) return json({ error: "tasks.db unavailable" }, { status: 503 });
	const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
	try {
		const enriched = db.prepare(`SELECT id, name, status, agent, scope_json, current_task,
                tasks_completed_json, tasks_created_json, started_at, ended_at,
                stats_json, debrief_json
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`).all(limit).map((s) => {
			let completedIds = [];
			try {
				completedIds = s.tasks_completed_json ? JSON.parse(s.tasks_completed_json) : [];
			} catch {
				completedIds = [];
			}
			let createdIds = [];
			try {
				createdIds = s.tasks_created_json ? JSON.parse(s.tasks_created_json) : [];
			} catch {
				createdIds = [];
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
				currentTask: s.current_task,
				startedAt: s.started_at,
				endedAt: s.ended_at,
				durationMs,
				completedCount: completedIds.length,
				createdCount: createdIds.length,
				completedTasks
			};
		});
		return json({
			sessions: enriched,
			total: enriched.length
		});
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};

export { GET };
//# sourceMappingURL=_server.ts-BrXpM19N.js.map

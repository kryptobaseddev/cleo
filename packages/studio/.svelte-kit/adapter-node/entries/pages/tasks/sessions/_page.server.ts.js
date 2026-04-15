import { o as getTasksDb } from "../../../../chunks/connections.js";
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
//#endregion
export { load };

import { b as getTasksDb } from './connections-BR9V-1fV.js';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/tasks/events/+server.ts
/**
* GET /api/tasks/events — SSE endpoint for real-time task change notifications.
*
* Polls tasks.db every 2 seconds and emits 'task-updated' events when
* the last updated_at timestamp changes.
*/
var GET = () => {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({ start(controller) {
		let lastUpdated = "";
		let lastCount = 0;
		let closed = false;
		function send(event, data) {
			if (closed) return;
			const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			try {
				controller.enqueue(encoder.encode(payload));
			} catch {
				closed = true;
			}
		}
		send("connected", { ts: (/* @__PURE__ */ new Date()).toISOString() });
		const interval = setInterval(() => {
			if (closed) {
				clearInterval(interval);
				return;
			}
			try {
				const db = getTasksDb();
				if (!db) return;
				const row = db.prepare(`SELECT MAX(updated_at) as latest, COUNT(*) as cnt FROM tasks WHERE status != 'archived'`).get();
				const latest = row?.latest ?? "";
				const cnt = row?.cnt ?? 0;
				if (latest !== lastUpdated || cnt !== lastCount) {
					lastUpdated = latest;
					lastCount = cnt;
					send("task-updated", {
						ts: (/* @__PURE__ */ new Date()).toISOString(),
						latestChange: latest,
						activeCount: cnt
					});
				} else send("heartbeat", { ts: (/* @__PURE__ */ new Date()).toISOString() });
			} catch {}
		}, 2e3);
		return () => {
			closed = true;
			clearInterval(interval);
		};
	} });
	return new Response(stream, { headers: {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no"
	} });
};

export { GET };
//# sourceMappingURL=_server.ts-JWwIIwJd.js.map

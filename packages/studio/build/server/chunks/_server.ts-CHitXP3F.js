import { a as getBrainDb, b as getTasksDb, d as getConduitDb } from './connections-C-btvhSI.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/living-brain/stream/+server.ts
/**
* SSE Live Synapses stream endpoint.
*
* GET /api/living-brain/stream
*   → text/event-stream
*
* Emits `LBStreamEvent` objects encoded as `data: <JSON>\n\n`.
*
* Event types:
*   hello          — sent immediately on connect
*   heartbeat      — sent every 30 s (prevents proxy/client timeout)
*   node.create    — new row in brain_observations
*   edge.strengthen — brain_page_edges weight updated
*   task.status    — tasks row status changed
*   message.send   — new row in conduit messages
*
* Polling uses a per-source watermark (`last_seen_id` or `last_seen_ts`)
* so already-delivered rows are never replayed.
*
* The stream self-terminates when the client disconnects (AbortSignal).
*
* @see packages/studio/src/lib/server/living-brain/types.ts — LBStreamEvent
*/
/** How often (ms) to poll source tables for new rows. */
var POLL_INTERVAL_MS = 1e3;
/** How often (ms) to send a heartbeat to prevent connection drop. */
var HEARTBEAT_INTERVAL_MS = 3e4;
/** Max chars for message preview in message.send events. */
var MESSAGE_PREVIEW_LEN = 120;
/**
* Serialises an `LBStreamEvent` to the `data: …\n\n` SSE wire format.
*
* @param event - The event to encode.
* @returns SSE-formatted string ready for the stream.
*/
function sseEncode(event) {
	return `data: ${JSON.stringify(event)}\n\n`;
}
/**
* Initialises watermarks from the current state of all source tables.
* This prevents replaying historical rows when a client first connects.
*
* @param ctx - Active project context for resolving per-project DB paths.
* @returns Initial watermark state.
*/
function initWatermarks(ctx) {
	const state = {
		lastObsRowid: 0,
		edgeWeights: /* @__PURE__ */ new Map(),
		lastTaskRowid: 0,
		taskStatuses: /* @__PURE__ */ new Map(),
		lastMsgRowid: 0
	};
	try {
		const brainDb = getBrainDb(ctx);
		if (brainDb) {
			state.lastObsRowid = brainDb.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM brain_observations").get()?.max_rowid ?? 0;
			const edges = brainDb.prepare("SELECT from_id, to_id, weight FROM brain_page_edges").all();
			for (const e of edges) state.edgeWeights.set(`${e.from_id}|${e.to_id}`, e.weight);
		}
	} catch {}
	try {
		const tasksDb = getTasksDb(ctx);
		if (tasksDb) {
			state.lastTaskRowid = tasksDb.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM tasks").get()?.max_rowid ?? 0;
			const rows = tasksDb.prepare("SELECT id, status FROM tasks").all();
			for (const r of rows) state.taskStatuses.set(r.id, r.status);
		}
	} catch {}
	try {
		const conduitDb = getConduitDb(ctx);
		if (conduitDb) state.lastMsgRowid = conduitDb.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages").get()?.max_rowid ?? 0;
	} catch {}
	return state;
}
/**
* Checks brain_observations for rows inserted since the last poll.
*
* @param state - Current watermark state (mutated on new rows).
* @param ctx - Active project context for resolving brain.db path.
* @returns Array of `node.create` events to emit.
*/
function detectNewObservations(state, ctx) {
	const events = [];
	try {
		const db = getBrainDb(ctx);
		if (!db) return events;
		const rows = db.prepare(`SELECT rowid, id, title, quality_score, memory_tier, created_at, source_session_id
         FROM brain_observations
         WHERE rowid > ?
         ORDER BY rowid ASC`).all(state.lastObsRowid);
		for (const row of rows) {
			state.lastObsRowid = row.rowid;
			const node = {
				id: `brain:${row.id}`,
				kind: "observation",
				substrate: "brain",
				label: row.title,
				weight: row.quality_score ?? void 0,
				createdAt: row.created_at,
				meta: {
					memory_tier: row.memory_tier,
					created_at: row.created_at,
					source_session_id: row.source_session_id
				}
			};
			events.push({
				type: "node.create",
				node,
				ts: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	} catch {}
	return events;
}
/**
* Checks brain_page_edges for rows whose weight changed since last poll.
*
* Compares against the in-memory weight snapshot. Both newly added edges
* (not in snapshot) and existing edges with a changed weight are emitted.
*
* @param state - Current watermark state (mutated on weight changes).
* @param ctx - Active project context for resolving brain.db path.
* @returns Array of `edge.strengthen` events to emit.
*/
function detectEdgeWeightChanges(state, ctx) {
	const events = [];
	try {
		const db = getBrainDb(ctx);
		if (!db) return events;
		const rows = db.prepare(`SELECT from_id, to_id, edge_type, weight, updated_at
         FROM brain_page_edges`).all();
		for (const row of rows) {
			const key = `${row.from_id}|${row.to_id}`;
			const prevWeight = state.edgeWeights.get(key);
			if (prevWeight === void 0 || prevWeight !== row.weight) {
				state.edgeWeights.set(key, row.weight);
				if (prevWeight !== void 0) events.push({
					type: "edge.strengthen",
					fromId: `brain:${row.from_id}`,
					toId: `brain:${row.to_id}`,
					edgeType: row.edge_type,
					weight: row.weight,
					ts: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		}
	} catch {}
	return events;
}
/**
* Checks the tasks table for rows whose status changed since last poll.
*
* Uses rowid watermark to detect new tasks, then status-map diff for
* tasks already seen.
*
* @param state - Current watermark state (mutated on changes).
* @param ctx - Active project context for resolving tasks.db path.
* @returns Array of `task.status` events to emit.
*/
function detectTaskStatusChanges(state, ctx) {
	const events = [];
	try {
		const db = getTasksDb(ctx);
		if (!db) return events;
		const newRows = db.prepare(`SELECT rowid, id, status, updated_at
         FROM tasks
         WHERE rowid > ?
         ORDER BY rowid ASC`).all(state.lastTaskRowid);
		for (const row of newRows) {
			state.lastTaskRowid = row.rowid;
			state.taskStatuses.set(row.id, row.status);
			events.push({
				type: "task.status",
				taskId: row.id,
				status: row.status,
				ts: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
		if (state.taskStatuses.size > 0) {
			const ids = [...state.taskStatuses.keys()];
			const placeholders = ids.map(() => "?").join(",");
			const existingRows = db.prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`).all(...ids);
			for (const row of existingRows) {
				const prev = state.taskStatuses.get(row.id);
				if (prev !== void 0 && prev !== row.status) {
					state.taskStatuses.set(row.id, row.status);
					events.push({
						type: "task.status",
						taskId: row.id,
						status: row.status,
						ts: (/* @__PURE__ */ new Date()).toISOString()
					});
				}
			}
		}
	} catch {}
	return events;
}
/**
* Checks conduit messages for rows inserted since the last poll.
*
* @param state - Current watermark state (mutated on new rows).
* @param ctx - Active project context for resolving conduit.db path.
* @returns Array of `message.send` events to emit.
*/
function detectNewMessages(state, ctx) {
	const events = [];
	try {
		const db = getConduitDb(ctx);
		if (!db) return events;
		const rows = db.prepare(`SELECT rowid, id, content, from_agent_id, to_agent_id, created_at
         FROM messages
         WHERE rowid > ?
         ORDER BY rowid ASC`).all(state.lastMsgRowid);
		for (const row of rows) {
			state.lastMsgRowid = row.rowid;
			const preview = row.content.length > MESSAGE_PREVIEW_LEN ? `${row.content.slice(0, MESSAGE_PREVIEW_LEN)}…` : row.content;
			events.push({
				type: "message.send",
				messageId: row.id,
				fromAgentId: row.from_agent_id ?? "",
				toAgentId: row.to_agent_id ?? "",
				preview,
				ts: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	} catch {}
	return events;
}
var GET = ({ locals, request }) => {
	const signal = request.signal;
	const projectCtx = locals.projectCtx;
	const stream = new ReadableStream({ start(controller) {
		/** Whether the stream has been closed (prevent double-close). */
		let closed = false;
		function close() {
			if (closed) return;
			closed = true;
			try {
				controller.close();
			} catch {}
		}
		signal.addEventListener("abort", close);
		const watermarks = initWatermarks(projectCtx);
		controller.enqueue(new TextEncoder().encode(sseEncode({
			type: "hello",
			ts: (/* @__PURE__ */ new Date()).toISOString()
		})));
		const heartbeatTimer = setInterval(() => {
			if (closed) {
				clearInterval(heartbeatTimer);
				return;
			}
			try {
				controller.enqueue(new TextEncoder().encode(sseEncode({
					type: "heartbeat",
					ts: (/* @__PURE__ */ new Date()).toISOString()
				})));
			} catch {
				clearInterval(heartbeatTimer);
				close();
			}
		}, HEARTBEAT_INTERVAL_MS);
		const pollTimer = setInterval(() => {
			if (closed) {
				clearInterval(pollTimer);
				return;
			}
			const events = [
				...detectNewObservations(watermarks, projectCtx),
				...detectEdgeWeightChanges(watermarks, projectCtx),
				...detectTaskStatusChanges(watermarks, projectCtx),
				...detectNewMessages(watermarks, projectCtx)
			];
			for (const event of events) {
				if (closed) break;
				try {
					controller.enqueue(new TextEncoder().encode(sseEncode(event)));
				} catch {
					clearInterval(pollTimer);
					clearInterval(heartbeatTimer);
					close();
					return;
				}
			}
		}, POLL_INTERVAL_MS);
		return () => {
			clearInterval(heartbeatTimer);
			clearInterval(pollTimer);
			signal.removeEventListener("abort", close);
			close();
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
//# sourceMappingURL=_server.ts-CHitXP3F.js.map

import { e as getSignaldockDb, d as getConduitDb, b as getTasksDb, g as getNexusDb, a as getBrainDb } from './connections-C-btvhSI.js';
import { a as resolveDefaultProjectContext } from './project-context-enjwprPM.js';

//#region src/lib/server/living-brain/adapters/brain.ts
/**
* BRAIN substrate adapter for the Living Brain API.
*
* Queries brain.db and returns LBNodes/LBEdges for all typed memory tables:
* observations, decisions, patterns, learnings, plus the graph layer
* (brain_page_nodes / brain_page_edges).
*
* Cross-substrate bridges are synthesized for:
* - brain_page_edges whose to_id references a task (task:T-xxx → tasks:T-xxx)
* - brain_page_edges whose to_id is a nexus-style path (foo.ts::Symbol → nexus:...)
* - brain_memory_links rows (memory_type + memory_id → task_id link)
* - brain_observations.files_modified_json (observation → nexus file path)
*
* Node IDs are prefixed with "brain:" to prevent collisions.
*/
/**
* Converts a brain_page_edges type-prefixed ID (e.g. "observation:O-abc")
* into the LBNode ID prefix (e.g. "brain:O-abc").
*
* Returns null when the prefix is not a recognised brain type.
*
* @param typeId - Type-prefixed ID from brain_page_edges.from_id or to_id.
* @returns LBNode-prefixed ID or null.
*/
function brainTypeIdToLBId(typeId) {
	const sep = typeId.indexOf(":");
	if (sep === -1) return null;
	const prefix = typeId.slice(0, sep);
	const rawId = typeId.slice(sep + 1);
	if (prefix === "observation" || prefix === "decision" || prefix === "pattern" || prefix === "learning") return `brain:${rawId}`;
	return null;
}
/**
* Returns true when a brain_page_edges to_id looks like a nexus node path
* (contains "::" separator used by nexus for file::Symbol paths, or is a
* relative file path with a known extension).
*
* @param toId - to_id value from brain_page_edges.
* @returns True when the ID appears to reference a nexus node.
*/
function isNexusStyleId(toId) {
	if (toId.includes("::")) return true;
	if (!toId.includes(":") && toId.includes("/")) return true;
	return false;
}
/**
* Returns true when a brain_page_edges ID looks like a task reference
* (e.g. "task:T532").
*
* @param id - ID from brain_page_edges.
* @returns True when the ID references a task node.
*/
function isTaskId(id) {
	return id.startsWith("task:");
}
/**
* Converts a brain_page_edges task-reference to a tasks-substrate LBNode ID.
* e.g. "task:T532" → "tasks:T532"
*
* @param taskRef - Task reference from brain_page_edges.
* @returns tasks-substrate LBNode ID.
*/
function taskRefToLBId(taskRef) {
	return `tasks:${taskRef.slice(5)}`;
}
/**
* Returns all LBNodes and LBEdges sourced from brain.db.
*
* Pulls from all four typed memory tables plus brain_page_edges.
* Emits intra-brain edges between loaded nodes, cross-substrate
* brain→tasks bridges, cross-substrate brain→nexus bridges, and
* brain_memory_links as cross-substrate edges.
*
* Applies `minWeight` filter where quality_score is available.
* Node count is bounded by `limit / 5` to share budget with other substrates.
*
* @param options - Query options (limit, minWeight).
* @returns Nodes and edges from the BRAIN substrate.
*/
function getBrainSubstrate(options = {}) {
	const db = getBrainDb(options.projectCtx ?? resolveDefaultProjectContext());
	if (!db) return {
		nodes: [],
		edges: []
	};
	const minWeight = options.minWeight ?? 0;
	const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
	const nodes = [];
	const edges = [];
	try {
		const obsRows = db.prepare(`SELECT id, title, quality_score, memory_tier,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at,
                source_session_id, files_modified_json
         FROM brain_observations
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`).all(minWeight, Math.ceil(perSubstrateLimit * .4));
		for (const row of obsRows) nodes.push({
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
		});
		const decRows = db.prepare(`SELECT id, decision, quality_score, context_task_id,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at
         FROM brain_decisions
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`).all(minWeight, Math.ceil(perSubstrateLimit * .25));
		for (const row of decRows) nodes.push({
			id: `brain:${row.id}`,
			kind: "decision",
			substrate: "brain",
			label: row.decision.slice(0, 100),
			weight: row.quality_score ?? void 0,
			createdAt: row.created_at,
			meta: {
				context_task_id: row.context_task_id,
				created_at: row.created_at
			}
		});
		const patRows = db.prepare(`SELECT id, pattern, type, quality_score,
                strftime('%Y-%m-%dT%H:%M:%S', extracted_at) AS extracted_at
         FROM brain_patterns
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, extracted_at DESC
         LIMIT ?`).all(minWeight, Math.ceil(perSubstrateLimit * .2));
		for (const row of patRows) nodes.push({
			id: `brain:${row.id}`,
			kind: "pattern",
			substrate: "brain",
			label: row.pattern.slice(0, 100),
			weight: row.quality_score ?? void 0,
			createdAt: row.extracted_at,
			meta: {
				pattern_type: row.type,
				created_at: row.extracted_at
			}
		});
		const learnRows = db.prepare(`SELECT id, insight, quality_score,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at
         FROM brain_learnings
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`).all(minWeight, Math.ceil(perSubstrateLimit * .15));
		for (const row of learnRows) nodes.push({
			id: `brain:${row.id}`,
			kind: "learning",
			substrate: "brain",
			label: row.insight.slice(0, 100),
			weight: row.quality_score ?? void 0,
			createdAt: row.created_at,
			meta: { created_at: row.created_at }
		});
		const typeIdToLBId = /* @__PURE__ */ new Map();
		for (const n of nodes) {
			const rawId = n.id.slice(6);
			let typePrefix;
			if (n.kind === "observation") typePrefix = "observation";
			else if (n.kind === "decision") typePrefix = "decision";
			else if (n.kind === "pattern") typePrefix = "pattern";
			else typePrefix = "learning";
			typeIdToLBId.set(`${typePrefix}:${rawId}`, n.id);
		}
		const pageEdgeRows = db.prepare(`SELECT from_id, to_id, edge_type, weight FROM brain_page_edges`).all();
		for (const row of pageEdgeRows) {
			const sourceLBId = typeIdToLBId.get(row.from_id) ?? brainTypeIdToLBId(row.from_id);
			if (!sourceLBId) continue;
			if (isTaskId(row.to_id)) edges.push({
				source: sourceLBId,
				target: taskRefToLBId(row.to_id),
				type: row.edge_type,
				weight: row.weight ?? .5,
				substrate: "cross"
			});
			else if (isNexusStyleId(row.to_id)) edges.push({
				source: sourceLBId,
				target: `nexus:${row.to_id}`,
				type: row.edge_type,
				weight: row.weight ?? .5,
				substrate: "cross"
			});
			else {
				const targetLBId = typeIdToLBId.get(row.to_id) ?? brainTypeIdToLBId(row.to_id);
				if (targetLBId) edges.push({
					source: sourceLBId,
					target: targetLBId,
					type: row.edge_type,
					weight: row.weight ?? .5,
					substrate: "brain"
				});
			}
		}
		const memLinkRows = db.prepare(`SELECT memory_type, memory_id, task_id, link_type
         FROM brain_memory_links`).all();
		for (const row of memLinkRows) {
			const sourceTypeId = `${row.memory_type}:${row.memory_id}`;
			const sourceLBId = typeIdToLBId.get(sourceTypeId) ?? brainTypeIdToLBId(sourceTypeId);
			if (!sourceLBId) continue;
			edges.push({
				source: sourceLBId,
				target: `tasks:${row.task_id}`,
				type: row.link_type,
				weight: .7,
				substrate: "cross"
			});
		}
		for (const row of obsRows) {
			if (!row.files_modified_json) continue;
			let filePaths;
			try {
				filePaths = JSON.parse(row.files_modified_json);
			} catch {
				continue;
			}
			if (!Array.isArray(filePaths)) continue;
			const sourceLBId = `brain:${row.id}`;
			for (const rawPath of filePaths) {
				if (typeof rawPath !== "string" || rawPath.length === 0) continue;
				edges.push({
					source: sourceLBId,
					target: `nexus:${rawPath}`,
					type: "modified_by",
					weight: .6,
					substrate: "cross"
				});
			}
		}
		for (const dec of decRows) if (dec.context_task_id) edges.push({
			source: `brain:${dec.id}`,
			target: `tasks:${dec.context_task_id}`,
			type: "applies_to",
			weight: .8,
			substrate: "cross"
		});
	} catch {}
	return {
		nodes,
		edges
	};
}
//#endregion
//#region src/lib/server/living-brain/adapters/conduit.ts
/**
* CONDUIT substrate adapter for the Living Brain API.
*
* Queries conduit.db and returns LBNodes/LBEdges for agent-to-agent messages.
* Each message becomes a node; `from_agent_id → to_agent_id` becomes an edge.
* Co-authoring agent pairs produce cross-substrate edges to SIGNALDOCK.
*
* Node IDs are prefixed with "conduit:" to prevent collisions.
*/
/**
* Converts a UNIX epoch seconds value to an ISO-8601 string.
* Returns null when the value is not a finite positive number.
*
* @param epoch - UNIX timestamp in seconds.
* @returns ISO-8601 string or null.
*/
function epochToIso$1(epoch) {
	if (!Number.isFinite(epoch) || epoch <= 0) return null;
	return (/* @__PURE__ */ new Date(epoch * 1e3)).toISOString();
}
/**
* Returns all LBNodes and LBEdges sourced from conduit.db.
*
* Fetches the most recent messages (capped at perSubstrateLimit).
* Synthesizes agent→agent edges and cross-substrate agent references
* pointing to signaldock.
*
* @param options - Query options (limit).
* @returns Nodes and edges from the CONDUIT substrate.
*/
function getConduitSubstrate(options = {}) {
	const db = getConduitDb(options.projectCtx ?? resolveDefaultProjectContext());
	if (!db) return {
		nodes: [],
		edges: []
	};
	const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
	const nodes = [];
	const edges = [];
	try {
		const msgRows = db.prepare(`SELECT id, content, from_agent_id, to_agent_id, created_at, conversation_id
         FROM messages
         ORDER BY created_at DESC
         LIMIT ?`).all(perSubstrateLimit);
		const agentPairs = /* @__PURE__ */ new Map();
		for (const row of msgRows) {
			const label = row.content.length > 80 ? `${row.content.slice(0, 80)}…` : row.content;
			nodes.push({
				id: `conduit:${row.id}`,
				kind: "message",
				substrate: "conduit",
				label,
				createdAt: epochToIso$1(row.created_at),
				meta: {
					from_agent_id: row.from_agent_id,
					to_agent_id: row.to_agent_id,
					conversation_id: row.conversation_id,
					created_at: row.created_at
				}
			});
			if (row.from_agent_id && row.to_agent_id) {
				const key = `${row.from_agent_id}→${row.to_agent_id}`;
				const existing = agentPairs.get(key);
				if (existing) existing.count++;
				else agentPairs.set(key, {
					count: 1,
					from: row.from_agent_id,
					to: row.to_agent_id
				});
			}
		}
		for (const [, pair] of agentPairs) {
			const weight = Math.min(1, pair.count / 10);
			edges.push({
				source: `signaldock:${pair.from}`,
				target: `signaldock:${pair.to}`,
				type: "messages",
				weight,
				substrate: "cross"
			});
		}
	} catch {}
	return {
		nodes,
		edges
	};
}
//#endregion
//#region src/lib/server/living-brain/adapters/nexus.ts
/**
* NEXUS substrate adapter for the Living Brain API.
*
* Queries nexus.db (global) and returns LBNodes/LBEdges for code symbols and files.
* Prioritises high-in-degree nodes (most-called functions, most-imported files)
* since the full nexus graph can exceed 10k nodes.
*
* Node IDs are prefixed with "nexus:" to prevent collisions.
*/
/** Maps nexus node kinds to LBNodeKind. */
function mapKind(nexusKind) {
	if (nexusKind === "file" || nexusKind === "folder" || nexusKind === "module") return "file";
	return "symbol";
}
/**
* Returns all LBNodes and LBEdges sourced from nexus.db.
*
* Fetches the highest in-degree nodes (capped at perSubstrateLimit) and
* all relations between those nodes.
*
* @param options - Query options (limit, minWeight).
* @returns Nodes and edges from the NEXUS substrate.
*/
function getNexusSubstrate(options = {}) {
	const db = getNexusDb();
	if (!db) return {
		nodes: [],
		edges: []
	};
	const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
	const nodes = [];
	const edges = [];
	try {
		const nodeRows = db.prepare(`SELECT n.id, n.kind, n.name, n.indexed_at,
                COUNT(r.target_id) AS in_degree
         FROM nexus_nodes n
         LEFT JOIN nexus_relations r ON r.target_id = n.id
         WHERE n.kind IN (
           'file', 'function', 'method', 'class', 'interface',
           'type_alias', 'constant', 'module', 'enum'
         )
         GROUP BY n.id
         ORDER BY in_degree DESC
         LIMIT ?`).all(perSubstrateLimit);
		for (const row of nodeRows) nodes.push({
			id: `nexus:${row.id}`,
			kind: mapKind(row.kind),
			substrate: "nexus",
			label: row.name,
			weight: row.in_degree > 0 ? Math.min(1, row.in_degree / 50) : void 0,
			createdAt: row.indexed_at ?? null,
			meta: {
				nexus_kind: row.kind,
				in_degree: row.in_degree
			}
		});
		const nodeIds = new Set(nodes.map((n) => n.id));
		const rawIds = new Set([...nodeIds].map((id) => id.replace(/^nexus:/, "")));
		const placeholders = [...rawIds].map(() => "?").join(",");
		if (rawIds.size === 0) return {
			nodes,
			edges
		};
		const relRows = db.prepare(`SELECT source_id, target_id, type, confidence
         FROM nexus_relations
         WHERE source_id IN (${placeholders})
           AND target_id IN (${placeholders})`).all(...rawIds, ...rawIds);
		for (const row of relRows) edges.push({
			source: `nexus:${row.source_id}`,
			target: `nexus:${row.target_id}`,
			type: row.type,
			weight: row.confidence ?? .5,
			substrate: "nexus"
		});
	} catch {}
	return {
		nodes,
		edges
	};
}
//#endregion
//#region src/lib/server/living-brain/adapters/signaldock.ts
/**
* SIGNALDOCK substrate adapter for the Living Brain API.
*
* Queries signaldock.db (global) and returns LBNodes/LBEdges for agents
* and agent-to-agent social connections.
*
* Node IDs are prefixed with "signaldock:" to prevent collisions.
* Agents are the cross-substrate identity bridge — they appear in TASKS
* (assignee), CONDUIT (from/to), and BRAIN (source agent).
*/
/**
* Converts a UNIX epoch seconds value to an ISO-8601 string.
* Returns null when the value is not a finite positive number.
*
* @param epoch - UNIX timestamp in seconds, or null.
* @returns ISO-8601 string or null.
*/
function epochToIso(epoch) {
	if (epoch === null || !Number.isFinite(epoch) || epoch <= 0) return null;
	return (/* @__PURE__ */ new Date(epoch * 1e3)).toISOString();
}
/**
* Returns all LBNodes and LBEdges sourced from signaldock.db.
*
* Fetches all active agents plus their declared connections.
* Agent nodes serve as the cross-substrate identity anchors.
*
* @param options - Query options (limit).
* @returns Nodes and edges from the SIGNALDOCK substrate.
*/
function getSignaldockSubstrate(options = {}) {
	const db = getSignaldockDb();
	if (!db) return {
		nodes: [],
		edges: []
	};
	const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
	const nodes = [];
	const edges = [];
	try {
		const agentRows = db.prepare(`SELECT agent_id, name, status, created_at
         FROM agents
         WHERE status != 'deleted'
         ORDER BY created_at DESC
         LIMIT ?`).all(perSubstrateLimit);
		const agentIds = /* @__PURE__ */ new Set();
		for (const row of agentRows) {
			agentIds.add(row.agent_id);
			nodes.push({
				id: `signaldock:${row.agent_id}`,
				kind: "agent",
				substrate: "signaldock",
				label: row.name,
				weight: row.status === "active" ? 1 : .5,
				createdAt: epochToIso(row.created_at),
				meta: {
					status: row.status,
					created_at: row.created_at
				}
			});
		}
		if (agentIds.size > 0) {
			const placeholders = [...agentIds].map(() => "?").join(",");
			const connRows = db.prepare(`SELECT from_agent_id, to_agent_id, connection_type, strength
           FROM agent_connections
           WHERE from_agent_id IN (${placeholders})
             AND to_agent_id IN (${placeholders})`).all(...agentIds, ...agentIds);
			for (const row of connRows) edges.push({
				source: `signaldock:${row.from_agent_id}`,
				target: `signaldock:${row.to_agent_id}`,
				type: row.connection_type,
				weight: row.strength ?? .5,
				substrate: "signaldock"
			});
		}
	} catch {}
	return {
		nodes,
		edges
	};
}
//#endregion
//#region src/lib/server/living-brain/adapters/tasks.ts
/**
* TASKS substrate adapter for the Living Brain API.
*
* Queries tasks.db and returns LBNodes/LBEdges for tasks and sessions.
* Prioritises critical/high priority tasks and active sessions.
*
* Node IDs are prefixed with "tasks:" to prevent collisions.
*/
/** Maps priority string to numeric weight for LBNode.weight. */
function priorityWeight(priority) {
	return {
		critical: 1,
		high: .75,
		medium: .5,
		low: .25
	}[priority] ?? .25;
}
/**
* Returns all LBNodes and LBEdges sourced from tasks.db.
*
* Fetches tasks ordered by priority, plus recent sessions.
* Synthesizes parent→child, dependency, and relation edges.
*
* @param options - Query options (limit, minWeight).
* @returns Nodes and edges from the TASKS substrate.
*/
function getTasksSubstrate(options = {}) {
	const db = getTasksDb(options.projectCtx ?? resolveDefaultProjectContext());
	if (!db) return {
		nodes: [],
		edges: []
	};
	const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);
	const minWeight = options.minWeight ?? 0;
	const nodes = [];
	const edges = [];
	try {
		const taskRows = db.prepare(`SELECT id, title, status, priority, type, parent_id, created_at
         FROM tasks
         WHERE status NOT IN ('archived', 'cancelled')
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
           END,
           created_at DESC
         LIMIT ?`).all(Math.ceil(perSubstrateLimit * .8));
		const taskIds = /* @__PURE__ */ new Set();
		for (const row of taskRows) {
			const weight = priorityWeight(row.priority);
			if (weight < minWeight) continue;
			taskIds.add(row.id);
			nodes.push({
				id: `tasks:${row.id}`,
				kind: "task",
				substrate: "tasks",
				label: row.title,
				weight,
				createdAt: row.created_at,
				meta: {
					status: row.status,
					priority: row.priority,
					type: row.type,
					parent_id: row.parent_id,
					created_at: row.created_at
				}
			});
		}
		const sessionRows = db.prepare(`SELECT id, status, started_at, ended_at
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`).all(Math.ceil(perSubstrateLimit * .2));
		const sessionIds = /* @__PURE__ */ new Set();
		for (const row of sessionRows) {
			sessionIds.add(row.id);
			nodes.push({
				id: `tasks:${row.id}`,
				kind: "session",
				substrate: "tasks",
				label: `Session ${row.id.slice(-8)}`,
				weight: row.status === "active" ? .9 : .4,
				createdAt: row.started_at,
				meta: {
					status: row.status,
					started_at: row.started_at,
					ended_at: row.ended_at
				}
			});
		}
		for (const row of taskRows) if (row.parent_id && taskIds.has(row.parent_id)) edges.push({
			source: `tasks:${row.parent_id}`,
			target: `tasks:${row.id}`,
			type: "parent_of",
			weight: .9,
			substrate: "tasks"
		});
		if (taskIds.size > 0) {
			const placeholders = [...taskIds].map(() => "?").join(",");
			const relRows = db.prepare(`SELECT task_id, related_task_id, relation_type
           FROM task_relations
           WHERE task_id IN (${placeholders})
             AND related_task_id IN (${placeholders})`).all(...taskIds, ...taskIds);
			for (const row of relRows) edges.push({
				source: `tasks:${row.task_id}`,
				target: `tasks:${row.related_task_id}`,
				type: row.relation_type,
				weight: .7,
				substrate: "tasks"
			});
			const depRows = db.prepare(`SELECT task_id, depends_on_task_id
           FROM task_dependencies
           WHERE task_id IN (${placeholders})
             AND depends_on_task_id IN (${placeholders})`).all(...taskIds, ...taskIds);
			for (const row of depRows) edges.push({
				source: `tasks:${row.task_id}`,
				target: `tasks:${row.depends_on_task_id}`,
				type: "depends_on",
				weight: .85,
				substrate: "tasks"
			});
		}
	} catch {}
	return {
		nodes,
		edges
	};
}
//#endregion
//#region src/lib/server/living-brain/adapters/index.ts
/** Substrate names ordered for iteration. */
var ALL_SUBSTRATES = [
	"brain",
	"nexus",
	"tasks",
	"conduit",
	"signaldock"
];
/** Maps substrate name to its adapter function. */
var ADAPTER_MAP = {
	brain: getBrainSubstrate,
	nexus: getNexusSubstrate,
	tasks: getTasksSubstrate,
	conduit: getConduitSubstrate,
	signaldock: getSignaldockSubstrate
};
/**
* Queries all five substrates and merges the results into a unified LBGraph.
*
* When `options.substrates` is provided, only those substrates are queried.
* Node IDs are substrate-prefixed, so deduplication is safe to perform
* by ID equality alone.
*
* Cross-substrate edges may reference nodes not present in the current result
* (e.g. a CONDUIT message edge pointing to a signaldock agent not loaded due
* to limit). Those edges are included — the caller is responsible for
* rendering unresolved endpoints as virtual stubs.
*
* @param options - Query options forwarded to each substrate adapter.
* @returns Merged LBGraph across all requested substrates.
*/
function getAllSubstrates(options = {}) {
	const substrates = options.substrates ?? ALL_SUBSTRATES;
	const limit = options.limit ?? 500;
	const allNodes = [];
	const allEdges = [];
	const nodeCounts = Object.fromEntries(ALL_SUBSTRATES.map((s) => [s, 0]));
	const edgeCounts = Object.fromEntries([...ALL_SUBSTRATES, "cross"].map((s) => [s, 0]));
	for (const substrate of substrates) {
		const adapter = ADAPTER_MAP[substrate];
		if (!adapter) continue;
		const { nodes, edges } = adapter({
			...options,
			limit
		});
		allNodes.push(...nodes);
		allEdges.push(...edges);
		nodeCounts[substrate] = nodes.length;
		for (const edge of edges) edgeCounts[edge.substrate] = (edgeCounts[edge.substrate] ?? 0) + 1;
	}
	const seenIds = /* @__PURE__ */ new Set();
	const uniqueNodes = [];
	for (const node of allNodes) if (!seenIds.has(node.id)) {
		seenIds.add(node.id);
		uniqueNodes.push(node);
	}
	const truncated = uniqueNodes.length >= limit;
	return {
		nodes: truncated ? uniqueNodes.slice(0, limit) : uniqueNodes,
		edges: allEdges,
		counts: {
			nodes: nodeCounts,
			edges: edgeCounts
		},
		truncated
	};
}

export { getAllSubstrates as g };
//# sourceMappingURL=adapters-CHxN16M4.js.map

import { g as getNexusDb } from './connections-C-btvhSI.js';
import { json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/nexus/symbol/[name]/+server.ts
/**
* GET /api/nexus/symbol/:name
*
* Returns an ego network (2-hop) around the named symbol.
* The center node plus all nodes directly connected (hop 1) and their
* immediate neighbours (hop 2) are included. Edges within the subgraph
* are also returned.
*/
var GET = ({ params }) => {
	const db = getNexusDb();
	if (!db) return json({ error: "nexus.db not available" }, { status: 503 });
	const name = decodeURIComponent(params.name);
	const centerRow = db.prepare(`SELECT id, label, kind, file_path, community_id
       FROM nexus_nodes
       WHERE label = ? OR id = ?
       ORDER BY CASE WHEN label = ? THEN 0 ELSE 1 END
       LIMIT 1`).get(name, name, name);
	if (!centerRow) return json({ error: `Symbol "${name}" not found` }, { status: 404 });
	const centerId = centerRow.id;
	const hop1Rows = db.prepare(`SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.community_id
       FROM nexus_relations r
       JOIN nexus_nodes n ON (r.target_id = n.id OR r.source_id = n.id)
       WHERE (r.source_id = ? OR r.target_id = ?)
         AND n.id != ?
       LIMIT 100`).all(centerId, centerId, centerId);
	const hop1Ids = hop1Rows.map((n) => n.id);
	let hop2Rows = [];
	if (hop1Ids.length > 0) {
		const placeholders = hop1Ids.map(() => "?").join(",");
		const excludeIds = [centerId, ...hop1Ids];
		const excludePlaceholders = excludeIds.map(() => "?").join(",");
		hop2Rows = db.prepare(`SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.community_id
         FROM nexus_relations r
         JOIN nexus_nodes n ON (r.target_id = n.id OR r.source_id = n.id)
         WHERE (r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))
           AND n.id NOT IN (${excludePlaceholders})
         LIMIT 200`).all(...hop1Ids, ...hop1Ids, ...excludeIds);
	}
	const allIds = [
		centerId,
		...hop1Ids,
		...hop2Rows.map((n) => n.id)
	];
	const callerCounts = /* @__PURE__ */ new Map();
	if (allIds.length > 0) {
		const placeholders = allIds.map(() => "?").join(",");
		const ccRows = db.prepare(`SELECT target_id, COUNT(*) AS cnt
         FROM nexus_relations
         WHERE target_id IN (${placeholders}) AND type = 'calls'
         GROUP BY target_id`).all(...allIds);
		for (const row of ccRows) callerCounts.set(row.target_id, row.cnt);
	}
	const subgraphEdges = allIds.length > 0 ? db.prepare(`SELECT source_id, target_id, type
           FROM nexus_relations
           WHERE source_id IN (${allIds.map(() => "?").join(",")})
             AND target_id IN (${allIds.map(() => "?").join(",")})
           LIMIT 1000`).all(...allIds, ...allIds) : [];
	return json({
		center: centerId,
		nodes: [
			{
				id: centerRow.id,
				label: centerRow.label,
				kind: centerRow.kind,
				filePath: centerRow.file_path ?? "",
				hop: 0,
				callerCount: callerCounts.get(centerRow.id) ?? 0,
				communityId: centerRow.community_id
			},
			...hop1Rows.map((n) => ({
				id: n.id,
				label: n.label,
				kind: n.kind,
				filePath: n.file_path ?? "",
				hop: 1,
				callerCount: callerCounts.get(n.id) ?? 0,
				communityId: n.community_id
			})),
			...hop2Rows.map((n) => ({
				id: n.id,
				label: n.label,
				kind: n.kind,
				filePath: n.file_path ?? "",
				hop: 2,
				callerCount: callerCounts.get(n.id) ?? 0,
				communityId: n.community_id
			}))
		],
		edges: subgraphEdges.map((e) => ({
			source: e.source_id,
			target: e.target_id,
			type: e.type
		}))
	});
};

export { GET };
//# sourceMappingURL=_server.ts-C6OZ4Ejt.js.map

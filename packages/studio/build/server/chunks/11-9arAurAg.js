import { g as getNexusDb } from './connections-C-btvhSI.js';
import { error } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/code/symbol/[name]/+page.server.ts
/**
* Symbol ego-network page server load.
*
* Fetches the 2-hop ego network for the named symbol directly from nexus.db.
*/
var load = ({ params }) => {
	const db = getNexusDb();
	if (!db) error(503, "nexus.db not available");
	const name = decodeURIComponent(params.name);
	const centerRow = db.prepare(`SELECT id, label, kind, file_path, community_id
       FROM nexus_nodes
       WHERE label = ? OR id = ?
       ORDER BY CASE WHEN label = ? THEN 0 ELSE 1 END
       LIMIT 1`).get(name, name, name);
	if (!centerRow) error(404, `Symbol "${name}" not found`);
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
	const edgeRows = allIds.length > 0 ? db.prepare(`SELECT source_id, target_id, type
             FROM nexus_relations
             WHERE source_id IN (${allIds.map(() => "?").join(",")})
               AND target_id IN (${allIds.map(() => "?").join(",")})
             LIMIT 1000`).all(...allIds, ...allIds) : [];
	return {
		symbolName: name,
		center: centerRow,
		egoNodes: [
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
		egoEdges: edgeRows.map((e) => ({
			source: e.source_id,
			target: e.target_id,
			type: e.type
		}))
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 11;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-iAZO0c5T.js')).default;
const server_id = "src/routes/code/symbol/[name]/+page.server.ts";
const imports = ["_app/immutable/nodes/11.DAgcWjXr.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js","_app/immutable/chunks/B9fs5Bq9.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/DdyX08XJ.js","_app/immutable/chunks/BgWknWDs.js"];
const stylesheets = ["_app/immutable/assets/NexusGraph.eS4eJg0E.css","_app/immutable/assets/11.BHw-5yit.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=11-9arAurAg.js.map

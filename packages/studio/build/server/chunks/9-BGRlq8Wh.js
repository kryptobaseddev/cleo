import { g as getNexusDb } from './connections-C-btvhSI.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/code/+page.server.ts
/**
* Nexus macro view server load.
*
* Builds the community graph data: one node per community (up to 259),
* with inter-community edges derived from cross-community relations.
*
* Label derivation priority:
*   1. `nexus_nodes.label` for the community node itself (heuristic label
*      written by community-processor, e.g. "Engines", "Pipeline")
*   2. Most-common parent folder across member file paths
*   3. `Cluster N` fallback
*/
var PALETTE = [
	"#3b82f6",
	"#8b5cf6",
	"#06b6d4",
	"#10b981",
	"#f59e0b",
	"#ef4444",
	"#ec4899",
	"#14b8a6",
	"#f97316",
	"#6366f1",
	"#84cc16",
	"#a855f7"
];
function colorForIndex(index) {
	return PALETTE[index % PALETTE.length] ?? "#3b82f6";
}
function communitySize(memberCount) {
	return 6 + Math.log1p(memberCount) * 3;
}
var load = () => {
	const db = getNexusDb();
	let macroNodes = [];
	let macroEdges = [];
	let totalNodes = 0;
	let totalRelations = 0;
	if (db) try {
		const nodeCount = db.prepare("SELECT COUNT(*) AS cnt FROM nexus_nodes").get();
		const relCount = db.prepare("SELECT COUNT(*) AS cnt FROM nexus_relations").get();
		totalNodes = nodeCount.cnt;
		totalRelations = relCount.cnt;
		macroNodes = db.prepare(`SELECT n1.community_id,
                  COUNT(*) AS member_count,
                  (SELECT kind FROM nexus_nodes n2
                   WHERE n2.community_id = n1.community_id
                   GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind,
                  (SELECT cn.label FROM nexus_nodes cn
                   WHERE cn.id = n1.community_id
                   LIMIT 1) AS community_label
           FROM nexus_nodes n1
           WHERE n1.community_id IS NOT NULL
           GROUP BY n1.community_id
           ORDER BY member_count DESC`).all().map((row, idx) => {
			const rawLabel = row.community_label?.trim() ?? "";
			const clusterNum = row.community_id.replace("comm_", "");
			const label = rawLabel && rawLabel !== row.community_id ? `${rawLabel} (${row.member_count})` : `Cluster ${clusterNum} (${row.member_count})`;
			return {
				id: row.community_id,
				label,
				size: communitySize(row.member_count),
				color: colorForIndex(idx),
				topKind: row.top_kind ?? "function",
				memberCount: row.member_count
			};
		});
		macroEdges = db.prepare(`SELECT s.community_id AS src_comm,
                  t.community_id AS tgt_comm,
                  COUNT(*) AS weight
           FROM nexus_relations r
           JOIN nexus_nodes s ON r.source_id = s.id
           JOIN nexus_nodes t ON r.target_id = t.id
           WHERE s.community_id IS NOT NULL
             AND t.community_id IS NOT NULL
             AND s.community_id != t.community_id
           GROUP BY src_comm, tgt_comm
           ORDER BY weight DESC
           LIMIT 600`).all().map((row) => ({
			source: row.src_comm,
			target: row.tgt_comm,
			weight: row.weight
		}));
	} catch {}
	return {
		macroNodes,
		macroEdges,
		totalNodes,
		totalRelations
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 9;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-B1HwjZNo.js')).default;
const server_id = "src/routes/code/+page.server.ts";
const imports = ["_app/immutable/nodes/9.CDuVeJJ4.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ibwe1TAv.js","_app/immutable/chunks/CmJOQN3G.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/hOfOSlm7.js","_app/immutable/chunks/DTI-ijOe.js"];
const stylesheets = ["_app/immutable/assets/NexusGraph.eS4eJg0E.css","_app/immutable/assets/9.3TsiVwvh.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=9-BGRlq8Wh.js.map

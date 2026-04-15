import { i as getNexusDb } from "../../../chunks/connections.js";
//#region src/routes/nexus/+page.server.ts
/**
* Nexus macro view server load.
*
* Builds the community graph data: one node per community (up to 259),
* with inter-community edges derived from cross-community relations.
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
		macroNodes = db.prepare(`SELECT community_id,
                  COUNT(*) AS member_count,
                  (SELECT kind FROM nexus_nodes n2
                   WHERE n2.community_id = n1.community_id
                   GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind
           FROM nexus_nodes n1
           WHERE community_id IS NOT NULL
           GROUP BY community_id
           ORDER BY member_count DESC`).all().map((row, idx) => ({
			id: row.community_id,
			label: `Cluster ${row.community_id.replace("comm_", "")}`,
			size: communitySize(row.member_count),
			color: colorForIndex(idx),
			topKind: row.top_kind ?? "function",
			memberCount: row.member_count
		}));
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
//#endregion
export { load };

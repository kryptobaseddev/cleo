import { g as getNexusDb } from './connections-BR9V-1fV.js';
import { json } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/nexus/+server.ts
/**
* GET /api/nexus/communities
*
* Returns all communities with member counts and assigned colors.
* Color is derived from a deterministic palette by community index.
*/
/** Community palette — 12 distinct hues cycling for 254 communities. */
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
var GET = () => {
	const db = getNexusDb();
	if (!db) return json({ error: "nexus.db not available" }, { status: 503 });
	return json(db.prepare(`SELECT community_id,
              COUNT(*) AS size,
              (SELECT kind FROM nexus_nodes n2
               WHERE n2.community_id = n1.community_id
               GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 1) AS top_kind
       FROM nexus_nodes n1
       WHERE community_id IS NOT NULL
       GROUP BY community_id
       ORDER BY size DESC`).all().map((row, idx) => ({
		id: row.community_id,
		name: `Cluster ${row.community_id.replace("comm_", "")}`,
		size: row.size,
		color: colorForIndex(idx),
		topKind: row.top_kind ?? "function"
	})));
};

export { GET };
//# sourceMappingURL=_server.ts-DR5nwGwj.js.map

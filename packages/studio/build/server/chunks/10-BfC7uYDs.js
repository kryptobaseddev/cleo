import { g as getNexusDb } from './connections-C-btvhSI.js';
import { error } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/code/community/[id]/+page.server.ts
/**
* Community drill-down page server load.
*
* Fetches all member nodes and internal edges for the given community.
* Also returns the community's human-readable label so the breadcrumb
* can show "Memory (45)" instead of "comm_3".
*/
var load = ({ params }) => {
	const db = getNexusDb();
	if (!db) error(503, "nexus.db not available");
	const communityId = decodeURIComponent(params.id);
	const nodeRows = db.prepare(`SELECT n.id, n.label, n.kind, n.file_path,
              COUNT(r.id) AS caller_count
       FROM nexus_nodes n
       LEFT JOIN nexus_relations r ON r.target_id = n.id AND r.type = 'calls'
       WHERE n.community_id = ?
       GROUP BY n.id
       ORDER BY caller_count DESC
       LIMIT 500`).all(communityId);
	if (nodeRows.length === 0) error(404, `Community ${communityId} not found`);
	const nodeIds = nodeRows.map((n) => n.id);
	const placeholders = nodeIds.map(() => "?").join(",");
	const edgeRows = db.prepare(`SELECT source_id, target_id, type
       FROM nexus_relations
       WHERE source_id IN (${placeholders})
         AND target_id IN (${placeholders})
       LIMIT 2000`).all(...nodeIds, ...nodeIds);
	const communityNodes = nodeRows.map((row) => ({
		id: row.id,
		label: row.label,
		kind: row.kind,
		filePath: row.file_path ?? "",
		callerCount: row.caller_count
	}));
	const communityEdges = edgeRows.map((row) => ({
		source: row.source_id,
		target: row.target_id,
		type: row.type
	}));
	const rawLabel = db.prepare(`SELECT label FROM nexus_nodes WHERE id = ? LIMIT 1`).get(communityId)?.label?.trim() ?? "";
	const clusterNum = communityId.replace("comm_", "");
	const communityLabel = rawLabel && rawLabel !== communityId ? rawLabel : `Cluster ${clusterNum}`;
	const topKindRow = db.prepare(`SELECT kind, COUNT(*) AS cnt
       FROM nexus_nodes
       WHERE community_id = ?
       GROUP BY kind
       ORDER BY cnt DESC
       LIMIT 1`).get(communityId);
	return {
		communityId,
		communityLabel,
		communityNodes,
		communityEdges,
		summary: {
			id: communityId,
			label: communityLabel,
			memberCount: nodeRows.length,
			topKind: topKindRow?.kind ?? "function"
		}
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 10;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-MBpt8u2i.js')).default;
const server_id = "src/routes/code/community/[id]/+page.server.ts";
const imports = ["_app/immutable/nodes/10.Bx07lqRA.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/ibwe1TAv.js","_app/immutable/chunks/B9fs5Bq9.js","_app/immutable/chunks/lNG2k0Yr.js","_app/immutable/chunks/DdyX08XJ.js","_app/immutable/chunks/BgWknWDs.js"];
const stylesheets = ["_app/immutable/assets/NexusGraph.eS4eJg0E.css","_app/immutable/assets/10.CVbowohj.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=10-BfC7uYDs.js.map

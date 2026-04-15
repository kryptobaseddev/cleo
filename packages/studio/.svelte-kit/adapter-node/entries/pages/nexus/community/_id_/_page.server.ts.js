import { i as getNexusDb } from "../../../../../chunks/connections.js";
import { error } from "@sveltejs/kit";
//#region src/routes/nexus/community/[id]/+page.server.ts
/**
* Community drill-down page server load.
*
* Fetches all member nodes and internal edges for the given community.
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
	return {
		communityId,
		communityNodes: nodeRows.map((row) => ({
			id: row.id,
			label: row.label,
			kind: row.kind,
			filePath: row.file_path ?? "",
			callerCount: row.caller_count
		})),
		communityEdges: edgeRows.map((row) => ({
			source: row.source_id,
			target: row.target_id,
			type: row.type
		}))
	};
};
//#endregion
export { load };

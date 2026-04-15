import { g as getNexusDb } from './connections-BR9V-1fV.js';
import { json } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/nexus/community/[id]/+server.ts
/**
* GET /api/nexus/community/:id
*
* Returns all member nodes for a given community, along with edges
* between members (internal edges only, for drill-down view).
*/
var GET = ({ params }) => {
	const db = getNexusDb();
	if (!db) return json({ error: "nexus.db not available" }, { status: 503 });
	const communityId = params.id;
	const nodeRows = db.prepare(`SELECT n.id,
              n.label,
              n.kind,
              n.file_path,
              COUNT(r.id) AS caller_count
       FROM nexus_nodes n
       LEFT JOIN nexus_relations r ON r.target_id = n.id AND r.type = 'calls'
       WHERE n.community_id = ?
       GROUP BY n.id
       ORDER BY caller_count DESC
       LIMIT 500`).all(communityId);
	if (nodeRows.length === 0) return json({ error: `Community ${communityId} not found` }, { status: 404 });
	const nodeIds = nodeRows.map((n) => n.id);
	const placeholders = nodeIds.map(() => "?").join(",");
	const edgeRows = db.prepare(`SELECT source_id, target_id, type
       FROM nexus_relations
       WHERE source_id IN (${placeholders})
         AND target_id IN (${placeholders})
       LIMIT 2000`).all(...nodeIds, ...nodeIds);
	return json({
		communityId,
		nodes: nodeRows.map((row) => ({
			id: row.id,
			label: row.label,
			kind: row.kind,
			filePath: row.file_path ?? "",
			callerCount: row.caller_count
		})),
		edges: edgeRows.map((row) => ({
			source: row.source_id,
			target: row.target_id,
			type: row.type
		}))
	});
};

export { GET };
//# sourceMappingURL=_server.ts-lLIaMc-o.js.map

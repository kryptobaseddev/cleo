import { t as getBrainDb } from "../../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/brain/graph/+server.ts
/**
* Brain graph API endpoint.
* GET /api/brain/graph → { nodes: BrainNode[], edges: BrainEdge[] }
*
* Returns brain_page_nodes and brain_page_edges for the force-directed graph.
* Limits to 500 nodes for performance (highest quality first).
*/
var MAX_NODES = 500;
var GET = ({ locals }) => {
	const db = getBrainDb(locals.projectCtx);
	if (!db) return json({
		nodes: [],
		edges: [],
		total_nodes: 0,
		total_edges: 0
	});
	try {
		const totalNodeRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_page_nodes").get();
		const totalEdgeRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_page_edges").get();
		const nodes = db.prepare(`SELECT id, node_type, label, quality_score, metadata_json, created_at
         FROM brain_page_nodes
         ORDER BY quality_score DESC, last_activity_at DESC
         LIMIT ?`).all(MAX_NODES);
		const nodeIds = new Set(nodes.map((n) => n.id));
		return json({
			nodes,
			edges: db.prepare(`SELECT from_id, to_id, edge_type, weight, created_at
         FROM brain_page_edges`).all().filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id)),
			total_nodes: totalNodeRow.cnt,
			total_edges: totalEdgeRow.cnt
		});
	} catch {
		return json({
			nodes: [],
			edges: [],
			total_nodes: 0,
			total_edges: 0
		});
	}
};
//#endregion
export { GET };

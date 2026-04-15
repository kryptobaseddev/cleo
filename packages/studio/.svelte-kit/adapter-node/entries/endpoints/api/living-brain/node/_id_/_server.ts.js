import { t as getAllSubstrates } from "../../../../../../chunks/adapters.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/living-brain/node/[id]/+server.ts
/**
* Single Living Brain node + neighbors endpoint.
*
* GET /api/living-brain/node/:id
*   → { node: LBNode, neighbors: LBNode[], edges: LBEdge[] }
*
* `:id` must be a substrate-prefixed node ID, e.g.:
*   brain:O-abc123
*   nexus:packages/core/src/store/tasks-schema.ts::createTask
*   tasks:T626
*   conduit:msg-xyz
*   signaldock:agent-007
*
* Returns 404 if the node is not found.
* Returns neighbors = nodes directly connected by at least one edge.
*/
var GET = ({ locals, params }) => {
	const nodeId = decodeURIComponent(params.id);
	if (!nodeId) return json({ error: "id is required" }, { status: 400 });
	if (nodeId.indexOf(":") === -1) return json({ error: "id must be substrate-prefixed, e.g. \"brain:O-abc\"" }, { status: 400 });
	try {
		const graph = getAllSubstrates({
			limit: 2e3,
			projectCtx: locals.projectCtx
		});
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return json({ error: `Node not found: ${nodeId}` }, { status: 404 });
		const edges = graph.edges.filter((e) => e.source === nodeId || e.target === nodeId);
		const neighborIds = /* @__PURE__ */ new Set();
		for (const e of edges) {
			if (e.source !== nodeId) neighborIds.add(e.source);
			if (e.target !== nodeId) neighborIds.add(e.target);
		}
		return json({
			node,
			neighbors: graph.nodes.filter((n) => neighborIds.has(n.id)),
			edges
		});
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};
//#endregion
export { GET };

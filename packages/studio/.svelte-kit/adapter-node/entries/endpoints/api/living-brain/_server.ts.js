import { t as getAllSubstrates } from "../../../../chunks/adapters.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/living-brain/+server.ts
/**
* Unified Living Brain API endpoint.
*
* GET /api/living-brain
*   → { nodes: LBNode[], edges: LBEdge[], counts, truncated }
*
* Query params:
*   limit      — max nodes to return (default 500, max 2000)
*   substrates — comma-separated: brain,nexus,tasks,conduit,signaldock (default all)
*   min_weight — minimum quality/weight threshold 0.0–1.0 (default 0)
*
* @see packages/studio/src/lib/server/living-brain/types.ts for schema
* @see docs/plans/brain-synaptic-visualization-research.md §5.2
*/
var VALID_SUBSTRATES = new Set([
	"brain",
	"nexus",
	"tasks",
	"conduit",
	"signaldock"
]);
var GET = ({ url }) => {
	const limitParam = Number(url.searchParams.get("limit") ?? "500");
	const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 500 : limitParam), 2e3);
	const substratesParam = url.searchParams.get("substrates");
	const substrates = substratesParam ? substratesParam.split(",").map((s) => s.trim()).filter((s) => VALID_SUBSTRATES.has(s)) : void 0;
	const minWeightParam = url.searchParams.get("min_weight");
	const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;
	try {
		return json(getAllSubstrates({
			limit,
			substrates,
			minWeight
		}));
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};
//#endregion
export { GET };

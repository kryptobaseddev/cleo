import { t as getAllSubstrates } from "../../../../../../chunks/adapters.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/living-brain/substrate/[name]/+server.ts
/**
* Substrate-filtered Living Brain endpoint.
*
* GET /api/living-brain/substrate/:name
*   → { nodes: LBNode[], edges: LBEdge[], counts, truncated }
*
* `:name` must be one of: brain | nexus | tasks | conduit | signaldock
*
* Query params:
*   limit      — max nodes to return (default 500, max 2000)
*   min_weight — minimum quality/weight threshold 0.0–1.0 (default 0)
*
* Returns 400 for unrecognised substrate names.
* This endpoint is equivalent to GET /api/living-brain?substrates=<name>
* but provides a cleaner URL and explicit 400 on bad substrate names.
*/
var VALID_SUBSTRATES = new Set([
	"brain",
	"nexus",
	"tasks",
	"conduit",
	"signaldock"
]);
var GET = ({ locals, params, url }) => {
	const name = params.name;
	if (!VALID_SUBSTRATES.has(name)) return json({ error: `Unknown substrate: "${name}". Valid values: brain, nexus, tasks, conduit, signaldock` }, { status: 400 });
	const limitParam = Number(url.searchParams.get("limit") ?? "500");
	const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 500 : limitParam), 2e3);
	const minWeightParam = url.searchParams.get("min_weight");
	const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;
	try {
		return json(getAllSubstrates({
			limit,
			substrates: [name],
			minWeight,
			projectCtx: locals.projectCtx
		}));
	} catch (err) {
		return json({ error: String(err) }, { status: 500 });
	}
};
//#endregion
export { GET };

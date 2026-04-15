import { t as getBrainDb } from "../../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/brain/decisions/+server.ts
/**
* Brain decisions API endpoint.
* GET /api/brain/decisions → { decisions: BrainDecision[] }
*
* Returns brain_decisions ordered chronologically for timeline view.
*/
var GET = () => {
	const db = getBrainDb();
	if (!db) return json({
		decisions: [],
		total: 0
	});
	try {
		const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_decisions").get();
		return json({
			decisions: db.prepare(`SELECT id, type, decision, rationale, confidence, outcome,
                context_epic_id, context_task_id, context_phase,
                quality_score, memory_tier, verified, valid_at, invalid_at,
                prune_candidate, created_at
         FROM brain_decisions
         ORDER BY created_at ASC`).all(),
			total: totalRow.cnt
		});
	} catch {
		return json({
			decisions: [],
			total: 0
		});
	}
};
//#endregion
export { GET };

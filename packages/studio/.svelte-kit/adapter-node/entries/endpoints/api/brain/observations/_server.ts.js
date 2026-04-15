import { t as getBrainDb } from "../../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/brain/observations/+server.ts
/**
* Brain observations API endpoint.
* GET /api/brain/observations?tier=short&type=episodic&min_quality=0.5 → { observations: BrainObservation[] }
*
* Supports optional query filters: tier, type, min_quality.
*/
var GET = ({ url }) => {
	const db = getBrainDb();
	if (!db) return json({
		observations: [],
		total: 0,
		filtered: 0
	});
	try {
		const tier = url.searchParams.get("tier");
		const type = url.searchParams.get("type");
		const minQuality = url.searchParams.get("min_quality");
		const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations").get();
		const conditions = [];
		const params = [];
		if (tier) {
			conditions.push("memory_tier = ?");
			params.push(tier);
		}
		if (type) {
			conditions.push("memory_type = ?");
			params.push(type);
		}
		if (minQuality !== null) {
			const q = parseFloat(minQuality);
			if (!Number.isNaN(q)) {
				conditions.push("(quality_score IS NULL OR quality_score >= ?)");
				params.push(q);
			}
		}
		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const observations = db.prepare(`SELECT id, type, title, subtitle, narrative, project,
                quality_score, memory_tier, memory_type, verified,
                valid_at, invalid_at, source_confidence, citation_count,
                prune_candidate, created_at
         FROM brain_observations
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT 200`).all(...params);
		return json({
			observations,
			total: totalRow.cnt,
			filtered: observations.length
		});
	} catch {
		return json({
			observations: [],
			total: 0,
			filtered: 0
		});
	}
};
//#endregion
export { GET };

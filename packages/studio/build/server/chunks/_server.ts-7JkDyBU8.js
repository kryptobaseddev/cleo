import { a as getBrainDb } from './connections-C-btvhSI.js';
import { json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/brain/decisions/+server.ts
/**
* Brain decisions API endpoint.
* GET /api/brain/decisions → { decisions: BrainDecision[] }
*
* Returns brain_decisions ordered chronologically for timeline view.
*/
var GET = ({ locals }) => {
	const db = getBrainDb(locals.projectCtx);
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

export { GET };
//# sourceMappingURL=_server.ts-7JkDyBU8.js.map

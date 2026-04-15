import { a as getBrainDb } from './connections-BR9V-1fV.js';
import { json } from '@sveltejs/kit';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/api/brain/quality/+server.ts
/**
* Brain quality distribution API endpoint.
* GET /api/brain/quality → quality distribution stats across all brain tables.
*/
/** Build quality buckets for a table. */
function buildBuckets(db, table) {
	return [
		{
			range: "0.0–0.2",
			min: 0,
			max: .2
		},
		{
			range: "0.2–0.4",
			min: .2,
			max: .4
		},
		{
			range: "0.4–0.6",
			min: .4,
			max: .6
		},
		{
			range: "0.6–0.8",
			min: .6,
			max: .8
		},
		{
			range: "0.8–1.0",
			min: .8,
			max: 1
		}
	].map(({ range, min, max }) => {
		const isLast = max === 1;
		return {
			range,
			min,
			max,
			count: db.prepare(`SELECT COUNT(*) as cnt FROM ${table}
         WHERE quality_score >= ? AND quality_score ${isLast ? "<=" : "<"} ?`).get(min, max).cnt
		};
	});
}
var GET = () => {
	const db = getBrainDb();
	if (!db) {
		const empty = {
			buckets: [],
			verified_count: 0,
			prune_count: 0,
			invalidated_count: 0
		};
		return json({
			observations: {
				...empty,
				tiers: [],
				types: []
			},
			decisions: empty,
			patterns: empty,
			learnings: empty
		});
	}
	try {
		const obsBuckets = buildBuckets(db, "brain_observations");
		const obsTiers = db.prepare(`SELECT COALESCE(memory_tier, 'unknown') as tier, COUNT(*) as count
         FROM brain_observations GROUP BY memory_tier ORDER BY count DESC`).all();
		const obsTypes = db.prepare(`SELECT COALESCE(memory_type, 'unknown') as memory_type, COUNT(*) as count
         FROM brain_observations GROUP BY memory_type ORDER BY count DESC`).all();
		const obsVerified = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations WHERE verified = 1").get().cnt;
		const obsPrune = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations WHERE prune_candidate = 1").get().cnt;
		const obsInvalidated = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations WHERE invalid_at IS NOT NULL").get().cnt;
		const decBuckets = buildBuckets(db, "brain_decisions");
		const decVerified = db.prepare("SELECT COUNT(*) as cnt FROM brain_decisions WHERE verified = 1").get().cnt;
		const decPrune = db.prepare("SELECT COUNT(*) as cnt FROM brain_decisions WHERE prune_candidate = 1").get().cnt;
		const patBuckets = buildBuckets(db, "brain_patterns");
		const patVerified = db.prepare("SELECT COUNT(*) as cnt FROM brain_patterns WHERE verified = 1").get().cnt;
		const learnBuckets = buildBuckets(db, "brain_learnings");
		const learnVerified = db.prepare("SELECT COUNT(*) as cnt FROM brain_learnings WHERE verified = 1").get().cnt;
		return json({
			observations: {
				buckets: obsBuckets,
				tiers: obsTiers,
				types: obsTypes,
				verified_count: obsVerified,
				prune_count: obsPrune,
				invalidated_count: obsInvalidated
			},
			decisions: {
				buckets: decBuckets,
				verified_count: decVerified,
				prune_count: decPrune,
				invalidated_count: 0
			},
			patterns: {
				buckets: patBuckets,
				verified_count: patVerified,
				prune_count: 0,
				invalidated_count: 0
			},
			learnings: {
				buckets: learnBuckets,
				verified_count: learnVerified,
				prune_count: 0,
				invalidated_count: 0
			}
		});
	} catch {
		const empty = {
			buckets: [],
			verified_count: 0,
			prune_count: 0,
			invalidated_count: 0
		};
		return json({
			observations: {
				...empty,
				tiers: [],
				types: []
			},
			decisions: empty,
			patterns: empty,
			learnings: empty
		});
	}
};

export { GET };
//# sourceMappingURL=_server.ts-CKI5WKmO.js.map

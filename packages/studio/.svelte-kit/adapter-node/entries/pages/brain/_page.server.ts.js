import { t as getBrainDb } from "../../../chunks/connections.js";
//#region src/routes/brain/+page.server.ts
/**
* Brain overview page server load — fetches stats for the dashboard.
*/
function formatCount(n) {
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
var load = () => {
	let stats = null;
	let recentNodes = [];
	let nodeTypeCounts = [];
	let tierCounts = [];
	try {
		const db = getBrainDb();
		if (db) {
			const nodeRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_page_nodes").get();
			const edgeRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_page_edges").get();
			const obsRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations").get();
			const decRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_decisions").get();
			const patRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_patterns").get();
			const learnRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_learnings").get();
			const verifiedRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations WHERE verified = 1").get();
			const pruneRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations WHERE prune_candidate = 1").get();
			stats = [
				{
					value: formatCount(nodeRow.cnt),
					label: "Graph Nodes"
				},
				{
					value: formatCount(edgeRow.cnt),
					label: "Graph Edges"
				},
				{
					value: formatCount(obsRow.cnt),
					label: "Observations"
				},
				{
					value: formatCount(decRow.cnt),
					label: "Decisions"
				},
				{
					value: formatCount(patRow.cnt),
					label: "Patterns"
				},
				{
					value: formatCount(learnRow.cnt),
					label: "Learnings"
				},
				{
					value: formatCount(verifiedRow.cnt),
					label: "Verified"
				},
				{
					value: formatCount(pruneRow.cnt),
					label: "Prune Candidates"
				}
			];
			recentNodes = db.prepare(`SELECT id, label, node_type, quality_score, created_at
           FROM brain_page_nodes
           ORDER BY last_activity_at DESC, created_at DESC
           LIMIT 10`).all();
			nodeTypeCounts = db.prepare(`SELECT node_type, COUNT(*) as count
           FROM brain_page_nodes
           GROUP BY node_type
           ORDER BY count DESC`).all();
			tierCounts = db.prepare(`SELECT COALESCE(memory_tier, 'unknown') as tier, COUNT(*) as count
           FROM brain_observations
           GROUP BY memory_tier
           ORDER BY count DESC`).all();
		}
	} catch {}
	return {
		stats,
		recentNodes,
		nodeTypeCounts,
		tierCounts
	};
};
//#endregion
export { load };

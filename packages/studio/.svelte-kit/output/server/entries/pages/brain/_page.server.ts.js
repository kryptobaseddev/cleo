import { t as getBrainDb } from "../../../chunks/connections.js";
//#region src/routes/brain/+page.server.ts
/**
* Brain page server load — fetches basic stats for the placeholder view.
*/
function formatCount(n) {
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
var load = () => {
	let stats = null;
	try {
		const db = getBrainDb();
		if (db) {
			const nodeRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_page_nodes").get();
			const obsRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_observations").get();
			const decRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_decisions").get();
			const patRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_patterns").get();
			const learnRow = db.prepare("SELECT COUNT(*) as cnt FROM brain_learnings").get();
			stats = [
				{
					value: formatCount(nodeRow.cnt),
					label: "Graph Nodes"
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
				}
			];
		}
	} catch {}
	return { stats };
};
//#endregion
export { load };

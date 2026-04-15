import { r as getNexusDb } from "../../../chunks/connections.js";
//#region src/routes/nexus/+page.server.ts
/**
* Nexus page server load — fetches basic stats for the placeholder view.
*/
function formatCount(n) {
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
var load = () => {
	let stats = null;
	try {
		const db = getNexusDb();
		if (db) {
			const nodeRow = db.prepare("SELECT COUNT(*) as cnt FROM nexus_nodes").get();
			const relRow = db.prepare("SELECT COUNT(*) as cnt FROM nexus_relations").get();
			const kindRows = db.prepare("SELECT kind, COUNT(*) as cnt FROM nexus_nodes GROUP BY kind ORDER BY cnt DESC").all();
			stats = [
				{
					value: formatCount(nodeRow.cnt),
					label: "Total Symbols"
				},
				{
					value: formatCount(relRow.cnt),
					label: "Total Relations"
				},
				...kindRows.slice(0, 4).map((r) => ({
					value: formatCount(r.cnt),
					label: r.kind.charAt(0).toUpperCase() + r.kind.slice(1) + "s"
				}))
			];
		}
	} catch {}
	return { stats };
};
//#endregion
export { load };

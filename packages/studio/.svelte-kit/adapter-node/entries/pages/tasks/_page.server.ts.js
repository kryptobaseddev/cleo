import { i as getTasksDb } from "../../../chunks/connections.js";
//#region src/routes/tasks/+page.server.ts
/**
* Tasks page server load — fetches basic stats for the placeholder view.
*/
function formatCount(n) {
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
var load = () => {
	let stats = null;
	try {
		const db = getTasksDb();
		if (db) {
			const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks").get();
			const epicRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE type = 'epic'").get();
			const activeRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'active'").get();
			const doneRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'done'").get();
			const pendingRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get();
			stats = [
				{
					value: formatCount(totalRow.cnt),
					label: "Total Tasks"
				},
				{
					value: formatCount(epicRow.cnt),
					label: "Epics"
				},
				{
					value: formatCount(activeRow.cnt),
					label: "Active"
				},
				{
					value: formatCount(pendingRow.cnt),
					label: "Pending"
				},
				{
					value: formatCount(doneRow.cnt),
					label: "Done"
				}
			];
		}
	} catch {}
	return { stats };
};
//#endregion
export { load };

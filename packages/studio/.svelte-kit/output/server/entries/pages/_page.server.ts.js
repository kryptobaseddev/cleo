import { i as getTasksDb, r as getNexusDb, t as getBrainDb } from "../../chunks/connections.js";
//#region src/routes/+page.server.ts
/**
* Home page server load — fetches summary stats from all three databases.
*/
function formatCount(n) {
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
var load = () => {
	let nexusStats = null;
	let brainStats = null;
	let tasksStats = null;
	try {
		const nexus = getNexusDb();
		if (nexus) {
			const nodeRow = nexus.prepare("SELECT COUNT(*) as cnt FROM nexus_nodes").get();
			const relRow = nexus.prepare("SELECT COUNT(*) as cnt FROM nexus_relations").get();
			nexusStats = [{
				value: formatCount(nodeRow.cnt),
				label: "Symbols"
			}, {
				value: formatCount(relRow.cnt),
				label: "Relations"
			}];
		}
	} catch {}
	try {
		const brain = getBrainDb();
		if (brain) {
			const nodeRow = brain.prepare("SELECT COUNT(*) as cnt FROM brain_page_nodes").get();
			const obsRow = brain.prepare("SELECT COUNT(*) as cnt FROM brain_observations").get();
			brainStats = [{
				value: formatCount(nodeRow.cnt),
				label: "Nodes"
			}, {
				value: formatCount(obsRow.cnt),
				label: "Observations"
			}];
		}
	} catch {}
	try {
		const tasks = getTasksDb();
		if (tasks) {
			const taskRow = tasks.prepare("SELECT COUNT(*) as cnt FROM tasks").get();
			const epicRow = tasks.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE type = 'epic'").get();
			tasksStats = [{
				value: formatCount(taskRow.cnt),
				label: "Tasks"
			}, {
				value: formatCount(epicRow.cnt),
				label: "Epics"
			}];
		}
	} catch {}
	return {
		nexusStats,
		brainStats,
		tasksStats
	};
};
//#endregion
export { load };

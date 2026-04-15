import { g as getNexusDb, a as getBrainDb, b as getTasksDb } from './connections-BR9V-1fV.js';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

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

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 2;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-5qupkggX.js')).default;
const server_id = "src/routes/+page.server.ts";
const imports = ["_app/immutable/nodes/2.BRy6KubA.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/2.4tNR_TUx.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=2-DH4G59PK.js.map

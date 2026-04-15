import { b as getTasksDb } from './connections-iyzH8dC3.js';
import 'node:module';
import 'node:fs';
import 'node:os';
import 'node:path';

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

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 5;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-CFhY8_Qi.js')).default;
const server_id = "src/routes/tasks/+page.server.ts";
const imports = ["_app/immutable/nodes/5.D7dqvIqL.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
const stylesheets = ["_app/immutable/assets/5.CBMHUWtE.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=5-BE9dTBmm.js.map

import { a as getBrainDb } from './connections-iyzH8dC3.js';
import 'node:module';
import 'node:fs';
import 'node:os';
import 'node:path';

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

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 3;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-iQmot-8E.js')).default;
const server_id = "src/routes/brain/+page.server.ts";
const imports = ["_app/immutable/nodes/3.kuzi7ysy.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
const stylesheets = ["_app/immutable/assets/3.C92tpZzl.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=3-C3_UDpN0.js.map

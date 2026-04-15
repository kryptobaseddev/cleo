import { g as getNexusDb } from './connections-iyzH8dC3.js';
import 'node:module';
import 'node:fs';
import 'node:os';
import 'node:path';

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

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 4;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-BzFb-nQI.js')).default;
const server_id = "src/routes/nexus/+page.server.ts";
const imports = ["_app/immutable/nodes/4.CzC-ygOU.js","_app/immutable/chunks/FR9iDC2_.js","_app/immutable/chunks/CFKVnMbq.js"];
const stylesheets = ["_app/immutable/assets/4.BOrZ0clC.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=4-NarTRNns.js.map

import "../../../../chunks/index-server.js";
import { V as escape_html, i as derived, n as attr_class, o as head } from "../../../../chunks/dev.js";
import "d3";
//#endregion
//#region src/routes/brain/graph/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let nodes = [];
		let edges = [];
		let useTimeSlider = false;
		derived(() => Object.entries(nodes.reduce((acc, n) => {
			acc[n.node_type] = (acc[n.node_type] ?? 0) + 1;
			return acc;
		}, {})).sort((a, b) => b[1] - a[1]));
		derived(() => Object.entries(edges.reduce((acc, e) => {
			acc[e.edge_type] = (acc[e.edge_type] ?? 0) + 1;
			return acc;
		}, {})).sort((a, b) => b[1] - a[1]));
		head("16wa9bo", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN Graph — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="graph-page svelte-16wa9bo"><div class="graph-header svelte-16wa9bo"><div class="header-left svelte-16wa9bo"><a href="/brain" class="back-link svelte-16wa9bo">← Brain</a> <h1 class="page-title svelte-16wa9bo">Knowledge Graph</h1> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <div class="header-controls svelte-16wa9bo"><button${attr_class("toggle-btn svelte-16wa9bo", void 0, { "active": useTimeSlider })}>Time Slider ${escape_html("Off")}</button> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div> `);
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="loading svelte-16wa9bo">Loading graph data…</div>`);
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

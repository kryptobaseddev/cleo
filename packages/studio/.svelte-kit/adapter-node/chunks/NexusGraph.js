import { n as onDestroy } from "./index-server.js";
import { l as stringify, r as attr_style } from "./dev.js";
import "./navigation.js";
import "graphology";
import "graphology-layout-forceatlas2";
//#region src/lib/components/NexusGraph.svelte
function NexusGraph($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/** For ego network: 0=center, 1=hop1, 2=hop2 */
		/** Navigate to this URL pattern on node click. :id replaced with node id. */
		/** Whether node IDs are community IDs (macro view). */
		let { nodes, edges, drillDownBase = "", isMacroView = false, height = "100%" } = $$props;
		let sigmaInstance = null;
		onDestroy(() => {
			sigmaInstance?.kill();
			sigmaInstance = null;
		});
		$$renderer.push(`<div class="nexus-graph-wrap svelte-1r5tvur"${attr_style(`height: ${stringify(height)}; position: relative;`)}><div class="nexus-graph-canvas svelte-1r5tvur"></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (nodes.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-1r5tvur">No data to display</div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { NexusGraph as t };

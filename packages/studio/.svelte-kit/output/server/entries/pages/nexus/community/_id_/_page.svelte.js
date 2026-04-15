import { B as attr, V as escape_html, a as ensure_array_like, i as derived, l as stringify, o as head, r as attr_style } from "../../../../../chunks/dev.js";
import { t as NexusGraph } from "../../../../../chunks/NexusGraph.js";
//#region src/routes/nexus/community/[id]/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const KIND_COLORS = {
			function: "#3b82f6",
			method: "#06b6d4",
			class: "#8b5cf6",
			interface: "#10b981",
			type_alias: "#f59e0b",
			enum: "#ef4444",
			property: "#94a3b8",
			file: "#64748b",
			folder: "#475569",
			process: "#f97316"
		};
		function kindColor(kind) {
			return KIND_COLORS[kind] ?? "#64748b";
		}
		const graphNodes = derived(() => data.communityNodes.map((n) => ({
			id: n.id,
			label: n.label,
			kind: n.kind,
			color: kindColor(n.kind),
			callerCount: n.callerCount,
			filePath: n.filePath
		})));
		const graphEdges = derived(() => data.communityEdges.map((e) => ({
			source: e.source,
			target: e.target,
			type: e.type
		})));
		const topNodes = derived(() => data.communityNodes.slice(0, 20));
		function shortPath(filePath) {
			return filePath.split("/").slice(-2).join("/");
		}
		head("71h8fa", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Community ${escape_html(data.communityId)} — NEXUS — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="community-view svelte-71h8fa"><div class="breadcrumb svelte-71h8fa"><a href="/nexus" class="breadcrumb-link svelte-71h8fa">NEXUS</a> <span class="breadcrumb-sep svelte-71h8fa">/</span> <span class="breadcrumb-current svelte-71h8fa">${escape_html(data.communityId.replace("comm_", "Cluster "))}</span></div> <div class="page-header svelte-71h8fa"><div><h1 class="view-title svelte-71h8fa">${escape_html(data.communityId.replace("comm_", "Cluster "))}</h1> <p class="view-subtitle svelte-71h8fa">${escape_html(data.communityNodes.length)} symbols — click a node to explore its ego network</p></div></div> <div class="graph-container svelte-71h8fa">`);
		NexusGraph($$renderer, {
			nodes: graphNodes(),
			edges: graphEdges(),
			drillDownBase: "/nexus/symbol/:id",
			height: "calc(100vh - 250px)"
		});
		$$renderer.push(`<!----></div> <div class="member-table-section"><h2 class="section-title svelte-71h8fa">Top Members by Caller Count</h2> <table class="member-table svelte-71h8fa"><thead><tr><th class="svelte-71h8fa">Symbol</th><th class="svelte-71h8fa">Kind</th><th class="svelte-71h8fa">File</th><th class="col-count svelte-71h8fa">Callers</th></tr></thead><tbody><!--[-->`);
		const each_array = ensure_array_like(topNodes());
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let node = each_array[$$index];
			$$renderer.push(`<tr class="svelte-71h8fa"><td class="svelte-71h8fa"><a${attr("href", `/nexus/symbol/${stringify(encodeURIComponent(node.label))}`)} class="symbol-link svelte-71h8fa">${escape_html(node.label)}</a></td><td class="svelte-71h8fa"><span class="kind-badge svelte-71h8fa"${attr_style(`color: ${stringify(kindColor(node.kind))};`)}>${escape_html(node.kind)}</span></td><td class="file-cell svelte-71h8fa">${escape_html(shortPath(node.filePath))}</td><td class="col-count svelte-71h8fa">${escape_html(node.callerCount)}</td></tr>`);
		}
		$$renderer.push(`<!--]--></tbody></table></div></div>`);
	});
}
//#endregion
export { _page as default };

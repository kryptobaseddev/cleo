import { B as attr, V as escape_html, a as ensure_array_like, i as derived, l as stringify, o as head, r as attr_style } from "../../../../../chunks/dev.js";
import { t as NexusGraph } from "../../../../../chunks/NexusGraph.js";
//#region src/routes/code/community/[id]/+page.svelte
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
		/** Display label for the page title and breadcrumb. */
		const displayLabel = derived(() => data.communityLabel);
		/** Edge count from the loaded community edges. */
		const edgeCount = derived(() => data.communityEdges.length);
		head("1ewb8aw", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>${escape_html(displayLabel())} — Code — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="community-view svelte-1ewb8aw"><div class="breadcrumb svelte-1ewb8aw"><a href="/code" class="breadcrumb-link svelte-1ewb8aw">Code</a> <span class="breadcrumb-sep svelte-1ewb8aw">/</span> <span class="breadcrumb-current svelte-1ewb8aw">${escape_html(displayLabel())}</span></div> <div class="context-strip svelte-1ewb8aw"><div class="context-card svelte-1ewb8aw"><span class="context-card-label svelte-1ewb8aw">Community</span> <span class="context-card-value svelte-1ewb8aw">${escape_html(displayLabel())}</span></div> <div class="context-card svelte-1ewb8aw"><span class="context-card-label svelte-1ewb8aw">Symbols</span> <span class="context-card-value svelte-1ewb8aw">${escape_html(data.summary.memberCount)}</span></div> <div class="context-card svelte-1ewb8aw"><span class="context-card-label svelte-1ewb8aw">Internal edges</span> <span class="context-card-value svelte-1ewb8aw">${escape_html(edgeCount())}</span></div> <div class="context-card svelte-1ewb8aw"><span class="context-card-label svelte-1ewb8aw">Top kind</span> <span class="context-card-value svelte-1ewb8aw"${attr_style(`color: ${stringify(kindColor(data.summary.topKind))};`)}>${escape_html(data.summary.topKind)}</span></div> <a${attr("href", `/brain?scope=nexus&community=${stringify(encodeURIComponent(data.communityId))}`)} class="canvas-pill svelte-1ewb8aw">Open in Canvas →</a> <a href="/code" class="context-back-link svelte-1ewb8aw"><span class="back-arrow svelte-1ewb8aw">←</span> All communities</a></div> <div class="page-header svelte-1ewb8aw"><div><h1 class="view-title svelte-1ewb8aw">${escape_html(displayLabel())}</h1> <p class="view-subtitle svelte-1ewb8aw">${escape_html(data.communityNodes.length)} symbols — ${escape_html(edgeCount())} connections — click a node
        to explore its ego network</p></div></div> <div class="graph-container svelte-1ewb8aw">`);
		NexusGraph($$renderer, {
			nodes: graphNodes(),
			edges: graphEdges(),
			drillDownBase: "/code/symbol/:id",
			height: "calc(100vh - 320px)"
		});
		$$renderer.push(`<!----></div> <div class="member-table-section"><h2 class="section-title svelte-1ewb8aw">Top Members by Caller Count</h2> <table class="member-table svelte-1ewb8aw"><thead><tr><th class="svelte-1ewb8aw">Symbol</th><th class="svelte-1ewb8aw">Kind</th><th class="svelte-1ewb8aw">File</th><th class="col-count svelte-1ewb8aw">Callers</th></tr></thead><tbody><!--[-->`);
		const each_array = ensure_array_like(topNodes());
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let node = each_array[$$index];
			$$renderer.push(`<tr class="svelte-1ewb8aw"><td class="svelte-1ewb8aw"><a${attr("href", `/code/symbol/${stringify(encodeURIComponent(node.label))}`)} class="symbol-link svelte-1ewb8aw">${escape_html(node.label)}</a></td><td class="svelte-1ewb8aw"><span class="kind-badge svelte-1ewb8aw"${attr_style(`color: ${stringify(kindColor(node.kind))};`)}>${escape_html(node.kind)}</span></td><td class="file-cell svelte-1ewb8aw">${escape_html(shortPath(node.filePath))}</td><td class="col-count svelte-1ewb8aw">${escape_html(node.callerCount)}</td></tr>`);
		}
		$$renderer.push(`<!--]--></tbody></table></div></div>`);
	});
}
//#endregion
export { _page as default };

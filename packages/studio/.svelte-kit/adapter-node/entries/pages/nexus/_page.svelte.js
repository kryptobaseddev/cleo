import { B as attr, V as escape_html, a as ensure_array_like, i as derived, l as stringify, o as head, r as attr_style } from "../../../chunks/dev.js";
import { t as NexusGraph } from "../../../chunks/NexusGraph.js";
//#region src/routes/nexus/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		function formatCount(n) {
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}
		const graphNodes = derived(() => data.macroNodes.map((n) => ({
			id: n.id,
			label: n.label,
			kind: n.topKind,
			size: n.size,
			color: n.color,
			callerCount: n.memberCount
		})));
		const graphEdges = derived(() => data.macroEdges.map((e) => ({
			source: e.source,
			target: e.target,
			type: "cross-community"
		})));
		head("ho3hy8", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>NEXUS — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="nexus-macro svelte-ho3hy8"><div class="page-header svelte-ho3hy8"><div class="header-left svelte-ho3hy8"><div class="view-icon nexus-icon svelte-ho3hy8">N</div> <div><h1 class="view-title svelte-ho3hy8">NEXUS — Code Intelligence</h1> <p class="view-subtitle svelte-ho3hy8">${escape_html(formatCount(data.totalNodes))} symbols across ${escape_html(data.macroNodes.length)} communities</p></div></div> <div class="header-stats svelte-ho3hy8"><div class="stat svelte-ho3hy8"><span class="stat-value svelte-ho3hy8">${escape_html(formatCount(data.totalNodes))}</span> <span class="stat-label svelte-ho3hy8">Symbols</span></div> <div class="stat svelte-ho3hy8"><span class="stat-value svelte-ho3hy8">${escape_html(formatCount(data.totalRelations))}</span> <span class="stat-label svelte-ho3hy8">Relations</span></div> <div class="stat svelte-ho3hy8"><span class="stat-value svelte-ho3hy8">${escape_html(data.macroNodes.length)}</span> <span class="stat-label svelte-ho3hy8">Communities</span></div></div></div> <div class="graph-hint svelte-ho3hy8">Click any community node to drill into its members.</div> <div class="graph-container svelte-ho3hy8">`);
		if (data.macroNodes.length > 0) {
			$$renderer.push("<!--[0-->");
			NexusGraph($$renderer, {
				nodes: graphNodes(),
				edges: graphEdges(),
				drillDownBase: "/nexus/community/:id",
				isMacroView: true,
				height: "calc(100vh - 200px)"
			});
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="no-data svelte-ho3hy8"><p>nexus.db unavailable or empty.</p> <p class="no-data-hint svelte-ho3hy8">Run <code class="svelte-ho3hy8">cleo nexus analyze</code> to index the codebase.</p></div>`);
		}
		$$renderer.push(`<!--]--></div> `);
		if (data.macroNodes.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="community-list"><h2 class="section-title svelte-ho3hy8">Communities</h2> <div class="community-grid svelte-ho3hy8"><!--[-->`);
			const each_array = ensure_array_like(data.macroNodes.slice(0, 24));
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let community = each_array[$$index];
				$$renderer.push(`<a${attr("href", `/nexus/community/${stringify(encodeURIComponent(community.id))}`)} class="community-card svelte-ho3hy8"${attr_style(`border-left-color: ${stringify(community.color)};`)}><span class="community-name svelte-ho3hy8">${escape_html(community.label)}</span> <span class="community-meta svelte-ho3hy8">${escape_html(community.memberCount)} symbols</span> <span class="community-kind svelte-ho3hy8">${escape_html(community.topKind)}</span></a>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

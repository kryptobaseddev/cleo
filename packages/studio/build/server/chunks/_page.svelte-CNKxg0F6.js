import { a7 as head, a2 as attr, a9 as stringify, a5 as escape_html, a1 as ensure_array_like, P as derived } from './dev-BIJYOMms.js';
import { N as NexusGraph } from './NexusGraph-0f7WLfkE.js';
import './index-server-D_hhbQIS.js';
import 'node:module';
import './client-N_q1nHbX.js';
import './internal-B2puBP7A.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';
import 'graphology';
import 'graphology-layout-forceatlas2';

//#region src/routes/nexus/symbol/[name]/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const HOP_COLORS = {
			0: "#f59e0b",
			1: "#3b82f6",
			2: "#475569"
		};
		const graphNodes = derived(() => data.egoNodes.map((n) => ({
			id: n.id,
			label: n.label,
			kind: n.kind,
			color: HOP_COLORS[n.hop] ?? "#475569",
			callerCount: n.callerCount,
			filePath: n.filePath,
			hop: n.hop
		})));
		const graphEdges = derived(() => data.egoEdges.map((e) => ({
			source: e.source,
			target: e.target,
			type: e.type
		})));
		const centerNode = derived(() => data.egoNodes.find((n) => n.hop === 0));
		head("p37w8n", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>${escape_html(data.symbolName)} — NEXUS — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="symbol-view svelte-p37w8n"><div class="breadcrumb svelte-p37w8n"><a href="/nexus" class="breadcrumb-link svelte-p37w8n">NEXUS</a> <span class="breadcrumb-sep svelte-p37w8n">/</span> `);
		if (centerNode()?.communityId) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/nexus/community/${stringify(encodeURIComponent(centerNode().communityId))}`)} class="breadcrumb-link svelte-p37w8n">${escape_html(centerNode().communityId.replace("comm_", "Cluster "))}</a> <span class="breadcrumb-sep svelte-p37w8n">/</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <span class="breadcrumb-current svelte-p37w8n">${escape_html(data.symbolName)}</span></div> <div class="page-header svelte-p37w8n"><div><h1 class="view-title symbol-title svelte-p37w8n">${escape_html(data.symbolName)}</h1> <p class="view-subtitle svelte-p37w8n">${escape_html(data.egoNodes.length)} nodes in ego network —
        ${escape_html(centerNode()?.kind ?? "")} —
        ${escape_html(centerNode()?.filePath ?? "")}</p></div></div> <div class="legend svelte-p37w8n"><span class="legend-item svelte-p37w8n"><span class="legend-dot svelte-p37w8n" style="background: #f59e0b;"></span> Center</span> <span class="legend-item svelte-p37w8n"><span class="legend-dot svelte-p37w8n" style="background: #3b82f6;"></span> Hop 1 (direct)</span> <span class="legend-item svelte-p37w8n"><span class="legend-dot svelte-p37w8n" style="background: #475569;"></span> Hop 2</span></div> <div class="graph-container svelte-p37w8n">`);
		NexusGraph($$renderer, {
			nodes: graphNodes(),
			edges: graphEdges(),
			drillDownBase: "/nexus/symbol/:id",
			height: "calc(100vh - 280px)"
		});
		$$renderer.push(`<!----></div> <div class="context-section"><h2 class="section-title svelte-p37w8n">Direct Connections (${escape_html(data.egoNodes.filter((n) => n.hop === 1).length)})</h2> <div class="node-chips svelte-p37w8n"><!--[-->`);
		const each_array = ensure_array_like(data.egoNodes.filter((n) => n.hop === 1));
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let node = each_array[$$index];
			$$renderer.push(`<a${attr("href", `/nexus/symbol/${stringify(encodeURIComponent(node.label))}`)} class="node-chip svelte-p37w8n"><span class="chip-label svelte-p37w8n">${escape_html(node.label)}</span> <span class="chip-kind svelte-p37w8n">${escape_html(node.kind)}</span></a>`);
		}
		$$renderer.push(`<!--]--></div></div></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-CNKxg0F6.js.map

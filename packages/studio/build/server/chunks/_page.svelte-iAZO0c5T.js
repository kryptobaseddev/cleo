import { a9 as head, a2 as attr, a8 as stringify, a5 as escape_html, a1 as ensure_array_like, P as derived } from './dev-YtqJX9rn.js';
import { N as NexusGraph } from './NexusGraph-87Lt5YQ8.js';
import './index-server-7GMbbq1i.js';
import 'node:module';
import './client-CKMNLyyF.js';
import './internal-DGi2TeBn.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';
import 'graphology';
import 'graphology-layout-forceatlas2';

//#region src/routes/code/symbol/[name]/+page.svelte
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
		/** Callers: hop-1 nodes where the edge comes *into* the center. */
		const callerNodes = derived(() => data.egoNodes.filter((n) => {
			if (n.hop !== 1) return false;
			return data.egoEdges.some((e) => e.target === centerNode()?.id && e.source === n.id);
		}));
		/** Callees: hop-1 nodes where the edge goes *out from* the center. */
		const calleeNodes = derived(() => data.egoNodes.filter((n) => {
			if (n.hop !== 1) return false;
			return data.egoEdges.some((e) => e.source === centerNode()?.id && e.target === n.id);
		}));
		/** Nodes that are connected to center but direction is ambiguous (both or neither). */
		const otherHop1 = derived(() => data.egoNodes.filter((n) => {
			if (n.hop !== 1) return false;
			const isCaller = data.egoEdges.some((e) => e.target === centerNode()?.id && e.source === n.id);
			const isCallee = data.egoEdges.some((e) => e.source === centerNode()?.id && e.target === n.id);
			return !isCaller && !isCallee;
		}));
		/** Human-readable community label for the breadcrumb. */
		const communityBreadcrumb = derived(() => () => {
			const commId = centerNode()?.communityId;
			if (!commId) return "";
			return `Cluster ${commId.replace("comm_", "")}`;
		});
		head("16icikf", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>${escape_html(data.symbolName)} — Code — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="symbol-view svelte-16icikf"><div class="breadcrumb svelte-16icikf"><a href="/code" class="breadcrumb-link svelte-16icikf">Code</a> <span class="breadcrumb-sep svelte-16icikf">/</span> `);
		if (centerNode()?.communityId) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/code/community/${stringify(encodeURIComponent(centerNode().communityId))}`)} class="breadcrumb-link svelte-16icikf">${escape_html(communityBreadcrumb())}</a> <span class="breadcrumb-sep svelte-16icikf">/</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <span class="breadcrumb-current svelte-16icikf">${escape_html(data.symbolName)}</span></div> <div class="context-strip svelte-16icikf"><div class="context-card svelte-16icikf"><span class="context-card-label svelte-16icikf">Callers</span> <span class="context-card-value callers-value svelte-16icikf">${escape_html(callerNodes().length)}</span></div> <div class="context-card svelte-16icikf"><span class="context-card-label svelte-16icikf">Callees</span> <span class="context-card-value callees-value svelte-16icikf">${escape_html(calleeNodes().length)}</span></div> <div class="context-card svelte-16icikf"><span class="context-card-label svelte-16icikf">Hop-2 nodes</span> <span class="context-card-value svelte-16icikf">${escape_html(data.egoNodes.filter((n) => n.hop === 2).length)}</span></div> <div class="context-card svelte-16icikf"><span class="context-card-label svelte-16icikf">Edges visible</span> <span class="context-card-value svelte-16icikf">${escape_html(data.egoEdges.length)}</span></div> <a href="/brain?scope=nexus" class="canvas-pill svelte-16icikf">Open in Canvas →</a> `);
		if (centerNode()?.communityId) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/code/community/${stringify(encodeURIComponent(centerNode().communityId))}`)} class="context-back-link svelte-16icikf"><span class="back-arrow svelte-16icikf">←</span> Back to ${escape_html(communityBreadcrumb())}</a>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<a href="/code" class="context-back-link svelte-16icikf"><span class="back-arrow svelte-16icikf">←</span> Back to Code</a>`);
		}
		$$renderer.push(`<!--]--></div> <div class="page-header svelte-16icikf"><div><h1 class="view-title symbol-title svelte-16icikf">${escape_html(data.symbolName)}</h1> <p class="view-subtitle svelte-16icikf">${escape_html(data.egoNodes.length)} nodes in ego network —
        ${escape_html(centerNode()?.kind ?? "")} —
        ${escape_html(centerNode()?.filePath ?? "")}</p></div></div> <div class="legend svelte-16icikf"><span class="legend-item svelte-16icikf"><span class="legend-dot svelte-16icikf" style="background: #f59e0b;"></span> Center</span> <span class="legend-item svelte-16icikf"><span class="legend-dot svelte-16icikf" style="background: #3b82f6;"></span> Hop 1 (direct)</span> <span class="legend-item svelte-16icikf"><span class="legend-dot svelte-16icikf" style="background: #475569;"></span> Hop 2</span> <span class="legend-item legend-edge-hint svelte-16icikf"><span class="legend-edge-sample svelte-16icikf"></span> Arrow = calls direction</span></div> <div class="graph-container svelte-16icikf">`);
		NexusGraph($$renderer, {
			nodes: graphNodes(),
			edges: graphEdges(),
			drillDownBase: "/code/symbol/:id",
			height: "calc(100vh - 360px)"
		});
		$$renderer.push(`<!----></div> `);
		if (callerNodes().length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="context-section svelte-16icikf"><h2 class="section-title svelte-16icikf">Callers (${escape_html(callerNodes().length)})</h2> <div class="node-chips svelte-16icikf"><!--[-->`);
			const each_array = ensure_array_like(callerNodes());
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let node = each_array[$$index];
				$$renderer.push(`<a${attr("href", `/code/symbol/${stringify(encodeURIComponent(node.label))}`)} class="node-chip chip-caller svelte-16icikf"><span class="chip-label svelte-16icikf">${escape_html(node.label)}</span> <span class="chip-kind svelte-16icikf">${escape_html(node.kind)}</span></a>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (calleeNodes().length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="context-section svelte-16icikf"><h2 class="section-title svelte-16icikf">Callees (${escape_html(calleeNodes().length)})</h2> <div class="node-chips svelte-16icikf"><!--[-->`);
			const each_array_1 = ensure_array_like(calleeNodes());
			for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
				let node = each_array_1[$$index_1];
				$$renderer.push(`<a${attr("href", `/code/symbol/${stringify(encodeURIComponent(node.label))}`)} class="node-chip chip-callee svelte-16icikf"><span class="chip-label svelte-16icikf">${escape_html(node.label)}</span> <span class="chip-kind svelte-16icikf">${escape_html(node.kind)}</span></a>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (otherHop1().length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="context-section svelte-16icikf"><h2 class="section-title svelte-16icikf">Direct Connections (${escape_html(otherHop1().length)})</h2> <div class="node-chips svelte-16icikf"><!--[-->`);
			const each_array_2 = ensure_array_like(otherHop1());
			for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
				let node = each_array_2[$$index_2];
				$$renderer.push(`<a${attr("href", `/code/symbol/${stringify(encodeURIComponent(node.label))}`)} class="node-chip svelte-16icikf"><span class="chip-label svelte-16icikf">${escape_html(node.label)}</span> <span class="chip-kind svelte-16icikf">${escape_html(node.kind)}</span></a>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-iAZO0c5T.js.map

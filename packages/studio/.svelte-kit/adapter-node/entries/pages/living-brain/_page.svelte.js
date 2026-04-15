import { n as onDestroy } from "../../../chunks/index-server.js";
import { B as attr, V as escape_html, a as ensure_array_like, i as derived, l as stringify, n as attr_class, o as head, r as attr_style } from "../../../chunks/dev.js";
import "graphology";
import "graphology-layout-forceatlas2";
//#region src/lib/components/LivingBrainGraph.svelte
function LivingBrainGraph($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/** Fired when the user clicks a node. Passes the node ID. */
		let { nodes, edges, onNodeClick, height = "100%" } = $$props;
		let sigmaInstance = null;
		onDestroy(() => {
			sigmaInstance?.kill();
			sigmaInstance = null;
		});
		$$renderer.push(`<div class="lb-graph-wrap svelte-9h1whb"${attr_style(`height: ${stringify(height)}; position: relative;`)}><div class="lb-graph-canvas svelte-9h1whb"></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (nodes.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="lb-empty svelte-9h1whb">No data to display</div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
//#region src/routes/living-brain/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		let graph = data.graph;
		let loading = false;
		/** Active substrate filter set (all enabled by default). */
		let enabledSubstrates = new Set([
			"brain",
			"nexus",
			"tasks",
			"conduit",
			"signaldock"
		]);
		/** Minimum weight threshold [0,1]. */
		let minWeight = 0;
		/** Side panel node detail. */
		let selectedNode = null;
		let sideLoading = false;
		let sideError = null;
		const ALL_SUBSTRATES = [
			"brain",
			"nexus",
			"tasks",
			"conduit",
			"signaldock"
		];
		const SUBSTRATE_COLOR = {
			brain: "#3b82f6",
			nexus: "#22c55e",
			tasks: "#f97316",
			conduit: "#a855f7",
			signaldock: "#ef4444"
		};
		const EDGE_TYPES = [
			{
				type: "supersedes",
				color: "#ef4444"
			},
			{
				type: "affects",
				color: "#3b82f6"
			},
			{
				type: "applies_to",
				color: "#22c55e"
			},
			{
				type: "calls",
				color: "#94a3b8"
			},
			{
				type: "co_retrieved",
				color: "#a855f7"
			},
			{
				type: "mentions",
				color: "#eab308"
			}
		];
		let filteredGraph = derived(() => ({
			nodes: graph.nodes.filter((n) => enabledSubstrates.has(n.substrate) && (n.weight ?? 1) >= minWeight),
			edges: graph.edges.filter((e) => {
				return e.substrate === "cross" || enabledSubstrates.has(e.substrate);
			}),
			counts: graph.counts,
			truncated: graph.truncated
		}));
		async function handleNodeClick(id) {
			sideLoading = true;
			sideError = null;
			selectedNode = null;
			try {
				const res = await fetch(`/api/living-brain/node/${encodeURIComponent(id)}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				selectedNode = (await res.json()).node;
			} catch (e) {
				sideError = e instanceof Error ? e.message : "Failed to load node";
			} finally {
				sideLoading = false;
			}
		}
		let totalNodes = derived(() => filteredGraph().nodes.length);
		let totalEdges = derived(() => filteredGraph().edges.length);
		let isFullGraph = derived(() => graph.nodes.length > 500);
		head("prt765", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Living Brain — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="lb-page svelte-prt765"><div class="lb-header svelte-prt765"><div class="header-left svelte-prt765"><h1 class="page-title svelte-prt765">Living Brain</h1> <span class="node-count svelte-prt765">${escape_html(totalNodes())} nodes · ${escape_html(totalEdges())} edges `);
		if (graph.truncated) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="truncated-badge svelte-prt765">truncated</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></span></div> <div class="header-controls svelte-prt765"><div class="substrate-filters svelte-prt765"><!--[-->`);
		const each_array = ensure_array_like(ALL_SUBSTRATES);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let s = each_array[$$index];
			$$renderer.push(`<button${attr_class("substrate-btn svelte-prt765", void 0, { "active": enabledSubstrates.has(s) })}${attr_style(`--s-color: ${stringify(SUBSTRATE_COLOR[s])}`)}${attr("title", `Toggle ${stringify(s)} substrate`)}>${escape_html(s)}</button>`);
		}
		$$renderer.push(`<!--]--></div> <div class="weight-wrap svelte-prt765"><label class="weight-label svelte-prt765" for="weight-slider">min weight: <span class="weight-val svelte-prt765">${escape_html(minWeight.toFixed(2))}</span></label> <input id="weight-slider" type="range" min="0" max="1" step="0.05"${attr("value", minWeight)} class="weight-slider svelte-prt765"/></div> `);
		if (!isFullGraph()) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<button class="full-graph-btn svelte-prt765"${attr("disabled", loading, true)}>${escape_html("Full graph")}</button>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<span class="full-graph-label svelte-prt765">Full graph loaded</span>`);
		}
		$$renderer.push(`<!--]--></div></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->  <div${attr_class("lb-body svelte-prt765", void 0, { "has-panel": selectedNode !== null || sideLoading || sideError !== null })}><div class="lb-canvas svelte-prt765">`);
		LivingBrainGraph($$renderer, {
			nodes: filteredGraph().nodes,
			edges: filteredGraph().edges,
			onNodeClick: handleNodeClick,
			height: "100%"
		});
		$$renderer.push(`<!----></div> `);
		if (selectedNode !== null || sideLoading || sideError !== null) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="lb-panel svelte-prt765"><div class="panel-header svelte-prt765"><span class="panel-title svelte-prt765">Node Detail</span> <button class="panel-close svelte-prt765" aria-label="Close panel">×</button></div> `);
			if (sideLoading) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel-loading svelte-prt765">Loading…</div>`);
			} else if (sideError) {
				$$renderer.push("<!--[1-->");
				$$renderer.push(`<div class="panel-error svelte-prt765">${escape_html(sideError)}</div>`);
			} else if (selectedNode) {
				$$renderer.push("<!--[2-->");
				$$renderer.push(`<div class="panel-body svelte-prt765"><div class="panel-kind-badge svelte-prt765"${attr_style(`background: ${stringify(SUBSTRATE_COLOR[selectedNode.substrate])}22; color: ${stringify(SUBSTRATE_COLOR[selectedNode.substrate])}; border-color: ${stringify(SUBSTRATE_COLOR[selectedNode.substrate])}44`)}>${escape_html(selectedNode.substrate)} / ${escape_html(selectedNode.kind)}</div> <p class="panel-label svelte-prt765">${escape_html(selectedNode.label)}</p> <div class="panel-id svelte-prt765"><span class="field-key svelte-prt765">id</span> <span class="field-val mono svelte-prt765">${escape_html(selectedNode.id)}</span></div> `);
				if (selectedNode.weight !== void 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="panel-field svelte-prt765"><span class="field-key svelte-prt765">weight</span> <span class="field-val svelte-prt765">${escape_html(selectedNode.weight.toFixed(3))}</span></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (Object.keys(selectedNode.meta).length > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<details class="panel-meta svelte-prt765"><summary class="meta-summary svelte-prt765">Metadata</summary> <pre class="meta-pre svelte-prt765">${escape_html(JSON.stringify(selectedNode.meta, null, 2))}</pre></details>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>  <div class="lb-legend svelte-prt765"><div class="legend-section svelte-prt765"><span class="legend-label svelte-prt765">Substrates</span> <!--[-->`);
		const each_array_1 = ensure_array_like(ALL_SUBSTRATES);
		for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
			let s = each_array_1[$$index_1];
			if (enabledSubstrates.has(s)) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="legend-item svelte-prt765"><span class="legend-dot svelte-prt765"${attr_style(`background: ${stringify(SUBSTRATE_COLOR[s])}`)}></span> <span>${escape_html(s)} <span class="legend-count svelte-prt765">${escape_html(graph.counts.nodes[s] ?? 0)}</span></span></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]-->`);
		}
		$$renderer.push(`<!--]--></div> <div class="legend-section svelte-prt765"><span class="legend-label svelte-prt765">Edges</span> <!--[-->`);
		const each_array_2 = ensure_array_like(EDGE_TYPES);
		for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
			let et = each_array_2[$$index_2];
			$$renderer.push(`<div class="legend-item svelte-prt765"><span class="legend-line svelte-prt765"${attr_style(`background: ${stringify(et.color)}`)}></span> <span>${escape_html(et.type)}</span></div>`);
		}
		$$renderer.push(`<!--]--></div> <div class="legend-section legend-todo svelte-prt765"><span class="legend-label svelte-prt765">Time slider</span> <span class="todo-note svelte-prt765">TODO — requires LBNode.createdAt</span></div></div></div>`);
	});
}
//#endregion
export { _page as default };

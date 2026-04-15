import { o as onDestroy } from './index-server-7GMbbq1i.js';
import { a9 as head, a5 as escape_html, a3 as attr_class, a2 as attr, a8 as stringify, a1 as ensure_array_like, a7 as attr_style, P as derived } from './dev-YtqJX9rn.js';
import 'graphology';
import 'graphology-layout-forceatlas2';
import '@cosmograph/cosmos';
import 'node:module';

//#region src/lib/components/LivingBrainGraph.svelte
function LivingBrainGraph($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/** Fired when the user clicks a node. Passes the node ID. */
		/** Set of node IDs that are currently pulsing (new/updated). */
		/** Set of edge keys (`${source}|${target}`) that are currently pulsing. */
		let { nodes, height = "100%"} = $$props;
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
//#region src/lib/components/LivingBrainCosmograph.svelte
function LivingBrainCosmograph($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/**
		* Props interface matching LivingBrainGraph.svelte so the two renderers
		* are interchangeable in the page template.
		*/
		/** Fired when the user clicks a node. Passes the node ID. */
		/**
		* Set of node IDs currently pulsing (new/updated).
		*
		* In cosmos.gl 2.0 there is no per-node animation API; when this set is
		* non-empty the component does a `fitView` on the first pulsing node as a
		* best-effort visual cue and schedules a full color-buffer re-upload after
		* the pulse duration.  This is a known trade-off relative to sigma's
		* per-node pulse; documented here for future improvement.
		*/
		/**
		* Set of edge keys (`${source}|${target}`) currently pulsing.
		*
		* cosmos.gl 2.0 does not support per-link animation; this prop is accepted
		* for API parity but has no visible effect.  A full link-color buffer
		* re-upload would be required for visual feedback.
		*/
		/**
		* Called when the cosmos.gl renderer fails to initialise (e.g. WebGL
		* unavailable).  The parent page should use this to revert to the Standard
		* renderer so the user never sees a blank canvas.
		*
		* @param reason - Human-readable failure description.
		*/
		let { nodes, height = "100%"} = $$props;
		let cosmos = null;
		onDestroy(() => {
			cosmos?.destroy();
			cosmos = null;
		});
		$$renderer.push(`<div class="lbc-wrap svelte-1fx55sa"${attr_style(`height: ${stringify(height)}; position: relative;`)}>`);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<div class="lbc-canvas svelte-1fx55sa"></div> `);
		if (nodes.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="lbc-empty svelte-1fx55sa">No data to display</div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="lbc-badge svelte-1fx55sa" aria-label="GPU-accelerated renderer active">GPU</div>`);
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
//#region src/routes/brain/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		let graph = data.graph;
		let loading = false;
		/** Current state of the SSE connection. */
		let connectionStatus = "connecting";
		/** Current EventSource instance (null when disconnected). */
		let eventSource = null;
		onDestroy(() => {
			eventSource?.close();
			eventSource = null;
			connectionStatus = "disconnected";
		});
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
		/** Whether the time slider is toggled on. */
		let useTimeSlider = false;
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
		/** The date selected by the slider, or null when slider is off. */
		let filterDate = derived(() => null);
		let filteredGraph = derived(() => ({
			nodes: graph.nodes.filter((n) => {
				if (!enabledSubstrates.has(n.substrate)) return false;
				if ((n.weight ?? 1) < minWeight) return false;
				if (filterDate() !== null) {
					if (n.createdAt !== null && n.createdAt.slice(0, 10) > filterDate()) return false;
				}
				return true;
			}),
			edges: graph.edges.filter((e) => {
				return e.substrate === "cross" || enabledSubstrates.has(e.substrate);
			}),
			counts: graph.counts,
			truncated: graph.truncated
		}));
		/**
		* True when GPU mode is active — either user-forced or auto-activated at
		* the 2 000-node threshold where sigma's CPU layout becomes a bottleneck.
		*/
		let shouldUseGpu = derived(() => filteredGraph().nodes.length > 2e3);
		let totalNodes = derived(() => filteredGraph().nodes.length);
		let totalEdges = derived(() => filteredGraph().edges.length);
		let isFullGraph = derived(() => graph.nodes.length > 500);
		head("9heiib", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Brain — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="lb-page svelte-9heiib"><div class="lb-header svelte-9heiib"><div class="header-left svelte-9heiib"><h1 class="page-title svelte-9heiib">Brain Canvas</h1> <span class="node-count svelte-9heiib">${escape_html(totalNodes())} nodes · ${escape_html(totalEdges())} edges `);
		if (graph.truncated) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="truncated-badge svelte-9heiib">truncated</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></span> <span${attr_class(`sse-status sse-status--${stringify(connectionStatus)}`, "svelte-9heiib")}${attr("title", `Live stream: ${stringify(connectionStatus)}`)}>`);
		if (connectionStatus === "connected") {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`live`);
		} else if (connectionStatus === "connecting") {
			$$renderer.push("<!--[1-->");
			$$renderer.push(`connecting…`);
		} else if (connectionStatus === "error") {
			$$renderer.push("<!--[2-->");
			$$renderer.push(`reconnecting…`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`offline`);
		}
		$$renderer.push(`<!--]--></span></div> <div class="header-controls svelte-9heiib"><div class="substrate-filters svelte-9heiib"><!--[-->`);
		const each_array = ensure_array_like(ALL_SUBSTRATES);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let s = each_array[$$index];
			$$renderer.push(`<button${attr_class("substrate-btn svelte-9heiib", void 0, { "active": enabledSubstrates.has(s) })}${attr_style(`--s-color: ${stringify(SUBSTRATE_COLOR[s])}`)}${attr("title", `Toggle ${stringify(s)} substrate`)}>${escape_html(s)}</button>`);
		}
		$$renderer.push(`<!--]--></div> <div class="weight-wrap svelte-9heiib"><label class="weight-label svelte-9heiib" for="weight-slider">min weight: <span class="weight-val svelte-9heiib">${escape_html(minWeight.toFixed(2))}</span></label> <input id="weight-slider" type="range" min="0" max="1" step="0.05"${attr("value", minWeight)} class="weight-slider svelte-9heiib"/></div> <button${attr_class("toggle-btn svelte-9heiib", void 0, { "active": useTimeSlider })}>Time ${escape_html("Off")}</button> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (!isFullGraph()) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<button class="full-graph-btn svelte-9heiib"${attr("disabled", loading, true)}>${escape_html("Full graph")}</button>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<span class="full-graph-label svelte-9heiib">Full graph loaded</span>`);
		}
		$$renderer.push(`<!--]--> <button${attr_class("renderer-btn svelte-9heiib", void 0, { "active": shouldUseGpu() })}${attr("title", shouldUseGpu() ? "GPU mode active (cosmos.gl) — click to switch to Standard" : "Standard mode active (sigma) — click to switch to GPU")}>${escape_html(shouldUseGpu() ? "GPU mode" : "Standard")}</button></div></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->  <div${attr_class("lb-body svelte-9heiib", void 0, { "has-panel": sideError !== null })}><div class="lb-canvas svelte-9heiib">`);
		if (shouldUseGpu()) {
			$$renderer.push("<!--[0-->");
			LivingBrainCosmograph($$renderer, {
				nodes: filteredGraph().nodes,
				edges: filteredGraph().edges,
				height: "100%"});
		} else {
			$$renderer.push("<!--[-1-->");
			LivingBrainGraph($$renderer, {
				nodes: filteredGraph().nodes,
				edges: filteredGraph().edges,
				height: "100%"});
		}
		$$renderer.push(`<!--]--></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>  <div class="lb-legend svelte-9heiib"><div class="legend-section svelte-9heiib"><span class="legend-label svelte-9heiib">Substrates</span> <!--[-->`);
		const each_array_1 = ensure_array_like(ALL_SUBSTRATES);
		for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
			let s = each_array_1[$$index_1];
			if (enabledSubstrates.has(s)) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="legend-item svelte-9heiib"><span class="legend-dot svelte-9heiib"${attr_style(`background: ${stringify(SUBSTRATE_COLOR[s])}`)}></span> <span class="svelte-9heiib">${escape_html(s)} <span class="legend-count svelte-9heiib">${escape_html(graph.counts.nodes[s] ?? 0)}</span></span></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]-->`);
		}
		$$renderer.push(`<!--]--></div> <div class="legend-section svelte-9heiib"><span class="legend-label svelte-9heiib">Edges</span> <!--[-->`);
		const each_array_2 = ensure_array_like(EDGE_TYPES);
		for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
			let et = each_array_2[$$index_2];
			$$renderer.push(`<div class="legend-item svelte-9heiib"><span class="legend-line svelte-9heiib"${attr_style(`background: ${stringify(et.color)}`)}></span> <span class="svelte-9heiib">${escape_html(et.type)}</span></div>`);
		}
		$$renderer.push(`<!--]--></div> <div class="legend-section svelte-9heiib"><span class="legend-label svelte-9heiib">Time slider</span> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<span class="legend-item svelte-9heiib" style="color: #475569; font-style: italic; font-size: 0.6875rem;">off — toggle in header</span>`);
		$$renderer.push(`<!--]--></div></div></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-DjM2SDsC.js.map

import { a7 as head, a1 as ensure_array_like, a5 as escape_html, a8 as attr_style, a9 as stringify } from './dev-BIJYOMms.js';

//#region src/routes/brain/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const NODE_COLORS = {
			observation: "#3b82f6",
			decision: "#22c55e",
			pattern: "#a855f7",
			learning: "#f97316",
			task: "#6b7280",
			session: "#64748b",
			epic: "#f59e0b",
			sticky: "#ec4899"
		};
		const TIER_COLORS = {
			short: "#64748b",
			medium: "#3b82f6",
			long: "#22c55e",
			unknown: "#475569"
		};
		function nodeColor(type) {
			return NODE_COLORS[type] ?? "#94a3b8";
		}
		function tierColor(tier) {
			return TIER_COLORS[tier] ?? "#475569";
		}
		head("9heiib", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="brain-overview svelte-9heiib"><div class="view-header svelte-9heiib"><div class="view-icon brain-icon svelte-9heiib">B</div> <div><h1 class="view-title svelte-9heiib">BRAIN View</h1> <p class="view-subtitle svelte-9heiib">Knowledge Graph &amp; Memory Tiers</p></div> <div class="header-nav svelte-9heiib"><a href="/brain/graph" class="nav-pill svelte-9heiib">Graph</a> <a href="/brain/decisions" class="nav-pill svelte-9heiib">Decisions</a> <a href="/brain/observations" class="nav-pill svelte-9heiib">Observations</a> <a href="/brain/quality" class="nav-pill svelte-9heiib">Quality</a></div></div> `);
		if (!data.stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="no-data svelte-9heiib"><p>brain.db not found. Start a CLEO session to populate memory.</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="stats-grid svelte-9heiib"><!--[-->`);
			const each_array = ensure_array_like(data.stats);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let stat = each_array[$$index];
				$$renderer.push(`<div class="stat-card svelte-9heiib"><span class="stat-value svelte-9heiib">${escape_html(stat.value)}</span> <span class="stat-label svelte-9heiib">${escape_html(stat.label)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div> <div class="panels svelte-9heiib">`);
			if (data.nodeTypeCounts.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel svelte-9heiib"><h2 class="panel-title svelte-9heiib">Node Types</h2> <div class="type-list svelte-9heiib"><!--[-->`);
				const each_array_1 = ensure_array_like(data.nodeTypeCounts);
				for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
					let item = each_array_1[$$index_1];
					$$renderer.push(`<div class="type-row svelte-9heiib"><span class="type-dot svelte-9heiib"${attr_style(`background:${stringify(nodeColor(item.node_type))}`)}></span> <span class="type-name svelte-9heiib">${escape_html(item.node_type)}</span> <span class="type-count svelte-9heiib">${escape_html(item.count)}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> `);
			if (data.tierCounts.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel svelte-9heiib"><h2 class="panel-title svelte-9heiib">Memory Tiers</h2> <div class="tier-list svelte-9heiib"><!--[-->`);
				const each_array_2 = ensure_array_like(data.tierCounts);
				for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
					let item = each_array_2[$$index_2];
					$$renderer.push(`<div class="tier-row svelte-9heiib"><span class="tier-dot svelte-9heiib"${attr_style(`background:${stringify(tierColor(item.tier))}`)}></span> <span class="tier-name svelte-9heiib">${escape_html(item.tier)}</span> <span class="tier-count svelte-9heiib">${escape_html(item.count)}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> `);
			if (data.recentNodes.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel panel-wide svelte-9heiib"><h2 class="panel-title svelte-9heiib">Recent Activity</h2> <div class="recent-list svelte-9heiib"><!--[-->`);
				const each_array_3 = ensure_array_like(data.recentNodes);
				for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
					let node = each_array_3[$$index_3];
					$$renderer.push(`<div class="recent-row svelte-9heiib"><span class="recent-dot svelte-9heiib"${attr_style(`background:${stringify(nodeColor(node.node_type))}`)}></span> <span class="recent-label svelte-9heiib">${escape_html(node.label)}</span> <span class="recent-type svelte-9heiib">${escape_html(node.node_type)}</span> <span class="recent-quality svelte-9heiib">${escape_html((node.quality_score ?? 0).toFixed(2))}</span> <span class="recent-date svelte-9heiib">${escape_html(node.created_at.slice(0, 10))}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div> <div class="action-cards svelte-9heiib"><a href="/brain/graph" class="action-card svelte-9heiib"><div class="action-icon svelte-9heiib" style="background:rgba(59,130,246,0.15);color:#3b82f6">G</div> <div><div class="action-title svelte-9heiib">Knowledge Graph</div> <div class="action-desc svelte-9heiib">Force-directed neural network with ${escape_html(data.stats[0].value)} nodes</div></div></a> <a href="/brain/decisions" class="action-card svelte-9heiib"><div class="action-icon svelte-9heiib" style="background:rgba(34,197,94,0.15);color:#22c55e">D</div> <div><div class="action-title svelte-9heiib">Decisions Timeline</div> <div class="action-desc svelte-9heiib">Chronological decision history with rationale</div></div></a> <a href="/brain/observations" class="action-card svelte-9heiib"><div class="action-icon svelte-9heiib" style="background:rgba(168,85,247,0.15);color:#a855f7">O</div> <div><div class="action-title svelte-9heiib">Observations</div> <div class="action-desc svelte-9heiib">Filter by tier, type, and quality score</div></div></a> <a href="/brain/quality" class="action-card svelte-9heiib"><div class="action-icon svelte-9heiib" style="background:rgba(249,115,22,0.15);color:#f97316">Q</div> <div><div class="action-title svelte-9heiib">Quality Distribution</div> <div class="action-desc svelte-9heiib">Score histograms and tier breakdowns</div></div></a></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-lg5jTzXM.js.map

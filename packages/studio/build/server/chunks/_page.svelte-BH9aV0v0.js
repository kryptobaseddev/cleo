import { a9 as head, a1 as ensure_array_like, a5 as escape_html, a7 as attr_style, a8 as stringify } from './dev-YtqJX9rn.js';

//#region src/routes/brain/overview/+page.svelte
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
		head("1x5k1qb", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="brain-overview svelte-1x5k1qb"><div class="view-header svelte-1x5k1qb"><div class="view-icon brain-icon svelte-1x5k1qb">B</div> <div><h1 class="view-title svelte-1x5k1qb">BRAIN View</h1> <p class="view-subtitle svelte-1x5k1qb">Knowledge Graph &amp; Memory Tiers</p></div> <div class="header-nav svelte-1x5k1qb"><a href="/brain" class="nav-pill nav-pill--canvas svelte-1x5k1qb">Open in Canvas →</a> <a href="/brain/graph" class="nav-pill svelte-1x5k1qb">Graph</a> <a href="/brain/decisions" class="nav-pill svelte-1x5k1qb">Decisions</a> <a href="/brain/observations" class="nav-pill svelte-1x5k1qb">Observations</a> <a href="/brain/quality" class="nav-pill svelte-1x5k1qb">Quality</a></div></div> `);
		if (!data.stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="no-data svelte-1x5k1qb"><p>brain.db not found. Start a CLEO session to populate memory.</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="stats-grid svelte-1x5k1qb"><!--[-->`);
			const each_array = ensure_array_like(data.stats);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let stat = each_array[$$index];
				$$renderer.push(`<div class="stat-card svelte-1x5k1qb"><span class="stat-value svelte-1x5k1qb">${escape_html(stat.value)}</span> <span class="stat-label svelte-1x5k1qb">${escape_html(stat.label)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div> <div class="panels svelte-1x5k1qb">`);
			if (data.nodeTypeCounts.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel svelte-1x5k1qb"><h2 class="panel-title svelte-1x5k1qb">Node Types</h2> <div class="type-list svelte-1x5k1qb"><!--[-->`);
				const each_array_1 = ensure_array_like(data.nodeTypeCounts);
				for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
					let item = each_array_1[$$index_1];
					$$renderer.push(`<div class="type-row svelte-1x5k1qb"><span class="type-dot svelte-1x5k1qb"${attr_style(`background:${stringify(nodeColor(item.node_type))}`)}></span> <span class="type-name svelte-1x5k1qb">${escape_html(item.node_type)}</span> <span class="type-count svelte-1x5k1qb">${escape_html(item.count)}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> `);
			if (data.tierCounts.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel svelte-1x5k1qb"><h2 class="panel-title svelte-1x5k1qb">Memory Tiers</h2> <div class="tier-list svelte-1x5k1qb"><!--[-->`);
				const each_array_2 = ensure_array_like(data.tierCounts);
				for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
					let item = each_array_2[$$index_2];
					$$renderer.push(`<div class="tier-row svelte-1x5k1qb"><span class="tier-dot svelte-1x5k1qb"${attr_style(`background:${stringify(tierColor(item.tier))}`)}></span> <span class="tier-name svelte-1x5k1qb">${escape_html(item.tier)}</span> <span class="tier-count svelte-1x5k1qb">${escape_html(item.count)}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> `);
			if (data.recentNodes.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="panel panel-wide svelte-1x5k1qb"><h2 class="panel-title svelte-1x5k1qb">Recent Activity</h2> <div class="recent-list svelte-1x5k1qb"><!--[-->`);
				const each_array_3 = ensure_array_like(data.recentNodes);
				for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
					let node = each_array_3[$$index_3];
					$$renderer.push(`<div class="recent-row svelte-1x5k1qb"><span class="recent-dot svelte-1x5k1qb"${attr_style(`background:${stringify(nodeColor(node.node_type))}`)}></span> <span class="recent-label svelte-1x5k1qb">${escape_html(node.label)}</span> <span class="recent-type svelte-1x5k1qb">${escape_html(node.node_type)}</span> <span class="recent-quality svelte-1x5k1qb">${escape_html((node.quality_score ?? 0).toFixed(2))}</span> <span class="recent-date svelte-1x5k1qb">${escape_html(node.created_at.slice(0, 10))}</span></div>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div> <div class="action-cards svelte-1x5k1qb"><a href="/brain/graph" class="action-card svelte-1x5k1qb"><div class="action-icon svelte-1x5k1qb" style="background:rgba(59,130,246,0.15);color:#3b82f6">G</div> <div><div class="action-title svelte-1x5k1qb">Knowledge Graph</div> <div class="action-desc svelte-1x5k1qb">Force-directed neural network with ${escape_html(data.stats[0].value)} nodes</div></div></a> <a href="/brain/decisions" class="action-card svelte-1x5k1qb"><div class="action-icon svelte-1x5k1qb" style="background:rgba(34,197,94,0.15);color:#22c55e">D</div> <div><div class="action-title svelte-1x5k1qb">Decisions Timeline</div> <div class="action-desc svelte-1x5k1qb">Chronological decision history with rationale</div></div></a> <a href="/brain/observations" class="action-card svelte-1x5k1qb"><div class="action-icon svelte-1x5k1qb" style="background:rgba(168,85,247,0.15);color:#a855f7">O</div> <div><div class="action-title svelte-1x5k1qb">Observations</div> <div class="action-desc svelte-1x5k1qb">Filter by tier, type, and quality score</div></div></a> <a href="/brain/quality" class="action-card svelte-1x5k1qb"><div class="action-icon svelte-1x5k1qb" style="background:rgba(249,115,22,0.15);color:#f97316">Q</div> <div><div class="action-title svelte-1x5k1qb">Quality Distribution</div> <div class="action-desc svelte-1x5k1qb">Score histograms and tier breakdowns</div></div></a></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-BH9aV0v0.js.map

import { a9 as head, a2 as attr, a1 as ensure_array_like, a5 as escape_html, a3 as attr_class, a7 as attr_style, a8 as stringify, P as derived } from './dev-YtqJX9rn.js';
import 'node:module';

//#region src/routes/brain/observations/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let observations = [];
		let total = 0;
		let filtered = 0;
		let loading = true;
		let error = null;
		let tierFilter = "";
		let typeFilter = "";
		let minQuality = "";
		let searchText = "";
		let expandedId = null;
		const TIER_OPTIONS = [
			"",
			"short",
			"medium",
			"long"
		];
		const TYPE_OPTIONS = [
			"",
			"episodic",
			"semantic",
			"procedural"
		];
		const NODE_COLORS = {
			observation: "#3b82f6",
			decision: "#22c55e",
			pattern: "#a855f7",
			learning: "#f97316"
		};
		const TIER_COLORS = {
			short: "#64748b",
			medium: "#3b82f6",
			long: "#22c55e"
		};
		function tierColor(t) {
			return TIER_COLORS[t ?? "short"] ?? "#64748b";
		}
		async function loadObservations() {
			loading = true;
			error = null;
			try {
				const params = new URLSearchParams();
				const res = await fetch(`/api/brain/observations?${params.toString()}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				observations = data.observations;
				total = data.total;
				filtered = data.filtered;
			} catch (e) {
				error = e instanceof Error ? e.message : "Failed to load observations";
			} finally {
				loading = false;
			}
		}
		let displayedObservations = derived(() => observations);
		function qualityBar(score) {
			return Math.round((score ?? .5) * 100);
		}
		function qualityColor(score) {
			const q = score ?? .5;
			if (q >= .7) return "#22c55e";
			if (q >= .4) return "#f59e0b";
			return "#ef4444";
		}
		head("8nabpv", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN Observations — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="obs-page svelte-8nabpv"><div class="page-header svelte-8nabpv"><a href="/brain/overview" class="back-link svelte-8nabpv">← Overview</a> <h1 class="page-title svelte-8nabpv">Observations</h1> `);
		if (!loading && !error) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="count-badge svelte-8nabpv">${escape_html(filtered)} shown / ${escape_html(total)} total</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <a href="/brain?scope=brain&amp;type=observation" class="canvas-pill svelte-8nabpv">Open in Canvas →</a></div> <div class="filters svelte-8nabpv"><input class="search-input svelte-8nabpv" type="text" placeholder="Search title or narrative…"${attr("value", searchText)}/> `);
		$$renderer.select({
			class: "filter-select",
			value: tierFilter,
			onchange: loadObservations
		}, ($$renderer) => {
			$$renderer.push(`<!--[-->`);
			const each_array = ensure_array_like(TIER_OPTIONS);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let opt = each_array[$$index];
				$$renderer.option({ value: opt }, ($$renderer) => {
					$$renderer.push(`${escape_html(opt || "All tiers")}`);
				});
			}
			$$renderer.push(`<!--]-->`);
		}, "svelte-8nabpv");
		$$renderer.push(` `);
		$$renderer.select({
			class: "filter-select",
			value: typeFilter,
			onchange: loadObservations
		}, ($$renderer) => {
			$$renderer.push(`<!--[-->`);
			const each_array_1 = ensure_array_like(TYPE_OPTIONS);
			for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
				let opt = each_array_1[$$index_1];
				$$renderer.option({ value: opt }, ($$renderer) => {
					$$renderer.push(`${escape_html(opt || "All types")}`);
				});
			}
			$$renderer.push(`<!--]-->`);
		}, "svelte-8nabpv");
		$$renderer.push(` <input class="quality-input svelte-8nabpv" type="number" min="0" max="1" step="0.1" placeholder="Min quality"${attr("value", minQuality)}/> <button class="apply-btn svelte-8nabpv">Apply</button></div> `);
		if (loading) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="loading svelte-8nabpv">Loading observations…</div>`);
		} else if (error) {
			$$renderer.push("<!--[1-->");
			$$renderer.push(`<div class="error svelte-8nabpv">${escape_html(error)}</div>`);
		} else if (displayedObservations().length === 0) {
			$$renderer.push("<!--[2-->");
			$$renderer.push(`<div class="empty svelte-8nabpv">No observations match the current filters.</div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="obs-list svelte-8nabpv"><!--[-->`);
			const each_array_2 = ensure_array_like(displayedObservations());
			for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
				let obs = each_array_2[$$index_2];
				$$renderer.push(`<div${attr_class("obs-card svelte-8nabpv", void 0, {
					"invalidated": !!obs.invalid_at,
					"prune": !!obs.prune_candidate
				})}><button class="obs-header svelte-8nabpv"><div class="obs-meta svelte-8nabpv"><span class="obs-date svelte-8nabpv">${escape_html(obs.created_at.slice(0, 10))}</span> <span class="obs-type svelte-8nabpv"${attr_style(`color:${stringify(NODE_COLORS[obs.type] ?? "#94a3b8")}`)}>${escape_html(obs.type)}</span> `);
				if (obs.memory_tier) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="tier-pill svelte-8nabpv"${attr_style(`border-color:${stringify(tierColor(obs.memory_tier))};color:${stringify(tierColor(obs.memory_tier))}`)}>${escape_html(obs.memory_tier)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (obs.memory_type) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="type-pill svelte-8nabpv">${escape_html(obs.memory_type)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (obs.verified) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="status-badge verified svelte-8nabpv">verified</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (obs.prune_candidate) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="status-badge prune svelte-8nabpv">prune</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (obs.invalid_at) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="status-badge invalid svelte-8nabpv">invalidated</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (obs.citation_count > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="citation-count svelte-8nabpv">${escape_html(obs.citation_count)} citations</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> <div class="obs-title-row svelte-8nabpv"><span class="obs-title svelte-8nabpv">${escape_html(obs.title)}</span> <div class="quality-pill svelte-8nabpv"><div class="quality-fill svelte-8nabpv"${attr_style(`width:${stringify(qualityBar(obs.quality_score))}%;background:${stringify(qualityColor(obs.quality_score))}`)}></div> <span class="quality-label svelte-8nabpv">${escape_html((obs.quality_score ?? .5).toFixed(2))}</span></div></div></button> `);
				if (expandedId === obs.id) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="obs-detail svelte-8nabpv">`);
					if (obs.subtitle) {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<p class="obs-subtitle svelte-8nabpv">${escape_html(obs.subtitle)}</p>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--> `);
					if (obs.narrative) {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<div class="detail-section svelte-8nabpv"><span class="detail-label svelte-8nabpv">Narrative</span> <p class="detail-text svelte-8nabpv">${escape_html(obs.narrative)}</p></div>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--> <div class="detail-footer svelte-8nabpv"><span class="detail-id svelte-8nabpv">${escape_html(obs.id)}</span> `);
					if (obs.project) {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<span class="detail-ctx svelte-8nabpv">Project: ${escape_html(obs.project)}</span>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--> `);
					if (obs.source_confidence) {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<span class="detail-ctx svelte-8nabpv">Source confidence: ${escape_html(obs.source_confidence)}</span>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--></div></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-C15kke4y.js.map

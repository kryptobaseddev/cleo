import { V as escape_html, a as ensure_array_like, o as head } from "../../../chunks/dev.js";
//#region src/routes/brain/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		head("9heiib", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="placeholder-view svelte-9heiib"><div class="view-header svelte-9heiib"><div class="view-icon brain-icon svelte-9heiib">B</div> <div><h1 class="view-title svelte-9heiib">BRAIN View</h1> <p class="view-subtitle svelte-9heiib">Memory Visualization</p></div></div> <div class="coming-soon svelte-9heiib"><p class="coming-soon-text svelte-9heiib">BRAIN View coming soon</p> <p class="coming-soon-detail svelte-9heiib">Force-directed memory graph, decision timeline, quality scores, and tier distribution — delivered
      by T579 workers.</p></div> `);
		if (data.stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="stats-preview svelte-9heiib"><h2 class="stats-title svelte-9heiib">Live Data Ready</h2> <div class="stats-grid svelte-9heiib"><!--[-->`);
			const each_array = ensure_array_like(data.stats);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let stat = each_array[$$index];
				$$renderer.push(`<div class="stat-card svelte-9heiib"><span class="stat-value svelte-9heiib">${escape_html(stat.value)}</span> <span class="stat-label svelte-9heiib">${escape_html(stat.label)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

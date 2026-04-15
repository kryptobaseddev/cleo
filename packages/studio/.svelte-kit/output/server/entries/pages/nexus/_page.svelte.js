import { V as escape_html, a as ensure_array_like, o as head } from "../../../chunks/dev.js";
//#region src/routes/nexus/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		head("ho3hy8", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>NEXUS — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="placeholder-view svelte-ho3hy8"><div class="view-header svelte-ho3hy8"><div class="view-icon nexus-icon svelte-ho3hy8">N</div> <div><h1 class="view-title svelte-ho3hy8">NEXUS View</h1> <p class="view-subtitle svelte-ho3hy8">Code Intelligence Graph</p></div></div> <div class="coming-soon svelte-ho3hy8"><p class="coming-soon-text svelte-ho3hy8">NEXUS View coming soon</p> <p class="coming-soon-detail svelte-ho3hy8">Interactive symbol graph, community clusters, and execution flow visualization — delivered
      by T578 workers.</p></div> `);
		if (data.stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="stats-preview svelte-ho3hy8"><h2 class="stats-title svelte-ho3hy8">Live Data Ready</h2> <div class="stats-grid svelte-ho3hy8"><!--[-->`);
			const each_array = ensure_array_like(data.stats);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let stat = each_array[$$index];
				$$renderer.push(`<div class="stat-card svelte-ho3hy8"><span class="stat-value svelte-ho3hy8">${escape_html(stat.value)}</span> <span class="stat-label svelte-ho3hy8">${escape_html(stat.label)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

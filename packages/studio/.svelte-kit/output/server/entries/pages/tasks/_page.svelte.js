import { V as escape_html, a as ensure_array_like, o as head } from "../../../chunks/dev.js";
//#region src/routes/tasks/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		head("1pluywh", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Tasks — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="placeholder-view svelte-1pluywh"><div class="view-header svelte-1pluywh"><div class="view-icon tasks-icon svelte-1pluywh">T</div> <div><h1 class="view-title svelte-1pluywh">TASKS View</h1> <p class="view-subtitle svelte-1pluywh">Task Management</p></div></div> <div class="coming-soon svelte-1pluywh"><p class="coming-soon-text svelte-1pluywh">TASKS View coming soon</p> <p class="coming-soon-detail svelte-1pluywh">RCASD-IVTR+C pipeline board, epic hierarchy tree, session timeline, and task detail views —
      delivered by T580 workers.</p></div> `);
		if (data.stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="stats-preview svelte-1pluywh"><h2 class="stats-title svelte-1pluywh">Live Data Ready</h2> <div class="stats-grid svelte-1pluywh"><!--[-->`);
			const each_array = ensure_array_like(data.stats);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let stat = each_array[$$index];
				$$renderer.push(`<div class="stat-card svelte-1pluywh"><span class="stat-value svelte-1pluywh">${escape_html(stat.value)}</span> <span class="stat-label svelte-1pluywh">${escape_html(stat.label)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

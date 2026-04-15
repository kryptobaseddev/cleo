import { B as attr, V as escape_html, a as ensure_array_like, l as stringify, o as head, r as attr_style } from "../../chunks/dev.js";
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const portals = [
			{
				href: "/nexus",
				title: "Nexus",
				subtitle: "Code Intelligence Graph",
				description: "Interactive visualization of the codebase symbol graph. Explore function calls, module dependencies, community clusters, and execution flows.",
				color: "#3b82f6",
				stats: data.nexusStats
			},
			{
				href: "/brain",
				title: "Brain",
				subtitle: "Memory Visualization",
				description: "Explore the CLEO memory graph. View decisions, patterns, learnings, and observations with quality scores and temporal relationships.",
				color: "#22c55e",
				stats: data.brainStats
			},
			{
				href: "/tasks",
				title: "Tasks",
				subtitle: "Task Management",
				description: "RCASD-IVTR+C pipeline board, epic hierarchy, session history, and task detail views. Read-only — all mutations remain CLI-only.",
				color: "#a855f7",
				stats: data.tasksStats
			}
		];
		head("1uha8ag", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="home svelte-1uha8ag"><div class="home-hero svelte-1uha8ag"><h1 class="hero-title svelte-1uha8ag">CLEO Studio</h1> <p class="hero-subtitle svelte-1uha8ag">Unified observability portal for the CLEO agent platform. Read-only views over live project
      data.</p></div> <div class="portal-grid svelte-1uha8ag"><!--[-->`);
		const each_array = ensure_array_like(portals);
		for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
			let portal = each_array[$$index_1];
			$$renderer.push(`<a${attr("href", portal.href)} class="portal-card svelte-1uha8ag"${attr_style(`--accent: ${stringify(portal.color)}`)}><div class="card-header svelte-1uha8ag"><div class="card-icon svelte-1uha8ag"${attr_style(`background: ${stringify(portal.color)}20; color: ${stringify(portal.color)}`)}>${escape_html(portal.title[0])}</div> <div class="card-titles svelte-1uha8ag"><h2 class="card-title svelte-1uha8ag">${escape_html(portal.title)}</h2> <span class="card-subtitle svelte-1uha8ag">${escape_html(portal.subtitle)}</span></div></div> <p class="card-description svelte-1uha8ag">${escape_html(portal.description)}</p> `);
			if (portal.stats) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="card-stats svelte-1uha8ag"><!--[-->`);
				const each_array_1 = ensure_array_like(portal.stats);
				for (let $$index = 0, $$length = each_array_1.length; $$index < $$length; $$index++) {
					let stat = each_array_1[$$index];
					$$renderer.push(`<div class="stat svelte-1uha8ag"><span class="stat-value svelte-1uha8ag">${escape_html(stat.value)}</span> <span class="stat-label svelte-1uha8ag">${escape_html(stat.label)}</span></div>`);
				}
				$$renderer.push(`<!--]--></div>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<div class="card-unavailable svelte-1uha8ag">Database not found</div>`);
			}
			$$renderer.push(`<!--]--> <div class="card-arrow svelte-1uha8ag"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8a.5.5 0 0 1 .5-.5h7.793L8.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L11.293 8.5H3.5A.5.5 0 0 1 3 8z"></path></svg></div></a>`);
		}
		$$renderer.push(`<!--]--></div></div>`);
	});
}
//#endregion
export { _page as default };

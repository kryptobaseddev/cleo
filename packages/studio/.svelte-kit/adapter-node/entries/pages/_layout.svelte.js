import "../../chunks/index-server.js";
import { B as attr, V as escape_html, a as ensure_array_like, c as store_get, et as getContext, i as derived, l as stringify, n as attr_class, r as attr_style, u as unsubscribe_stores } from "../../chunks/dev.js";
import "../../chunks/client.js";
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/stores.js
/**
* A function that returns all of the contextual stores. On the server, this must be called during component initialization.
* Only use this if you need to defer store subscription until after the component has mounted, for some reason.
*
* @deprecated Use `$app/state` instead (requires Svelte 5, [see docs for more info](https://svelte.dev/docs/kit/migrating-to-sveltekit-2#SvelteKit-2.12:-$app-stores-deprecated))
*/
var getStores = () => {
	const stores$1 = getContext("__svelte__");
	return {
		page: { subscribe: stores$1.page.subscribe },
		navigating: { subscribe: stores$1.navigating.subscribe },
		updated: stores$1.updated
	};
};
/**
* A readable store whose value contains page data.
*
* On the server, this store can only be subscribed to during component initialization. In the browser, it can be subscribed to at any time.
*
* @deprecated Use `page` from `$app/state` instead (requires Svelte 5, [see docs for more info](https://svelte.dev/docs/kit/migrating-to-sveltekit-2#SvelteKit-2.12:-$app-stores-deprecated))
* @type {import('svelte/store').Readable<import('@sveltejs/kit').Page>}
*/
var page = { subscribe(fn) {
	return getStores().page.subscribe(fn);
} };
//#endregion
//#region src/lib/components/ProjectSelector.svelte
function ProjectSelector($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/**
		* ProjectSelector — header dropdown for switching the active CLEO project.
		*
		* Displays the current project name with a colored chip and chevron.
		* Opens a searchable, filterable dropdown panel.  Switching POSTs to
		* /api/project/switch and reloads the page on success.
		*
		* @task T646
		*/
		/** Shape returned by listRegisteredProjects(). */
		let { projects, activeProjectId } = $$props;
		let isOpen = false;
		let searchQuery = "";
		let highlightedIndex = 0;
		const TEST_PATH_RE = /\/(tmp|test|fixture|scratch|sandbox)\b/i;
		const activeProject = derived(() => projects.find((p) => p.projectId === activeProjectId) ?? null);
		/** Chip colour based on project name initial. */
		const CHIP_COLORS = [
			"#3b82f6",
			"#10b981",
			"#f59e0b",
			"#8b5cf6",
			"#ec4899",
			"#06b6d4",
			"#84cc16",
			"#f97316"
		];
		function chipColor(name) {
			return CHIP_COLORS[(name.charCodeAt(0) || 0) % CHIP_COLORS.length];
		}
		function chipLetter(name) {
			return (name[0] ?? "?").toUpperCase();
		}
		/** Projects after search + test-project filter. */
		const filteredProjects = derived(() => {
			let list = projects;
			list = list.filter((p) => !TEST_PATH_RE.test(p.projectPath));
			if (searchQuery.trim());
			return list;
		});
		derived(() => filteredProjects()[highlightedIndex] ?? null);
		$$renderer.push(`<div class="project-selector svelte-t4k058"><button type="button"${attr_class("trigger svelte-t4k058", void 0, { "open": isOpen })} aria-haspopup="listbox"${attr("aria-expanded", isOpen)}${attr("title", activeProject() ? activeProject().projectPath : "Select project")}>`);
		if (activeProject()) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="chip svelte-t4k058"${attr_style(`background: ${stringify(chipColor(activeProject().name))}`)} aria-hidden="true">${escape_html(chipLetter(activeProject().name))}</span> <span class="trigger-name svelte-t4k058">${escape_html(activeProject().name)}</span>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<span class="chip placeholder svelte-t4k058" aria-hidden="true">?</span> <span class="trigger-name muted svelte-t4k058">Select project</span>`);
		}
		$$renderer.push(`<!--]--> <svg${attr_class("chevron svelte-t4k058", void 0, { "rotated": isOpen })} width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let { data, children } = $$props;
		const navItems = [
			{
				href: "/brain",
				label: "Brain",
				description: "5-substrate living canvas",
				exact: true
			},
			{
				href: "/brain/overview",
				label: "Memory",
				description: "BRAIN dashboard (decisions, observations, quality)",
				exact: false
			},
			{
				href: "/code",
				label: "Code",
				description: "Code intelligence",
				exact: false
			},
			{
				href: "/tasks",
				label: "Tasks",
				description: "Task management",
				exact: false
			}
		];
		$$renderer.push(`<div class="studio-shell svelte-12qhfyh"><header class="studio-header svelte-12qhfyh"><a href="/" class="studio-logo svelte-12qhfyh"><span class="logo-mark svelte-12qhfyh">C</span> <span class="logo-text svelte-12qhfyh">CLEO Studio</span></a> `);
		ProjectSelector($$renderer, {
			projects: data.projects,
			activeProjectId: data.activeProjectId
		});
		$$renderer.push(`<!----> <nav class="studio-nav svelte-12qhfyh"><!--[-->`);
		const each_array = ensure_array_like(navItems);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let item = each_array[$$index];
			$$renderer.push(`<a${attr("href", item.href)}${attr_class("nav-link svelte-12qhfyh", void 0, { "active": item.exact ? store_get($$store_subs ??= {}, "$page", page).url.pathname === item.href : store_get($$store_subs ??= {}, "$page", page).url.pathname.startsWith(item.href) })}${attr("title", item.description)}>${escape_html(item.label)}</a>`);
		}
		$$renderer.push(`<!--]--></nav></header> <main class="studio-main svelte-12qhfyh">`);
		children($$renderer);
		$$renderer.push(`<!----></main></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _layout as default };

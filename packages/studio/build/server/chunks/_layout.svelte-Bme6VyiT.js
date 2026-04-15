import { a1 as ensure_array_like, a2 as attr, a3 as attr_class, a4 as store_get, a5 as escape_html, a6 as unsubscribe_stores, g as getContext } from './dev-BIJYOMms.js';
import 'node:module';
import './client-N_q1nHbX.js';
import './index-server-D_hhbQIS.js';
import './internal-B2puBP7A.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';

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
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let { children } = $$props;
		const navItems = [
			{
				href: "/projects",
				label: "Projects",
				description: "Multi-project registry"
			},
			{
				href: "/nexus",
				label: "Nexus",
				description: "Code intelligence graph"
			},
			{
				href: "/brain",
				label: "Brain",
				description: "Memory visualization"
			},
			{
				href: "/living-brain",
				label: "Living Brain",
				description: "Unified 5-substrate graph"
			},
			{
				href: "/tasks",
				label: "Tasks",
				description: "Task management"
			}
		];
		$$renderer.push(`<div class="studio-shell svelte-12qhfyh"><header class="studio-header svelte-12qhfyh"><a href="/" class="studio-logo svelte-12qhfyh"><span class="logo-mark svelte-12qhfyh">C</span> <span class="logo-text svelte-12qhfyh">CLEO Studio</span></a> <nav class="studio-nav svelte-12qhfyh"><!--[-->`);
		const each_array = ensure_array_like(navItems);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let item = each_array[$$index];
			$$renderer.push(`<a${attr("href", item.href)}${attr_class("nav-link svelte-12qhfyh", void 0, { "active": store_get($$store_subs ??= {}, "$page", page).url.pathname.startsWith(item.href) })}${attr("title", item.description)}>${escape_html(item.label)}</a>`);
		}
		$$renderer.push(`<!--]--></nav></header> <main class="studio-main svelte-12qhfyh">`);
		children($$renderer);
		$$renderer.push(`<!----></main></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte-Bme6VyiT.js.map

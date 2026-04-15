import { c as escape_html, g as getContext } from './dev-BGytRnSO.js';
import 'node:module';
import './client-BfVTDezj.js';
import './internal-CwKA1UI_.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';

//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/state/server.js
function context() {
	return getContext("__request__");
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/state/index.js
/**
* A read-only reactive object with information about the current page, serving several use cases:
* - retrieving the combined `data` of all pages/layouts anywhere in your component tree (also see [loading data](https://svelte.dev/docs/kit/load))
* - retrieving the current value of the `form` prop anywhere in your component tree (also see [form actions](https://svelte.dev/docs/kit/form-actions))
* - retrieving the page state that was set through `goto`, `pushState` or `replaceState` (also see [goto](https://svelte.dev/docs/kit/$app-navigation#goto) and [shallow routing](https://svelte.dev/docs/kit/shallow-routing))
* - retrieving metadata such as the URL you're on, the current route and its parameters, and whether or not there was an error
*
* ```svelte
* <!--- file: +layout.svelte --->
* <script>
* 	import { page } from '$app/state';
* <\/script>
*
* <p>Currently at {page.url.pathname}</p>
*
* {#if page.error}
* 	<span class="red">Problem detected</span>
* {:else}
* 	<span class="small">All systems operational</span>
* {/if}
* ```
*
* Changes to `page` are available exclusively with runes. (The legacy reactivity syntax will not reflect any changes)
*
* ```svelte
* <!--- file: +page.svelte --->
* <script>
* 	import { page } from '$app/state';
* 	const id = $derived(page.params.id); // This will correctly update id for usage on this page
* 	$: badId = page.params.id; // Do not use; will never update after initial load
* <\/script>
* ```
*
* On the server, values can only be read during rendering (in other words _not_ in e.g. `load` functions). In the browser, the values can be read at any time.
*
* @type {import('@sveltejs/kit').Page}
*/
var page = {
	get error() {
		return context().page.error;
	},
	get status() {
		return context().page.status;
	}};
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte
function Error$1($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<h1>${escape_html(page.status)}</h1> <p>${escape_html(page.error?.message)}</p>`);
	});
}

export { Error$1 as default };
//# sourceMappingURL=error.svelte-g7ZE6PdD.js.map

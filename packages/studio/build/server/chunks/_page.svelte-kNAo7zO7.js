import { a9 as head } from './dev-YtqJX9rn.js';
import 'node:module';

//#region src/routes/brain/decisions/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		head("c3xmlv", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN Decisions — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="decisions-page svelte-c3xmlv"><div class="page-header svelte-c3xmlv"><a href="/brain/overview" class="back-link svelte-c3xmlv">← Overview</a> <h1 class="page-title svelte-c3xmlv">Decisions Timeline</h1> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <a href="/brain?scope=brain&amp;type=decision" class="canvas-pill svelte-c3xmlv">Open in Canvas →</a></div> `);
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="loading svelte-c3xmlv">Loading decisions…</div>`);
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-kNAo7zO7.js.map

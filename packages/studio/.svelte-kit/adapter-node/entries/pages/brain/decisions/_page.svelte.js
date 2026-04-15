import "../../../../chunks/index-server.js";
import { o as head } from "../../../../chunks/dev.js";
//#region src/routes/brain/decisions/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		head("c3xmlv", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN Decisions — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="decisions-page svelte-c3xmlv"><div class="page-header svelte-c3xmlv"><a href="/brain" class="back-link svelte-c3xmlv">← Brain</a> <h1 class="page-title svelte-c3xmlv">Decisions Timeline</h1> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> `);
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="loading svelte-c3xmlv">Loading decisions…</div>`);
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

import "../../../../chunks/index-server.js";
import { o as head } from "../../../../chunks/dev.js";
//#region src/routes/brain/quality/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		head("u82uod", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>BRAIN Quality — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="quality-page svelte-u82uod"><div class="page-header svelte-u82uod"><a href="/brain" class="back-link svelte-u82uod">← Brain</a> <h1 class="page-title svelte-u82uod">Quality Distribution</h1></div> `);
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="loading svelte-u82uod">Loading quality data…</div>`);
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
export { _page as default };

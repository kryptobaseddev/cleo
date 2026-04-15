import { g as getAllSubstrates } from './adapters-CHxN16M4.js';
import './connections-C-btvhSI.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';
import './project-context-enjwprPM.js';

//#region src/routes/brain/+page.server.ts
/**
* Brain canvas page server load (`/brain`).
*
* Fetches the initial graph from the unified Living Brain API with a
* default limit of 500 nodes.  The client-side component can request
* larger slices via the "Full graph" button.
*
* @note The underlying API route is `/api/living-brain` for historical reasons
* (the route was originally served at `/living-brain`). A rename of the API
* path is deferred to a future task to avoid churn in other consumers.
*/
var load = ({ locals }) => {
	return { graph: getAllSubstrates({
		limit: 500,
		projectCtx: locals.projectCtx
	}) };
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 3;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-DjM2SDsC.js')).default;
const server_id = "src/routes/brain/+page.server.ts";
const imports = ["_app/immutable/nodes/3.BWrU5B_p.js","_app/immutable/chunks/BaLXwP8b.js","_app/immutable/chunks/BgWknWDs.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/3.IYs8PPvo.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=3-DYIReQ5c.js.map

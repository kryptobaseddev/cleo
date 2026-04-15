import { g as getAllSubstrates } from './adapters-CU77vhaB.js';
import './connections-BR9V-1fV.js';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
import 'node:module';

//#region src/routes/living-brain/+page.server.ts
/**
* Living Brain page server load.
*
* Fetches the initial graph from the unified Living Brain API with a
* default limit of 500 nodes.  The client-side component can request
* larger slices via the "Full graph" button.
*/
var load = () => {
	return { graph: getAllSubstrates({ limit: 500 }) };
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 8;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-7XEZbqk4.js')).default;
const server_id = "src/routes/living-brain/+page.server.ts";
const imports = ["_app/immutable/nodes/8.BQYfwzeP.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/woD0E6xL.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/8.BLO6eOrj.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=8-DHEmOjSc.js.map

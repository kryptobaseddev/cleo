import { g as getActiveProjectId, l as listRegisteredProjects } from './project-context-enjwprPM.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/+layout.server.ts
/**
* Root layout server load — supplies active project context and full project
* list to every page in CLEO Studio so the header ProjectSelector has data
* without requiring a per-page load function.
*
* @task T646
*/
var load = ({ cookies }) => {
	const activeProjectId = getActiveProjectId(cookies);
	return {
		projects: listRegisteredProjects(),
		activeProjectId
	};
};

var _layout_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

const index = 0;
let component_cache;
const component = async () => component_cache ??= (await import('./_layout.svelte-B5ujYZOr.js')).default;
const server_id = "src/routes/+layout.server.ts";
const imports = ["_app/immutable/nodes/0.DAYBsSCs.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/0.Dwhkaog4.css"];
const fonts = [];

export { component, fonts, imports, index, _layout_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=0-CzCkOP4c.js.map

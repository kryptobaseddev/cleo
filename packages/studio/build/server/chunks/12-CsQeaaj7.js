import { c as clearActiveProjectId, s as setActiveProjectId, g as getActiveProjectId, l as listRegisteredProjects } from './project-context-enjwprPM.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/projects/+page.server.ts
/**
* Projects page server load — lists all projects registered in the
* global nexus.db registry and resolves the active project context.
*
* @task T622
*/
var load = ({ cookies }) => {
	const activeProjectId = getActiveProjectId(cookies);
	return {
		projects: listRegisteredProjects(),
		activeProjectId
	};
};
var actions = {
	switchProject: async ({ request, cookies }) => {
		const projectId = (await request.formData()).get("projectId");
		if (typeof projectId === "string" && projectId) setActiveProjectId(cookies, projectId);
		return { success: true };
	},
	clearProject: async ({ cookies }) => {
		clearActiveProjectId(cookies);
		return { success: true };
	}
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	actions: actions,
	load: load
});

const index = 12;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-BsruZYLH.js')).default;
const server_id = "src/routes/projects/+page.server.ts";
const imports = ["_app/immutable/nodes/12.DMViR_1j.js","_app/immutable/chunks/ZT3WoQr4.js","_app/immutable/chunks/ltU5_Kh5.js","_app/immutable/chunks/hOfOSlm7.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/12.UOd2WnhF.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=12-CsQeaaj7.js.map

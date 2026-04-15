import { c as clearActiveProjectId, s as setActiveProjectId, g as getActiveProjectId, l as listRegisteredProjects } from './project-context-BdxnBRDU.js';
import './cleo-home-hJ0l__SG.js';
import 'node:fs';
import 'node:os';
import 'node:path';
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
const component = async () => component_cache ??= (await import('./_page.svelte-BrcbkTQX.js')).default;
const server_id = "src/routes/projects/+page.server.ts";
const imports = ["_app/immutable/nodes/12.CTxmnjPb.js","_app/immutable/chunks/CC_7gvW7.js","_app/immutable/chunks/dVYxnWpL.js","_app/immutable/chunks/BdnaH7OR.js","_app/immutable/chunks/ibwe1TAv.js"];
const stylesheets = ["_app/immutable/assets/12.DP-hlj4s.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=12-jL00Yw-p.js.map

import { n as getActiveProjectId, o as setActiveProjectId, r as listRegisteredProjects, t as clearActiveProjectId } from "../../../chunks/project-context.js";
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
//#endregion
export { actions, load };

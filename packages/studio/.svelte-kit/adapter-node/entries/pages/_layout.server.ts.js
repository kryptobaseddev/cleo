import { n as getActiveProjectId, r as listRegisteredProjects } from "../../chunks/project-context.js";
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
//#endregion
export { load };

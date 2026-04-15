import { a as resolveProjectContext, i as resolveDefaultProjectContext, n as getActiveProjectId } from "../chunks/project-context.js";
//#region src/hooks.server.ts
var handle = async ({ event, resolve }) => {
	const activeId = getActiveProjectId(event.cookies);
	const ctx = activeId && resolveProjectContext(activeId) || resolveDefaultProjectContext();
	event.locals.projectCtx = ctx;
	return resolve(event);
};
//#endregion
export { handle };

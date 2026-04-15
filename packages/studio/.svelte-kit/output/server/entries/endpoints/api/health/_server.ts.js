import { r as getDbStatus } from "../../../../chunks/connections.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/health/+server.ts
/**
* Health check endpoint for the CLEO Studio server.
* GET /api/health → { ok: true, version: string, databases: {...} }
*/
var GET = () => {
	const dbStatus = getDbStatus();
	return json({
		ok: true,
		service: "cleo-studio",
		version: "2026.4.47",
		databases: {
			nexus: dbStatus.nexus ? "available" : "not found",
			brain: dbStatus.brain ? "available" : "not found",
			tasks: dbStatus.tasks ? "available" : "not found"
		},
		paths: {
			nexus: dbStatus.nexusPath,
			brain: dbStatus.brainPath,
			tasks: dbStatus.tasksPath
		}
	});
};
//#endregion
export { GET };

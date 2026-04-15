import { t as runCleoCli } from "../../../../../chunks/spawn-cli.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/project/[id]/+server.ts
/**
* DELETE /api/project/[id]
*
* Removes a project from the global nexus.db registry by calling:
*   `cleo nexus projects remove <id> --json`
*
* Returns a LAFS envelope on success or a 502 with reason on CLI failure.
*
* @task T657
*/
var DELETE = async ({ params }) => {
	const projectId = params.id;
	if (!projectId?.trim()) return json({
		success: false,
		error: { message: "Missing project id" }
	}, { status: 400 });
	const result = await runCleoCli([
		"nexus",
		"projects",
		"remove",
		projectId,
		"--json"
	]);
	if (!result.ok) return json({
		success: false,
		error: {
			message: result.stderr.trim() || result.stdout.trim() || "CLI command failed",
			code: "CLI_FAILURE"
		},
		meta: { exitCode: result.exitCode }
	}, { status: 502 });
	return json(result.envelope ?? { success: true });
};
//#endregion
export { DELETE };

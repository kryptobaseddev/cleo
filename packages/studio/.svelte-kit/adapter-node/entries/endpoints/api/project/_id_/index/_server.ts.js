import { r as listRegisteredProjects } from "../../../../../../chunks/project-context.js";
import { t as runCleoCli } from "../../../../../../chunks/spawn-cli.js";
import { json } from "@sveltejs/kit";
//#region src/routes/api/project/[id]/index/+server.ts
/**
* POST /api/project/[id]/index
*
* Triggers a full nexus index for a project by calling:
*   `cleo nexus analyze <projectPath> --json`
*
* The project path is resolved by looking up the project ID in the
* listRegisteredProjects() registry. Returns a LAFS envelope on success
* or a 502 with reason on CLI failure.
*
* @task T657
*/
var POST = async ({ params }) => {
	const projectId = params.id;
	if (!projectId?.trim()) return json({
		success: false,
		error: { message: "Missing project id" }
	}, { status: 400 });
	const project = listRegisteredProjects().find((p) => p.projectId === projectId);
	if (!project) return json({
		success: false,
		error: { message: `Project ${projectId} not found in registry` }
	}, { status: 404 });
	const result = await runCleoCli([
		"nexus",
		"analyze",
		project.projectPath,
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
export { POST };

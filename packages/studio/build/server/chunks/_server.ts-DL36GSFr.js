import { s as setActiveProjectId } from './project-context-enjwprPM.js';
import { error, json } from '@sveltejs/kit';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/routes/api/project/switch/+server.ts
/**
* POST /api/project/switch
*
* Accepts `{ projectId: string }` as JSON, sets the active project cookie,
* and returns `{ success: true }`.  Used by the header ProjectSelector
* component for client-side project switching without a full page form POST.
*
* @task T646
*/
var POST = async ({ request, cookies }) => {
	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, "Invalid JSON body");
	}
	if (typeof body !== "object" || body === null || typeof body.projectId !== "string") throw error(400, "Missing or invalid projectId");
	const projectId = body.projectId;
	if (!projectId.trim()) throw error(400, "projectId must not be empty");
	setActiveProjectId(cookies, projectId);
	return json({ success: true });
};

export { POST };
//# sourceMappingURL=_server.ts-DL36GSFr.js.map

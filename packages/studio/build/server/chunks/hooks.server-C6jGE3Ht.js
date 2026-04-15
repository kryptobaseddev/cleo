import { g as getActiveProjectId, r as resolveProjectContext, a as resolveDefaultProjectContext } from './project-context-enjwprPM.js';
import './cleo-home-BSckk0xW.js';
import 'node:fs';
import 'node:path';
import 'node:os';
import 'node:module';

//#region src/hooks.server.ts
var handle = async ({ event, resolve }) => {
	const activeId = getActiveProjectId(event.cookies);
	const ctx = activeId && resolveProjectContext(activeId) || resolveDefaultProjectContext();
	event.locals.projectCtx = ctx;
	return resolve(event);
};

export { handle };
//# sourceMappingURL=hooks.server-C6jGE3Ht.js.map

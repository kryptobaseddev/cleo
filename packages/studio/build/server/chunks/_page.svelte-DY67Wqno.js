import { a7 as head, a5 as escape_html, a1 as ensure_array_like, a3 as attr_class, a9 as stringify, a2 as attr } from './dev-BIJYOMms.js';

//#region src/routes/tasks/sessions/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const sessions = data.sessions ?? [];
		let expandedId = null;
		function formatDuration(ms) {
			if (ms === null) return "—";
			const s = Math.floor(ms / 1e3);
			if (s < 60) return `${s}s`;
			const m = Math.floor(s / 60);
			if (m < 60) return `${m}m ${s % 60}s`;
			return `${Math.floor(m / 60)}h ${m % 60}m`;
		}
		function formatDate(iso) {
			try {
				return new Date(iso).toLocaleString("en-US", {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return iso;
			}
		}
		function statusClass(s) {
			if (s === "active") return "sess-active";
			if (s === "ended") return "sess-ended";
			return "sess-other";
		}
		const totalCompleted = sessions.reduce((sum, s) => sum + s.completedCount, 0);
		const totalCreated = sessions.reduce((sum, s) => sum + s.createdCount, 0);
		const activeSessions = sessions.filter((s) => s.status === "active").length;
		head("1x47y1z", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Sessions — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="sessions-view svelte-1x47y1z"><div class="page-header svelte-1x47y1z"><div class="header-left svelte-1x47y1z"><h1 class="page-title svelte-1x47y1z">Sessions</h1> <nav class="tasks-nav svelte-1x47y1z"><a href="/tasks" class="nav-tab svelte-1x47y1z">Dashboard</a> <a href="/tasks/pipeline" class="nav-tab svelte-1x47y1z">Pipeline</a> <a href="/tasks/sessions" class="nav-tab active svelte-1x47y1z">Sessions</a></nav></div> <div class="header-stats svelte-1x47y1z"><span class="hstat svelte-1x47y1z"><strong class="svelte-1x47y1z">${escape_html(sessions.length)}</strong> sessions</span> <span class="hstat svelte-1x47y1z"><strong class="svelte-1x47y1z">${escape_html(totalCreated)}</strong> created</span> <span class="hstat svelte-1x47y1z"><strong class="svelte-1x47y1z">${escape_html(totalCompleted)}</strong> completed</span> `);
		if (activeSessions > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="hstat hstat-active svelte-1x47y1z"><strong class="svelte-1x47y1z">${escape_html(activeSessions)}</strong> active</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div> `);
		if (sessions.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-1x47y1z">No sessions found in tasks.db</div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="timeline svelte-1x47y1z"><!--[-->`);
			const each_array = ensure_array_like(sessions);
			for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
				let sess = each_array[$$index_1];
				$$renderer.push(`<div class="timeline-item svelte-1x47y1z"><div class="timeline-connector svelte-1x47y1z"><div${attr_class(`timeline-dot ${stringify(statusClass(sess.status))}`, "svelte-1x47y1z")}></div> <div class="timeline-line svelte-1x47y1z"></div></div> <div${attr_class("session-card svelte-1x47y1z", void 0, { "expanded": expandedId === sess.id })}><div class="session-header svelte-1x47y1z"><div class="session-title-row svelte-1x47y1z"><span${attr_class(`session-status-badge ${stringify(statusClass(sess.status))}`, "svelte-1x47y1z")}>${escape_html(sess.status)}</span> <span class="session-name svelte-1x47y1z">${escape_html(sess.name ?? sess.id)}</span></div> <div class="session-meta-row svelte-1x47y1z"><span class="session-time svelte-1x47y1z">${escape_html(formatDate(sess.startedAt))}</span> `);
				if (sess.endedAt) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="session-sep svelte-1x47y1z">→</span> <span class="session-time svelte-1x47y1z">${escape_html(formatDate(sess.endedAt))}</span> <span class="session-duration svelte-1x47y1z">${escape_html(formatDuration(sess.durationMs))}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (sess.agent) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="session-agent svelte-1x47y1z">${escape_html(sess.agent)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> <div class="session-counts svelte-1x47y1z">`);
				if (sess.completedCount > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="count-chip count-done svelte-1x47y1z">${escape_html(sess.completedCount)} completed</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (sess.createdCount > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="count-chip count-created svelte-1x47y1z">${escape_html(sess.createdCount)} created</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (sess.completedCount === 0 && sess.createdCount === 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="count-chip count-empty svelte-1x47y1z">no tasks</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div> `);
				if (expandedId === sess.id && sess.completedTasks.length > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="session-tasks svelte-1x47y1z"><div class="tasks-label svelte-1x47y1z">Completed Tasks</div> <!--[-->`);
					const each_array_1 = ensure_array_like(sess.completedTasks);
					for (let $$index = 0, $$length = each_array_1.length; $$index < $$length; $$index++) {
						let t = each_array_1[$$index];
						$$renderer.push(`<a${attr("href", `/tasks/${stringify(t.id)}`)} class="completed-task-row svelte-1x47y1z"><span class="ct-id svelte-1x47y1z">${escape_html(t.id)}</span> <span class="ct-title svelte-1x47y1z">${escape_html(t.title)}</span> <span class="ct-status svelte-1x47y1z">${escape_html(t.status)}</span></a>`);
					}
					$$renderer.push(`<!--]--></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-DY67Wqno.js.map

import { a9 as head, a3 as attr_class, a5 as escape_html, a1 as ensure_array_like, a7 as attr_style, a2 as attr, a8 as stringify } from './dev-YtqJX9rn.js';

//#region src/routes/tasks/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const stats = data.stats;
		const recentTasks = data.recentTasks ?? [];
		const epicProgress = data.epicProgress ?? [];
		function priorityClass(p) {
			if (p === "critical") return "priority-critical";
			if (p === "high") return "priority-high";
			if (p === "medium") return "priority-medium";
			return "priority-low";
		}
		function statusIcon(s) {
			if (s === "done") return "✓";
			if (s === "active") return "●";
			if (s === "blocked") return "✗";
			return "○";
		}
		function statusClass(s) {
			if (s === "done") return "status-done";
			if (s === "active") return "status-active";
			if (s === "blocked") return "status-blocked";
			return "status-pending";
		}
		function progressPct(ep) {
			if (ep.total === 0) return 0;
			return Math.round(ep.done / ep.total * 100);
		}
		function formatTime(iso) {
			try {
				const d = new Date(iso);
				const diff = Date.now() - d.getTime();
				const mins = Math.floor(diff / 6e4);
				if (mins < 60) return `${mins}m ago`;
				const hrs = Math.floor(mins / 60);
				if (hrs < 24) return `${hrs}h ago`;
				return `${Math.floor(hrs / 24)}d ago`;
			} catch {
				return iso;
			}
		}
		let liveConnected = false;
		head("1pluywh", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Tasks — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="tasks-dashboard svelte-1pluywh"><div class="page-header svelte-1pluywh"><div class="header-left svelte-1pluywh"><h1 class="page-title svelte-1pluywh">Tasks</h1> <nav class="tasks-nav svelte-1pluywh"><a href="/tasks" class="nav-tab active svelte-1pluywh">Dashboard</a> <a href="/tasks/pipeline" class="nav-tab svelte-1pluywh">Pipeline</a> <a href="/tasks/sessions" class="nav-tab svelte-1pluywh">Sessions</a></nav></div> <div${attr_class("live-indicator svelte-1pluywh", void 0, { "connected": liveConnected })}><span class="live-dot svelte-1pluywh"></span> <span class="live-label svelte-1pluywh">${escape_html("Connecting...")}</span> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div> `);
		if (stats) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="stats-section svelte-1pluywh"><div class="stat-group svelte-1pluywh"><div class="stat-card primary svelte-1pluywh"><span class="stat-num svelte-1pluywh">${escape_html(stats.total)}</span> <span class="stat-lbl svelte-1pluywh">Total</span></div> <div class="stat-card status-active-card svelte-1pluywh"><span class="stat-num svelte-1pluywh">${escape_html(stats.active)}</span> <span class="stat-lbl svelte-1pluywh">Active</span></div> <div class="stat-card svelte-1pluywh"><span class="stat-num svelte-1pluywh">${escape_html(stats.pending)}</span> <span class="stat-lbl svelte-1pluywh">Pending</span></div> <div class="stat-card status-done-card svelte-1pluywh"><span class="stat-num svelte-1pluywh">${escape_html(stats.done)}</span> <span class="stat-lbl svelte-1pluywh">Done</span></div> <div class="stat-card muted svelte-1pluywh"><span class="stat-num svelte-1pluywh">${escape_html(stats.archived)}</span> <span class="stat-lbl svelte-1pluywh">Archived</span></div></div> <div class="priority-breakdown svelte-1pluywh"><div class="section-label svelte-1pluywh">Priority</div> <div class="priority-bars svelte-1pluywh"><!--[-->`);
			const each_array = ensure_array_like([
				["critical", stats.critical],
				["high", stats.high],
				["medium", stats.medium],
				["low", stats.low]
			]);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let [label, count] = each_array[$$index];
				const total = stats.critical + stats.high + stats.medium + stats.low;
				const pct = total > 0 ? Math.round(Number(count) / total * 100) : 0;
				$$renderer.push(`<div class="priority-row svelte-1pluywh"><span${attr_class(`priority-label ${stringify(priorityClass(String(label)))}`, "svelte-1pluywh")}>${escape_html(label)}</span> <div class="priority-bar-track svelte-1pluywh"><div${attr_class(`priority-bar-fill ${stringify(priorityClass(String(label)))}`, "svelte-1pluywh")}${attr_style(`width:${stringify(pct)}%`)}></div></div> <span class="priority-count svelte-1pluywh">${escape_html(count)}</span></div>`);
			}
			$$renderer.push(`<!--]--></div></div> <div class="type-breakdown svelte-1pluywh"><div class="section-label svelte-1pluywh">Type</div> <div class="type-chips svelte-1pluywh"><span class="type-chip svelte-1pluywh">Epics: <strong class="svelte-1pluywh">${escape_html(stats.epics)}</strong></span> <span class="type-chip svelte-1pluywh">Tasks: <strong class="svelte-1pluywh">${escape_html(stats.tasks)}</strong></span> <span class="type-chip svelte-1pluywh">Subtasks: <strong class="svelte-1pluywh">${escape_html(stats.subtasks)}</strong></span></div></div></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="no-db svelte-1pluywh">tasks.db not found — start CLEO in the project directory</div>`);
		}
		$$renderer.push(`<!--]--> <div class="lower-grid svelte-1pluywh">`);
		if (epicProgress.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<section class="panel svelte-1pluywh"><h2 class="panel-title svelte-1pluywh">Epic Progress</h2> <div class="epic-list svelte-1pluywh"><!--[-->`);
			const each_array_1 = ensure_array_like(epicProgress);
			for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
				let ep = each_array_1[$$index_1];
				$$renderer.push(`<a${attr("href", `/tasks/tree/${stringify(ep.id)}`)} class="epic-row svelte-1pluywh"><div class="epic-header-row svelte-1pluywh"><span class="epic-id svelte-1pluywh">${escape_html(ep.id)}</span> <span class="epic-title svelte-1pluywh">${escape_html(ep.title)}</span> <span class="epic-pct svelte-1pluywh">${escape_html(progressPct(ep))}%</span></div> <div class="epic-progress-bar svelte-1pluywh"><div class="epic-done-bar svelte-1pluywh"${attr_style(`width:${stringify(progressPct(ep))}%`)}></div></div> <div class="epic-sub-counts svelte-1pluywh"><span class="sub-done svelte-1pluywh">${escape_html(ep.done)} done</span> <span class="sub-active svelte-1pluywh">${escape_html(ep.active)} active</span> <span class="sub-pending svelte-1pluywh">${escape_html(ep.pending)} pending</span></div></a>`);
			}
			$$renderer.push(`<!--]--></div></section>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (recentTasks.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<section class="panel svelte-1pluywh"><h2 class="panel-title svelte-1pluywh">Recent Activity</h2> <div class="task-list svelte-1pluywh"><!--[-->`);
			const each_array_2 = ensure_array_like(recentTasks);
			for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
				let t = each_array_2[$$index_2];
				$$renderer.push(`<a${attr("href", `/tasks/${stringify(t.id)}`)} class="task-row svelte-1pluywh"><span${attr_class(`task-status-icon ${stringify(statusClass(t.status))}`, "svelte-1pluywh")}>${escape_html(statusIcon(t.status))}</span> <div class="task-info svelte-1pluywh"><span class="task-id svelte-1pluywh">${escape_html(t.id)}</span> <span class="task-title svelte-1pluywh">${escape_html(t.title)}</span></div> <div class="task-meta svelte-1pluywh"><span${attr_class(`task-priority ${stringify(priorityClass(t.priority))}`, "svelte-1pluywh")}>${escape_html(t.priority)}</span> `);
				if (t.pipeline_stage) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="task-stage svelte-1pluywh">${escape_html(t.pipeline_stage)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <span class="task-time svelte-1pluywh">${escape_html(formatTime(t.updated_at))}</span></div></a>`);
			}
			$$renderer.push(`<!--]--></div></section>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-Buhpx1l6.js.map

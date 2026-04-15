import { a7 as head, a5 as escape_html, a1 as ensure_array_like, a3 as attr_class, a2 as attr, a9 as stringify } from './dev-BIJYOMms.js';

//#region src/routes/tasks/pipeline/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const columns = data.columns ?? [];
		function priorityClass(p) {
			if (p === "critical") return "p-critical";
			if (p === "high") return "p-high";
			if (p === "medium") return "p-medium";
			return "p-low";
		}
		function statusIcon(s) {
			if (s === "done") return "✓";
			if (s === "active") return "●";
			if (s === "blocked") return "✗";
			return "○";
		}
		function statusClass(s) {
			if (s === "done") return "sc-done";
			if (s === "active") return "sc-active";
			if (s === "blocked") return "sc-blocked";
			return "sc-pending";
		}
		function gatesPassed(task) {
			try {
				if (!task.verification_json) return {
					i: false,
					t: false,
					q: false
				};
				const v = JSON.parse(task.verification_json);
				return {
					i: v.gates?.implemented ?? false,
					t: v.gates?.testsPassed ?? false,
					q: v.gates?.qaPassed ?? false
				};
			} catch {
				return {
					i: false,
					t: false,
					q: false
				};
			}
		}
		let focusedCol = 0;
		let focusedRow = 0;
		const totalTasks = columns.reduce((sum, c) => sum + c.count, 0);
		head("1jyay8m", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Pipeline — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="pipeline-view svelte-1jyay8m" role="main" tabindex="-1"><div class="page-header svelte-1jyay8m"><div class="header-left svelte-1jyay8m"><h1 class="page-title svelte-1jyay8m">Pipeline</h1> <nav class="tasks-nav svelte-1jyay8m"><a href="/tasks" class="nav-tab svelte-1jyay8m">Dashboard</a> <a href="/tasks/pipeline" class="nav-tab active svelte-1jyay8m">Pipeline</a> <a href="/tasks/sessions" class="nav-tab svelte-1jyay8m">Sessions</a></nav></div> <span class="total-count svelte-1jyay8m">${escape_html(totalTasks)} tasks</span></div> <div class="kanban-scroll svelte-1jyay8m"><div class="kanban-board svelte-1jyay8m"><!--[-->`);
		const each_array = ensure_array_like(columns);
		for (let ci = 0, $$length = each_array.length; ci < $$length; ci++) {
			let col = each_array[ci];
			$$renderer.push(`<div${attr_class("kanban-col svelte-1jyay8m", void 0, { "col-focused": ci === focusedCol })}><div class="col-header svelte-1jyay8m"><span class="col-label svelte-1jyay8m">${escape_html(col.label)}</span> <span class="col-count svelte-1jyay8m">${escape_html(col.count)}</span></div> <div class="col-body svelte-1jyay8m"><!--[-->`);
			const each_array_1 = ensure_array_like(col.tasks);
			for (let ri = 0, $$length = each_array_1.length; ri < $$length; ri++) {
				let task = each_array_1[ri];
				const gates = gatesPassed(task);
				$$renderer.push(`<a${attr("href", `/tasks/${stringify(task.id)}`)}${attr_class("task-card svelte-1jyay8m", void 0, { "card-focused": ci === focusedCol && ri === focusedRow })}><div class="card-top svelte-1jyay8m"><span class="card-id svelte-1jyay8m">${escape_html(task.id)}</span> <span${attr_class(`card-status ${stringify(statusClass(task.status))}`, "svelte-1jyay8m")}>${escape_html(statusIcon(task.status))}</span></div> <p class="card-title svelte-1jyay8m">${escape_html(task.title)}</p> <div class="card-footer svelte-1jyay8m"><span${attr_class(`card-priority ${stringify(priorityClass(task.priority))}`, "svelte-1jyay8m")}>${escape_html(task.priority)}</span> `);
				if (task.size) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="card-size svelte-1jyay8m">${escape_html(task.size)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="card-gates svelte-1jyay8m"><span${attr_class("g-dot svelte-1jyay8m", void 0, { "g-pass": gates.i })} title="Implemented">I</span> <span${attr_class("g-dot svelte-1jyay8m", void 0, { "g-pass": gates.t })} title="Tests">T</span> <span${attr_class("g-dot svelte-1jyay8m", void 0, { "g-pass": gates.q })} title="QA">Q</span></div></div></a>`);
			}
			$$renderer.push(`<!--]--> `);
			if (col.tasks.length === 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="col-empty svelte-1jyay8m">—</div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div></div>`);
		}
		$$renderer.push(`<!--]--></div></div> <p class="keyboard-hint svelte-1jyay8m">Arrow keys to navigate · Enter to open</p></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-3F4R47BX.js.map

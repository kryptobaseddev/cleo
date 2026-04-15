import { a7 as head, a2 as attr, a9 as stringify, a5 as escape_html, a3 as attr_class, a1 as ensure_array_like, a8 as attr_style } from './dev-BIJYOMms.js';

//#region src/routes/tasks/[id]/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const { task, subtasks, parent } = data;
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
		function gateIcon(passed) {
			return passed ? "✓" : "·";
		}
		function formatDate(iso) {
			if (!iso) return "—";
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
		function subtaskVerif(row) {
			try {
				if (!row.verification_json) return null;
				return JSON.parse(row.verification_json).gates ?? null;
			} catch {
				return null;
			}
		}
		const doneSubtasks = subtasks.filter((s) => s.status === "done").length;
		const subtaskPct = subtasks.length > 0 ? Math.round(doneSubtasks / subtasks.length * 100) : 0;
		head("13zy71l", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>${escape_html(task.id)} — ${escape_html(task.title)} — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="task-detail svelte-13zy71l"><nav class="breadcrumb svelte-13zy71l"><a href="/tasks" class="svelte-13zy71l">Tasks</a> `);
		if (parent) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="crumb-sep svelte-13zy71l">›</span> <a${attr("href", `/tasks/${stringify(parent.id)}`)} class="svelte-13zy71l">${escape_html(parent.id)}</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <span class="crumb-sep svelte-13zy71l">›</span> <span class="crumb-current svelte-13zy71l">${escape_html(task.id)}</span></nav> <div class="task-layout svelte-13zy71l"><div class="task-main"><div class="task-header svelte-13zy71l"><div class="task-title-row svelte-13zy71l"><span class="task-id-badge svelte-13zy71l">${escape_html(task.id)}</span> <span${attr_class(`task-status-badge ${stringify(statusClass(task.status))}`, "svelte-13zy71l")}>${escape_html(statusIcon(task.status))} ${escape_html(task.status)}</span> <span${attr_class(`task-priority-badge ${stringify(priorityClass(task.priority))}`, "svelte-13zy71l")}>${escape_html(task.priority)}</span> `);
		if (task.type !== "task") {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="task-type-badge svelte-13zy71l">${escape_html(task.type)}</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <h1 class="task-title svelte-13zy71l">${escape_html(task.title)}</h1> `);
		if (task.description) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p class="task-description svelte-13zy71l">${escape_html(task.description)}</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> `);
		if (task.acceptance && task.acceptance.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<section class="detail-section svelte-13zy71l"><h2 class="section-title svelte-13zy71l">Acceptance Criteria</h2> <ul class="acceptance-list svelte-13zy71l"><!--[-->`);
			const each_array = ensure_array_like(task.acceptance);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let criterion = each_array[$$index];
				$$renderer.push(`<li class="acceptance-item svelte-13zy71l"><span class="acceptance-check svelte-13zy71l">○</span> <span>${escape_html(criterion)}</span></li>`);
			}
			$$renderer.push(`<!--]--></ul></section>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (task.verification) {
			$$renderer.push("<!--[0-->");
			const v = task.verification;
			$$renderer.push(`<section class="detail-section svelte-13zy71l"><h2 class="section-title svelte-13zy71l">Verification Gates <span${attr_class("verif-badge svelte-13zy71l", void 0, { "passed": v.passed })}>${escape_html(v.passed ? "PASSED" : `Round ${v.round}`)}</span></h2> <div class="gates-grid svelte-13zy71l"><div${attr_class("gate svelte-13zy71l", void 0, { "gate-passed": v.gates.implemented })}><span class="gate-icon svelte-13zy71l">${escape_html(gateIcon(v.gates.implemented))}</span> <span class="gate-label svelte-13zy71l">Implemented</span> <span class="gate-short svelte-13zy71l">I</span></div> <div${attr_class("gate svelte-13zy71l", void 0, { "gate-passed": v.gates.testsPassed })}><span class="gate-icon svelte-13zy71l">${escape_html(gateIcon(v.gates.testsPassed))}</span> <span class="gate-label svelte-13zy71l">Tests Passed</span> <span class="gate-short svelte-13zy71l">T</span></div> <div${attr_class("gate svelte-13zy71l", void 0, { "gate-passed": v.gates.qaPassed })}><span class="gate-icon svelte-13zy71l">${escape_html(gateIcon(v.gates.qaPassed))}</span> <span class="gate-label svelte-13zy71l">QA Passed</span> <span class="gate-short svelte-13zy71l">Q</span></div></div> `);
			if (v.lastAgent) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<p class="verif-meta svelte-13zy71l">Last agent: ${escape_html(v.lastAgent)} · ${escape_html(formatDate(v.lastUpdated))}</p>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> `);
			if (v.failureLog && v.failureLog.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="failure-log svelte-13zy71l"><!--[-->`);
				const each_array_1 = ensure_array_like(v.failureLog);
				for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
					let entry = each_array_1[$$index_1];
					$$renderer.push(`<div class="failure-entry svelte-13zy71l">${escape_html(entry)}</div>`);
				}
				$$renderer.push(`<!--]--></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></section>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (subtasks.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<section class="detail-section svelte-13zy71l"><h2 class="section-title svelte-13zy71l">Subtasks <span class="subtask-progress svelte-13zy71l">${escape_html(doneSubtasks)}/${escape_html(subtasks.length)} (${escape_html(subtaskPct)}%)</span></h2> <div class="subtask-progress-bar svelte-13zy71l"><div class="subtask-done-fill svelte-13zy71l"${attr_style(`width:${stringify(subtaskPct)}%`)}></div></div> <div class="subtask-list svelte-13zy71l"><!--[-->`);
			const each_array_2 = ensure_array_like(subtasks);
			for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
				let sub = each_array_2[$$index_2];
				const gates = subtaskVerif(sub);
				$$renderer.push(`<a${attr("href", `/tasks/${stringify(sub.id)}`)} class="subtask-row svelte-13zy71l"><span${attr_class(`subtask-status ${stringify(statusClass(sub.status))}`, "svelte-13zy71l")}>${escape_html(statusIcon(sub.status))}</span> <div class="subtask-info svelte-13zy71l"><span class="subtask-id svelte-13zy71l">${escape_html(sub.id)}</span> <span class="subtask-title svelte-13zy71l">${escape_html(sub.title)}</span></div> <div class="subtask-meta svelte-13zy71l"><span${attr_class(`subtask-priority ${stringify(priorityClass(sub.priority))}`, "svelte-13zy71l")}>${escape_html(sub.priority)}</span> `);
				if (gates) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="gate-icons svelte-13zy71l"><span${attr_class("gate-dot svelte-13zy71l", void 0, { "gate-dot-pass": gates.implemented })} title="Implemented">I</span> <span${attr_class("gate-dot svelte-13zy71l", void 0, { "gate-dot-pass": gates.testsPassed })} title="Tests">T</span> <span${attr_class("gate-dot svelte-13zy71l", void 0, { "gate-dot-pass": gates.qaPassed })} title="QA">Q</span></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></a>`);
			}
			$$renderer.push(`<!--]--></div></section>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <aside class="task-sidebar svelte-13zy71l"><dl class="meta-list svelte-13zy71l"><div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Status</dt> <dd${attr_class(statusClass(task.status), "svelte-13zy71l")}>${escape_html(statusIcon(task.status))} ${escape_html(task.status)}</dd></div> <div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Priority</dt> <dd${attr_class(priorityClass(task.priority), "svelte-13zy71l")}>${escape_html(task.priority)}</dd></div> <div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Type</dt> <dd class="svelte-13zy71l">${escape_html(task.type)}</dd></div> `);
		if (task.size) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Size</dt> <dd class="svelte-13zy71l">${escape_html(task.size)}</dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (task.pipeline_stage) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Stage</dt> <dd class="svelte-13zy71l">${escape_html(task.pipeline_stage)}</dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (task.phase) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Phase</dt> <dd class="svelte-13zy71l">${escape_html(task.phase)}</dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (task.assignee) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Assignee</dt> <dd class="svelte-13zy71l">${escape_html(task.assignee)}</dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Created</dt> <dd class="svelte-13zy71l">${escape_html(formatDate(task.created_at))}</dd></div> <div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Updated</dt> <dd class="svelte-13zy71l">${escape_html(formatDate(task.updated_at))}</dd></div> `);
		if (task.completed_at) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Completed</dt> <dd class="svelte-13zy71l">${escape_html(formatDate(task.completed_at))}</dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (task.labels && task.labels.length > 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="meta-row svelte-13zy71l"><dt class="svelte-13zy71l">Labels</dt> <dd class="svelte-13zy71l"><div class="label-chips svelte-13zy71l"><!--[-->`);
			const each_array_3 = ensure_array_like(task.labels);
			for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
				let lbl = each_array_3[$$index_3];
				$$renderer.push(`<span class="label-chip svelte-13zy71l">${escape_html(lbl)}</span>`);
			}
			$$renderer.push(`<!--]--></div></dd></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></dl> <div class="sidebar-nav svelte-13zy71l"><a href="/tasks" class="sidebar-link svelte-13zy71l">← All Tasks</a> `);
		if (parent) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/tasks/tree/${stringify(parent.id)}`)} class="sidebar-link svelte-13zy71l">View Epic Tree</a>`);
		} else if (task.type === "epic") {
			$$renderer.push("<!--[1-->");
			$$renderer.push(`<a${attr("href", `/tasks/tree/${stringify(task.id)}`)} class="sidebar-link svelte-13zy71l">View as Tree</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div></aside></div></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-CRJDY3zw.js.map

import { a9 as head, a5 as escape_html, a3 as attr_class, a8 as stringify, a7 as attr_style, a2 as attr, a1 as ensure_array_like } from './dev-YtqJX9rn.js';

//#region src/routes/tasks/tree/[epicId]/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		const { epic, stats } = data;
		let collapsed = /* @__PURE__ */ new Set();
		function priorityClass(p) {
			if (p === "critical") return "pc-critical";
			if (p === "high") return "pc-high";
			if (p === "medium") return "pc-medium";
			return "pc-low";
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
		function gatesFromJson(json) {
			try {
				if (!json) return {
					i: false,
					t: false,
					q: false
				};
				const v = JSON.parse(json);
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
		const progressPct = stats ? stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0 : 0;
		head("11khb5n", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>${escape_html(epic?.id ?? "Tree")} — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="tree-view svelte-11khb5n"><nav class="breadcrumb svelte-11khb5n"><a href="/tasks" class="svelte-11khb5n">Tasks</a> <span class="crumb-sep svelte-11khb5n">›</span> <span class="crumb-current svelte-11khb5n">Tree: ${escape_html(epic?.id ?? "...")}</span></nav> `);
		if (epic) {
			$$renderer.push("<!--[0-->");
			function renderNode($$renderer, node, depth) {
				const isCollapsed = collapsed.has(node.id);
				const gates = gatesFromJson(node.verification_json);
				const hasChildren = node.children.length > 0;
				$$renderer.push(`<div class="tree-node svelte-11khb5n"${attr_style(`--depth:${stringify(depth)}`)}><div${attr_class("node-row svelte-11khb5n", void 0, { "node-done": node.status === "done" })}><div class="node-indent svelte-11khb5n"${attr_style(`width:${stringify(depth * 20)}px`)}></div> `);
				if (hasChildren) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="node-toggle svelte-11khb5n" role="button" tabindex="0"${attr("aria-label", isCollapsed ? "Expand" : "Collapse")}>${escape_html(isCollapsed ? "▶" : "▼")}</span>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<span class="node-toggle node-leaf svelte-11khb5n">·</span>`);
				}
				$$renderer.push(`<!--]--> <a${attr("href", `/tasks/${stringify(node.id)}`)} class="node-link svelte-11khb5n"><span class="node-id svelte-11khb5n">${escape_html(node.id)}</span> <span${attr_class(`node-status ${stringify(statusClass(node.status))}`, "svelte-11khb5n")}>${escape_html(statusIcon(node.status))}</span> <span class="node-title svelte-11khb5n">${escape_html(node.title)}</span> <span${attr_class(`node-priority ${stringify(priorityClass(node.priority))}`, "svelte-11khb5n")}>${escape_html(node.priority)}</span> `);
				if (node.pipeline_stage) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="node-stage svelte-11khb5n">${escape_html(node.pipeline_stage)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="node-gates svelte-11khb5n"><span${attr_class("ng svelte-11khb5n", void 0, { "ng-pass": gates.i })} title="Implemented">I</span> <span${attr_class("ng svelte-11khb5n", void 0, { "ng-pass": gates.t })} title="Tests">T</span> <span${attr_class("ng svelte-11khb5n", void 0, { "ng-pass": gates.q })} title="QA">Q</span></div></a></div> `);
				if (!isCollapsed && hasChildren) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="node-children svelte-11khb5n"><!--[-->`);
					const each_array = ensure_array_like(node.children);
					for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
						let child = each_array[$$index];
						renderNode($$renderer, child, depth + 1);
					}
					$$renderer.push(`<!--]--></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div>`);
			}
			$$renderer.push(`<div class="tree-header svelte-11khb5n"><div class="tree-title-row svelte-11khb5n"><span class="epic-id-badge svelte-11khb5n">${escape_html(epic.id)}</span> <span class="epic-type-badge svelte-11khb5n">${escape_html(epic.type)}</span> <span${attr_class(`epic-status ${stringify(statusClass(epic.status))}`, "svelte-11khb5n")}>${escape_html(statusIcon(epic.status))} ${escape_html(epic.status)}</span> <span${attr_class(`epic-priority ${stringify(priorityClass(epic.priority))}`, "svelte-11khb5n")}>${escape_html(epic.priority)}</span></div> <h1 class="tree-title svelte-11khb5n">${escape_html(epic.title)}</h1> `);
			if (stats) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="tree-stats svelte-11khb5n"><div class="tree-progress-bar svelte-11khb5n"><div class="tree-done-fill svelte-11khb5n"${attr_style(`width:${stringify(progressPct)}%`)}></div></div> <div class="tree-stat-row svelte-11khb5n"><span class="ts-done svelte-11khb5n">${escape_html(stats.done)} done</span> <span class="ts-active svelte-11khb5n">${escape_html(stats.active)} active</span> <span class="ts-pending svelte-11khb5n">${escape_html(stats.pending)} pending</span> `);
				if (stats.archived > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="ts-archived svelte-11khb5n">${escape_html(stats.archived)} archived</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <span class="ts-total svelte-11khb5n">${escape_html(stats.total)} total · ${escape_html(progressPct)}%</span></div></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> <div class="tree-controls svelte-11khb5n"><button class="tree-btn svelte-11khb5n">Expand All</button> <button class="tree-btn svelte-11khb5n">Collapse All</button></div></div> <div class="tree-body svelte-11khb5n">`);
			renderNode($$renderer, epic, 0);
			$$renderer.push(`<!----></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="not-found svelte-11khb5n">Epic not found</div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-Bjnp4VVn.js.map

import { a9 as head, a1 as ensure_array_like, a3 as attr_class, a5 as escape_html, a2 as attr } from './dev-YtqJX9rn.js';
import './client-CCez4mH4.js';
import './index-server-7GMbbq1i.js';
import 'node:module';
import './internal-CrNuA_rm.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';

//#endregion
//#region src/routes/projects/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		let projects = data.projects;
		const rowStates = {};
		const rowErrors = {};
		function formatCount(n) {
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}
		function formatDate(iso) {
			if (!iso) return "never";
			return iso.slice(0, 10);
		}
		const SEVEN_DAYS_MS = 10080 * 60 * 1e3;
		/** Returns true when lastIndexed is more than 7 days old. */
		function isStale(lastIndexed) {
			if (!lastIndexed) return false;
			return Date.now() - new Date(lastIndexed).getTime() > SEVEN_DAYS_MS;
		}
		head("rqn88j", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Projects — CLEO Studio</title>`);
			});
		});
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="projects-view svelte-rqn88j"><div class="view-header svelte-rqn88j"><div class="view-icon projects-icon svelte-rqn88j">P</div> <div class="view-header-text svelte-rqn88j"><h1 class="view-title svelte-rqn88j">Projects</h1> <p class="view-subtitle svelte-rqn88j">Multi-Project Registry</p></div> <div class="toolbar svelte-rqn88j"><button type="button" class="btn btn-toolbar svelte-rqn88j">Scan</button> <button type="button" class="btn btn-toolbar btn-toolbar-danger svelte-rqn88j">Clean…</button></div></div> `);
		if (projects.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-rqn88j"><p class="empty-text svelte-rqn88j">No projects registered</p> <p class="empty-detail svelte-rqn88j">Run <code class="svelte-rqn88j">cleo nexus projects register</code> or <code class="svelte-rqn88j">cleo nexus analyze</code> to
        register the current project, or use the <strong>Scan</strong> button above.</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="projects-list svelte-rqn88j"><!--[-->`);
			const each_array = ensure_array_like(projects);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let project = each_array[$$index];
				const isActive = data.activeProjectId === project.projectId;
				const rowState = rowStates[project.projectId] ?? "idle";
				const rowError = rowErrors[project.projectId] ?? "";
				const neverIndexed = project.lastIndexed === null;
				const stale = isStale(project.lastIndexed);
				$$renderer.push(`<div${attr_class("project-card svelte-rqn88j", void 0, { "active": isActive })}><div class="project-header svelte-rqn88j"><div class="project-name-row svelte-rqn88j"><span class="project-name svelte-rqn88j">${escape_html(project.name)}</span> `);
				if (isActive) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="active-badge svelte-rqn88j">active</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (stale && !neverIndexed) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="stale-dot svelte-rqn88j" title="Index is older than 7 days"></span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> <span class="project-path svelte-rqn88j">${escape_html(project.projectPath)}</span></div> <div class="project-stats svelte-rqn88j"><div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.taskCount))}</span> <span class="stat-label svelte-rqn88j">Tasks</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.nodeCount))}</span> <span class="stat-label svelte-rqn88j">Symbols</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.relationCount))}</span> <span class="stat-label svelte-rqn88j">Relations</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatDate(project.lastIndexed))}</span> <span class="stat-label svelte-rqn88j">Last Indexed</span></div></div> <div class="project-actions svelte-rqn88j">`);
				if (!isActive) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<form method="POST" action="?/switchProject"><input type="hidden" name="projectId"${attr("value", project.projectId)}/> <button type="submit" class="btn btn-primary svelte-rqn88j">Switch to Project</button></form>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<form method="POST" action="?/clearProject"><button type="submit" class="btn btn-secondary svelte-rqn88j">Clear Selection</button></form>`);
				}
				$$renderer.push(`<!--]--> `);
				if (neverIndexed) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<button type="button" class="btn btn-action svelte-rqn88j"${attr("disabled", rowState === "loading", true)}>${escape_html(rowState === "loading" ? "" : "Index")} `);
					if (rowState === "loading") {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<span class="spinner svelte-rqn88j" aria-hidden="true"></span>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--></button>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<button type="button"${attr_class("btn btn-action svelte-rqn88j", void 0, { "stale-btn": stale })}${attr("disabled", rowState === "loading", true)}>${escape_html(rowState === "loading" ? "" : "Re-Index")} `);
					if (rowState === "loading") {
						$$renderer.push("<!--[0-->");
						$$renderer.push(`<span class="spinner svelte-rqn88j" aria-hidden="true"></span>`);
					} else $$renderer.push("<!--[-1-->");
					$$renderer.push(`<!--]--></button>`);
				}
				$$renderer.push(`<!--]--> <button type="button" class="btn btn-delete svelte-rqn88j"${attr("disabled", rowState === "loading", true)}>Delete</button> `);
				if (rowState === "success") {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="status-badge success svelte-rqn88j" role="status">Done</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (rowState === "error" && rowError) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="status-badge error svelte-rqn88j"${attr("title", rowError)} role="alert">Error</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-BsruZYLH.js.map

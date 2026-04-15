import { a7 as head, a1 as ensure_array_like, a3 as attr_class, a5 as escape_html, a2 as attr } from './dev-BIJYOMms.js';
import './client-N_q1nHbX.js';
import './index-server-D_hhbQIS.js';
import 'node:module';
import './internal-B2puBP7A.js';
import '@sveltejs/kit/internal';
import '@sveltejs/kit/internal/server';

//#region src/routes/projects/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		function formatCount(n) {
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}
		function formatDate(iso) {
			if (!iso) return "never";
			return iso.slice(0, 10);
		}
		head("rqn88j", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Projects — CLEO Studio</title>`);
			});
		});
		$$renderer.push(`<div class="projects-view svelte-rqn88j"><div class="view-header svelte-rqn88j"><div class="view-icon projects-icon svelte-rqn88j">P</div> <div><h1 class="view-title svelte-rqn88j">Projects</h1> <p class="view-subtitle svelte-rqn88j">Multi-Project Registry</p></div></div> `);
		if (data.projects.length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-rqn88j"><p class="empty-text svelte-rqn88j">No projects registered</p> <p class="empty-detail svelte-rqn88j">Run <code class="svelte-rqn88j">cleo nexus projects register</code> or <code class="svelte-rqn88j">cleo nexus analyze</code> to register
        the current project.</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="projects-list svelte-rqn88j"><!--[-->`);
			const each_array = ensure_array_like(data.projects);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let project = each_array[$$index];
				const isActive = data.activeProjectId === project.projectId;
				$$renderer.push(`<div${attr_class("project-card svelte-rqn88j", void 0, { "active": isActive })}><div class="project-header svelte-rqn88j"><div class="project-name-row svelte-rqn88j"><span class="project-name svelte-rqn88j">${escape_html(project.name)}</span> `);
				if (isActive) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="active-badge svelte-rqn88j">active</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> <span class="project-path svelte-rqn88j">${escape_html(project.projectPath)}</span></div> <div class="project-stats svelte-rqn88j"><div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.taskCount))}</span> <span class="stat-label svelte-rqn88j">Tasks</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.nodeCount))}</span> <span class="stat-label svelte-rqn88j">Symbols</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatCount(project.relationCount))}</span> <span class="stat-label svelte-rqn88j">Relations</span></div> <div class="stat svelte-rqn88j"><span class="stat-value svelte-rqn88j">${escape_html(formatDate(project.lastIndexed))}</span> <span class="stat-label svelte-rqn88j">Last Indexed</span></div></div> <div class="project-actions svelte-rqn88j">`);
				if (!isActive) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<form method="POST" action="?/switchProject"><input type="hidden" name="projectId"${attr("value", project.projectId)}/> <button type="submit" class="btn btn-primary svelte-rqn88j">Switch to Project</button></form>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<form method="POST" action="?/clearProject"><button type="submit" class="btn btn-secondary svelte-rqn88j">Clear Selection</button></form>`);
				}
				$$renderer.push(`<!--]--></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte-BrcbkTQX.js.map

import { B as attr, V as escape_html, a as ensure_array_like, i as derived, n as attr_class, o as head } from "../../../chunks/dev.js";
import "../../../chunks/client.js";
import "../../../chunks/navigation.js";
//#region src/lib/components/admin/DeleteConfirmModal.svelte
function DeleteConfirmModal($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/** Display name of the project to delete. */
		/** Called when the user confirms deletion. */
		/** Called when the modal is dismissed without action. */
		let { projectName, onConfirm, onClose } = $$props;
		let inputValue = "";
		const confirmed = derived(() => inputValue === projectName);
		$$renderer.push(`<div class="modal-backdrop svelte-15ygpq" role="presentation"></div> <div class="modal-dialog svelte-15ygpq" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title"><div class="modal-header svelte-15ygpq"><h2 id="delete-modal-title" class="modal-title svelte-15ygpq">Delete Project</h2> <button type="button" class="close-btn svelte-15ygpq" aria-label="Close">✕</button></div> <div class="modal-body svelte-15ygpq"><p class="warning-text svelte-15ygpq">This action will remove the project from the nexus registry. It will not delete files on
      disk.</p> <p class="confirm-label svelte-15ygpq">Type <strong class="project-name-hint svelte-15ygpq">${escape_html(projectName)}</strong> to confirm:</p> <input type="text" class="confirm-input svelte-15ygpq"${attr("placeholder", projectName)}${attr("value", inputValue)} autocomplete="off" spellcheck="false"/></div> <div class="modal-footer svelte-15ygpq"><button type="button" class="btn btn-cancel svelte-15ygpq">Cancel</button> <button type="button" class="btn btn-danger svelte-15ygpq"${attr("disabled", !confirmed(), true)}>Delete</button></div></div>`);
	});
}
//#endregion
//#region src/lib/components/admin/ScanModal.svelte
function ScanModal($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { onClose } = $$props;
		let roots = "~/code,~/projects,/mnt/projects";
		let maxDepth = 4;
		let autoRegister = false;
		let loading = false;
		$$renderer.push(`<div class="modal-backdrop svelte-1y7f472" role="presentation"></div> <div class="modal-dialog svelte-1y7f472" role="dialog" aria-modal="true" aria-labelledby="scan-modal-title"><div class="modal-header svelte-1y7f472"><h2 id="scan-modal-title" class="modal-title svelte-1y7f472">Scan for Projects</h2> <button type="button" class="close-btn svelte-1y7f472" aria-label="Close">✕</button></div> <div class="modal-body svelte-1y7f472"><div class="field svelte-1y7f472"><label class="field-label svelte-1y7f472" for="scan-roots">Root Paths (comma-separated)</label> <textarea id="scan-roots" class="field-textarea svelte-1y7f472" rows="3" placeholder="~/code,~/projects,/mnt/projects">`);
		const $$body = escape_html(roots);
		if ($$body) $$renderer.push(`${$$body}`);
		$$renderer.push(`</textarea></div> <div class="field svelte-1y7f472"><label class="field-label svelte-1y7f472" for="scan-depth">Max Depth</label> <input id="scan-depth" type="number" class="field-input svelte-1y7f472" min="1" max="10"${attr("value", maxDepth)}/></div> <div class="checkbox-field svelte-1y7f472"><input id="scan-auto-register" type="checkbox" class="checkbox svelte-1y7f472"${attr("checked", autoRegister, true)}/> <label for="scan-auto-register" class="checkbox-label svelte-1y7f472">Auto-register discovered projects</label></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <div class="modal-footer svelte-1y7f472"><button type="button" class="btn btn-cancel svelte-1y7f472">Close</button> <button type="button" class="btn btn-primary svelte-1y7f472"${attr("disabled", loading, true)}>${escape_html("Run Scan")}</button></div></div>`);
	});
}
//#endregion
//#region src/lib/components/admin/CleanModal.svelte
function CleanModal($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { onClose } = $$props;
		let includeTemp = true;
		let includeTests = false;
		let includeUnhealthy = false;
		let includeNeverIndexed = false;
		let pattern = "";
		let purgeInput = "";
		const purgeConfirmed = derived(() => purgeInput === "PURGE");
		let loading = false;
		let result = null;
		$$renderer.push(`<div class="modal-backdrop svelte-1bkgyl6" role="presentation"></div> <div class="modal-dialog svelte-1bkgyl6" role="dialog" aria-modal="true" aria-labelledby="clean-modal-title"><div class="modal-header svelte-1bkgyl6"><h2 id="clean-modal-title" class="modal-title svelte-1bkgyl6">Clean Project Registry</h2> <button type="button" class="close-btn svelte-1bkgyl6" aria-label="Close">✕</button></div> <div class="modal-body svelte-1bkgyl6"><p class="section-label svelte-1bkgyl6">Target filters:</p> <div class="checkbox-group svelte-1bkgyl6"><label class="checkbox-row svelte-1bkgyl6"><input type="checkbox" class="checkbox svelte-1bkgyl6"${attr("checked", includeTemp, true)}/> <span class="checkbox-label svelte-1bkgyl6">Include <code class="svelte-1bkgyl6">.temp</code> paths</span></label> <label class="checkbox-row svelte-1bkgyl6"><input type="checkbox" class="checkbox svelte-1bkgyl6"${attr("checked", includeTests, true)}/> <span class="checkbox-label svelte-1bkgyl6">Include test / tmp / fixture / scratch / sandbox paths</span></label> <label class="checkbox-row svelte-1bkgyl6"><input type="checkbox" class="checkbox svelte-1bkgyl6"${attr("checked", includeUnhealthy, true)}/> <span class="checkbox-label svelte-1bkgyl6">Include unhealthy projects</span></label> <label class="checkbox-row svelte-1bkgyl6"><input type="checkbox" class="checkbox svelte-1bkgyl6"${attr("checked", includeNeverIndexed, true)}/> <span class="checkbox-label svelte-1bkgyl6">Include never-indexed projects</span></label></div> <div class="field svelte-1bkgyl6"><label class="field-label svelte-1bkgyl6" for="clean-pattern">Pattern filter (optional regex)</label> <input id="clean-pattern" type="text" class="field-input svelte-1bkgyl6" placeholder="e.g. /tmp/"${attr("value", pattern)}/></div> <div class="purge-section svelte-1bkgyl6"><p class="section-label svelte-1bkgyl6">Confirm destructive purge:</p> <p class="purge-hint svelte-1bkgyl6">Type <strong class="purge-keyword svelte-1bkgyl6">PURGE</strong> below to enable the real-delete button.</p> <input type="text" class="field-input purge-input svelte-1bkgyl6" placeholder="PURGE" autocomplete="off" spellcheck="false"${attr("value", purgeInput)}/></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (result !== null) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div${attr_class("results-box svelte-1bkgyl6", void 0, { "dry-run": result.dryRun })}><div class="results-header svelte-1bkgyl6">`);
			if (result.dryRun) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<span class="tag dry-run-tag svelte-1bkgyl6">DRY RUN</span>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<span class="tag purge-tag svelte-1bkgyl6">PURGED</span>`);
			}
			$$renderer.push(`<!--]--> `);
			if (result.removed !== void 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<span class="removed-count svelte-1bkgyl6">${escape_html(result.removed)} project(s) would be removed</span>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></div> `);
			if (result.paths && result.paths.length > 0) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<ul class="paths-list svelte-1bkgyl6"><!--[-->`);
				const each_array = ensure_array_like(result.paths);
				for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
					let p = each_array[$$index];
					$$renderer.push(`<li class="path-item svelte-1bkgyl6">${escape_html(p)}</li>`);
				}
				$$renderer.push(`<!--]--></ul>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<p class="no-results svelte-1bkgyl6">No matching projects found.</p>`);
			}
			$$renderer.push(`<!--]--></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> <div class="modal-footer svelte-1bkgyl6"><button type="button" class="btn btn-cancel svelte-1bkgyl6">Close</button> <button type="button" class="btn btn-preview svelte-1bkgyl6"${attr("disabled", loading, true)}>${escape_html("Preview")}</button> <button type="button" class="btn btn-danger svelte-1bkgyl6"${attr("disabled", !purgeConfirmed() || loading, true)}>Purge</button></div></div>`);
	});
}
//#endregion
//#region src/routes/projects/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		let showScan = false;
		let showClean = false;
		let deleteTarget = null;
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
		async function confirmDelete() {
			if (!deleteTarget) return;
			const { projectId } = deleteTarget;
			deleteTarget = null;
			rowStates[projectId] = "loading";
			rowErrors[projectId] = "";
			try {
				const envelope = await (await fetch(`/api/project/${encodeURIComponent(projectId)}`, { method: "DELETE" })).json();
				if (envelope.success) projects = projects.filter((p) => p.projectId !== projectId);
				else {
					rowStates[projectId] = "error";
					rowErrors[projectId] = envelope.error?.message ?? "Delete failed";
				}
			} catch (err) {
				rowStates[projectId] = "error";
				rowErrors[projectId] = err instanceof Error ? err.message : "Unexpected error";
			}
		}
		head("rqn88j", $$renderer, ($$renderer) => {
			$$renderer.title(($$renderer) => {
				$$renderer.push(`<title>Projects — CLEO Studio</title>`);
			});
		});
		if (showScan) {
			$$renderer.push("<!--[0-->");
			ScanModal($$renderer, { onClose: () => showScan = false });
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (showClean) {
			$$renderer.push("<!--[0-->");
			CleanModal($$renderer, { onClose: () => showClean = false });
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (deleteTarget) {
			$$renderer.push("<!--[0-->");
			DeleteConfirmModal($$renderer, {
				projectName: deleteTarget.name,
				onConfirm: confirmDelete,
				onClose: () => deleteTarget = null
			});
		} else $$renderer.push("<!--[-1-->");
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
//#endregion
export { _page as default };

//! Import safety rules: S03, S09, S10, S11, and the import-graph walk
//! that runs S03, S11 and S12 across resolved files.
//!
//! S03: Circular import chain detection.
//! S09: Import path traversal prevention.
//! S10: Symlink escape prevention.
//! S11: Import chain depth limit.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use crate::dsl::ast::{CantDocument, ImportStatement, Section};
use crate::dsl::span::Span;

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

use super::bindings::check_permission_escalation;

// ── S09: Import path traversal prevention ──────────────────────────

/// S09: Import paths MUST NOT escape the project root via `..` traversal.
pub fn check_import_path_traversal(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section
            && path_escapes_root(&imp.path)
        {
            diags.push(Diagnostic::error(
                    "S09",
                    format!(
                        "Import path '{}' escapes the project root. Imports MUST resolve within the project directory.",
                        imp.path
                    ),
                    imp.span,
                ));
        }
    }

    diags
}

/// Checks whether a relative path escapes the project root by resolving
/// `..` components. Returns true if the net path goes above the starting
/// directory.
pub(super) fn path_escapes_root(path: &str) -> bool {
    let mut depth: i32 = 0;
    for component in path.split('/') {
        match component {
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            "" | "." => {}
            _ => {
                depth += 1;
            }
        }
    }
    false
}

// ── S10: Symlink escape prevention ─────────────────────────────────

/// S10: Import paths MUST NOT follow symlinks resolving outside project root.
///
/// Note: This is a static-analysis level check. Full symlink resolution requires
/// filesystem access and is performed at import resolution time (runtime). The
/// static check flags patterns known to be suspicious (e.g., `/` prefixed paths).
pub fn check_import_symlink_escape(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section {
            // Static check: absolute paths are never relative to project root
            if imp.path.starts_with('/') {
                diags.push(Diagnostic::error(
                    "S10",
                    format!(
                        "Import '{}' uses an absolute path. Imports MUST be relative to the project root to prevent symlink escape.",
                        imp.path
                    ),
                    imp.span,
                ));
            }
        }
    }

    diags
}

// ── S11: Import chain depth limit ──────────────────────────────────

/// S11: Import chain depth MUST NOT exceed the configured maximum.
pub fn check_import_depth(ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let depth = ctx.import_chain.len() as u32;
    if depth > ctx.limits.max_import_depth {
        let last_path = ctx.import_chain.last().cloned().unwrap_or_default();
        diags.push(Diagnostic::error(
            "S11",
            format!(
                "Import chain depth of {} exceeds the maximum of {} at '{}'. Flatten your import hierarchy.",
                depth, ctx.limits.max_import_depth, last_path
            ),
            Span::dummy(),
        ));
    }
    diags
}

// ── S03: Circular import chains ────────────────────────────────────

/// S03: Check for circular import chains.
///
/// Note: Full cycle detection requires resolving imports across files. This
/// check validates the `import_chain` in the context. Call before processing
/// each import to verify the target is not already in the chain.
pub fn check_circular_import(path: &str, ctx: &ValidationContext, span: Span) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    if ctx.import_chain.contains(&path.to_string()) {
        let chain_str = ctx.import_chain.join(" -> ");
        diags.push(Diagnostic::error(
            "S03",
            format!(
                "Circular import chain detected: {chain_str} -> {path}. Break the cycle by extracting shared definitions."
            ),
            span,
        ));
    }

    diags
}

// ── Import graph walk: S03, S11, S12 across files ──────────────────

/// Permissions held by an import context, by domain.
type PermissionContext = HashMap<String, Vec<String>>;

/// Walks the import graph rooted at `file` and runs the cross-file import
/// rules on every edge: S03 (circular chain), S11 (chain depth) and S12
/// (permission escalation).
///
/// `doc` is the already-parsed contents of `file`. Imports resolve per the
/// spec's resolution algorithm (Section 6.2): `./` and `../` specifiers are
/// relative to the importing file; `@name` and bare specifiers resolve to
/// `.cleo/skills/<name>.cant` under the project root (the nearest ancestor
/// holding `.cleo/`, else `.git/`). A specifier without a `.cant` suffix also
/// tries `<specifier>.cant`. Imports that do not resolve or do not parse are
/// skipped here: S04 (target existence) is not implemented.
///
/// Containment (Section 6.4) is checked before the filesystem is touched: a
/// specifier whose normalized path leaves the project root is refused with
/// S09, an absolute one with S10, and a file whose real path (after symlinks)
/// leaves the root with S10. A refused import is never read.
///
/// S12 compares the agents of each imported file with the permission context
/// of the file importing it: the permissions its own agents hold, or, for a
/// file that defines no agents, the context it inherited from its importer.
/// The root file without agents sets no context.
///
/// The `import_chain` of `ctx` holds the resolution stack (root first) while
/// the walk runs and is restored before returning.
pub fn check_import_graph(
    doc: &CantDocument,
    file: &Path,
    ctx: &mut ValidationContext,
) -> Vec<Diagnostic> {
    let root_file = canonical_or_normalized(file);
    let project_root = find_project_root(&root_file);
    let mut walk = ImportWalk {
        project_root,
        ctx,
        finished: HashSet::new(),
        depth_reported: false,
        diags: Vec::new(),
    };
    let saved_chain = std::mem::take(&mut walk.ctx.import_chain);
    walk.visit(doc, &root_file, None);
    walk.ctx.import_chain = saved_chain;
    walk.diags
}

/// State of one import-graph walk.
struct ImportWalk<'a> {
    /// Directory every import must resolve within; `@name` and bare
    /// specifiers resolve under its `.cleo/skills/`.
    project_root: PathBuf,
    /// Context whose `import_chain` is the live resolution stack.
    ctx: &'a mut ValidationContext,
    /// (file, permission context) pairs whose whole subgraph was already
    /// walked (diamond imports). The context is part of the key because an
    /// agentless file's imports are checked against what it inherited.
    finished: HashSet<(PathBuf, String)>,
    /// S11 is reported once per walk, at the first chain over the limit.
    depth_reported: bool,
    /// Collected diagnostics.
    diags: Vec<Diagnostic>,
}

impl ImportWalk<'_> {
    /// Visits `file` (already parsed as `doc`) and recurses into its imports.
    ///
    /// `inherited` is the permission context of the importing file.
    fn visit(&mut self, doc: &CantDocument, file: &Path, inherited: Option<&PermissionContext>) {
        self.ctx.import_chain.push(self.display(file));

        if self.ctx.import_chain.len() as u32 > self.ctx.limits.max_import_depth {
            if !self.depth_reported {
                self.diags.extend(check_import_depth(self.ctx));
                self.depth_reported = true;
            }
            self.ctx.import_chain.pop();
            return;
        }

        let context = agent_permissions(doc).or_else(|| inherited.cloned());
        let context_key = context_key(context.as_ref());
        let base_dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
        let is_root_file = self.ctx.import_chain.len() == 1;

        for section in &doc.sections {
            let Section::Import(imp) = section else {
                continue;
            };
            let Some(target) = self.resolve(imp, &base_dir, file, is_root_file) else {
                continue;
            };

            let target_display = self.display(&target);
            let cycle = check_circular_import(&target_display, self.ctx, imp.span);
            if !cycle.is_empty() {
                self.diags.extend(cycle);
                continue;
            }

            let Some(imported) = read_document(&target) else {
                continue;
            };

            if let Some(allowed) = &context {
                for section in &imported.sections {
                    if let Section::Agent(agent) = section {
                        self.diags.extend(check_permission_escalation(
                            agent,
                            allowed,
                            &target_display,
                        ));
                    }
                }
            }

            let child_key = (target.clone(), context_key.clone());
            if !self.finished.contains(&child_key) {
                self.visit(&imported, &target, context.as_ref());
            }
        }

        self.ctx.import_chain.pop();
        self.finished.insert((file.to_path_buf(), context_key));
    }

    /// Resolves an import to an existing file inside the project root.
    ///
    /// Returns `None` for an import that does not resolve, and for one that
    /// escapes the project root, which is reported (S09/S10) and never read.
    /// On the root file, escapes the string checks
    /// [`check_import_path_traversal`] and [`check_import_symlink_escape`]
    /// already report are not reported twice.
    fn resolve(
        &mut self,
        imp: &ImportStatement,
        base_dir: &Path,
        importer: &Path,
        is_root_file: bool,
    ) -> Option<PathBuf> {
        let specifier = imp.path.as_str();
        let relative = specifier.starts_with("./") || specifier.starts_with("../");
        let name = specifier.strip_prefix('@').unwrap_or(specifier);

        // S10: an absolute specifier is never relative to the project root.
        if Path::new(name).is_absolute() {
            if !(is_root_file && specifier.starts_with('/')) {
                self.refuse("S10", "is an absolute path", imp, importer);
            }
            return None;
        }

        // S09: containment by lexical normalization, before any filesystem access.
        let candidate = if relative {
            normalize_lexically(&base_dir.join(specifier))
        } else {
            normalize_lexically(&self.project_root.join(".cleo").join("skills").join(name))
        };
        if !candidate.starts_with(&self.project_root) {
            if !(is_root_file && path_escapes_root(specifier)) {
                self.refuse("S09", "resolves outside the project root", imp, importer);
            }
            return None;
        }

        let with_ext = PathBuf::from(format!("{}.cant", candidate.display()));
        let found = [candidate, with_ext].into_iter().find(|p| p.is_file())?;

        // S10: the real path, after symlinks, must stay inside the root.
        let real = canonical_or_normalized(&found);
        if !real.starts_with(&self.project_root) {
            self.refuse(
                "S10",
                "follows a symlink that resolves outside the project root",
                imp,
                importer,
            );
            return None;
        }
        Some(real)
    }

    /// Records an S09/S10 refusal for an import that was not read.
    fn refuse(&mut self, rule: &str, why: &str, imp: &ImportStatement, importer: &Path) {
        let importer = self.display(importer);
        self.diags.push(Diagnostic::error(
            rule,
            format!(
                "Import '{}' in '{importer}' {why}. Imports MUST resolve within the project directory; the import was not read.",
                imp.path
            ),
            imp.span,
        ));
    }

    /// Displays a resolved path relative to the project root when possible.
    fn display(&self, path: &Path) -> String {
        path.strip_prefix(&self.project_root)
            .unwrap_or(path)
            .display()
            .to_string()
    }
}

/// Reads and parses a `.cant` file, normalizing CRLF line endings.
fn read_document(path: &Path) -> Option<CantDocument> {
    let content = std::fs::read_to_string(path).ok()?;
    crate::dsl::parse_document(&content.replace("\r\n", "\n")).ok()
}

/// Collects the permissions held by the agents of `doc`, by domain.
///
/// Returns `None` when `doc` defines no agents (no permission context of
/// its own).
fn agent_permissions(doc: &CantDocument) -> Option<PermissionContext> {
    let mut found_agent = false;
    let mut held = PermissionContext::new();
    for section in &doc.sections {
        if let Section::Agent(agent) = section {
            found_agent = true;
            for perm in &agent.permissions {
                let entry = held.entry(perm.domain.clone()).or_default();
                for access in &perm.access {
                    if !entry.contains(access) {
                        entry.push(access.clone());
                    }
                }
            }
        }
    }
    found_agent.then_some(held)
}

/// A deterministic key for a permission context (`None` = no context).
fn context_key(context: Option<&PermissionContext>) -> String {
    let Some(context) = context else {
        return String::from("-");
    };
    let mut entries: Vec<String> = context
        .iter()
        .map(|(domain, access)| {
            let mut access = access.clone();
            access.sort();
            format!("{domain}:{}", access.join(","))
        })
        .collect();
    entries.sort();
    entries.join(";")
}

/// Normalizes `.` and `..` components of an absolute path without touching
/// the filesystem.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalizes `path`, falling back to lexical normalization when the
/// filesystem cannot (for example under WASI without `realpath`).
fn canonical_or_normalized(path: &Path) -> PathBuf {
    if let Ok(p) = std::fs::canonicalize(path) {
        return p;
    }
    if path.is_absolute() {
        normalize_lexically(path)
    } else {
        normalize_lexically(&std::env::current_dir().unwrap_or_default().join(path))
    }
}

/// Finds the project root above `file`: the nearest ancestor directory
/// holding `.cleo/`, else `.git/`, else the file's own directory.
fn find_project_root(file: &Path) -> PathBuf {
    let start = file.parent().unwrap_or(file);
    for marker in [".cleo", ".git"] {
        if let Some(dir) = start.ancestors().find(|d| d.join(marker).is_dir()) {
            return dir.to_path_buf();
        }
    }
    start.to_path_buf()
}

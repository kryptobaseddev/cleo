/**
 * CleoOS postinstall — deploys the extensions `cleoos` needs to start.
 *
 * Runs automatically after `npm install -g @cleocode/cleo-os`.
 * Creates the XDG directories and copies the compiled extensions. Since
 * T13996 (ADR-098: the Pi/CleoOS harness is retiring) it no longer seeds
 * `.cant` files or runs `cleo skills install`, and it prints a deprecation
 * notice.
 *
 * Behaviour:
 *   - Skips silently during workspace/dev installs (non-global).
 *   - All directory creation is idempotent (no-op if directory exists).
 *   - Extensions are always overwritten on upgrade.
 *   - Missing `@mariozechner/pi-coding-agent` is handled gracefully.
 *
 * This source compiles to `bin/postinstall.js` via a dedicated tsconfig
 * (see `tsconfig.postinstall.json`). The `postinstall` script in
 * `package.json` references the compiled output at `bin/postinstall.js`.
 *
 * @packageDocumentation
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import envPaths from 'env-paths';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ---------------------------------------------------------------------------
// Cross-OS path resolution via env-paths (the underlying SSoT library that
// @cleocode/core's platform-paths also wraps).
//
// IMPORTANT: this MUST NOT import from `@cleocode/core/...` — the import
// statement resolves at module-load time, BEFORE isGlobalInstall() runs.
// In workspace CI (pnpm install → build → test), cleo-os's postinstall
// runs right after install, when @cleocode/core's dist/ does not yet
// exist. Importing from core would crash the whole install.
// env-paths is a direct dep of cleo-os and is always resolvable from
// node_modules after pnpm install completes.
// ---------------------------------------------------------------------------
/**
 * Resolve CleoOS directory layout. Uses env-paths directly — same underlying
 * library that @cleocode/core's `getPlatformPaths` wraps, so the two stay
 * in lock-step without creating a build-order dependency.
 *
 * @returns Resolved CleoOS directory paths.
 */
function resolveCleoOsPaths() {
    const ep = envPaths('cleo', { suffix: '' });
    const data = process.env['CLEO_HOME'] ?? ep.data;
    const config = ep.config;
    return {
        data,
        config,
        agentDir: data,
        extensions: join(data, 'extensions'),
        auth: join(config, 'auth'),
    };
}
// ---------------------------------------------------------------------------
// Global install detection
// ---------------------------------------------------------------------------
/**
 * Detect whether this is a global npm / pnpm install.
 *
 * Uses four heuristics in priority order:
 *  1. `npm_config_global=true` env var (set by npm/pnpm for global installs)
 *  2. Package path contains `lib/node_modules/` (npm global pattern)
 *  3. Package path starts with `npm_config_prefix` (npm prefix-based check)
 *  4. Presence of `pnpm-workspace.yaml` two levels up (workspace = dev)
 *
 * @returns `true` if the install appears to be a global install.
 */
function isGlobalInstall() {
    const pkgRoot = resolve(__dirname, '..');
    // Signal 1: npm_config_global env var (set by npm during global installs)
    if (process.env['npm_config_global'] === 'true')
        return true;
    // Signal 2: path contains a global node_modules (npm, pnpm, yarn)
    if (/[/\\]lib[/\\]node_modules[/\\]/.test(pkgRoot))
        return true;
    // Signal 3: npm_config_prefix matches the package path
    const prefix = process.env['npm_config_prefix'];
    if (prefix !== undefined && pkgRoot.startsWith(prefix))
        return true;
    // Signal 4: inside a pnpm workspace — definitely not global
    const workspaceMarker = join(pkgRoot, '..', '..', 'pnpm-workspace.yaml');
    if (existsSync(workspaceMarker))
        return false;
    return false;
}
// ---------------------------------------------------------------------------
// Directory scaffolding
// ---------------------------------------------------------------------------
/**
 * Idempotently create a directory if it does not already exist.
 *
 * @param dir - Absolute path to the directory to create.
 */
function ensureDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        process.stdout.write(`CleoOS: created ${dir}\n`);
    }
}
// ---------------------------------------------------------------------------
// Extension deployment
// ---------------------------------------------------------------------------
/**
 * Copy a compiled extension to the XDG extensions directory.
 *
 * Always overwrites the target so that upgrades deploy the latest version.
 * Extensions are managed files, not user-editable configs.
 *
 * @param extensionName - Filename without the `.js` extension.
 * @param pkgRoot - Absolute path to the installed package root.
 * @param extensionsDir - Absolute path to the XDG extensions directory.
 */
function deployExtension(extensionName, pkgRoot, extensionsDir) {
    const src = join(pkgRoot, 'extensions', `${extensionName}.js`);
    const dest = join(extensionsDir, `${extensionName}.js`);
    if (!existsSync(src)) {
        process.stdout.write(`CleoOS: skipping ${extensionName}.js (source not found at ${src})\n`);
        return;
    }
    const updating = existsSync(dest);
    cpSync(src, dest, { force: true });
    if (updating) {
        process.stdout.write(`CleoOS: updating extension: ${extensionName}.js\n`);
    }
    else {
        process.stdout.write(`CleoOS: deployed ${extensionName}.js to ${dest}\n`);
    }
}
// ---------------------------------------------------------------------------
// Extension node_modules symlink
// ---------------------------------------------------------------------------
/**
 * Create a symlink from the extensions directory's `node_modules` to the
 * cleo-os package's `node_modules`.
 *
 * Extensions are compiled JS files copied to `~/.local/share/cleo/extensions/`
 * by {@link deployExtension}. When they use `import("@cleocode/cant")` or
 * `import("@cleocode/core")`, Node's module resolution looks for
 * `node_modules` relative to the extension file's directory. Since the
 * extensions directory has no `node_modules`, the import fails.
 *
 * This function creates:
 *   `<extensionsDir>/node_modules` → `<pkgRoot>/node_modules`
 *
 * so that bare-specifier imports from deployed extensions resolve against the
 * cleo-os package's dependency tree. The symlink is idempotent: if it already
 * points to the correct target, it is left in place; if it points elsewhere
 * (e.g., after a prefix change), it is replaced.
 *
 * @param pkgRoot - Absolute path to the installed cleo-os package root.
 * @param extensionsDir - Absolute path to the XDG extensions directory.
 */
function linkExtensionNodeModules(pkgRoot, extensionsDir) {
    const target = join(pkgRoot, 'node_modules');
    const link = join(extensionsDir, 'node_modules');
    // Bail if the package's node_modules doesn't exist (shouldn't happen, but be safe)
    if (!existsSync(target)) {
        process.stdout.write(`CleoOS: skipping node_modules symlink (${target} not found)\n`);
        return;
    }
    try {
        // Check if symlink already exists and points to the right place.
        // Use lstatSync first (doesn't follow symlinks) to handle dangling symlinks.
        let linkExists = false;
        try {
            linkExists = lstatSync(link).isSymbolicLink() || existsSync(link);
        }
        catch {
            // Path doesn't exist at all — fine, we'll create it
        }
        if (linkExists) {
            try {
                const currentTarget = readlinkSync(link);
                if (currentTarget === target) {
                    // Already correct — nothing to do
                    return;
                }
            }
            catch {
                // readlinkSync fails if it's not a symlink — remove and re-create
            }
            // Points elsewhere or is stale — remove and re-create
            unlinkSync(link);
        }
    }
    catch {
        // Cleanup failed — try creating anyway
    }
    try {
        symlinkSync(target, link, 'dir');
        process.stdout.write(`CleoOS: linked extensions/node_modules → ${target}\n`);
    }
    catch (err) {
        // Best-effort: log and continue. The extension has a createRequire fallback.
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`CleoOS: warning: could not symlink node_modules: ${message}\n`);
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/** Deprecation notice the postinstall prints (T13996, ADR-098). */
const DEPRECATION_NOTICE = 'CleoOS: @cleocode/cleo-os is deprecated (ADR-098). Use the cleo CLI with your own harness; ' +
    'CLEO Goal drives autonomous runs.\n';
/**
 * Entry point for the CleoOS postinstall script.
 *
 * Orchestrates directory scaffolding, extension deployment and
 * node_modules linking. All operations are idempotent.
 */
function main() {
    if (!isGlobalInstall()) {
        process.stdout.write('CleoOS: skipping postinstall (not global install)\n');
        return;
    }
    const paths = resolveCleoOsPaths();
    const pkgRoot = resolve(__dirname, '..');
    // 1. Scaffold XDG directories
    for (const dir of [paths.data, paths.config, paths.extensions, paths.auth]) {
        ensureDir(dir);
    }
    // 2. Deploy compiled extensions
    // tui-theme is a shared library imported by all other extensions — deploy first.
    deployExtension('tui-theme', pkgRoot, paths.extensions);
    deployExtension('cleo-startup', pkgRoot, paths.extensions);
    deployExtension('cleo-cant-bridge', pkgRoot, paths.extensions);
    deployExtension('cleo-hooks-bridge', pkgRoot, paths.extensions);
    deployExtension('cleo-chatroom', pkgRoot, paths.extensions);
    deployExtension('cleo-agent-monitor', pkgRoot, paths.extensions);
    // 2b. Symlink extensions/node_modules → pkgRoot/node_modules so that
    // deployed extensions can resolve @cleocode/* and @mariozechner/*
    // bare-specifier imports against the cleo-os dependency tree.
    linkExtensionNodeModules(pkgRoot, paths.extensions);
    // T13996 (ADR-098): the CleoOS harness is retiring. The postinstall no
    // longer creates the cant/ directory, seeds .cant files (model-routing
    // stub, starter team bundle) or runs `cleo skills install`. It still
    // deploys the extensions the `cleoos` launcher loads, so an installed
    // cleoos keeps starting until the package is removed.
    process.stdout.write(DEPRECATION_NOTICE); // stdout-discipline-allowed: npm postinstall output, not a CLI envelope (T13996) // stdout-write-allowed: npm postinstall output (T13996)
    process.stdout.write('CleoOS: postinstall complete\n');
}
main();
//# sourceMappingURL=postinstall.js.map
/**
 * CleoOS postinstall — scaffolds the global XDG hub and deploys extensions.
 *
 * Runs automatically after `npm install -g @cleocode/cleo-os`.
 * Creates an XDG-compliant directory structure, copies the compiled CANT
 * bridge extension to the extensions directory, and optionally invokes
 * `cleo skills install` for any bundled CleoOS skills.
 *
 * Behaviour:
 *   - Skips silently during workspace/dev installs (non-global).
 *   - All directory creation is idempotent (no-op if directory exists).
 *   - All file copies are idempotent (only copies if target is missing).
 *   - Skill install is best-effort; failures are logged but not fatal.
 *   - Missing `@mariozechner/pi-coding-agent` is handled gracefully.
 *
 * This source compiles to `bin/postinstall.js` via a dedicated tsconfig
 * (see `tsconfig.postinstall.json`). The `postinstall` script in
 * `package.json` references the compiled output at `bin/postinstall.js`.
 *
 * @packageDocumentation
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ---------------------------------------------------------------------------
// XDG path resolution (inline copy — avoids importing from dist/ which may
// not exist when this script runs for the first time)
// ---------------------------------------------------------------------------
/**
 * Inline XDG path resolution that mirrors `src/xdg.ts`.
 *
 * Uses an inline copy here so the postinstall script can run before
 * the compiled `dist/` tree is available on a fresh install.
 *
 * @returns Resolved CleoOS XDG directory paths.
 */
function resolveCleoOsPaths() {
    const home = homedir();
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
    const data = join(xdgData, 'cleo');
    const config = join(xdgConfig, 'cleo');
    return {
        data,
        config,
        agentDir: data,
        extensions: join(data, 'extensions'),
        cant: join(data, 'cant'),
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
 * Only copies if the target does not already exist (idempotent). The
 * source is the compiled `.js` file in the package's `extensions/` folder.
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
    if (existsSync(dest)) {
        // Already deployed — idempotent, skip.
        return;
    }
    cpSync(src, dest, { force: false });
    process.stdout.write(`CleoOS: deployed ${extensionName}.js to ${dest}\n`);
}
// ---------------------------------------------------------------------------
// Default CANT file scaffolding
// ---------------------------------------------------------------------------
/**
 * Write a default `model-routing.cant` stub to the XDG CANT directory if
 * no `.cant` files are present. This gives the user a starting point for
 * CANT declarations without overwriting any existing work.
 *
 * @param cantDir - Absolute path to the XDG CANT directory.
 */
function scaffoldDefaultCant(cantDir) {
    const modelRoutingPath = join(cantDir, 'model-routing.cant');
    if (existsSync(modelRoutingPath))
        return;
    const stub = [
        '# CleoOS default model-routing.cant',
        '# Declare agents, teams, and routing rules here.',
        '# See: https://github.com/kryptobaseddev/cleo/blob/main/docs/cant-dsl.md',
        '',
    ].join('\n');
    try {
        writeFileSync(modelRoutingPath, stub, 'utf-8');
        process.stdout.write(`CleoOS: created default ${modelRoutingPath}\n`);
    }
    catch {
        // Best-effort: non-fatal.
    }
}
// ---------------------------------------------------------------------------
// Skill installation
// ---------------------------------------------------------------------------
/**
 * Invoke `cleo skills install` via `execFileSync` to register the CleoOS
 * bundled skills with the project. This is best-effort — if `cleo` is not
 * on PATH or the command fails, we log and continue.
 *
 * Uses `execFileSync` (not `exec`) to prevent shell injection: the command
 * and arguments are passed as separate parameters so no shell is spawned.
 */
function installSkills() {
    try {
        execFileSync('cleo', ['skills', 'install'], { stdio: 'inherit' });
        process.stdout.write('CleoOS: skills install complete\n');
    }
    catch {
        // cleo may not be installed or skills may already be up to date.
        process.stdout.write('CleoOS: skipping skills install (cleo not found or already installed)\n');
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * Entry point for the CleoOS postinstall script.
 *
 * Orchestrates directory scaffolding, extension deployment, CANT stub
 * creation, and optional skill installation. All operations are idempotent.
 */
function main() {
    if (!isGlobalInstall()) {
        process.stdout.write('CleoOS: skipping postinstall (not global install)\n');
        return;
    }
    const paths = resolveCleoOsPaths();
    const pkgRoot = resolve(__dirname, '..');
    // 1. Scaffold XDG directories
    for (const dir of [paths.data, paths.config, paths.extensions, paths.cant, paths.auth]) {
        ensureDir(dir);
    }
    // 2. Deploy compiled extensions
    deployExtension('cleo-cant-bridge', pkgRoot, paths.extensions);
    deployExtension('cleo-chatroom', pkgRoot, paths.extensions);
    // 3. Write default CANT stub (only if file does not exist)
    scaffoldDefaultCant(paths.cant);
    // 4. Install CleoOS skills (best-effort)
    installSkills();
    process.stdout.write('CleoOS: postinstall complete\n');
}
main();
//# sourceMappingURL=postinstall.js.map
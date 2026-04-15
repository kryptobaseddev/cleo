import { spawn } from 'node:child_process';

//#region src/lib/server/spawn-cli.ts
/**
* Shared utility for shelling out to the `cleo` CLI from Studio API endpoints.
*
* Uses child_process.spawn (NOT execFileSync) so long-running commands
* (nexus analyze, nexus projects scan, etc.) do not block the event loop.
* Stdout is buffered and the final JSON envelope is parsed on process exit.
* Stderr is captured and surfaced on failure.
*
* @task T657
*/
/** Timeout for CLI commands in milliseconds. */
var CLI_TIMEOUT_MS = 6e4;
/**
* Run a `cleo` CLI command and collect its output.
*
* @param args - Arguments to pass to the `cleo` binary (e.g. `['nexus', 'analyze', '/path']`).
* @returns A promise that resolves with the collected CLI output.
*
* @example
* const result = await runCleoCli(['nexus', 'projects', 'remove', 'proj-123', '--json']);
*/
function runCleoCli(args) {
	return new Promise((resolve) => {
		const child = spawn(process.env["CLEO_BIN"] ?? "cleo", args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({
				ok: false,
				envelope: null,
				stdout,
				stderr: stderr || "CLI command timed out after 60s",
				exitCode: -1
			});
		}, CLI_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			const exitCode = code ?? -1;
			let envelope = null;
			try {
				const trimmed = stdout.trim();
				if (trimmed.startsWith("{")) envelope = JSON.parse(trimmed);
			} catch {}
			resolve({
				ok: exitCode === 0 && (envelope?.success ?? true),
				envelope,
				stdout,
				stderr,
				exitCode
			});
		});
	});
}

export { runCleoCli as r };
//# sourceMappingURL=spawn-cli-wI1lBJhm.js.map

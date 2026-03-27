import { describe, expect, it } from "vitest";
import { buildCleoProfile, checkCommandReachability, extractVersionTag, isCleoSource, normalizeCleoChannel, parseEnvAssignments, resolveChannelFromServerName, resolveCleoServerName, } from "../../src/core/mcp/cleo.js";
describe("core: mcp cleo", () => {
    // ── normalizeCleoChannel ──────────────────────────────────────────
    describe("normalizeCleoChannel", () => {
        it("returns stable for undefined", () => {
            expect(normalizeCleoChannel(undefined)).toBe("stable");
        });
        it("returns stable for empty string", () => {
            expect(normalizeCleoChannel("")).toBe("stable");
        });
        it("returns stable for whitespace-only string", () => {
            expect(normalizeCleoChannel("   ")).toBe("stable");
        });
        it("normalizes 'Stable' to 'stable'", () => {
            expect(normalizeCleoChannel("Stable")).toBe("stable");
        });
        it("normalizes 'BETA' to 'beta'", () => {
            expect(normalizeCleoChannel("BETA")).toBe("beta");
        });
        it("normalizes ' dev ' with whitespace to 'dev'", () => {
            expect(normalizeCleoChannel(" dev ")).toBe("dev");
        });
        it("throws for invalid channel value", () => {
            expect(() => normalizeCleoChannel("nightly")).toThrow('Invalid channel "nightly". Expected stable, beta, or dev.');
        });
        it("throws for random string", () => {
            expect(() => normalizeCleoChannel("foobar")).toThrow('Invalid channel "foobar"');
        });
    });
    // ── resolveChannelFromServerName ──────────────────────────────────
    describe("resolveChannelFromServerName", () => {
        it("resolves 'cleo' to stable", () => {
            expect(resolveChannelFromServerName("cleo")).toBe("stable");
        });
        it("resolves 'cleo-beta' to beta", () => {
            expect(resolveChannelFromServerName("cleo-beta")).toBe("beta");
        });
        it("resolves 'cleo-dev' to dev", () => {
            expect(resolveChannelFromServerName("cleo-dev")).toBe("dev");
        });
        it("returns null for unknown server name", () => {
            expect(resolveChannelFromServerName("unknown-server")).toBeNull();
        });
        it("returns null for empty string", () => {
            expect(resolveChannelFromServerName("")).toBeNull();
        });
    });
    // ── resolveCleoServerName ─────────────────────────────────────────
    describe("resolveCleoServerName", () => {
        it("returns 'cleo' for stable", () => {
            expect(resolveCleoServerName("stable")).toBe("cleo");
        });
        it("returns 'cleo-beta' for beta", () => {
            expect(resolveCleoServerName("beta")).toBe("cleo-beta");
        });
        it("returns 'cleo-dev' for dev", () => {
            expect(resolveCleoServerName("dev")).toBe("cleo-dev");
        });
    });
    // ── buildCleoProfile ─────────────────────────────────────────────
    describe("buildCleoProfile", () => {
        it("builds stable profile with latest package tag", () => {
            const profile = buildCleoProfile({ channel: "stable" });
            expect(profile.serverName).toBe("cleo");
            expect(profile.packageSpec).toBe("@cleocode/cleo@latest");
            expect(profile.config.command).toBe("npx");
            expect(profile.config.args).toEqual(["-y", "@cleocode/cleo@latest", "mcp"]);
        });
        it("builds stable profile with no version (defaults to latest tag)", () => {
            const profile = buildCleoProfile({ channel: "stable" });
            expect(profile.packageSpec).toBe("@cleocode/cleo@latest");
        });
        it("builds beta profile with no version (defaults to beta tag)", () => {
            const profile = buildCleoProfile({ channel: "beta" });
            expect(profile.packageSpec).toBe("@cleocode/cleo@beta");
        });
        it("builds beta profile with explicit pre-release version", () => {
            const profile = buildCleoProfile({ channel: "beta", version: "2026.3.0-beta.1" });
            expect(profile.serverName).toBe("cleo-beta");
            expect(profile.packageSpec).toBe("@cleocode/cleo@2026.3.0-beta.1");
        });
        it("builds dev profile and defaults CLEO_DIR", () => {
            const profile = buildCleoProfile({ channel: "dev", command: "./dist/mcp/index.js", args: ["--stdio"] });
            expect(profile.serverName).toBe("cleo-dev");
            expect(profile.config.command).toBe("./dist/mcp/index.js");
            expect(profile.config.args).toEqual(["--stdio"]);
            expect(profile.config.env?.CLEO_DIR).toBe("~/.cleo-dev");
        });
        it("dev channel with command as string with spaces and no explicit args", () => {
            const profile = buildCleoProfile({ channel: "dev", command: "node dist/mcp/index.js --stdio" });
            expect(profile.config.command).toBe("node");
            expect(profile.config.args).toEqual(["dist/mcp/index.js", "--stdio"]);
        });
        it("throws for dev channel without command", () => {
            expect(() => buildCleoProfile({ channel: "dev" })).toThrow("Dev channel requires --command.");
        });
        it("throws for dev channel with empty string command", () => {
            expect(() => buildCleoProfile({ channel: "dev", command: "  " })).toThrow("Dev channel requires --command.");
        });
        it("dev channel with explicit cleoDir", () => {
            const profile = buildCleoProfile({
                channel: "dev",
                command: "./run.js",
                args: ["--stdio"],
                cleoDir: "/custom/cleo",
            });
            expect(profile.config.env?.CLEO_DIR).toBe("/custom/cleo");
        });
        it("dev channel with existing env preserves other env vars", () => {
            const profile = buildCleoProfile({
                channel: "dev",
                command: "./run.js",
                args: ["--stdio"],
                env: { NODE_ENV: "development" },
            });
            expect(profile.config.env?.NODE_ENV).toBe("development");
            expect(profile.config.env?.CLEO_DIR).toBe("~/.cleo-dev");
        });
        it("dev channel with CLEO_DIR already set in env does not override", () => {
            const profile = buildCleoProfile({
                channel: "dev",
                command: "./run.js",
                args: ["--stdio"],
                env: { CLEO_DIR: "/my/custom/dir" },
            });
            expect(profile.config.env?.CLEO_DIR).toBe("/my/custom/dir");
        });
        it("non-dev channel does not set env from normalizeEnv", () => {
            const profile = buildCleoProfile({ channel: "stable" });
            expect(profile.config.env).toBeUndefined();
        });
        it("stable channel with explicit version", () => {
            const profile = buildCleoProfile({ channel: "stable", version: "1.2.3" });
            expect(profile.packageSpec).toBe("@cleocode/cleo@1.2.3");
        });
        it("dev profile has no packageSpec", () => {
            const profile = buildCleoProfile({ channel: "dev", command: "./run.js", args: [] });
            expect(profile.packageSpec).toBeUndefined();
        });
    });
    // ── checkCommandReachability ──────────────────────────────────────
    describe("checkCommandReachability", () => {
        it("checks reachability for missing path command", () => {
            const check = checkCommandReachability("./definitely-not-a-binary");
            expect(check.reachable).toBe(false);
            expect(check.method).toBe("path");
        });
        it("finds a command on PATH via lookup (e.g. node)", () => {
            const check = checkCommandReachability("node");
            expect(check.reachable).toBe(true);
            expect(check.method).toBe("lookup");
            expect(check.detail).toBe("node");
        });
        it("returns not reachable for nonexistent command via lookup", () => {
            const check = checkCommandReachability("xyznonexistentcommand12345");
            expect(check.reachable).toBe(false);
            expect(check.method).toBe("lookup");
        });
        it("handles tilde path", () => {
            // ~ resolves to homedir, which should exist but may not be an executable
            const check = checkCommandReachability("~/nonexistent-binary-xyz");
            expect(check.method).toBe("path");
            expect(check.reachable).toBe(false);
        });
        it("handles relative path with ./", () => {
            const check = checkCommandReachability("./some/relative/path");
            expect(check.method).toBe("path");
            expect(check.reachable).toBe(false);
        });
        it("handles backslash path separator", () => {
            const check = checkCommandReachability("some\\path\\command");
            expect(check.method).toBe("path");
        });
    });
    // ── expandHome (indirectly via checkCommandReachability) ──────────
    describe("expandHome (via checkCommandReachability)", () => {
        it("expands ~ alone to homedir", () => {
            // ~ alone should resolve to homedir which is a directory (exists)
            const check = checkCommandReachability("~");
            expect(check.method).toBe("path");
            // homedir should exist, so reachable = true
            expect(check.reachable).toBe(true);
        });
        it("expands ~/path to homedir/path", () => {
            const check = checkCommandReachability("~/some-nonexistent-path-abc");
            expect(check.method).toBe("path");
            expect(check.reachable).toBe(false);
        });
    });
    // ── parseEnvAssignments ───────────────────────────────────────────
    describe("parseEnvAssignments", () => {
        it("parses valid key=value pairs", () => {
            const env = parseEnvAssignments(["CLEO_DIR=~/.cleo-dev", "NODE_ENV=development"]);
            expect(env).toEqual({ CLEO_DIR: "~/.cleo-dev", NODE_ENV: "development" });
        });
        it("returns empty object for empty array", () => {
            expect(parseEnvAssignments([])).toEqual({});
        });
        it("throws for value with no = sign", () => {
            expect(() => parseEnvAssignments(["INVALID"])).toThrow('Invalid --env value "INVALID". Use KEY=value.');
        });
        it("throws for value starting with = (empty key)", () => {
            expect(() => parseEnvAssignments(["=value"])).toThrow('Invalid --env value "=value". Use KEY=value.');
        });
        it("handles value containing = signs", () => {
            const env = parseEnvAssignments(["KEY=value=with=equals"]);
            expect(env).toEqual({ KEY: "value=with=equals" });
        });
        it("handles empty value after =", () => {
            const env = parseEnvAssignments(["KEY="]);
            expect(env).toEqual({ KEY: "" });
        });
        it("throws for whitespace-only key before = sign", () => {
            expect(() => parseEnvAssignments(["  =value"])).toThrow('Invalid --env value "  =value". Key cannot be empty.');
        });
    });
    // ── extractVersionTag ───────────────────────────────────────────────
    describe("extractVersionTag", () => {
        it("extracts 'latest' from '@cleocode/cleo@latest'", () => {
            expect(extractVersionTag("@cleocode/cleo@latest")).toBe("latest");
        });
        it("extracts '1.2.3' from '@cleocode/cleo@1.2.3'", () => {
            expect(extractVersionTag("@cleocode/cleo@1.2.3")).toBe("1.2.3");
        });
        it("extracts 'beta' from '@cleocode/cleo@beta'", () => {
            expect(extractVersionTag("@cleocode/cleo@beta")).toBe("beta");
        });
        it("returns undefined for undefined input", () => {
            expect(extractVersionTag(undefined)).toBeUndefined();
        });
        it("returns undefined for '@cleocode/cleo' (no version)", () => {
            expect(extractVersionTag("@cleocode/cleo")).toBeUndefined();
        });
        it("returns undefined for empty string", () => {
            expect(extractVersionTag("")).toBeUndefined();
        });
        it("handles non-scoped package 'pkg@2.0.0'", () => {
            expect(extractVersionTag("pkg@2.0.0")).toBe("2.0.0");
        });
    });
    // ── isCleoSource ──────────────────────────────────────────────────
    describe("isCleoSource", () => {
        it("returns true for 'cleo'", () => {
            expect(isCleoSource("cleo")).toBe(true);
        });
        it("returns true for 'CLEO' (case insensitive)", () => {
            expect(isCleoSource("CLEO")).toBe(true);
        });
        it("returns true for ' Cleo ' (whitespace trimmed)", () => {
            expect(isCleoSource(" Cleo ")).toBe(true);
        });
        it("returns false for non-cleo source", () => {
            expect(isCleoSource("not-cleo")).toBe(false);
        });
        it("returns false for empty string", () => {
            expect(isCleoSource("")).toBe(false);
        });
    });
});
//# sourceMappingURL=mcp-cleo-core.test.js.map